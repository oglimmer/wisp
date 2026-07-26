const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

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
    title: 'Raw Notes',
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
