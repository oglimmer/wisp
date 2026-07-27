const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');

// ---- Simple config persistence (remembers the last base folder) ----
const configPath = () => path.join(app.getPath('userData'), 'config.json');

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

// Directories we never want to show in the tree.
const IGNORED = new Set(['.git', 'node_modules', '.obsidian', '.DS_Store', REMINDERS_FILE]);

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
    if (IGNORED.has(entry.name)) continue;
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: full,
        type: 'dir',
        children: await buildTree(full),
      });
    } else if (entry.isFile()) {
      nodes.push({ name: entry.name, path: full, type: 'file' });
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 640,
    minHeight: 400,
    title: 'Wisp',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');

  // Stop the taskbar flash we start when a reminder comes due, once the user looks.
  mainWindow.on('focus', () => {
    try {
      mainWindow.flashFrame(false);
    } catch {}
  });
}

// Guard against path-traversal: ensure `target` stays inside `base`.
function isInside(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

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
ipcMain.handle('reveal-path', (_e, baseFolder, target) => {
  if (typeof baseFolder !== 'string' || typeof target !== 'string')
    return { ok: false, error: 'Invalid path.' };
  if (!isInside(baseFolder, target)) return { ok: false, error: 'Outside the vault.' };
  if (!fs.existsSync(target)) return { ok: false, error: 'Not found on disk.' };
  shell.showItemInFolder(target);
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
ipcMain.handle('read-file', async (_e, filePath) => {
  try {
    const content = await fsp.readFile(filePath, 'utf8');
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// Write raw text back to a file.
ipcMain.handle('write-file', async (_e, filePath, content) => {
  try {
    await fsp.writeFile(filePath, content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// Synchronous write for the renderer's beforeunload flush. Blocks the renderer
// briefly, but guarantees the last edit is on disk before the window closes.
ipcMain.on('write-file-sync', (e, filePath, content) => {
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    e.returnValue = { ok: true };
  } catch (err) {
    e.returnValue = { ok: false, error: String(err) };
  }
});

// Create a new file. name may include subfolders (created as needed).
ipcMain.handle('create-file', async (_e, baseFolder, relPath) => {
  try {
    const target = path.resolve(baseFolder, relPath);
    if (!isInside(baseFolder, target)) return { ok: false, error: 'Invalid path' };
    if (fs.existsSync(target)) return { ok: false, error: 'File already exists' };
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, '', 'utf8');
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// Create a new folder.
ipcMain.handle('create-folder', async (_e, baseFolder, relPath) => {
  try {
    const target = path.resolve(baseFolder, relPath);
    if (!isInside(baseFolder, target)) return { ok: false, error: 'Invalid path' };
    if (fs.existsSync(target)) return { ok: false, error: 'Folder already exists' };
    await fsp.mkdir(target, { recursive: true });
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// Delete a file or folder (must live inside the base folder).
ipcMain.handle('delete-path', async (_e, baseFolder, target) => {
  try {
    if (!isInside(baseFolder, target) || path.resolve(target) === path.resolve(baseFolder)) {
      return { ok: false, error: 'Invalid path' };
    }
    await fsp.rm(target, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// Rename / move a file or folder within the base folder.
ipcMain.handle('rename-path', async (_e, baseFolder, oldPath, newName) => {
  try {
    const target = path.join(path.dirname(oldPath), newName);
    if (!isInside(baseFolder, target)) return { ok: false, error: 'Invalid path' };
    if (fs.existsSync(target)) return { ok: false, error: 'Target already exists' };
    await fsp.rename(oldPath, target);
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// ---- Reminders ----

// The whole list is read and written as one JSON document — same philosophy as the
// tree (rebuild, don't mutate). It's small, and keeping it a single plain file means
// the vault stays self-describing with no index to fall out of sync.
ipcMain.handle('read-reminders', async (_e, baseFolder) => {
  try {
    if (!baseFolder || !fs.existsSync(baseFolder)) return { ok: true, reminders: [] };
    const file = path.join(baseFolder, REMINDERS_FILE);
    if (!fs.existsSync(file)) return { ok: true, reminders: [] };
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed && parsed.reminders;
    return { ok: true, reminders: Array.isArray(list) ? list : [] };
  } catch (err) {
    return { ok: false, error: String(err), reminders: [] };
  }
});

ipcMain.handle('write-reminders', async (_e, baseFolder, reminders) => {
  try {
    if (!baseFolder || !fs.existsSync(baseFolder)) return { ok: false, error: 'No folder open.' };
    const file = path.join(baseFolder, REMINDERS_FILE);
    const body = JSON.stringify({ reminders: Array.isArray(reminders) ? reminders : [] }, null, 2);
    await fsp.writeFile(file, body, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
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

// ---- Images ----

// Resolve a Markdown image reference (relative to the open file) and return it as
// a base64 data URL. The renderer swaps these in after rendering because the
// app's file:// origin + CSP won't load vault-relative image paths directly.
// Only local paths that stay inside the vault are served.
ipcMain.handle('read-image', async (_e, baseFolder, currentFile, src) => {
  try {
    if (!baseFolder || !src) return { ok: false };
    let ref = String(src).trim();
    if (/^(https?:|data:|file:)/i.test(ref)) return { ok: false }; // not a local ref
    try {
      ref = decodeURIComponent(ref);
    } catch {}
    const fromDir = currentFile ? path.dirname(currentFile) : baseFolder;
    const target = path.resolve(fromDir, ref);
    if (!isInside(baseFolder, target)) return { ok: false };
    const mime = IMAGE_MIME[path.extname(target).toLowerCase()];
    if (!mime) return { ok: false };
    const buf = await fsp.readFile(target);
    return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
  } catch {
    return { ok: false };
  }
});

// Open an image file picked in the tree. Same idea as `read-image`, but the target
// is an absolute vault path rather than a Markdown reference resolved against the
// open note — the renderer shows the picture instead of the editor showing bytes.
ipcMain.handle('read-image-file', async (_e, baseFolder, filePath) => {
  try {
    if (!baseFolder || !filePath) return { ok: false, error: 'No file.' };
    const target = path.resolve(filePath);
    if (!isInside(baseFolder, target)) return { ok: false, error: 'Outside the vault.' };
    const mime = IMAGE_MIME[path.extname(target).toLowerCase()];
    if (!mime) return { ok: false, error: 'Unsupported image type.' };
    const buf = await fsp.readFile(target);
    return {
      ok: true,
      dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
      size: buf.length,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Copy a dropped image file into the vault's `images/` folder (deduping the name)
// and return a Markdown reference relative to the open file so it works both in
// the raw source and the rendered preview, and stays portable if the vault moves.
ipcMain.handle('import-image', async (_e, baseFolder, currentFile, srcPath, originalName) => {
  try {
    if (!baseFolder || !fs.existsSync(baseFolder)) return { ok: false, error: 'No folder open.' };
    if (!srcPath || !fs.existsSync(srcPath)) return { ok: false, error: 'Source file not found.' };
    const ext = path.extname(originalName || srcPath).toLowerCase();
    if (!IMAGE_MIME[ext]) return { ok: false, error: 'Unsupported image type.' };

    const imagesDir = path.join(baseFolder, 'images');
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
    const dest = path.join(imagesDir, name);
    await fsp.copyFile(srcPath, dest);

    const fromDir = currentFile ? path.dirname(currentFile) : baseFolder;
    const ref = path.relative(fromDir, dest).split(path.sep).join('/');
    return { ok: true, path: dest, ref };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
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
      if (IGNORED.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(baseFolder, full);
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
ipcMain.handle('smart-check', async (_e, baseFolder, currentFile, text) => {
  if (!baseFolder || !fs.existsSync(baseFolder)) return { ok: false, error: 'No folder open.' };
  if (!text || !text.trim()) return { ok: false, error: 'Nothing to add.' };

  const files = await gatherFiles(baseFolder);
  const currentRel =
    currentFile && isInside(baseFolder, currentFile)
      ? path.relative(baseFolder, currentFile)
      : null;

  const res = await runClaude(baseFolder, buildInsertPrompt(files, text, currentRel));
  if (!res.ok) return res;

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

  const target = path.resolve(baseFolder, plan.targetFile);
  if (!isInside(baseFolder, target)) {
    return { ok: false, error: 'Claude chose a path outside the vault.' };
  }
  const exists = fs.existsSync(target);
  let oldContent = '';
  if (exists) {
    try {
      oldContent = await fsp.readFile(target, 'utf8');
    } catch {}
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
    const target = path.resolve(baseFolder, file);
    if (!isInside(baseFolder, target) || !fs.existsSync(target)) continue;
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
ipcMain.handle('smart-lookup', async (_e, baseFolder, currentFile, question) => {
  if (!baseFolder || !fs.existsSync(baseFolder)) return { ok: false, error: 'No folder open.' };
  if (!question || !question.trim()) return { ok: false, error: 'Nothing to look up.' };

  const files = await gatherFiles(baseFolder);
  const currentRel =
    currentFile && isInside(baseFolder, currentFile)
      ? path.relative(baseFolder, currentFile)
      : null;

  const res = await runClaude(baseFolder, buildLookupPrompt(files, question, currentRel));
  if (!res.ok) return res;

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
ipcMain.handle('analyze-image', async (_e, baseFolder, imagePath) => {
  try {
    if (!baseFolder || !fs.existsSync(baseFolder)) return { ok: false, error: 'No folder open.' };
    const target = path.resolve(imagePath || '');
    if (!isInside(baseFolder, target)) return { ok: false, error: 'Image is outside the vault.' };
    if (!fs.existsSync(target)) return { ok: false, error: 'Image not found.' };
    if (!ANALYZABLE_IMAGE.has(path.extname(target).toLowerCase())) {
      return { ok: false, skipped: true, error: 'Claude can’t read this image type.' };
    }

    const rel = path.relative(baseFolder, target).split(path.sep).join('/');
    const res = await runClaude(baseFolder, buildImagePrompt(rel));
    if (!res.ok) return res;

    let envelope = null;
    try {
      envelope = JSON.parse(res.stdout);
    } catch {}
    const modelText =
      envelope && typeof envelope.result === 'string' ? envelope.result : res.stdout;
    const analysis = sanitizeAnalysis(extractJson(modelText));
    if (!analysis) return { ok: false, error: 'Could not understand Claude’s response.' };
    return { ok: true, ...analysis };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// Apply a previously-checked plan: write the new content (creating parent dirs).
ipcMain.handle('smart-apply', async (_e, baseFolder, relPath, content) => {
  try {
    const target = path.resolve(baseFolder, relPath);
    if (!isInside(baseFolder, target)) return { ok: false, error: 'Invalid path' };
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content, 'utf8');
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});
