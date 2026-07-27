const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Safe, minimal API exposed to the renderer.
contextBridge.exposeInMainWorld('api', {
  getLastFolder: () => ipcRenderer.invoke('get-last-folder'),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  readTree: (baseFolder) => ipcRenderer.invoke('read-tree', baseFolder),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('write-file', filePath, content),
  // Synchronous write, used only on window close to guarantee the last edit lands.
  writeFileSync: (filePath, content) => ipcRenderer.sendSync('write-file-sync', filePath, content),
  createFile: (baseFolder, relPath) => ipcRenderer.invoke('create-file', baseFolder, relPath),
  createFolder: (baseFolder, relPath) => ipcRenderer.invoke('create-folder', baseFolder, relPath),
  // Smart insert: ask Claude where a note belongs, then apply the result.
  smartCheck: (baseFolder, currentFile, text) =>
    ipcRenderer.invoke('smart-check', baseFolder, currentFile, text),
  smartApply: (baseFolder, relPath, content) =>
    ipcRenderer.invoke('smart-apply', baseFolder, relPath, content),
  deletePath: (baseFolder, target) => ipcRenderer.invoke('delete-path', baseFolder, target),
  renamePath: (baseFolder, oldPath, newName) =>
    ipcRenderer.invoke('rename-path', baseFolder, oldPath, newName),
  // Open a link from the Markdown preview in the default browser.
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  // Show a vault file/folder in the OS file manager. `platform` is only used to
  // label that menu entry the way the host OS calls it.
  revealPath: (baseFolder, target) => ipcRenderer.invoke('reveal-path', baseFolder, target),
  platform: process.platform,
  // Images: resolve a vault-relative ref to a data URL for preview, and import a
  // dropped file into the vault. getPathForFile turns a dropped File into its
  // absolute path (Electron 32 removed File.path; webUtils is the replacement).
  readImage: (baseFolder, currentFile, src) =>
    ipcRenderer.invoke('read-image', baseFolder, currentFile, src),
  importImage: (baseFolder, currentFile, srcPath, originalName) =>
    ipcRenderer.invoke('import-image', baseFolder, currentFile, srcPath, originalName),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  // Reminders: the list is stored as one JSON file in the vault root. alertWindow
  // brings the window forward (and flashes the taskbar) when one comes due.
  readReminders: (baseFolder) => ipcRenderer.invoke('read-reminders', baseFolder),
  writeReminders: (baseFolder, reminders) =>
    ipcRenderer.invoke('write-reminders', baseFolder, reminders),
  alertWindow: () => ipcRenderer.invoke('alert-window'),
});
