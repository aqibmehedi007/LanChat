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

async function isPortInUse(port) {
  // Quick HTTP check — if /info responds, a server is already running
  return new Promise(resolve => {
    const http = require('http')
    const req  = http.get(`http://127.0.0.1:${port}/info`, res => {
      res.resume()
      resolve(true)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(1000, () => { req.destroy(); resolve(false) })
  })
}

async function startServer() {
  if (serverProcess) return

  // If another instance already has the server running, skip
  const alreadyRunning = await isPortInUse(5000)
  if (alreadyRunning) {
    console.log('[ServerManager] Server already running on port 5000, skipping spawn')
    return
  }

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
  const ownProcess = serverProcess !== null && !serverProcess.killed
  return {
    running: ownProcess,
    pid:     serverProcess?.pid ?? null,
    error:   lastError,
    // If we didn't spawn it, check if another instance has it running
    externalRunning: !ownProcess,
  }
}

function initServerIPC() {
  ipcMain.handle('server:status', async () => {
    const status = getStatus()
    // If we don't own the process, check if the server is reachable anyway
    if (!status.running) {
      const reachable = await isPortInUse(5000)
      if (reachable) {
        return { running: true, pid: null, error: null, external: true }
      }
    }
    return status
  })

  ipcMain.handle('server:restart', () => {
    stopServer()
    lastError = null
    setTimeout(startServer, 600)
    return { success: true }
  })
}

module.exports = { startServer, stopServer, getStatus, initServerIPC }
