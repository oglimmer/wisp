const { app, BrowserWindow, Menu, ipcMain, dialog, protocol, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');

// ---- The app:// scheme ----
//
// The UI is served from a custom scheme rather than loaded off disk with
// loadFile(). Chromium refuses a `<script type="module">` from a file:// page —
// module fetches go through CORS and a file:// origin is opaque — so the renderer
// could not be split into ES modules at all while the window loaded file://.
//
// `standard` is what gives the scheme real origin semantics: relative URLs
// resolve, and localStorage works (which is where the view mode and the divider
// positions live). `secure` keeps it out of Chromium's mixed-content and
// restricted-API buckets, the same as https.
const APP_SCHEME = 'app';
const APP_ORIGIN = `${APP_SCHEME}://wisp`;
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true } },
]);

// Served content types. A module script is subject to strict MIME checking —
// Chromium refuses to execute one that doesn't arrive as JavaScript — so these
// are stated rather than guessed.
const CONTENT_TYPE = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// Serve the app's own directory, and nothing else: the request path is resolved
// against __dirname and refused if it escapes — the same guard the vault handlers
// apply, for the same reason. Inside a packaged build __dirname is app.asar, which
// fs reads through transparently.
function registerAppProtocol() {
  protocol.handle(APP_SCHEME, async (request) => {
    let rel;
    try {
      rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '');
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    const file = path.join(__dirname, rel || 'index.html');
    if (!isInside(__dirname, file)) return new Response('Forbidden', { status: 403 });
    try {
      const body = await fsp.readFile(file);
      const type = CONTENT_TYPE[path.extname(file).toLowerCase()] || 'application/octet-stream';
      return new Response(body, { headers: { 'content-type': type } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

// ---- Simple config persistence (remembers the last base folder) ----
const configPath = () => path.join(app.getPath('userData'), 'config.json');

/**
 * The window's saved geometry. Position, maximized and fullScreen are all
 * optional: a frame that no longer overlaps a live display is restored at its
 * size but not its position, so unplugging a monitor can't strand it off-screen.
 * @typedef {{ width: number, height: number, x?: number, y?: number,
 *             maximized?: boolean, fullScreen?: boolean }} WindowState
 */

/**
 * Everything in `config.json` (under Electron's userData dir, never the vault).
 * @typedef {{ baseFolder?: string, window?: WindowState }} Config
 */

/** @returns {Config} */
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  } catch (err) {
    console.error('Failed to save config:', err);
  }
}

// The reminder list lives in the vault root so it travels with the notes, but it
// is app state rather than a note — hidden from the tree (and from smart insert).
const REMINDERS_FILE = '.wisp-reminders.json';

// Entries we never want to show in the tree. Anything dot-prefixed is treated as
// hidden — that covers VCS metadata, OS cruft, other editors' per-vault config
// folders and REMINDERS_FILE itself — plus this explicit list of the rest.
const IGNORED = new Set(['node_modules']);

function isIgnored(name) {
  return name.startsWith('.') || IGNORED.has(name);
}

// Image extensions we can embed (preview) and import (drag & drop), mapped to
// the MIME type used when inlining them as data URLs.
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};

// The subset of those the `claude` CLI can actually look at (what its Read tool
// accepts as an image). The rest still import fine — they just skip analysis
// rather than having Claude read e.g. an .svg as source text and describe markup.
const ANALYZABLE_IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

// Last-modified time in epoch ms, or 0 for anything that can't be stat'd (a
// symlink to nowhere, an entry deleted between the readdir and here). The
// recency list sorts on this, and 0 sorts to the bottom rather than the top.
async function mtimeOf(filePath) {
  try {
    return (await fsp.stat(filePath)).mtimeMs;
  } catch {
    return 0;
  }
}

// Recursively build a folder/file tree rooted at dirPath.
async function buildTree(dirPath) {
  let entries;
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const nodes = [];
  for (const entry of entries) {
    if (isIgnored(entry.name)) continue;
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: full,
        type: 'dir',
        children: await buildTree(full),
      });
    } else if (entry.isFile()) {
      // `mtime` is what the sidebar's recency list sorts by. It is read here,
      // during the walk, rather than in a second pass: the tree is rebuilt whole
      // on every change anyway, so a stat per file is the cheapest place to get it
      // and both views then come out of one call.
      nodes.push({ name: entry.name, path: full, type: 'file', mtime: await mtimeOf(full) });
    }
  }

  // Folders first, then files, each alphabetical (case-insensitive).
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  return nodes;
}

let mainWindow;

const DEFAULT_WINDOW = { width: 1200, height: 800 };
const MIN_WINDOW = { width: 640, height: 400 };

// Restore the window where it was left. Size is always safe to reuse; the
// *position* isn't — the display it was on may be gone (laptop undocked, monitor
// unplugged), which would park the window off-screen where it can't be reached.
// So x/y are only honoured when the saved frame still overlaps some display.
function restoredWindowState() {
  const saved = loadConfig().window;
  if (!saved || typeof saved !== 'object') return { ...DEFAULT_WINDOW };

  const num = (v, fallback) => (Number.isFinite(v) ? Math.round(v) : fallback);
  /** @type {WindowState} */
  const state = {
    width: Math.max(MIN_WINDOW.width, num(saved.width, DEFAULT_WINDOW.width)),
    height: Math.max(MIN_WINDOW.height, num(saved.height, DEFAULT_WINDOW.height)),
  };

  if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    const frame = { x: num(saved.x), y: num(saved.y), width: state.width, height: state.height };
    const onScreen = screen.getAllDisplays().some((display) => {
      const a = display.workArea;
      return (
        frame.x < a.x + a.width &&
        frame.x + frame.width > a.x &&
        frame.y < a.y + a.height &&
        frame.y + frame.height > a.y
      );
    });
    if (onScreen) {
      state.x = frame.x;
      state.y = frame.y;
    }
  }

  if (saved.maximized) state.maximized = true;
  if (saved.fullScreen) state.fullScreen = true;
  return state;
}

// Written on a timer rather than per event: dragging or resizing a window emits
// a stream of move/resize events, and one config rewrite each would hammer disk.
/** @type {NodeJS.Timeout | undefined} */
let saveBoundsTimer;

function persistWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // getNormalBounds() is the un-maximized frame, so restoring from a maximized
  // session still knows what size to return to.
  const bounds = mainWindow.getNormalBounds();
  const cfg = loadConfig();
  cfg.window = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized: mainWindow.isMaximized(),
    fullScreen: mainWindow.isFullScreen(),
  };
  saveConfig(cfg);
}

function scheduleWindowStateSave() {
  clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(persistWindowState, 400);
}

function createWindow() {
  const state = restoredWindowState();

  mainWindow = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    show: false,
    title: 'Wisp',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Maximize/fullscreen before the first paint, so the window never shows at its
  // restored size and then visibly jumps.
  if (state.fullScreen) mainWindow.setFullScreen(true);
  else if (state.maximized) mainWindow.maximize();
  mainWindow.show();

  mainWindow.loadURL(`${APP_ORIGIN}/index.html`);

  for (const event of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    mainWindow.on(event, scheduleWindowStateSave);
  }
  // The debounce may still be pending when the window goes away, and after
  // 'closed' the bounds are unreadable — so flush here.
  mainWindow.on('close', () => {
    clearTimeout(saveBoundsTimer);
    persistWindowState();
    // The terminal's claude belongs to this window; without this it survives as an
    // orphan process holding a pty nobody can see or answer.
    killPty();
  });

  // Stop the taskbar flash we start when a reminder comes due, once the user looks.
  mainWindow.on('focus', () => {
    try {
      mainWindow.flashFrame(false);
    } catch {}
  });
}

