import { BrowserWindow, Menu, ipcMain, dialog, shell, screen } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { APP_ORIGIN } from './protocol.mjs';
import { loadConfig, saveConfig } from './config.mjs';
import { handle } from './ipc.mjs';
import { vaultPath } from './guards.mjs';

// One window is the design: the pty session, the vault watch and the reminder
// alert all belong to it, and every main → renderer push goes to it.
let mainWindow;

// This module's directory; the repo root (and preload.js) is one level up, in
// and out of app.asar alike.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

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
  /** @type {import('./config.mjs').WindowState} */
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

// What runs when the window closes, supplied by the entry: the terminal's claude
// belongs to this window, so it is killed here — injected rather than imported,
// because the terminal module in turn needs sendToWindow() from this one.
export function createWindow(cleanupOnClose) {
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
      preload: path.join(MODULE_DIR, '..', 'preload.js'),
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
    // Without this the terminal's claude survives as an orphan process holding a
    // pty nobody can see or answer.
    cleanupOnClose();
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
export function buildMenu() {
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

export function sendToWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---- Window- and shell-level IPC ----

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
