const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')

const { initTray }          = require('./tray')
const { startServer, stopServer, initServerIPC } = require('./server-manager')
const { initFileHandler }   = require('./file-handler')
const { initSettingsIPC }   = require('./settings-handler')
const { initAutoLaunchIPC } = require('./auto-launch')

let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 700,
    minHeight: 500,
    frame: false,
    backgroundColor: '#1a1d2e',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))

  mainWindow.once('ready-to-show', () => mainWindow.show())

  // Minimize to tray instead of closing
  mainWindow.on('close', e => {
    if (!app.isQuitting) {
      e.preventDefault()
      mainWindow.hide()
    }
  })

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }
}

// Window control IPC
ipcMain.on('window:minimize', () => mainWindow?.minimize())
ipcMain.on('window:maximize', () => {
  mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize()
})
ipcMain.on('window:close', () => mainWindow?.close())

app.whenReady().then(() => {
  // Start Python signaling server
  startServer()

  // Register all IPC handlers
  initFileHandler()
  initServerIPC()
  initSettingsIPC()
  initAutoLaunchIPC()

  createWindow()

  // System tray
  initTray(() => mainWindow)
})

app.on('before-quit', () => {
  app.isQuitting = true
  stopServer()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Don't quit — tray keeps app alive
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
