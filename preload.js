const { contextBridge, ipcRenderer } = require('electron');

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
});
