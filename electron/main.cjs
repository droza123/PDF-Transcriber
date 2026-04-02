const { app, BrowserWindow, shell, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');

let mainWindow;

// ── Persistence paths ────────────────────────────────────────────────────────
const userDataPath = app.getPath('userData');
const historyPath = path.join(userDataPath, 'history.json');
const queuePath = path.join(userDataPath, 'queue.json');
const progressDir = path.join(userDataPath, 'progress');

fs.mkdirSync(progressDir, { recursive: true });

/** Write JSON atomically via temp-file-then-rename. */
async function atomicWriteJson(filePath, data) {
  const tmp = filePath + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await fs.promises.rename(tmp, filePath);
}

/** Read a JSON file, returning fallback on missing/corrupt. */
async function readJson(filePath, fallback) {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// ── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'PDF to Markdown',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
    autoHideMenuBar: true,
  });

  // In production, load the built files
  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  } else {
    // In dev, load from Vite dev server
    const devUrl = process.env.VITE_DEV_URL || 'http://localhost:3001';
    mainWindow.loadURL(devUrl);
  }

  // Inject referer for Google API requests (Electron's file:// sends no referer,
  // which gets blocked by API key website restrictions)
  mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: ['https://*.googleapis.com/*'] },
    (details, callback) => {
      details.requestHeaders['Referer'] = 'http://localhost:3001/';
      callback({ requestHeaders: details.requestHeaders });
    }
  );

  // Open external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Forward find-in-page results to renderer
  mainWindow.webContents.on('found-in-page', (_event, result) => {
    mainWindow.webContents.send('find-in-page-result', result);
  });
}

// ── IPC: file operations ─────────────────────────────────────────────────────

ipcMain.handle('save-markdown', async (_event, sourcePdfPath, content) => {
  const dir = path.dirname(sourcePdfPath);
  const baseName = path.basename(sourcePdfPath, path.extname(sourcePdfPath));
  const mdPath = path.join(dir, baseName + '.md');
  await fs.promises.writeFile(mdPath, content, 'utf-8');
  return mdPath;
});

ipcMain.handle('show-in-folder', async (_event, filePath) => {
  shell.showItemInFolder(filePath);
});

// ── IPC: persistence ─────────────────────────────────────────────────────────

ipcMain.handle('persistence:save-queue', async (_event, entries) => {
  await atomicWriteJson(queuePath, entries);
});

ipcMain.handle('persistence:load-queue', async () => {
  return readJson(queuePath, []);
});

ipcMain.handle('persistence:save-history', async (_event, entries) => {
  await atomicWriteJson(historyPath, entries);
});

ipcMain.handle('persistence:load-history', async () => {
  return readJson(historyPath, []);
});

ipcMain.handle('persistence:save-progress', async (_event, progress) => {
  const filePath = path.join(progressDir, progress.jobId + '.json');
  await atomicWriteJson(filePath, progress);
});

ipcMain.handle('persistence:load-progress', async (_event, jobId) => {
  const filePath = path.join(progressDir, jobId + '.json');
  return readJson(filePath, null);
});

ipcMain.handle('persistence:delete-progress', async (_event, jobId) => {
  const filePath = path.join(progressDir, jobId + '.json');
  try { await fs.promises.unlink(filePath); } catch { /* ignore ENOENT */ }
});

ipcMain.handle('persistence:read-markdown', async (_event, mdPath) => {
  try {
    return await fs.promises.readFile(mdPath, 'utf-8');
  } catch {
    return null;
  }
});

ipcMain.handle('persistence:read-pdf', async (_event, pdfPath) => {
  const buffer = await fs.promises.readFile(pdfPath);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
});

ipcMain.handle('persistence:file-exists', async (_event, filePath) => {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
});

// IPC: convert markdown to DOCX with native footnotes (runs in worker thread)
ipcMain.handle('convert-markdown-to-docx', async (_event, markdown) => {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'docxWorker.cjs'), {
      workerData: { markdown },
    });
    worker.on('message', (msg) => {
      if (msg.error) {
        reject(new Error(msg.error));
      } else {
        resolve(msg.buffer);
      }
    });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`DOCX worker exited with code ${code}`));
    });
  });
});

// IPC: find in page
ipcMain.handle('find-in-page', (_event, text, options) => {
  if (!mainWindow) return;
  return mainWindow.webContents.findInPage(text, options);
});

ipcMain.handle('find-in-page-stop', (_event, action) => {
  if (!mainWindow) return;
  mainWindow.webContents.stopFindInPage(action || 'clearSelection');
});

// ── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
