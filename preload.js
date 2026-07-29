const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Safe, minimal API exposed to the renderer.
//
// Annotated against the shared contract in `types/ipc.d.ts`, which is also what
// `window.api` is declared as — so a method that is missing here, misspelled, or
// wired to the wrong channel is an error at this line rather than an `undefined`
// the renderer trips over at runtime.
/** @type {import('./types/ipc').WispApi} */
const api = {
  getLastFolder: () => ipcRenderer.invoke('get-last-folder'),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  readTree: (baseFolder) => ipcRenderer.invoke('read-tree', baseFolder),
  // baseFolder is passed so main can refuse a path outside the vault — the same
  // guard every other handler that takes a target from the renderer applies.
  readFile: (baseFolder, filePath) => ipcRenderer.invoke('read-file', baseFolder, filePath),
  writeFile: (baseFolder, filePath, content) =>
    ipcRenderer.invoke('write-file', baseFolder, filePath, content),
  // Synchronous write, used only on window close to guarantee the last edit lands.
  writeFileSync: (baseFolder, filePath, content) =>
    ipcRenderer.sendSync('write-file-sync', baseFolder, filePath, content),
  createFile: (baseFolder, relPath) => ipcRenderer.invoke('create-file', baseFolder, relPath),
  createFolder: (baseFolder, relPath) => ipcRenderer.invoke('create-folder', baseFolder, relPath),
  // Smart insert: ask Claude where a note belongs, then apply the result.
  smartCheck: (baseFolder, currentFile, text) =>
    ipcRenderer.invoke('smart-check', baseFolder, currentFile, text),
  smartApply: (baseFolder, relPath, content) =>
    ipcRenderer.invoke('smart-apply', baseFolder, relPath, content),
  // Smart lookup: the other direction — answer a question from the vault.
  smartLookup: (baseFolder, currentFile, question) =>
    ipcRenderer.invoke('smart-lookup', baseFolder, currentFile, question),
  deletePath: (baseFolder, target) => ipcRenderer.invoke('delete-path', baseFolder, target),
  renamePath: (baseFolder, oldPath, newName) =>
    ipcRenderer.invoke('rename-path', baseFolder, oldPath, newName),
  // Tree drag & drop: move an entry into another folder. Both this and renamePath
  // rewrite the vault's Markdown refs so they follow what moved.
  movePath: (baseFolder, target, destDir) =>
    ipcRenderer.invoke('move-path', baseFolder, target, destDir),
  // Open a link from the Markdown preview in the default browser.
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  // Main → renderer: Help ▸ Keyboard Shortcuts was picked. The event itself is
  // never handed over — it carries a handle on the sender.
  onShowShortcuts: (fn) => ipcRenderer.on('show-shortcuts', () => fn()),
  // Show a vault file/folder in the OS file manager. `platform` is only used to
  // label that menu entry the way the host OS calls it.
  revealPath: (baseFolder, target) => ipcRenderer.invoke('reveal-path', baseFolder, target),
  platform: process.platform,
  // Images: resolve a vault-relative ref to a data URL for preview, and import a
  // dropped file into the vault. getPathForFile turns a dropped File into its
  // absolute path (Electron 32 removed File.path; webUtils is the replacement).
  readImage: (baseFolder, currentFile, src) =>
    ipcRenderer.invoke('read-image', baseFolder, currentFile, src),
  // An image opened from the tree, by absolute path, for the viewer pane.
  readImageFile: (baseFolder, filePath) =>
    ipcRenderer.invoke('read-image-file', baseFolder, filePath),
  importImage: (baseFolder, currentFile, srcPath, originalName) =>
    ipcRenderer.invoke('import-image', baseFolder, currentFile, srcPath, originalName),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  // Have Claude describe an imported image: returns { alt, description } for the
  // renderer to fold into the note that references it.
  analyzeImage: (baseFolder, imagePath) =>
    ipcRenderer.invoke('analyze-image', baseFolder, imagePath),
  // Reminders: the list is stored as one JSON file in the vault root. alertWindow
  // brings the window forward (and flashes the taskbar) when one comes due.
  readReminders: (baseFolder) => ipcRenderer.invoke('read-reminders', baseFolder),
  writeReminders: (baseFolder, reminders) =>
    ipcRenderer.invoke('write-reminders', baseFolder, reminders),
  alertWindow: () => ipcRenderer.invoke('alert-window'),
  // Git: the vault may or may not be a repository, so gitInfo answers
  // { repo: false } for a plain folder rather than failing.
  gitInfo: (baseFolder) => ipcRenderer.invoke('git-info', baseFolder),
  gitPull: (baseFolder) => ipcRenderer.invoke('git-pull', baseFolder),
  gitCommit: (baseFolder, message, push) =>
    ipcRenderer.invoke('git-commit', baseFolder, message, push),
  gitDiff: (baseFolder, target) => ipcRenderer.invoke('git-diff', baseFolder, target),
  gitRevert: (baseFolder, targets) => ipcRenderer.invoke('git-revert', baseFolder, targets),
  // The terminal pane: one interactive `claude` in a pty, at the vault root. The
  // renderer supplies a size and keystrokes — never a command to run.
  termStart: (baseFolder, cols, rows) =>
    ipcRenderer.invoke('term-start', baseFolder, cols, rows),
  termInput: (data) => ipcRenderer.invoke('term-input', data),
  termResize: (cols, rows) => ipcRenderer.invoke('term-resize', cols, rows),
  termStop: () => ipcRenderer.invoke('term-stop'),
  // Main → renderer, same shape as onShowShortcuts: the payload crosses, the
  // event (which carries a handle on the sender) does not.
  onTermData: (fn) => ipcRenderer.on('term-data', (_e, data) => fn(data)),
  onTermExit: (fn) => ipcRenderer.on('term-exit', (_e, info) => fn(info)),
  // Watch the vault for changes made outside the app (the terminal's claude, most
  // of all) and re-read what they touched.
  watchVault: (baseFolder) => ipcRenderer.invoke('watch-vault', baseFolder),
  onVaultChanged: (fn) => ipcRenderer.on('vault-changed', () => fn()),
};

contextBridge.exposeInMainWorld('api', api);
