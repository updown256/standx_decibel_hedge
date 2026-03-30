const { app, BrowserWindow } = require('electron');
const { startServer } = require('./dist/server');

let mainWindow = null;
let serverPort = 3847;

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1050,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'StandX × Decibel Hedge Bot',
    backgroundColor: '#1a1a2e',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
    autoHideMenuBar: true,
    show: false,
  });

  mainWindow.loadURL(`http://localhost:${port}`);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    serverPort = await startServer();
    createWindow(serverPort);
  } catch (err) {
    console.error('Server start failed:', err);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow(serverPort);
});
