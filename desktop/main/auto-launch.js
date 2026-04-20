/**
 * Windows auto-launch via registry.
 * Writes/removes HKCU run key so the app starts with Windows.
 */

const { app, ipcMain } = require('electron')
const { execSync }     = require('child_process')

const APP_NAME = 'OfficeMesh'
const REG_KEY  = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

function setAutoLaunch(enabled) {
  if (process.platform !== 'win32') return { success: true }
  const exePath = process.execPath.replace(/\\/g, '\\\\')
  try {
    if (enabled) {
      execSync(`reg add "${REG_KEY}" /v "${APP_NAME}" /t REG_SZ /d "${exePath}" /f`)
    } else {
      execSync(`reg delete "${REG_KEY}" /v "${APP_NAME}" /f`, { stdio: 'ignore' })
    }
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function isAutoLaunchEnabled() {
  if (process.platform !== 'win32') return false
  try {
    const out = execSync(`reg query "${REG_KEY}" /v "${APP_NAME}"`, { encoding: 'utf8' })
    return out.includes(APP_NAME)
  } catch {
    return false
  }
}

function initAutoLaunchIPC() {
  ipcMain.handle('autolaunch:set', (_e, enabled) => setAutoLaunch(enabled))
  ipcMain.handle('autolaunch:get', ()             => isAutoLaunchEnabled())
}

module.exports = { setAutoLaunch, isAutoLaunchEnabled, initAutoLaunchIPC }
