/**
 * OfficeMesh Desktop — Renderer Entry Point
 * Bootstraps all components and wires them together.
 */

import { initTitlebar } from './components/titlebar.js'
import { initSidebar, renderPeers } from './components/sidebar.js'
import { initChat, openChat } from './components/chat.js'
import { initDropzone } from './components/dropzone.js'
import { initSettings } from './components/settings.js'
import { loadSettings, saveSettings, getDeviceId } from './lib/storage.js'
import { scanNetwork } from './lib/scanner.js'

// ── Global app state ──────────────────────────────────────────────
export const state = {
  peers: {},
  settings: {},
  myDeviceId: null,
  signalingServerUrl: null,
  currentPeer: null,
}

async function init() {
  console.log('[App] Initializing OfficeMesh Desktop')

  // Load persisted state
  state.settings   = await loadSettings()
  state.myDeviceId = await getDeviceId()

  // Boot components
  initTitlebar()
  initSidebar({ onPeerClick: handlePeerClick, onScanClick: handleScan })
  initChat()
  initDropzone()
  initSettings({ onSave: handleSettingsSave })

  // Render any cached peers
  renderPeers(state.peers)

  // Listen for tray events from main process
  window.electronAPI.onTrayOpen(() => {
    // Window is already shown by main process; nothing extra needed
  })
  window.electronAPI.onScanTrigger(() => handleScan())

  console.log('[App] Ready. Device ID:', state.myDeviceId)
}

async function handlePeerClick(peer) {
  if (!peer.online) return
  state.currentPeer = peer
  openChat(peer)
}

async function handleScan() {
  const toast     = document.getElementById('scan-toast')
  const toastFill = document.getElementById('scan-toast-fill')
  const toastText = document.getElementById('scan-toast-text')

  toast.classList.remove('hidden')
  toastFill.style.width = '0%'
  toastText.textContent = 'Scanning network...'

  try {
    const result = await scanNetwork(state.settings.subnet || '192.168.1', {
      onProgress: (scanned, total) => {
        const pct = Math.round((scanned / total) * 100)
        toastFill.style.width = pct + '%'
        toastText.textContent = `Scanning... ${scanned}/${total}`
      }
    })

    state.peers = result.peers
    if (result.signalingServerUrl) {
      state.signalingServerUrl = result.signalingServerUrl
      localStorage.setItem('signalingServerUrl', result.signalingServerUrl)
    }

    renderPeers(state.peers)
    toastText.textContent = `Found ${result.foundCount} peer(s)`
    setTimeout(() => toast.classList.add('hidden'), 2500)
  } catch (err) {
    console.error('[App] Scan error:', err)
    toastText.textContent = 'Scan failed'
    setTimeout(() => toast.classList.add('hidden'), 2000)
  }
}

async function handleSettingsSave(newSettings) {
  state.settings = { ...state.settings, ...newSettings }
  await saveSettings(state.settings)
}

document.addEventListener('DOMContentLoaded', init)
