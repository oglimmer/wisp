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

// Directories we never want to show in the tree.
const IGNORED = new Set(['.git', 'node_modules', '.obsidian', '.DS_Store']);

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

// Build the instruction we hand to the `claude` CLI. It must reply with a single
// JSON object describing where the note goes and the file's full new content.
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
    'Respond with ONLY a JSON object (no prose, no code fence) of exactly this shape:',
    '{"targetFile":"<relative path>","isNew":<true|false>,"reason":"<one short sentence>","newContent":"<the complete new content of the target file>"}',
  ].join('\n');
}

// Run the `claude` CLI non-interactively and return its raw stdout.
function runClaude(cwd, prompt) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        'claude',
        ['-p', prompt, '--output-format', 'json', '--allowedTools', 'Read,Glob,Grep'],
        { cwd }
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
    },
  };
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
