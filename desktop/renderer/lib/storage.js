/**
 * Storage helpers — replaces chrome.storage with localStorage + IPC.
 */

const SETTINGS_KEY = 'officemesh_settings'
const PEERS_KEY    = 'officemesh_peers'
const DEVICE_KEY   = 'officemesh_device_id'

export async function loadSettings() {
  try {
    // Try IPC first (main process persists to userData JSON)
    const s = await window.electronAPI.getSettings()
    if (s && Object.keys(s).length > 0) return s
  } catch { /* fall through */ }

  // Fallback to localStorage
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }

  return { displayName: '', subnet: '192.168.1', autoScanInterval: 30 }
}

export async function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  try {
    await window.electronAPI.saveSettings(settings)
  } catch { /* ignore if IPC unavailable */ }
}

export function loadPeers() {
  try {
    const raw = localStorage.getItem(PEERS_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

export function savePeers(peers) {
  localStorage.setItem(PEERS_KEY, JSON.stringify(peers))
}

export async function getDeviceId() {
  let id = localStorage.getItem(DEVICE_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(DEVICE_KEY, id)
  }
  return id
}
