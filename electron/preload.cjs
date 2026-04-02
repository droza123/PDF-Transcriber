const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getFilePath: (file) => webUtils.getPathForFile(file),
  saveMarkdown: (sourcePdfPath, content) =>
    ipcRenderer.invoke('save-markdown', sourcePdfPath, content),
  showInFolder: (filePath) =>
    ipcRenderer.invoke('show-in-folder', filePath),
  saveFile: (sourcePdfPath, data, extension) =>
    ipcRenderer.invoke('save-file', sourcePdfPath, data, extension),
  saveInternalMarkdown: (jobId, content) =>
    ipcRenderer.invoke('save-internal-markdown', jobId, content),
  loadInternalMarkdown: (jobId) =>
    ipcRenderer.invoke('load-internal-markdown', jobId),

  // Persistence
  saveQueue: (entries) => ipcRenderer.invoke('persistence:save-queue', entries),
  loadQueue: () => ipcRenderer.invoke('persistence:load-queue'),
  saveProgress: (progress) => ipcRenderer.invoke('persistence:save-progress', progress),
  loadProgress: (jobId) => ipcRenderer.invoke('persistence:load-progress', jobId),
  deleteProgress: (jobId) => ipcRenderer.invoke('persistence:delete-progress', jobId),
  saveHistory: (entries) => ipcRenderer.invoke('persistence:save-history', entries),
  loadHistory: () => ipcRenderer.invoke('persistence:load-history'),
  saveLog: (entries) => ipcRenderer.invoke('persistence:save-log', entries),
  loadLog: () => ipcRenderer.invoke('persistence:load-log'),
  readMarkdown: (mdPath) => ipcRenderer.invoke('persistence:read-markdown', mdPath),
  readPdf: (pdfPath) => ipcRenderer.invoke('persistence:read-pdf', pdfPath),
  fileExists: (filePath) => ipcRenderer.invoke('persistence:file-exists', filePath),

  // DOCX conversion (runs in worker thread with native footnotes)
  // format: 'standard' (default) or 'logos' (Logos/Verbum Personal Books)
  convertMarkdownToDocx: (markdown, format) => ipcRenderer.invoke('convert-markdown-to-docx', markdown, format),

  // Power save blocker (prevents OS suspension during conversion)
  startPowerBlock: () => ipcRenderer.invoke('power:start-blocking'),
  stopPowerBlock: () => ipcRenderer.invoke('power:stop-blocking'),

  // Find in page
  findInPage: (text, options) => ipcRenderer.invoke('find-in-page', text, options),
  findInPageStop: (action) => ipcRenderer.invoke('find-in-page-stop', action),
  onFindInPageResult: (callback) => {
    const handler = (_event, result) => callback(result);
    ipcRenderer.on('find-in-page-result', handler);
    return () => ipcRenderer.removeListener('find-in-page-result', handler);
  },
});