// The app menu exists for one item — Help ▸ Keyboard Shortcuts — but building a
// menu at all replaces Electron's default one, so the standard roles have to be
// rebuilt with it: on macOS ⌘C/⌘V/⌘Q are menu accelerators, not browser
// behaviour, and a template without an Edit menu silently takes them away. The
// shortcut list itself lives in the renderer with the handlers it documents; this
// only opens it.
function buildMenu() {
  /** @type {import('electron').MenuItemConstructorOptions[]} */
  const template = [
    ...(process.platform === 'darwin'
      ? /** @type {import('electron').MenuItemConstructorOptions[]} */ ([{ role: 'appMenu' }])
      : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Keyboard Shortcuts',
          accelerator: 'CmdOrCtrl+/',
          click: () => {
            const win = BrowserWindow.getFocusedWindow() || mainWindow;
            if (win) win.webContents.send('show-shortcuts');
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Caps so a huge file cannot balloon main/renderer memory (images become base64
// data URLs in the UI, so the in-memory cost is larger than the on-disk size).
const MAX_TEXT_BYTES = 8 * 1024 * 1024; // notes opened / written as text
const MAX_IMAGE_BYTES = 12 * 1024 * 1024; // preview / import / analyze

function formatBytesLimit(n) {
  if (n >= 1024 * 1024) return `${Math.round(n / (1024 * 1024))} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

// Guard against path-traversal: ensure `target` stays inside `base` (lexical —
// does not follow symlinks; see vaultPath for the symlink-aware check).
function isInside(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Walk up from absPath until realpath succeeds. Returns the real path of the
// nearest existing ancestor and the missing basename segments below it (empty
// when absPath itself exists). Used so create/write into a not-yet-existing
// path still refuses a parent that symlinks out of the vault.
function realpathExisting(absPath) {
  let cursor = path.resolve(absPath);
  const missing = [];
  for (;;) {
    try {
      return { real: fs.realpathSync(cursor), missing };
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw err;
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

// Symlink-aware containment. Lexical path must sit under baseFolder, and the
// realpath-resolved location must too.
//
// `follow` (default true) is for content access (read/write): the final resolved
// path must stay inside the vault, so a vault entry that is a symlink pointing
// outside cannot be used to read or overwrite files elsewhere.
//
// `follow: false` is for entry operations (delete, rename source): those act on
// the directory entry itself (removing a symlink does not touch its target), so
// only the parent directory must resolve inside the vault.
function assertInsideVault(baseFolder, absPath, label = 'Invalid path', { follow = true } = {}) {
  const base = path.resolve(baseFolder);
  const abs = path.resolve(absPath);
  if (!isInside(base, abs)) throw new Error(label);

  let realBase;
  try {
    realBase = fs.realpathSync(base);
  } catch {
    throw new Error(label);
  }

  try {
    if (follow) {
      const { real, missing } = realpathExisting(abs);
      // basenames only in `missing` (from path.basename), so join cannot reintroduce `..`.
      const resolved = missing.length ? path.resolve(path.join(real, ...missing)) : real;
      if (!isInside(realBase, resolved)) throw new Error(label);
    } else {
      const parent = path.dirname(abs);
      const { real, missing } = realpathExisting(parent);
      const resolvedParent = missing.length ? path.resolve(path.join(real, ...missing)) : real;
      if (!isInside(realBase, resolvedParent)) throw new Error(label);
    }
  } catch (err) {
    if (err && err.message === label) throw err;
    throw new Error(label);
  }
  return abs;
}

// Refuse files that are not regular files or that exceed a byte budget *before*
// reading them into memory.
function assertReadableFile(filePath, maxBytes, what = 'File') {
  let st;
  try {
    st = fs.statSync(filePath);
  } catch {
    throw new Error(`${what} not found.`);
  }
  if (!st.isFile()) throw new Error(`${what} is not a regular file.`);
  if (st.size > maxBytes) {
    throw new Error(`${what} is too large (max ${formatBytesLimit(maxBytes)}).`);
  }
  return st;
}

// Every handler below answers `{ ok: true, … }` or `{ ok: false, error }` rather
// than rejecting — the renderer has one way to read a result, and a thrown error
// and a refused operation are the same thing to it. So the try/catch lives here
// once instead of being repeated (and eventually forgotten) in each handler.
// `_e` is never passed on: it carries a handle on the sender.
//
// Generic over the channel map in `types/ipc.d.ts`, so the channel name alone
// types each handler below: its parameters come from the declared signature,
// and a result the renderer isn't expecting is an error here rather than a
// missing property found later on the other side of the bridge.
/**
 * @template {keyof import('./types/ipc').IpcHandlers} C
 * @param {C} channel
 * @param {import('./types/ipc').IpcHandlers[C]} fn
 */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      // The arguments arrive off the wire as `any[]`; each handler declares what
      // it actually takes, and its own body is checked against that.
      return await /** @type {(...a: any[]) => any} */ (fn)(...args);
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
}

// Resolve a target the renderer supplied and refuse anything outside the vault.
// Throws rather than returning a value, so the guard cannot be written and then
// accidentally ignored — `handle()` turns it into the usual `{ ok: false }`.
// See assertInsideVault for the `follow` option (content vs entry ops).
function vaultPath(baseFolder, target, label = 'Invalid path', opts) {
  if (typeof baseFolder !== 'string' || typeof target !== 'string') throw new Error(label);
  if (target.includes('\0')) throw new Error(label);
  const abs = path.resolve(baseFolder, target);
  return assertInsideVault(baseFolder, abs, label, opts);
}

// UTF-8 text payload for write handlers: type-check and size-cap before disk I/O.
function assertTextContent(content, maxBytes = MAX_TEXT_BYTES) {
  if (typeof content !== 'string') throw new Error('Invalid content.');
  if (Buffer.byteLength(content, 'utf8') > maxBytes) {
    throw new Error(`Content is too large (max ${formatBytesLimit(maxBytes)}).`);
  }
  return content;
}

// ---- Markdown references ----
//
// Notes point at other files — images above all — with ordinary Markdown refs,
// and two conventions are in the wild. A ref can be relative to the note that
// holds it (what this app writes), or relative to the vault root: Obsidian's
// "relative to vault root" setting writes `./dir/img.png` from a note sitting in
// a subfolder, which resolves nowhere note-relative. Both are resolved, and
// `move-path` rewrites a ref in whichever convention it already used rather than
// silently converting the vault to one of them.

// Files that can hold a ref worth rewriting. Every text file is a note here, so
// this is about skipping binaries, not about Markdown in particular.
const TEXT_REF_EXT = new Set(['.md', '.markdown', '.mdown', '.txt']);

// Inline links and images: `](target)`, `](<target>)`, `](target "title")`. The
// target group stops at whitespace, so the title (and the closing paren) stay in
// the trailing group and are put back untouched — and an unescaped space ends the
// target, which is what marked does too: `](./a b.png)` isn't a link at all.
// One level of *balanced* parens is allowed, because marked accepts those
// (`./a%20(1).png`); the refs this app writes escape them either way.
const MD_REF_RE = /(\]\(\s*)(<[^<>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)([^)\n]*\))/g;

// A ref as a plain relative path, or null for anything that doesn't name a file
// on disk: a URL scheme, a protocol-relative or absolute URL, a bare anchor. A
// query or fragment is refused too — it would be dropped by a rewrite.
function refToRelPath(ref) {
  let value = String(ref).trim();
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim();
  if (!value || value.includes('\0')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) return null;
  if (value.includes('#') || value.includes('?')) return null;
  try {
    value = decodeURIComponent(value);
  } catch {
    // A stray `%` that isn't an escape — take the ref literally.
  }
  if (!value || value.includes('\0') || path.isAbsolute(value)) return null;
  return value;
}

// Resolve a ref to the file it names inside the vault: note-relative first, then
// vault-root-relative. `exists` decides which candidate wins, so a ref is only
// ever claimed by a convention that actually finds a file, and `style` reports
// the one that hit so a rewrite can stay in it.
/** @param {(abs: string) => boolean} [exists] */
function resolveVaultRef(baseFolder, noteDir, ref, exists = fs.existsSync) {
  const rel = refToRelPath(ref);
  if (rel === null) return null;
  const base = path.resolve(baseFolder);
  const candidates = [
    { abs: path.resolve(noteDir, rel), style: 'note' },
    { abs: path.resolve(base, rel), style: 'root' },
  ];
  for (const cand of candidates) {
    if (!isInside(base, cand.abs)) continue;
    if (exists(cand.abs)) return cand;
  }
  return null;
}

// Percent-encode a path for a Markdown ref, segment by segment so the separators
// survive: spaces (a ref ends at the first one) and the parens that would close
// `](…)` early.
function encodeRef(rel) {
  return rel
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/\(/g, '%28').replace(/\)/g, '%29'))
    .join('/');
}

// The ref text for `target`, written from `noteDir` in `style` — the convention
// the ref being replaced already used.
function refFor(baseFolder, noteDir, target, style) {
  const from = style === 'root' ? path.resolve(baseFolder) : noteDir;
  let rel = path.relative(from, target).split(path.sep).join('/');
  if (!rel) return null;
  if (!rel.startsWith('.')) rel = './' + rel;
  return encodeRef(rel);
}

// Rewrite every ref in `text` that a move invalidated. `mapTarget` maps a
// pre-move absolute path to its post-move one (identity for anything the move
// didn't touch), and `noteOldDir`/`noteNewDir` differ when the note itself moved
// — a note that changed folder has to re-aim even refs whose target stayed put.
//
// A ref whose target and note both stayed put is left exactly as written: this
// runs over every note in the vault, and re-encoding refs that nothing happened
// to would turn one move into a diff across the whole vault.
function rewriteMovedRefs(baseFolder, text, noteOldDir, noteNewDir, mapTarget) {
  let changed = 0;
  const out = text.replace(MD_REF_RE, (whole, open, ref, tail) => {
    // Existence is tested at the post-move location: the rename has already
    // happened, so a moved file is only findable through mapTarget.
    const hit = resolveVaultRef(baseFolder, noteOldDir, ref, (abs) =>
      fs.existsSync(mapTarget(abs))
    );
    if (!hit) return whole;
    const target = mapTarget(hit.abs);
    const targetMoved = target !== hit.abs;
    const noteMoved = hit.style === 'note' && noteNewDir !== noteOldDir;
    if (!targetMoved && !noteMoved) return whole;
    const next = refFor(baseFolder, noteNewDir, target, hit.style);
    if (!next || next === ref) return whole;
    changed++;
    return open + next + tail;
  });
  return { text: out, changed };
}

// Every text file in the vault, as absolute paths. Uses the same isIgnored() as
// the tree, so a move never rewrites anything the app doesn't show.
async function gatherTextFiles(baseFolder) {
  /** @type {string[]} */
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (isIgnored(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && TEXT_REF_EXT.has(path.extname(entry.name).toLowerCase())) {
        out.push(full);
      }
    }
  }
  await walk(baseFolder);
  return out;
}

app.whenReady().then(() => {
  registerAppProtocol();
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Belt and braces with the window's own 'close': a quit that never closes a window
// (⌘Q from the menu while hidden) must not leave the terminal's claude behind.
app.on('before-quit', () => killPty());

// ---- IPC handlers ----

// Return the last-used base folder (if it still exists).
// Open a URL in the user's default browser. Used by the Markdown preview so
// clicking a link doesn't navigate the app window away. Only http(s)/mailto are
// allowed through — anything else is ignored.
ipcMain.handle('open-external', (_e, url) => {
  if (typeof url === 'string' && /^(https?:|mailto:)/i.test(url)) {
    shell.openExternal(url);
  }
});

// Reveal a tree entry in the OS file manager (Finder on macOS), selecting it in
// its parent folder. Path-guarded like every other handler that takes a target
// from the renderer, so it can only ever point at something inside the vault.
handle('reveal-path', async (baseFolder, target) => {
  // follow: false — reveal the vault entry (including a symlink), not its target.
  const abs = vaultPath(baseFolder, target, 'Outside the vault.', { follow: false });
  if (!fs.existsSync(abs)) return { ok: false, error: 'Not found on disk.' };
  shell.showItemInFolder(abs);
  return { ok: true };
});

ipcMain.handle('get-last-folder', () => {
  const cfg = loadConfig();
  if (cfg.baseFolder && fs.existsSync(cfg.baseFolder)) return cfg.baseFolder;
  return null;
});

// Open a folder-picker dialog. Returns the chosen path or null.
ipcMain.handle('choose-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose a base folder',
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const folder = result.filePaths[0];
  const cfg = loadConfig();
  cfg.baseFolder = folder;
  saveConfig(cfg);
  return folder;
});

// Build the tree for a given base folder.
ipcMain.handle('read-tree', async (_e, baseFolder) => {
  if (!baseFolder || !fs.existsSync(baseFolder)) return null;
  return {
    name: path.basename(baseFolder) || baseFolder,
    path: baseFolder,
    type: 'dir',
    children: await buildTree(baseFolder),
  };
});

// Read a file as raw UTF-8 text.
handle('read-file', async (baseFolder, filePath) => {
  const target = vaultPath(baseFolder, filePath, 'Outside the vault.');
  assertReadableFile(target, MAX_TEXT_BYTES, 'File');
  return { ok: true, content: await fsp.readFile(target, 'utf8') };
});

// Write raw text back to a file.
handle('write-file', async (baseFolder, filePath, content) => {
  const target = vaultPath(baseFolder, filePath, 'Outside the vault.');
  assertTextContent(content);
  // Before the write, not after: the watcher can see the change while writeFile is
  // still settling, and an event that arrives first would be treated as somebody
  // else's edit and reload the buffer the user is typing into.
  noteOwnWrite(target);
  await fsp.writeFile(target, content, 'utf8');
  return { ok: true };
});

// Synchronous write for the renderer's beforeunload flush. Blocks the renderer
// briefly, but guarantees the last edit is on disk before the window closes.
// Sent rather than invoked, so it can't go through `handle()`.
ipcMain.on('write-file-sync', (e, baseFolder, filePath, content) => {
  try {
    const target = vaultPath(baseFolder, filePath, 'Outside the vault.');
    assertTextContent(content);
    noteOwnWrite(target);
    fs.writeFileSync(target, content, 'utf8');
    e.returnValue = { ok: true };
  } catch (err) {
    e.returnValue = { ok: false, error: String(err) };
  }
});

// Create a new file. name may include subfolders (created as needed).
handle('create-file', async (baseFolder, relPath) => {
  const target = vaultPath(baseFolder, relPath);
  if (fs.existsSync(target)) return { ok: false, error: 'File already exists' };
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, '', 'utf8');
  return { ok: true, path: target };
});

// Create a new folder.
handle('create-folder', async (baseFolder, relPath) => {
  const target = vaultPath(baseFolder, relPath);
  if (fs.existsSync(target)) return { ok: false, error: 'Folder already exists' };
  await fsp.mkdir(target, { recursive: true });
  return { ok: true, path: target };
});

// Delete a file or folder (must live inside the base folder). The vault root
// itself is inside the vault, so it needs ruling out separately.
// follow: false so a symlink that points outside can still be removed (rm acts
// on the entry; it does not delete the outside target).
handle('delete-path', async (baseFolder, target) => {
  const abs = vaultPath(baseFolder, target, 'Invalid path', { follow: false });
  // vaultPath has already thrown unless baseFolder is a string, which the type
  // checker can't see through — hence the cast rather than a second check.
  if (abs === path.resolve(/** @type {string} */ (baseFolder))) {
    return { ok: false, error: 'Invalid path' };
  }
  await fsp.rm(abs, { recursive: true, force: true });
  return { ok: true };
});

// Keep the vault's Markdown refs true across a completed move (a rename is one
// too — of a folder, or of an image every note points at). Runs *after* the
// rename, so each ref is validated against where its target now is, and covers
// both directions: a note that moved re-aims its own refs, and a note that
// pointed at something moved follows it.
//
// Returns how many notes were rewritten. A ref-rewrite failure never fails the
// move itself — the files are already where the user asked for them, and an
// unreadable or oversized note is skipped rather than taking the move down.
async function updateRefsAfterMove(baseFolder, src, dest) {
  // Pre-move ↔ post-move. The walk finds notes at their new paths, but their refs
  // were written relative to where they used to sit.
  const remap = (abs, from, to) => {
    if (abs === from) return to;
    const rel = path.relative(from, abs);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? path.join(to, rel) : abs;
  };
  const mapTarget = (/** @type {string} */ abs) => remap(abs, src, dest);

  let updated = 0;
  for (const file of await gatherTextFiles(baseFolder)) {
    let text;
    try {
      assertReadableFile(file, MAX_TEXT_BYTES, 'File');
      text = await fsp.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const wasAt = remap(file, dest, src);
    const res = rewriteMovedRefs(
      baseFolder,
      text,
      path.dirname(wasAt),
      path.dirname(file),
      mapTarget
    );
    if (!res.changed) continue;
    try {
      await fsp.writeFile(file, res.text, 'utf8');
      updated++;
    } catch {
      // Read-only note, vanished mid-walk — leave it as it was.
    }
  }
  return updated;
}

// Rename / move a file or folder within the base folder.
// follow: false on both ends: rename moves the directory entry (including a
// symlink) without writing through it.
handle('rename-path', async (baseFolder, oldPath, newName) => {
  if (typeof newName !== 'string' || !newName || newName.includes('\0')) {
    return { ok: false, error: 'Invalid name' };
  }
  const source = vaultPath(baseFolder, oldPath, 'Invalid path', { follow: false });
  const target = vaultPath(
    baseFolder,
    path.join(path.dirname(source), newName),
    'Invalid path',
    { follow: false }
  );
  if (fs.existsSync(target)) return { ok: false, error: 'Target already exists' };
  await fsp.rename(source, target);
  const updated = await updateRefsAfterMove(baseFolder, source, target);
  return { ok: true, path: target, updated };
});

// Move a file or folder into another folder in the vault — the tree's drag & drop.
//
// The move itself is a rename; the work is keeping the notes' references true
// (see updateRefsAfterMove). follow: false for the source, like rename-path — the
// directory entry moves rather than being written through. The destination is
// resolved with the default follow: true, because we write *into* it: a vault
// folder that symlinks outside must not be able to accept a move.
handle('move-path', async (baseFolder, target, destDir) => {
  const src = vaultPath(baseFolder, target, 'Invalid path', { follow: false });
  // vaultPath has already thrown unless baseFolder is a string, which the type
  // checker can't see through — hence the cast rather than a second check.
  const root = path.resolve(/** @type {string} */ (baseFolder));
  if (src === root) return { ok: false, error: 'Cannot move the vault itself' };

  const dir = vaultPath(baseFolder, destDir, 'Invalid destination');
  let st;
  try {
    st = fs.statSync(dir);
  } catch {
    return { ok: false, error: 'Destination folder not found' };
  }
  if (!st.isDirectory()) return { ok: false, error: 'Destination is not a folder' };
  if (dir === path.dirname(src)) return { ok: false, error: 'Already in that folder' };
  // Covers dropping a folder on itself (isInside is true for an equal path) as
  // well as on anything below it, either of which would move it out of existence.
  if (isInside(src, dir)) return { ok: false, error: 'Cannot move a folder into itself' };

  const dest = vaultPath(baseFolder, path.join(dir, path.basename(src)), 'Invalid path', {
    follow: false,
  });
  if (fs.existsSync(dest)) return { ok: false, error: 'Target already exists' };

  await fsp.rename(src, dest);
  const updated = await updateRefsAfterMove(baseFolder, src, dest);
  return { ok: true, path: dest, updated };
});

// ---- Reminders ----

// The whole list is read and written as one JSON document — same philosophy as the
// tree (rebuild, don't mutate). It's small, and keeping it a single plain file means
// the vault stays self-describing with no index to fall out of sync.
handle('read-reminders', async (baseFolder) => {
  if (!baseFolder || !fs.existsSync(baseFolder)) return { ok: true, reminders: [] };
  const file = path.join(baseFolder, REMINDERS_FILE);
  if (!fs.existsSync(file)) return { ok: true, reminders: [] };
  const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
  const list = Array.isArray(parsed) ? parsed : parsed && parsed.reminders;
  return { ok: true, reminders: Array.isArray(list) ? list : [] };
});

handle('write-reminders', async (baseFolder, reminders) => {
  if (!baseFolder || !fs.existsSync(baseFolder)) return { ok: false, error: 'No folder open.' };
  const file = path.join(baseFolder, REMINDERS_FILE);
  const body = JSON.stringify({ reminders: Array.isArray(reminders) ? reminders : [] }, null, 2);
  noteOwnWrite(file);
  await fsp.writeFile(file, body, 'utf8');
  return { ok: true };
});

// A reminder has come due: make sure the window is actually in front of the user,
// and flash the taskbar entry / bounce the dock if it isn't.
ipcMain.handle('alert-window', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    if (!mainWindow.isFocused()) {
      mainWindow.flashFrame(true);
      if (process.platform === 'darwin' && app.dock) app.dock.bounce('informational');
    }
    mainWindow.focus();
  } catch {}
});

// ---- The terminal pane ----
//
// The pane at the bottom of the editor runs `claude` interactively, which is a
// different thing from the one-shot `runClaude()` calls smart insert makes: the
// CLI is a full-screen TUI, so it needs a real pty — its own tty, raw keystrokes,
// a SIGWINCH when the pane is resized — rather than pipes it would see as a
// non-interactive stream. node-pty provides that, and ships N-API prebuilds, so
// nothing has to be rebuilt against Electron's ABI (`scripts/pty-permissions.js`
// covers the one thing those prebuilds get wrong).
//
// **The renderer never names the program.** `term-start` always spawns `claude`
// in the open vault, and `term-input` only ever writes to that process's tty:
// there is deliberately no channel here that runs an arbitrary command, which is
// the same reason git is only ever driven through `spawn('git', …)` below.
//
// One session at a time, for the one window. Starting a second replaces the
// first, and the window going away kills it — an orphaned `claude` holding a pty
// nobody can see would keep running (and keep spending) invisibly.

/** @type {import('node-pty').IPty | null} */
let ptyProcess = null;
/** @type {typeof import('node-pty') | null | undefined} */
let ptyModule; // undefined = not tried yet, null = unavailable

// Required on first use rather than at startup: a missing or unloadable native
// prebuild has to degrade to a terminal pane that says so, not take the app down
// before the window exists.
function loadPty() {
  if (ptyModule === undefined) {
    try {
      ptyModule = require('node-pty');
    } catch (err) {
      ptyModule = null;
      console.error('node-pty is unavailable, the terminal pane is disabled:', err);
    }
  }
  return ptyModule;
}

// A pty size arrives from the renderer's fit calculation, so it is only ever as
// trustworthy as any other renderer input; the ioctl behind it takes 16-bit
// values, and 0 columns makes the TUI unrenderable.
function ptyDimension(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 2 && n <= 1000 ? n : fallback;
}

function sendToWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// Clears `ptyProcess` *before* killing, so the dying session's onExit — which is
// how the renderer learns claude stopped — can tell it is not the current one and
// stay quiet. Otherwise a restart reports the old session's exit over the new one.
function killPty() {
  const doomed = ptyProcess;
  ptyProcess = null;
  if (!doomed) return;
  try {
    doomed.kill();
  } catch {}
}

handle('term-start', async (baseFolder, cols, rows) => {
  const pty = loadPty();
  if (!pty) return { ok: false, error: 'The terminal is unavailable in this build.' };
  if (typeof baseFolder !== 'string' || !fs.existsSync(baseFolder)) {
    return { ok: false, error: 'No folder is open.' };
  }
  killPty();

  // claudeEnv() for the same reason every other spawn uses it: a bundled .app
  // launched from Finder has a bare PATH and would not find `claude` at all.
  // TERM is what makes the CLI draw its full-screen UI rather than fall back to
  // line-at-a-time output, and it has to match what xterm.js can actually paint.
  const child = pty.spawn('claude', [], {
    name: 'xterm-256color',
    cols: ptyDimension(cols, 80),
    rows: ptyDimension(rows, 24),
    cwd: baseFolder,
    env: { ...claudeEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
  ptyProcess = child;

  // Both callbacks check they still own the session: a replaced pty can emit a
  // last chunk (or its exit) after `term-start` has handed the pane to a new one.
  child.onData((data) => {
    if (ptyProcess === child) sendToWindow('term-data', data);
  });
  child.onExit(({ exitCode, signal }) => {
    if (ptyProcess !== child) return;
    ptyProcess = null;
    sendToWindow('term-exit', { exitCode, signal });
  });

  return { ok: true, pid: child.pid };
});

// Keystrokes, straight through to the tty. A write to a session that has already
// exited is an ordinary race (the user typed into a pane whose claude just quit),
// not an error worth surfacing.
handle('term-input', async (data) => {
  if (!ptyProcess) return { ok: false, error: 'No session is running.' };
  if (typeof data !== 'string') throw new Error('Invalid terminal input.');
  ptyProcess.write(data);
  return { ok: true };
});

// The pane was resized: tell the tty, so the TUI reflows instead of drawing to a
// width that no longer exists.
handle('term-resize', async (cols, rows) => {
  if (!ptyProcess) return { ok: false, error: 'No session is running.' };
  ptyProcess.resize(ptyDimension(cols, 80), ptyDimension(rows, 24));
  return { ok: true };
});

handle('term-stop', async () => {
  killPty();
  return { ok: true };
});

// ---- Watching the vault ----
//
// The terminal makes something new possible: the vault changing *while the app is
// running*, from outside the app. Everything the renderer shows is read from disk
// once and rebuilt on demand, so without this a file claude just wrote is invisible
// until the user hits refresh — and the open buffer would be written back over it
// by the next autosave.
//
// It watches, rather than guessing from the terminal's output, because there is no
// "task finished" byte in a pty: claude prints continuously while it works, and a
// statusline keeps printing when it doesn't. A pause is not a signal; a write is.
// This also covers the cases the terminal can't — the pane collapsed, another
// editor, a `git` command in a real terminal.

/** @type {import('fs').FSWatcher | null} */
let vaultWatcher = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let vaultChangeTimer = null;
// A burst of writes (claude editing five files, git checking out a branch) is one
// change as far as the UI is concerned — it rebuilds everything either way.
const VAULT_DEBOUNCE_MS = 400;
// The app's own writes are not news: the autosave already knows what it wrote, and
// a refresh per keystroke-burst would re-read the whole tree for nothing.
const OWN_WRITE_MS = 1500;
/** @type {Map<string, number>} */
const recentWrites = new Map();

function noteOwnWrite(target) {
  const now = Date.now();
  recentWrites.set(target, now);
  if (recentWrites.size > 200) {
    for (const [p, t] of recentWrites) if (now - t > OWN_WRITE_MS) recentWrites.delete(p);
  }
}

function stopVaultWatch() {
  if (vaultChangeTimer) clearTimeout(vaultChangeTimer);
  vaultChangeTimer = null;
  if (!vaultWatcher) return;
  try {
    vaultWatcher.close();
  } catch {}
  vaultWatcher = null;
}

function onVaultEvent(root, filename) {
  // macOS can report an event with no name; there is nothing to filter it by, so
  // treat it as noise rather than refreshing on it.
  if (!filename) return;
  const rel = String(filename);
  // The same isIgnored() the tree uses, per path segment: without this every commit
  // would fire dozens of times over .git, and none of it is anything the UI shows.
  if (rel.split(path.sep).some(isIgnored)) return;
  const written = recentWrites.get(path.join(root, rel));
  if (written !== undefined && Date.now() - written < OWN_WRITE_MS) return;
  if (vaultChangeTimer) clearTimeout(vaultChangeTimer);
  vaultChangeTimer = setTimeout(() => {
    vaultChangeTimer = null;
    sendToWindow('vault-changed');
  }, VAULT_DEBOUNCE_MS);
}

// Watch the open vault, replacing any previous watch. Called on every vault open,
// so there is exactly one watcher and it always points at what is on screen.
handle('watch-vault', async (baseFolder) => {
  stopVaultWatch();
  if (typeof baseFolder !== 'string' || !fs.existsSync(baseFolder)) {
    return { ok: false, error: 'No folder is open.' };
  }
  try {
    vaultWatcher = fs.watch(baseFolder, { recursive: true }, (_type, filename) =>
      onVaultEvent(baseFolder, filename)
    );
  } catch (err) {
    // A vault on a filesystem that can't be watched still works; it just doesn't
    // refresh itself, which is what the app did before this existed.
    return { ok: false, error: String(err) };
  }
  // The watcher must never take the app down: a vanished folder or an exhausted
  // handle limit arrives here as an error event, not a throw at the call site.
  vaultWatcher.on('error', () => stopVaultWatch());
  return { ok: true };
});

// ---- Git ----
//
// The vault is *often* a git repository, but never has to be: every handler here
// answers `{ ok: true, repo: false }` for a plain folder instead of failing, and
// the UI hides itself entirely in that case. Git is only ever driven through the
// porcelain-stable plumbing below — never by shelling out to a shell.

const GIT_TIMEOUT_MS = 120000;

// Same bare-PATH problem as `claude` (see claudeEnv): a bundled .app launched from
// Finder inherits /usr/bin:/bin:/usr/sbin:/sbin, which has git on macOS but not
// necessarily a user-installed one. Git must also never block on an interactive
// credential prompt — there is no terminal to answer it and the app would hang —
// so prompting is disabled and a fetch/push needing a password fails fast.
function gitEnv() {
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...claudeEnv(),
    GIT_TERMINAL_PROMPT: '0',
    // Keep read-only calls (status runs on every tree refresh) from taking the
    // index lock and fighting a git command the user is running in a terminal.
    GIT_OPTIONAL_LOCKS: '0',
  };
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  return env;
}

// Run one git command. Never rejects: the caller always gets {ok, code, stdout, stderr}.
function runGit(cwd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, { cwd, env: gitEnv() });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String(err), missing: true });
      return;
    }

    const out = [];
    const err = [];
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish({ ok: false, code: -1, stdout: '', stderr: 'git timed out.', timedOut: true });
    }, opts.timeout || GIT_TIMEOUT_MS);

    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      finish({
        ok: false,
        code: -1,
        stdout: '',
        stderr: e.code === 'ENOENT' ? 'git was not found on your PATH.' : String(e),
        missing: e.code === 'ENOENT',
      });
    });
    child.on('close', (code) => {
      const buffer = Buffer.concat(out);
      finish({
        ok: code === 0,
        code,
        buffer,
        stdout: buffer.toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

// The repository the vault lives in, or null. The vault may be the repo root or a
// folder somewhere inside it, so every path below is translated through this.
async function gitRoot(baseFolder) {
  if (!baseFolder || !fs.existsSync(baseFolder)) return null;
  const res = await runGit(baseFolder, ['rev-parse', '--show-toplevel']);
  if (!res.ok) return null;
  const root = res.stdout.trim();
  return root ? path.resolve(root) : null;
}

// Repo-root-relative, forward-slashed — the form every git pathspec/rev wants.
function toRepoRel(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

// Boil the two-letter status code down to the single thing worth showing.
// Order matters: a conflict outranks a deletion outranks everything else.
function statusKind(index, work) {
  const code = index + work;
  if (code === '??') return 'untracked';
  if (index === 'U' || work === 'U' || code === 'AA' || code === 'DD') return 'conflict';
  if (index === 'D' || work === 'D') return 'deleted';
  if (index === 'R' || work === 'R') return 'renamed';
  if (index === 'A') return 'added';
  return 'modified';
}

// Parse `git status --porcelain=v1 -z -b`. Records are NUL-terminated, so a path
// containing a newline or a quote survives intact (the non-`-z` format would
// C-quote it). A rename/copy entry is followed by one extra field: its old path.
function parseStatus(raw) {
  const parts = raw.split('\0');
  const files = [];
  let branch = null;
  let upstream = null;
  let ahead = 0;
  let behind = 0;
  let detached = false;
  let noCommits = false;

  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;

    if (rec.startsWith('## ')) {
      let head = rec.slice(3).trim();
      // "[ahead 1, behind 2]" — only present with an upstream that has diverged.
      const track = head.match(/\s\[([^\]]+)\]$/);
      if (track) {
        const a = track[1].match(/ahead (\d+)/);
        const b = track[1].match(/behind (\d+)/);
        if (a) ahead = Number(a[1]);
        if (b) behind = Number(b[1]);
        head = head.slice(0, track.index);
      }
      const dots = head.indexOf('...');
      if (dots !== -1) {
        upstream = head.slice(dots + 3).trim();
        head = head.slice(0, dots);
      }
      head = head.trim();
      if (head.startsWith('No commits yet on ')) {
        noCommits = true;
        head = head.slice('No commits yet on '.length).trim();
      }
      if (head === 'HEAD (no branch)') {
        detached = true;
        head = 'HEAD';
      }
      branch = head;
      continue;
    }

    if (rec.length < 3) continue;
    const index = rec[0];
    const work = rec[1];
    const repoRel = rec.slice(3);
    let from = null;
    if (index === 'R' || index === 'C' || work === 'R' || work === 'C') {
      from = parts[++i] || null; // the entry's old path, its own NUL-terminated field
    }
    files.push({ index, work, repoRel, from, kind: statusKind(index, work) });
  }

  return { branch, upstream, ahead, behind, detached, noCommits, files };
}

// Everything the UI needs to decorate the tree and label the git bar. Answers for a
// non-repository too, so the renderer can treat "not a repo" as an ordinary state.
handle('git-info', async (baseFolder) => {
  if (!baseFolder || !fs.existsSync(baseFolder)) return { ok: true, repo: false };
  const root = await gitRoot(baseFolder);
  if (!root) return { ok: true, repo: false };

  // Scoped to the vault: if it's a subfolder of a bigger repo, the tree only
  // knows about its own files and Wisp only ever commits its own files.
  const res = await runGit(root, [
    'status', '--porcelain=v1', '-z', '-b', '--untracked-files=all', '--', baseFolder,
  ]);
  if (!res.ok) return { ok: false, repo: true, error: res.stderr.trim() || 'git status failed.' };

  const parsed = parseStatus(res.stdout);
  const files = parsed.files.map((f) => {
    const abs = path.resolve(root, f.repoRel);
    return {
      ...f,
      path: abs,
      rel: isInside(baseFolder, abs) ? toRepoRel(baseFolder, abs) : f.repoRel,
    };
  });

  return {
    ok: true,
    repo: true,
    root,
    isRoot: path.resolve(root) === path.resolve(baseFolder),
    branch: parsed.branch,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    detached: parsed.detached,
    noCommits: parsed.noCommits,
    files,
  };
});

// Fetch + merge. --ff-only would be safer but leaves a diverged vault stuck with no
// way forward from the UI, so an ordinary merge is used and a conflict is reported
// as-is — the tree then shows the conflicted files and the user resolves them.
handle('git-pull', async (baseFolder) => {
  const root = await gitRoot(baseFolder);
  if (!root) return { ok: false, error: 'Not a git repository.' };

  const upstream = await runGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!upstream.ok) {
    return { ok: false, error: 'This branch has no upstream to pull from.' };
  }

  // Since git 2.27 a bare `git pull` *refuses* to run once the branches have
  // actually diverged ("fatal: Need to specify how to reconcile divergent
  // branches") unless pull.rebase is configured. A vault edited on two machines
  // hits that constantly, so state the strategy — but only when the user hasn't,
  // so an explicit pull.rebase preference is still honoured.
  const branch = (await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  const prefs = [
    await runGit(root, ['config', '--get', 'pull.rebase']),
    await runGit(root, ['config', '--get', `branch.${branch}.rebase`]),
  ];
  const args = ['pull'];
  if (!prefs.some((p) => p.ok && p.stdout.trim())) args.push('--no-rebase');

  const res = await runGit(root, args);
  const output = [res.stdout.trim(), res.stderr.trim()].filter(Boolean).join('\n');
  if (!res.ok) {
    // A merge that stopped on a conflict is a normal, recoverable state — the
    // files are now marked in the tree and the user resolves them — not the same
    // thing as a pull that could not start at all.
    const conflict = /CONFLICT|Automatic merge failed|fix conflicts/i.test(output);
    return {
      ok: false,
      conflict,
      error: output || `git pull exited with code ${res.code}`,
    };
  }
  return { ok: true, output: output || 'Already up to date.' };
});

// Stage everything under the vault, commit, and optionally push. Returns as soon as
// a step fails, naming the step, so the UI can say what actually happened — a commit
// that lands but fails to push must not read as "nothing happened".
handle('git-commit', async (baseFolder, message, push) => {
  const root = await gitRoot(baseFolder);
  if (!root) return { ok: false, error: 'Not a git repository.' };
  if (typeof message !== 'string' || !message.trim()) {
    return { ok: false, error: 'A commit message is required.' };
  }

  const add = await runGit(root, ['add', '-A', '--', baseFolder]);
  if (!add.ok) {
    return { ok: false, step: 'add', error: add.stderr.trim() || 'git add failed.' };
  }

  // Scoping the commit to a pathspec is what keeps a vault-inside-a-bigger-repo from
  // sweeping up unrelated staged changes — but a partial commit is refused during a
  // merge, so the ordinary whole-index commit is used when the vault *is* the repo.
  // gitRoot() only answers for a real folder, so baseFolder is a string here.
  const vault = /** @type {string} */ (baseFolder);
  const scoped = path.resolve(root) !== path.resolve(vault);
  const commitArgs = ['commit', '-m', message.trim()];
  if (scoped) commitArgs.push('--', vault);
  const commit = await runGit(root, commitArgs);
  if (!commit.ok) {
    const text = [commit.stdout.trim(), commit.stderr.trim()].filter(Boolean).join('\n');
    if (/nothing to commit|no changes added/i.test(text)) {
      return { ok: false, step: 'commit', error: 'Nothing to commit.' };
    }
    return { ok: false, step: 'commit', error: text || 'git commit failed.' };
  }

  if (!push) return { ok: true, committed: true, pushed: false, output: commit.stdout.trim() };

  const pushRes = await gitPush(root);
  if (!pushRes.ok) {
    return { ok: false, step: 'push', committed: true, pushed: false, error: pushRes.error };
  }
  return { ok: true, committed: true, pushed: true, output: pushRes.output };
});

// Push the current branch. A branch with no upstream is published against the only
// remote if there is exactly one; with none or several, we say so rather than guess.
/** @returns {Promise<{ ok: true, output: string } | { ok: false, error: string }>} */
async function gitPush(root) {
  const upstream = await runGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  let args = ['push'];
  if (!upstream.ok) {
    const remotes = (await runGit(root, ['remote']))
      .stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    if (remotes.length === 0) {
      return { ok: false, error: 'No remote is configured, so there is nothing to push to.' };
    }
    if (remotes.length > 1) {
      return { ok: false, error: `This branch has no upstream, and there are several remotes (${remotes.join(', ')}). Set one with \`git push -u\`.` };
    }
    const branch = (await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    if (!branch || branch === 'HEAD') {
      return { ok: false, error: 'HEAD is detached, so there is no branch to push.' };
    }
    args = ['push', '-u', remotes[0], branch];
  }
  const res = await runGit(root, args);
  const output = [res.stdout.trim(), res.stderr.trim()].filter(Boolean).join('\n');
  if (!res.ok) return { ok: false, error: output || `git push exited with code ${res.code}` };
  return { ok: true, output: output || 'Pushed.' };
}

