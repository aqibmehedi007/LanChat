/**
 * Python signaling server manager.
 * Spawns server.py on app start, kills it on quit.
 */

const { app, ipcMain } = require('electron')
const { spawn }        = require('child_process')
const path             = require('path')
const fs               = require('fs')

let serverProcess = null

function getServerPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'server', 'server.py')
  }
  return path.join(__dirname, '..', '..', 'server', 'server.py')
}

function getPython() {
  return process.platform === 'win32' ? 'python' : 'python3'
}

function startServer() {
  if (serverProcess) return

  const serverPath = getServerPath()

  if (!fs.existsSync(serverPath)) {
    console.warn('[ServerManager] server.py not found at:', serverPath)
    return
  }

  const logPath   = path.join(app.getPath('userData'), 'server.log')
  const logStream = fs.createWriteStream(logPath, { flags: 'a' })

  console.log('[ServerManager] Starting Python server:', serverPath)

  serverProcess = spawn(getPython(), [serverPath], {
    cwd: path.dirname(serverPath),
  })

  serverProcess.stdout.pipe(logStream)
  serverProcess.stderr.pipe(logStream)

  serverProcess.on('exit', code => {
    console.log('[ServerManager] Server exited, code:', code)
    serverProcess = null
  })

  serverProcess.on('error', err => {
    console.error('[ServerManager] Failed to start:', err.message)
    serverProcess = null
  })
}

function stopServer() {
  if (!serverProcess) return
  console.log('[ServerManager] Stopping server...')
  serverProcess.kill()
  serverProcess = null
}

function getStatus() {
  return {
    running: serverProcess !== null && !serverProcess.killed,
    pid:     serverProcess?.pid ?? null,
  }
}

function initServerIPC() {
  ipcMain.handle('server:status', () => getStatus())

  ipcMain.handle('server:restart', () => {
    stopServer()
    setTimeout(startServer, 500)
    return { success: true }
  })
}

module.exports = { startServer, stopServer, getStatus, initServerIPC }
