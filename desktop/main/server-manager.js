/**
 * Python signaling server manager.
 * Spawns server.py on app start, kills it on quit.
 */

const { app, ipcMain } = require('electron')
const { spawn }        = require('child_process')
const path             = require('path')
const fs               = require('fs')

let serverProcess = null
let lastError     = null

function getServerPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'server', 'server.py')
  }
  // Dev: go up from desktop/main/ to repo root, then into server/
  return path.join(__dirname, '..', '..', 'server', 'server.py')
}

function getPython() {
  // On Windows 'python' is standard; on Mac/Linux prefer 'python3'
  return process.platform === 'win32' ? 'python' : 'python3'
}

function startServer() {
  if (serverProcess) return

  const serverPath = getServerPath()

  if (!fs.existsSync(serverPath)) {
    lastError = `server.py not found at: ${serverPath}`
    console.warn('[ServerManager]', lastError)
    return
  }

  const logPath   = path.join(app.getPath('userData'), 'server.log')
  const logStream = fs.createWriteStream(logPath, { flags: 'a' })
  const timestamp = new Date().toISOString()
  logStream.write(`\n--- Server start ${timestamp} ---\n`)

  console.log('[ServerManager] Starting Python server:', serverPath)
  lastError = null

  serverProcess = spawn(getPython(), [serverPath], {
    cwd: path.dirname(serverPath),
  })

  serverProcess.stdout.on('data', d => {
    process.stdout.write('[server] ' + d)
    logStream.write(d)
  })
  serverProcess.stderr.on('data', d => {
    const msg = d.toString()
    process.stderr.write('[server] ' + msg)
    logStream.write(msg)
    // Detect missing dependency errors
    if (msg.includes('ModuleNotFoundError') || msg.includes('No module named')) {
      lastError = 'Python dependencies missing. Run: pip install aiohttp python-socketio'
      console.error('[ServerManager]', lastError)
    }
  })

  serverProcess.on('exit', code => {
    console.log('[ServerManager] Server exited, code:', code)
    if (code !== 0 && !lastError) {
      lastError = `Server exited with code ${code}. Check userData/server.log`
    }
    serverProcess = null
  })

  serverProcess.on('error', err => {
    lastError = `Failed to start Python: ${err.message}`
    console.error('[ServerManager]', lastError)
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
    error:   lastError,
  }
}

function initServerIPC() {
  ipcMain.handle('server:status', () => getStatus())

  ipcMain.handle('server:restart', () => {
    stopServer()
    lastError = null
    setTimeout(startServer, 600)
    return { success: true }
  })
}

module.exports = { startServer, stopServer, getStatus, initServerIPC }