// Throw local changes away, restoring the given paths from HEAD.
//
// Untracked files are deliberately never touched. They have no committed version to
// go back to, so "discarding" one would mean deleting work git has never seen — an
// unrecoverable delete wearing the name of an undo. The renderer says as much, and
// the ordinary Delete menu item is still there for anyone who does want that.
handle('git-revert', async (baseFolder, targets) => {
  const root = await gitRoot(baseFolder);
  if (!root) return { ok: false, error: 'Not a git repository.' };

  const list = Array.isArray(targets) ? targets : [targets];
  const paths = list.map((target) => vaultPath(baseFolder, target, 'Outside the vault.'));
  if (!paths.length) return { ok: false, error: 'Nothing to discard.' };

  // Re-read status here rather than trusting what the renderer last saw: this
  // destroys work, so it must act on what the repository says right now.
  //
  // Scoped to the whole vault and filtered afterwards, NOT with the target paths
  // as a pathspec: git only detects a rename when both halves are in scope, so
  // asking about just the new path would report a bare add and quietly leave the
  // old path deleted.
  const res = await runGit(root, [
    'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', baseFolder,
  ]);
  if (!res.ok) return { ok: false, error: res.stderr.trim() || 'git status failed.' };

  // A target may be a file or a folder; a deleted file isn't on disk at all, in
  // which case there is nothing under it and an exact match is the only sense.
  const wanted = paths.map((p) => ({
    path: p,
    isDir: fs.existsSync(p) && fs.statSync(p).isDirectory(),
  }));
  const inScope = (abs) =>
    wanted.some((w) => (w.isDir ? isInside(w.path, abs) : path.resolve(abs) === w.path));

  const restore = new Set(); // has a HEAD version to come back to
  const unstage = new Set(); // staged but new — un-add it, leave the file alone
  let skipped = 0;
  for (const entry of parseStatus(res.stdout).files) {
    if (!inScope(path.resolve(root, entry.repoRel))) continue;
    if (entry.kind === 'untracked') {
      skipped++;
      continue;
    }
    const inHead = await runGit(root, ['cat-file', '-e', `HEAD:${entry.repoRel}`]);
    (inHead.ok ? restore : unstage).add(entry.repoRel);
    // A rename's old path is the one HEAD knows; restoring it puts the file back.
    if (entry.from && (await runGit(root, ['cat-file', '-e', `HEAD:${entry.from}`])).ok) {
      restore.add(entry.from);
    }
  }

  if (!restore.size && !unstage.size) return { ok: true, reverted: 0, skipped };

  if (unstage.size) {
    const r = await runGit(root, ['restore', '--staged', '--', ...unstage]);
    if (!r.ok) return { ok: false, error: r.stderr.trim() || 'git restore --staged failed.' };
  }
  if (restore.size) {
    const r = await runGit(root, [
      'restore', '--source=HEAD', '--staged', '--worktree', '--', ...restore,
    ]);
    if (!r.ok) return { ok: false, error: r.stderr.trim() || 'git restore failed.' };
  }
  return { ok: true, reverted: restore.size + unstage.size, skipped };
});

