const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow:    () => ipcRenderer.send('window:close'),

  // File operations
  saveFile: (fileName, base64Data) =>
    ipcRenderer.invoke('file:save', fileName, base64Data),

  // Server management
  getServerStatus: () => ipcRenderer.invoke('server:status'),
  restartServer:   () => ipcRenderer.invoke('server:restart'),

  // Settings
  getSettings:  ()         => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),

  // Auto-launch
  setAutoLaunch:     (enabled) => ipcRenderer.invoke('autolaunch:set', enabled),
  isAutoLaunchEnabled: ()      => ipcRenderer.invoke('autolaunch:get'),

  // Events pushed from main → renderer
  onTrayOpen:    (cb) => ipcRenderer.on('tray:open',    (_e, ...a) => cb(...a)),
  onScanTrigger: (cb) => ipcRenderer.on('tray:scan',    (_e, ...a) => cb(...a)),
  onServerStatus:(cb) => ipcRenderer.on('server:status-changed', (_e, ...a) => cb(...a)),
})
