const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  saveMarkdown: (sourcePdfPath, content) =>
    ipcRenderer.invoke('save-markdown', sourcePdfPath, content),
  showInFolder: (filePath) =>
    ipcRenderer.invoke('show-in-folder', filePath),
});