// A file's change against HEAD, in both forms the UI offers: the two texts (for the
// side-by-side visual diff) and git's own unified patch (for the raw view).
handle('git-diff', async (baseFolder, target) => {
  const root = await gitRoot(baseFolder);
  if (!root) return { ok: false, error: 'Not a git repository.' };
  const abs = vaultPath(baseFolder, target, 'Outside the vault.');
  const repoRel = toRepoRel(root, abs);

  // Missing from HEAD means the file is new (untracked or staged-as-added).
  const show = await runGit(root, ['show', `HEAD:${repoRel}`]);
  const headBuf = show.ok ? show.buffer : null;

  /** @type {Buffer | null} */
  let workBuf = null;
  try {
    workBuf = await fsp.readFile(abs);
  } catch {} // absent on disk = deleted

  // Oversized text is treated like binary: the visual diff must not load multi-MB
  // buffers into the LCS path. The raw unified patch still comes from git.
  const tooLarge =
    (headBuf && headBuf.length > MAX_TEXT_BYTES) || (workBuf && workBuf.length > MAX_TEXT_BYTES);
  const binary = isBinaryBuffer(headBuf) || isBinaryBuffer(workBuf) || tooLarge;

  let raw = (await runGit(root, ['diff', 'HEAD', '--', repoRel])).stdout;
  // An untracked file is invisible to `git diff`, so patch it against nothing.
  if (!raw.trim() && headBuf === null && workBuf !== null) {
    raw = (await runGit(root, ['diff', '--no-index', '--', '/dev/null', abs])).stdout;
  }

  return {
    ok: true,
    path: abs,
    rel: toRepoRel(baseFolder, abs),
    binary,
    head: binary || headBuf === null ? null : headBuf.toString('utf8'),
    work: binary || workBuf === null ? null : workBuf.toString('utf8'),
    isNew: headBuf === null,
    isDeleted: workBuf === null,
    raw: raw.trim() ? raw : '',
  };
});

