const { app, BrowserWindow, shell, session, ipcMain, powerSaveBlocker, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');

let mainWindow;
let powerSaveBlockerId = null;

// ── Migrate user data from old app name ─────────────────────────────────────
const oldDataDir = path.join(path.dirname(app.getPath('userData')), 'pdf-to-markdown-batch');
const newDataDir = app.getPath('userData');
if (oldDataDir !== newDataDir && fs.existsSync(oldDataDir) && !fs.existsSync(path.join(newDataDir, '.migrated'))) {
  const entries = fs.readdirSync(oldDataDir);
  for (const entry of entries) {
    const src = path.join(oldDataDir, entry);
    const dest = path.join(newDataDir, entry);
    if (!fs.existsSync(dest)) {
      fs.cpSync(src, dest, { recursive: true });
    }
  }
  fs.writeFileSync(path.join(newDataDir, '.migrated'), 'migrated from pdf-to-markdown-batch');
  console.log(`[migration] Migrated user data from ${oldDataDir}`);
}

// ── Persistence paths ────────────────────────────────────────────────────────
const userDataPath = app.getPath('userData');
const historyPath = path.join(userDataPath, 'history.json');
const queuePath = path.join(userDataPath, 'queue.json');
const progressDir = path.join(userDataPath, 'progress');
const markdownDir = path.join(userDataPath, 'markdown');
const logPath = path.join(userDataPath, 'log.json');

fs.mkdirSync(progressDir, { recursive: true });
fs.mkdirSync(markdownDir, { recursive: true });

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
    title: 'PDF Transcriber',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
    autoHideMenuBar: true,
  });

  // Load built files in production/preview, or dev server during development
  const distIndex = path.join(__dirname, '..', 'dist', 'index.html');
  if (app.isPackaged) {
    mainWindow.loadFile(distIndex);
  } else {
    // Check if the Vite dev server is running
    const devUrl = process.env.VITE_DEV_URL || 'http://localhost:3001';
    const http = require('http');
    const url = new URL(devUrl);
    const req = http.request({ hostname: url.hostname, port: url.port, path: '/', method: 'HEAD', timeout: 1000 }, () => {
      mainWindow.loadURL(devUrl);
    });
    req.on('error', () => {
      // Dev server not running — use built files (electron:preview mode)
      mainWindow.loadFile(distIndex);
    });
    req.on('timeout', () => {
      req.destroy();
      mainWindow.loadFile(distIndex);
    });
    req.end();
  }

  // Inject referer/origin for API requests (Electron's file:// sends no referer,
  // which gets blocked by API key website restrictions)
  mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: [
      'https://*.googleapis.com/*',
      'https://api.anthropic.com/*',
      'https://openrouter.ai/*',
    ]},
    (details, callback) => {
      details.requestHeaders['Referer'] = 'http://localhost:3001/';
      // Anthropic requires Origin for browser access
      if (details.url.includes('api.anthropic.com')) {
        details.requestHeaders['Origin'] = 'http://localhost:3001';
      }
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

/** If `unique` is true, append (1), (2), etc. to avoid overwriting an existing file. */
async function ensureUniquePath(filePath) {
  try {
    await fs.promises.access(filePath);
  } catch {
    return filePath; // doesn't exist — use as-is
  }
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  for (let i = 1; ; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    try {
      await fs.promises.access(candidate);
    } catch {
      return candidate;
    }
  }
}

ipcMain.handle('save-markdown', async (_event, sourcePdfPath, content, unique) => {
  const dir = path.dirname(sourcePdfPath);
  const baseName = path.basename(sourcePdfPath, path.extname(sourcePdfPath));
  let mdPath = path.join(dir, baseName + '.md');
  if (unique) mdPath = await ensureUniquePath(mdPath);
  await fs.promises.writeFile(mdPath, content, 'utf-8');
  return mdPath;
});

ipcMain.handle('show-in-folder', async (_event, filePath) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle('save-file', async (_event, sourcePdfPath, data, extension, unique) => {
  const dir = path.dirname(sourcePdfPath);
  const baseName = path.basename(sourcePdfPath, path.extname(sourcePdfPath));
  let filePath = path.join(dir, baseName + '.' + extension);
  if (unique) filePath = await ensureUniquePath(filePath);
  const content = typeof data === 'string' ? data : Buffer.from(data);
  await fs.promises.writeFile(filePath, content);
  return filePath;
});

ipcMain.handle('save-internal-markdown', async (_event, jobId, content) => {
  const filePath = path.join(markdownDir, jobId + '.md');
  await fs.promises.writeFile(filePath, content, 'utf-8');
  return filePath;
});

ipcMain.handle('load-internal-markdown', async (_event, jobId) => {
  const filePath = path.join(markdownDir, jobId + '.md');
  try {
    return await fs.promises.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
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

ipcMain.handle('persistence:save-log', async (_event, entries) => {
  // Cap at 500 entries, keep newest
  const capped = entries.length > 500 ? entries.slice(-500) : entries;
  await atomicWriteJson(logPath, capped);
});

ipcMain.handle('persistence:load-log', async () => {
  return readJson(logPath, []);
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

// Open a native file picker for the user to choose a markdown file to view.
// Returns the selected path + content, or null if the user cancels.
ipcMain.handle('open-markdown-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open markdown file',
    properties: ['openFile'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkdn', 'txt'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return { filePath, content };
  } catch (err) {
    return { filePath, content: null, error: err.message };
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
// format: 'standard' (default) or 'logos' (Logos/Verbum Personal Books)
ipcMain.handle('convert-markdown-to-docx', async (_event, markdown, format) => {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'docxWorker.cjs'), {
      workerData: { markdown, format: format || 'standard' },
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

// ── Power save blocker ──────────────────────────────────────────────────────
// Prevents the OS from sleeping or reducing CPU while conversions are running.
// The renderer calls these when processing starts/stops.

ipcMain.handle('power:start-blocking', (_event, preventSleep) => {
  if (powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
    return powerSaveBlockerId;
  }
  const type = preventSleep ? 'prevent-display-sleep' : 'prevent-app-suspension';
  powerSaveBlockerId = powerSaveBlocker.start(type);
  console.log(`[power] Started power save blocker: ${type} (id: ${powerSaveBlockerId})`);
  return powerSaveBlockerId;
});

ipcMain.handle('power:stop-blocking', () => {
  if (powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
    powerSaveBlocker.stop(powerSaveBlockerId);
    console.log(`[power] Stopped power save blocker (id: ${powerSaveBlockerId})`);
    powerSaveBlockerId = null;
  }
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
