const { app, BrowserWindow, shell, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

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
}

// IPC: save markdown file next to the source PDF
ipcMain.handle('save-markdown', async (_event, sourcePdfPath, content) => {
  const dir = path.dirname(sourcePdfPath);
  const baseName = path.basename(sourcePdfPath, path.extname(sourcePdfPath));
  const mdPath = path.join(dir, baseName + '.md');
  await fs.promises.writeFile(mdPath, content, 'utf-8');
  return mdPath;
});

// IPC: reveal a file in the system file explorer
ipcMain.handle('show-in-folder', async (_event, filePath) => {
  shell.showItemInFolder(filePath);
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