// A NUL byte in the first block is git's own heuristic for "binary" — good enough
// to keep the visual diff from trying to lay out a PNG as lines of text.
function isBinaryBuffer(buf) {
  if (!buf) return false;
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// ---- Images ----

// Resolve a Markdown image reference (relative to the open file) and return it as
// a base64 data URL. The renderer swaps these in after rendering because the
// app's app:// origin + CSP won't load vault-relative image paths directly.
// Only local paths that stay inside the vault (after symlink resolution) are served.
handle('read-image', async (baseFolder, currentFile, src) => {
  if (!baseFolder || !src) return { ok: false };
  const fromDir = currentFile ? path.dirname(currentFile) : baseFolder;
  // Note-relative first, then vault-root-relative — an Obsidian-written ref from a
  // note in a subfolder is `./dir/img.png` and resolves nowhere note-relative. The
  // candidate has to *be* an image for the fallback to be taken, so the second
  // convention can't claim a ref the first one already answered.
  const hit = resolveVaultRef(
    baseFolder,
    fromDir,
    src,
    (abs) => !!IMAGE_MIME[path.extname(abs).toLowerCase()] && fs.existsSync(abs)
  );
  if (!hit) return { ok: false };
  const target = hit.abs;
  try {
    assertInsideVault(baseFolder, target, 'Outside the vault.');
    assertReadableFile(target, MAX_IMAGE_BYTES, 'Image');
  } catch {
    return { ok: false };
  }
  const mime = IMAGE_MIME[path.extname(target).toLowerCase()];
  if (!mime) return { ok: false };
  const buf = await fsp.readFile(target);
  return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
});

// Open an image file picked in the tree. Same idea as `read-image`, but the target
// is an absolute vault path rather than a Markdown reference resolved against the
// open note — the renderer shows the picture instead of the editor showing bytes.
handle('read-image-file', async (baseFolder, filePath) => {
  if (!baseFolder || !filePath) return { ok: false, error: 'No file.' };
  const target = vaultPath(baseFolder, filePath, 'Outside the vault.');
  const mime = IMAGE_MIME[path.extname(target).toLowerCase()];
  if (!mime) return { ok: false, error: 'Unsupported image type.' };
  const st = assertReadableFile(target, MAX_IMAGE_BYTES, 'Image');
  const buf = await fsp.readFile(target);
  return {
    ok: true,
    dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
    size: st.size,
  };
});

// Copy a dropped image file into the vault's `images/` folder (deduping the name)
// and return a Markdown reference relative to the open file so it works both in
// the raw source and the rendered preview, and stays portable if the vault moves.
//
// The source is intentionally outside the vault (OS drag-and-drop). We still:
// refuse non-files / oversized inputs, and write the destination through vaultPath
// so a compromised renderer cannot use this channel to write outside the vault.
handle('import-image', async (baseFolder, currentFile, srcPath, originalName) => {
  if (!baseFolder || !fs.existsSync(baseFolder)) return { ok: false, error: 'No folder open.' };
  if (typeof srcPath !== 'string' || !srcPath || srcPath.includes('\0')) {
    return { ok: false, error: 'Source file not found.' };
  }
  // Resolve the source for the size/type check (follows symlinks — importing a
  // link to a huge file should still hit the cap on the real target).
  let srcReal;
  try {
    srcReal = fs.realpathSync(srcPath);
    assertReadableFile(srcReal, MAX_IMAGE_BYTES, 'Image');
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : 'Source file not found.' };
  }
  const ext = path.extname(originalName || srcPath).toLowerCase();
  if (!IMAGE_MIME[ext]) return { ok: false, error: 'Unsupported image type.' };

  const imagesDir = path.join(baseFolder, 'images');
  // Ensure images/ itself stays inside the vault even if baseFolder is odd.
  assertInsideVault(baseFolder, imagesDir, 'Outside the vault.');
  await fsp.mkdir(imagesDir, { recursive: true });

  // URL-safe base name (avoids escaping headaches in Markdown refs / data-url resolution).
  let base =
    path
      .basename(originalName || srcPath, path.extname(originalName || srcPath))
      .replace(/[^a-zA-Z0-9-_]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'image';
  let name = base + ext;
  let n = 1;
  while (fs.existsSync(path.join(imagesDir, name))) {
    name = `${base}-${n}${ext}`;
    n++;
  }
  const dest = vaultPath(baseFolder, path.join('images', name), 'Outside the vault.');
  await fsp.copyFile(srcReal, dest);

  const fromDir = currentFile ? path.dirname(currentFile) : baseFolder;
  const ref = path.relative(fromDir, dest).split(path.sep).join('/');
  return { ok: true, path: dest, ref };
});

// ---- Smart insert (Claude-powered "file this note") ----

// Gather every (non-ignored) file as { rel, content }. To let Claude decide in a
// single turn (no Read round-trips) we inline the text of small files; larger
// files, or files past a total budget, are listed by name only and can be Read.
const INLINE_FILE_MAX = 16 * 1024; // don't inline a single file bigger than this
const INLINE_TOTAL_MAX = 96 * 1024; // stop inlining once we've included this much
async function gatherFiles(baseFolder) {
  const out = [];
  let budget = INLINE_TOTAL_MAX;
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (isIgnored(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(baseFolder, full);
      /** @type {string | null} */
      let content = null;
      try {
        const stat = await fsp.stat(full);
        if (stat.size <= INLINE_FILE_MAX && budget - stat.size >= 0) {
          content = await fsp.readFile(full, 'utf8');
          budget -= stat.size;
        }
      } catch {}
      out.push({ rel, content });
    }
  }
  await walk(baseFolder);
  return out;
}

// Human-readable local "now", so Claude can resolve relative dates in a note
// ("tomorrow", "next Friday", "in two weeks") into an absolute reminder time.
function describeNow() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const day = now.toLocaleDateString('en-US', { weekday: 'long' });
  return `${stamp} (${day})`;
}

