/**
 * OfficeMesh Desktop — Renderer Entry Point
 */

import { initTitlebar, setTitlebarStatus } from './components/titlebar.js'
import { initSidebar, renderPeers } from './components/sidebar.js'
import { initChat, openChat } from './components/chat.js'
import { initDropzone } from './components/dropzone.js'
import { initSettings } from './components/settings.js'
import { loadSettings, saveSettings, getDeviceId, loadPeers, savePeers } from './lib/storage.js'
import { scanNetwork } from './lib/scanner.js'

// ── Global app state ──────────────────────────────────────────────
export const state = {
  peers:              {},
  settings:           {},
  myDeviceId:         null,
  signalingServerUrl: null,
  currentPeer:        null,
  presenceSocket:     null,   // kept-alive socket for peer registration
}

// ── Socket.IO — loaded via <script> tag in index.html as window.io ──
function getIO() {
  if (typeof window.io !== 'function') {
    throw new Error('socket.io not loaded — check index.html script tag')
  }
  return window.io
}

// ── Init ──────────────────────────────────────────────────────────
async function init() {
  console.log('[App] Initializing OfficeMesh Desktop')

  state.settings   = await loadSettings()
  state.myDeviceId = await getDeviceId()
  state.peers      = loadPeers()

  initTitlebar()
  initSidebar({ onPeerClick: handlePeerClick, onScanClick: handleScan })
  initChat()
  initDropzone()
  initSettings({ onSave: handleSettingsSave })

  renderPeers(state.peers)

  // Try to connect to a previously found server immediately on startup
  const savedUrl = localStorage.getItem('signalingServerUrl')
  if (savedUrl) {
    state.signalingServerUrl = savedUrl
    connectPresence(savedUrl)
  } else {
    // No saved server — try localhost first (same-machine scenario)
    tryLocalhost()
  }

  window.electronAPI.onTrayOpen(() => {})
  window.electronAPI.onScanTrigger(() => handleScan())

  console.log('[App] Ready. Device ID:', state.myDeviceId)
}

// ── Try localhost server (same-machine testing) ───────────────────
async function tryLocalhost() {
  try {
    const res = await fetch('http://127.0.0.1:5000/info', { signal: AbortSignal.timeout(2000) })
    if (res.ok) {
      const data = await res.json()
      if (data.type === 'officemesh-signaling') {
        const url = 'http://127.0.0.1:5000'
        state.signalingServerUrl = url
        localStorage.setItem('signalingServerUrl', url)
        console.log('[App] Found local server at', url)
        connectPresence(url)
      }
    }
  } catch {
    console.log('[App] No local server found, waiting for scan')
  }
}

// ── Presence socket — registers this instance with the server ─────
export async function connectPresence(serverUrl) {
  if (state.presenceSocket) {
    state.presenceSocket.disconnect()
    state.presenceSocket = null
  }

  console.log('[Presence] Connecting to', serverUrl)
  const io = getIO()

  const socket = io(serverUrl, {
    transports: ['websocket', 'polling'],
    timeout: 5000,
    reconnection: true,
    reconnectionDelay: 2000,
  })

  state.presenceSocket = socket

  socket.on('connect', () => {
    console.log('[Presence] Connected, registering peer...')
    socket.emit('register_peer', {
      deviceId:    state.myDeviceId,
      displayName: state.settings.displayName || 'Anonymous',
      ip:          null,   // server will detect from socket
    })
    setTitlebarStatus('connected', 'Connected')
    // Refresh peer list after registering
    setTimeout(() => refreshPeerList(serverUrl), 800)
  })

  socket.on('connect_error', err => {
    console.warn('[Presence] Connection error:', err.message)
    setTitlebarStatus('disconnected', '')
  })

  socket.on('disconnect', () => {
    console.log('[Presence] Disconnected')
    setTitlebarStatus('disconnected', '')
  })
}

// ── Fetch and render the peer list from the server ────────────────
async function refreshPeerList(serverUrl) {
  try {
    const res  = await fetch(`${serverUrl}/peers`)
    const data = await res.json()
    const serverHost = new URL(serverUrl).hostname

    const fresh = {}
    for (const p of (data.peers || [])) {
      // Never show ourselves in the peer list
      if (p.deviceId === state.myDeviceId) continue
      fresh[p.deviceId] = {
        ...p,
        online:   true,
        serverIp: serverHost,
      }
    }

    // Merge with cached peers (preserve custom names, keep offline ones)
    for (const [id, cached] of Object.entries(state.peers)) {
      if (!fresh[id]) {
        fresh[id] = { ...cached, online: false }
      } else {
        fresh[id].customName = cached.customName
      }
    }

    state.peers = fresh
    savePeers(fresh)
    renderPeers(fresh)
    console.log('[App] Peer list refreshed:', Object.keys(fresh).length, 'peers')
  } catch (err) {
    console.warn('[App] Could not refresh peer list:', err.message)
  }
}

// ── Peer click ────────────────────────────────────────────────────
async function handlePeerClick(peer) {
  if (!peer.online) return
  state.currentPeer = peer
  openChat(peer)
}

// ── Scan ──────────────────────────────────────────────────────────
async function handleScan() {
  const toast     = document.getElementById('scan-toast')
  const toastFill = document.getElementById('scan-toast-fill')
  const toastText = document.getElementById('scan-toast-text')

  toast.classList.remove('hidden')
  toastFill.style.width = '0%'
  toastText.textContent = 'Scanning network...'

  try {
    const subnet = state.settings.subnet || '192.168.1'
    const result = await scanNetwork(subnet, {
      onProgress: (scanned, total) => {
        toastFill.style.width = Math.round((scanned / total) * 100) + '%'
        toastText.textContent = `Scanning... ${scanned}/${total}`
      }
    })

    if (result.signalingServerUrl) {
      state.signalingServerUrl = result.signalingServerUrl
      localStorage.setItem('signalingServerUrl', result.signalingServerUrl)
      // Connect presence socket to the newly found server
      await connectPresence(result.signalingServerUrl)
    }

    // Merge scan results into state
    for (const [id, peer] of Object.entries(result.peers)) {
      state.peers[id] = { ...state.peers[id], ...peer }
    }
    savePeers(state.peers)
    renderPeers(state.peers)

    const msg = result.serversFound > 0
      ? `Found ${result.foundCount} peer(s) via ${result.serversFound} server(s)`
      : 'No OfficeMesh servers found on this subnet'
    toastText.textContent = msg
    setTimeout(() => toast.classList.add('hidden'), 3000)

  } catch (err) {
    console.error('[App] Scan error:', err)
    toastText.textContent = 'Scan failed: ' + err.message
    setTimeout(() => toast.classList.add('hidden'), 3000)
  }
}

// ── Settings save ─────────────────────────────────────────────────
async function handleSettingsSave(newSettings) {
  state.settings = { ...state.settings, ...newSettings }
  await saveSettings(state.settings)

  // Re-register with updated display name
  if (state.presenceSocket?.connected) {
    state.presenceSocket.emit('register_peer', {
      deviceId:    state.myDeviceId,
      displayName: state.settings.displayName || 'Anonymous',
      ip:          null,
    })
  }
}

document.addEventListener('DOMContentLoaded', init)
