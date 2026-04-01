const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getFilePath: (file) => webUtils.getPathForFile(file),
  saveMarkdown: (sourcePdfPath, content) =>
    ipcRenderer.invoke('save-markdown', sourcePdfPath, content),
  showInFolder: (filePath) =>
    ipcRenderer.invoke('show-in-folder', filePath),

  // Persistence
  saveQueue: (entries) => ipcRenderer.invoke('persistence:save-queue', entries),
  loadQueue: () => ipcRenderer.invoke('persistence:load-queue'),
  saveProgress: (progress) => ipcRenderer.invoke('persistence:save-progress', progress),
  loadProgress: (jobId) => ipcRenderer.invoke('persistence:load-progress', jobId),
  deleteProgress: (jobId) => ipcRenderer.invoke('persistence:delete-progress', jobId),
  saveHistory: (entries) => ipcRenderer.invoke('persistence:save-history', entries),
  loadHistory: () => ipcRenderer.invoke('persistence:load-history'),
  readMarkdown: (mdPath) => ipcRenderer.invoke('persistence:read-markdown', mdPath),
  readPdf: (pdfPath) => ipcRenderer.invoke('persistence:read-pdf', pdfPath),
  fileExists: (filePath) => ipcRenderer.invoke('persistence:file-exists', filePath),

  // DOCX conversion (runs in main process with native footnotes)
  convertMarkdownToDocx: (markdown) => ipcRenderer.invoke('convert-markdown-to-docx', markdown),

  // Find in page
  findInPage: (text, options) => ipcRenderer.invoke('find-in-page', text, options),
  findInPageStop: (action) => ipcRenderer.invoke('find-in-page-stop', action),
  onFindInPageResult: (callback) => {
    const handler = (_event, result) => callback(result);
    ipcRenderer.on('find-in-page-result', handler);
    return () => ipcRenderer.removeListener('find-in-page-result', handler);
  },
});