// Build the instruction we hand to the `claude` CLI. It must reply with a single
// JSON object describing where the note goes, the file's full new content, and
// whether the note implies a reminder.
function buildInsertPrompt(files, text, currentRel) {
  let filesSection;
  if (!files.length) {
    filesSection = '(the vault is empty — you will be creating the first file)';
  } else {
    filesSection = files
      .map((f) => {
        if (f.content === null) {
          return `### ${f.rel}\n(large file — read it if you need its contents)`;
        }
        return `### ${f.rel}\n\`\`\`\n${f.content}\n\`\`\``;
      })
      .join('\n\n');
  }
  const openHint = currentRel
    ? `\nThe user currently has this file open: ${currentRel}. Only prefer it if the note genuinely belongs there.\n`
    : '';
  return [
    'You are helping file a short note into a plain-text / Markdown notes vault.',
    'The vault root is your current working directory. Here are the existing files and their contents:',
    '',
    filesSection,
    '',
    'The note the user wants to add:',
    '"""',
    text,
    '"""',
    openHint,
    'Decide the single best destination for this note:',
    '- Choose an existing file if the note clearly belongs with its content, otherwise propose a new file with a sensible .md name.',
    '- Decide exactly where inside the file the note should go and integrate it naturally, matching the existing formatting and heading structure.',
    '- You may lightly adjust wording for fit, but never invent unrelated content or delete existing content.',
    '- Contents above are provided inline; only use Read for files marked as large.',
    '',
    `The current local date and time is ${describeNow()}.`,
    'Then decide whether this note also warrants a reminder:',
    '- Create one only for a genuine time-bound commitment: a deadline, appointment, booking,',
    '  renewal, follow-up, or an explicit "remind me" / "don\'t forget".',
    '- A plain fact, idea or reference needs no reminder — use null in that case.',
    '- "due" must be an absolute LOCAL date-time in "YYYY-MM-DDTHH:mm" form, resolved against',
    '  the current date and time above, and it must be in the future.',
    '- If the note implies a day but no time of day, use 09:00.',
    '- For something recurring, set "repeat" to daily, weekly, monthly or yearly; otherwise "none".',
    '- "title" is a short imperative label (e.g. "Renew passport"), not the whole note.',
    '',
    'Respond with ONLY a JSON object (no prose, no code fence) of exactly this shape:',
    '{"targetFile":"<relative path>","isNew":<true|false>,"reason":"<one short sentence>",' +
      '"newContent":"<the complete new content of the target file>",' +
      '"reminder":{"title":"<short label>","due":"<YYYY-MM-DDTHH:mm>","repeat":"<none|daily|weekly|monthly|yearly>","reason":"<why this needs a reminder>"}}',
    'Set "reminder" to null when no reminder is warranted.',
  ].join('\n');
}

