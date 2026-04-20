/**
 * Settings persistence — stores to userData/settings.json via IPC.
 */

const { app, ipcMain } = require('electron')
const path = require('path')
const fs   = require('fs')

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function readSettings() {
  try {
    const raw = fs.readFileSync(getSettingsPath(), 'utf8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function writeSettings(settings) {
  fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2), 'utf8')
}

function initSettingsIPC() {
  ipcMain.handle('settings:get',  ()        => readSettings())
  ipcMain.handle('settings:save', (_e, s)   => { writeSettings(s); return { success: true } })
}

module.exports = { readSettings, writeSettings, initSettingsIPC }