// Validate the reminder Claude proposed. Anything malformed (or in the past) is
// dropped rather than surfaced — a bogus alarm is worse than no alarm.
const REPEATS = new Set(['none', 'daily', 'weekly', 'monthly', 'yearly']);
function sanitizeReminder(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const due = typeof raw.due === 'string' ? raw.due.trim() : '';
  if (!title || !due) return null;
  // "YYYY-MM-DDTHH:mm" with no zone is parsed as local time, which is what we want.
  const when = new Date(due);
  if (Number.isNaN(when.getTime())) return null;
  return {
    title,
    due: when.toISOString(),
    repeat: REPEATS.has(raw.repeat) ? raw.repeat : 'none',
    reason: typeof raw.reason === 'string' ? raw.reason.trim() : '',
  };
}

// A bundled .app launched from Finder/Dock inherits a bare PATH
// (/usr/bin:/bin:/usr/sbin:/sbin) rather than the login shell's, so `claude`
// would be ENOENT even when it works fine from a terminal. Append the usual
// install locations instead of shelling out to the user's shell for its PATH.
function claudeEnv() {
  const home = app.getPath('home');
  const extra = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.npm-global', 'bin'),
  ];
  const current = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const merged = current.concat(extra.filter((p) => !current.includes(p)));
  return { ...process.env, PATH: merged.join(path.delimiter) };
}

// Run the `claude` CLI non-interactively and return its raw stdout.
function runClaude(cwd, prompt) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        'claude',
        ['-p', prompt, '--output-format', 'json', '--allowedTools', 'Read,Glob,Grep'],
        { cwd, env: claudeEnv() }
      );
    } catch (err) {
      resolve({ ok: false, error: String(err) });
      return;
    }

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, error: 'Claude timed out (over 3 minutes).' });
    }, 180000);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        error:
          err.code === 'ENOENT'
            ? 'The `claude` CLI was not found on your PATH.'
            : String(err),
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!stdout) {
        resolve({ ok: false, error: stderr.trim() || `claude exited with code ${code}` });
        return;
      }
      resolve({ ok: true, stdout });
    });
  });
}

// Pull a JSON object out of arbitrary model text (tolerates code fences / stray prose).
function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {}
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {}
  }
  return null;
}

// Ask Claude where a note should go. Returns a plan (target + proposed new content
// + the current content, so the renderer can preview the change) but writes nothing.
handle('smart-check', async (baseFolder, currentFile, text) => {
  if (!baseFolder || !fs.existsSync(baseFolder)) return { ok: false, error: 'No folder open.' };
  if (!text || !text.trim()) return { ok: false, error: 'Nothing to add.' };

  const files = await gatherFiles(baseFolder);
  const currentRel =
    currentFile && isInside(baseFolder, currentFile)
      ? path.relative(baseFolder, currentFile)
      : null;

  const res = await runClaude(baseFolder, buildInsertPrompt(files, text, currentRel));
  if (!res.ok) return res;

  /** @type {any} */
  let envelope = null;
  try {
    envelope = JSON.parse(res.stdout);
  } catch {}
  const modelText =
    envelope && typeof envelope.result === 'string' ? envelope.result : res.stdout;
  const plan = extractJson(modelText);
  if (!plan || !plan.targetFile || typeof plan.newContent !== 'string') {
    return { ok: false, error: 'Could not understand Claude’s response.' };
  }

  let target;
  try {
    target = vaultPath(baseFolder, plan.targetFile, 'Claude chose a path outside the vault.');
  } catch {
    return { ok: false, error: 'Claude chose a path outside the vault.' };
  }
  if (typeof plan.newContent === 'string' && Buffer.byteLength(plan.newContent, 'utf8') > MAX_TEXT_BYTES) {
    return { ok: false, error: `Proposed content is too large (max ${formatBytesLimit(MAX_TEXT_BYTES)}).` };
  }
  const exists = fs.existsSync(target);
  let oldContent = '';
  if (exists) {
    try {
      assertReadableFile(target, MAX_TEXT_BYTES, 'File');
      oldContent = await fsp.readFile(target, 'utf8');
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : 'Could not read target file.' };
    }
  }

  return {
    ok: true,
    plan: {
      targetFile: path.relative(baseFolder, target),
      isNew: !exists,
      reason: typeof plan.reason === 'string' ? plan.reason : '',
      newContent: plan.newContent,
      oldContent,
      reminder: sanitizeReminder(plan.reminder),
    },
  };
});

// ---- Smart lookup (Claude-powered "answer from my notes") ----

// The other direction to smart insert: instead of filing text into the vault, read
// the vault to answer a question. Same inlined-files trick, so the usual question
// is answered in one turn.
function buildLookupPrompt(files, question, currentRel) {
  let filesSection;
  if (!files.length) {
    filesSection = '(the vault is empty)';
  } else {
    filesSection = files
      .map((f) => {
        if (f.content === null) {
          return `### ${f.rel}\n(large file — read it if you need its contents)`;
        }
        return `### ${f.rel}\n\`\`\`\n${f.content}\n\`\`\``;
      })
      .join('\n\n');
  }
  const openHint = currentRel ? `\nThe user currently has this file open: ${currentRel}.\n` : '';
  return [
    'You are answering a question using only a plain-text / Markdown notes vault.',
    'The vault root is your current working directory. Here are the existing files and their contents:',
    '',
    filesSection,
    '',
    'The question:',
    '"""',
    question,
    '"""',
    openHint,
    `The current local date and time is ${describeNow()}.`,
    'Answer it from the notes:',
    '- Use only what the notes actually say. Never fill gaps with outside knowledge or guesses.',
    '- If the notes do not answer the question, say so plainly and leave "sources" empty.',
    '- If they answer it only partly, give what is there and say what is missing.',
    '- Contents above are provided inline; only use Read for files marked as large.',
    '- Keep "answer" to a few sentences of plain prose — no Markdown, no lists, no line breaks.',
    '- List every file you drew on in "sources", most relevant first, with a short note on',
    '  what that file contributed. Cite only files you actually used.',
    '',
    'Respond with ONLY a JSON object (no prose, no code fence) of exactly this shape:',
    '{"answer":"<a few sentences>","sources":[{"file":"<relative path>","detail":"<what this file contributed>"}]}',
  ].join('\n');
}

// Keep only sources that name a real file inside the vault — a made-up citation is
// worse than none, and the renderer turns each one into a click that opens the file.
function sanitizeSources(raw, baseFolder) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const file = typeof item.file === 'string' ? item.file.trim() : '';
    if (!file) continue;
    let target;
    try {
      target = vaultPath(baseFolder, file, 'Outside the vault.');
    } catch {
      continue;
    }
    if (!fs.existsSync(target)) continue;
    const rel = path.relative(baseFolder, target).split(path.sep).join('/');
    if (seen.has(rel)) continue;
    seen.add(rel);
    out.push({
      file: rel,
      detail: typeof item.detail === 'string' ? item.detail.trim() : '',
    });
  }
  return out;
}

// Ask Claude a question about the vault. Read-only: nothing is written.
handle('smart-lookup', async (baseFolder, currentFile, question) => {
  if (!baseFolder || !fs.existsSync(baseFolder)) return { ok: false, error: 'No folder open.' };
  if (!question || !question.trim()) return { ok: false, error: 'Nothing to look up.' };

  const files = await gatherFiles(baseFolder);
  const currentRel =
    currentFile && isInside(baseFolder, currentFile)
      ? path.relative(baseFolder, currentFile)
      : null;

  const res = await runClaude(baseFolder, buildLookupPrompt(files, question, currentRel));
  if (!res.ok) return res;

  /** @type {any} */
  let envelope = null;
  try {
    envelope = JSON.parse(res.stdout);
  } catch {}
  const modelText =
    envelope && typeof envelope.result === 'string' ? envelope.result : res.stdout;
  const parsed = extractJson(modelText);
  if (!parsed || typeof parsed.answer !== 'string' || !parsed.answer.trim()) {
    return { ok: false, error: 'Could not understand Claude’s response.' };
  }

  return {
    ok: true,
    result: {
      question,
      answer: parsed.answer.trim(),
      sources: sanitizeSources(parsed.sources, baseFolder),
    },
  };
});

// ---- Image analysis (Claude-powered alt text + description) ----

function buildImagePrompt(rel) {
  return [
    'Read the image file below and describe what it actually shows.',
    '',
    rel,
    '',
    'It has just been added to a plain-text notes vault (your working directory). The',
    'description is stored in the note next to the image and is what the user will search',
    'later, so be concrete and factual.',
    '- "alt": one short line naming what the image is, under 100 characters, for the',
    '  Markdown alt text (e.g. "a bar chart of Q3 revenue by region").',
    '- "description": a fuller account in plain prose — the kind of image it is, its key',
    '  elements, and any text, numbers or labels visible in it, transcribed accurately.',
    '  A few sentences, at most about 150 words. One paragraph: no lists, no line breaks,',
    '  no Markdown or HTML formatting.',
    '- Describe only what you can actually see. Never guess at anything else.',
    '- Do not open any other file; the image above is all you need.',
    '',
    'Respond with ONLY a JSON object (no prose, no code fence) of exactly this shape:',
    '{"alt":"<one short line>","description":"<a few sentences>"}',
  ].join('\n');
}

// Escape text that will be embedded in the note's HTML <details> block, so a model
// description can only ever be read as text — never as markup the preview renders.
function escapeHtmlText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Keep only a well-formed { alt, description }: both single-line (the block is
// written without blank lines so it stays one HTML block) and length-capped.
function sanitizeAnalysis(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const flatten = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
  // `]` would close the Markdown alt early; brackets add nothing to a description.
  let alt = flatten(raw.alt).replace(/[[\]]/g, '').slice(0, 120).trim();
  let description = escapeHtmlText(flatten(raw.description)).slice(0, 2000).trim();
  if (!alt && !description) return null;
  if (!alt) alt = description.slice(0, 100).trim();
  return { alt, description };
}

// Describe a freshly-imported image with Claude. Returns { alt, description } for
// the renderer to fold into the note; writes nothing itself. `skipped` marks an
// image type Claude can't look at, which is not an error worth reporting.
handle('analyze-image', async (baseFolder, imagePath) => {
  if (!baseFolder || !fs.existsSync(baseFolder)) return { ok: false, error: 'No folder open.' };
  const target = vaultPath(baseFolder, imagePath || '', 'Image is outside the vault.');
  if (!ANALYZABLE_IMAGE.has(path.extname(target).toLowerCase())) {
    return { ok: false, skipped: true, error: 'Claude can’t read this image type.' };
  }
  try {
    assertReadableFile(target, MAX_IMAGE_BYTES, 'Image');
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : 'Image not found.' };
  }

  const rel = path.relative(baseFolder, target).split(path.sep).join('/');
  const res = await runClaude(baseFolder, buildImagePrompt(rel));
  if (!res.ok) return res;

  /** @type {any} */
  let envelope = null;
  try {
    envelope = JSON.parse(res.stdout);
  } catch {}
  const modelText =
    envelope && typeof envelope.result === 'string' ? envelope.result : res.stdout;
  const analysis = sanitizeAnalysis(extractJson(modelText));
  if (!analysis) return { ok: false, error: 'Could not understand Claude’s response.' };
  return { ok: true, ...analysis };
});

// Apply a previously-checked plan: write the new content (creating parent dirs).
handle('smart-apply', async (baseFolder, relPath, content) => {
  const target = vaultPath(baseFolder, relPath);
  assertTextContent(content);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, content, 'utf8');
  return { ok: true, path: target };
});
