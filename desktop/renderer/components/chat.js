/**
 * Chat component — WebRTC peer connection, messaging, file transfer.
 * Ported from extension/popup/popup.js with chrome.* APIs removed.
 *
 * HOW THE CONNECTION WORKS:
 * 1. Both peers connect their chat socket to the SAME signaling server
 * 2. Both emit join_room with the same roomId (sorted deviceIds joined by '-')
 * 3. When 2 sockets are in the room, server emits 'ready' to both
 * 4. The initiator creates an RTCPeerConnection + DataChannel and sends an offer
 * 5. The other side answers, ICE candidates are exchanged, DataChannel opens
 *
 * KEY REQUIREMENT: both peers must click on each other and join the room
 * within the server's room lifetime. The server keeps the room open as long
 * as at least one socket is in it.
 */

import { state } from '../app.js'
import { setTitlebarStatus } from './titlebar.js'

// DOM refs
let chatView, chatMessages, chatInput, sendBtn
let chatPeerAvatar, chatPeerName, chatPeerStatus
let attachBtn, fileInput

// WebRTC state
let socket         = null
let peerConnection = null
let dataChannel    = null
let isInitiator    = false
let currentRoomId  = null

// File receive state
const pendingFiles = new Map()
const CHUNK_SIZE   = 16 * 1024

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

export function initChat() {
  chatView        = document.getElementById('chat-view')
  chatMessages    = document.getElementById('chat-messages')
  chatInput       = document.getElementById('chat-input')
  sendBtn         = document.getElementById('send-btn')
  chatPeerAvatar  = document.getElementById('chat-peer-avatar')
  chatPeerName    = document.getElementById('chat-peer-name')
  chatPeerStatus  = document.getElementById('chat-peer-status')
  attachBtn       = document.getElementById('attach-btn')
  fileInput       = document.getElementById('file-input')

  sendBtn.addEventListener('click', sendMessage)
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
  })
  chatInput.addEventListener('input', () => {
    sendBtn.disabled = !chatInput.value.trim() || !isChannelOpen()
  })

  attachBtn.addEventListener('click', () => fileInput.click())
  fileInput.addEventListener('change', () => {
    Array.from(fileInput.files).forEach(sendFile)
    fileInput.value = ''
  })
}

export function openChat(peer) {
  document.getElementById('welcome-screen').classList.add('hidden')
  document.getElementById('settings-view').classList.add('hidden')
  document.getElementById('settings-btn').classList.remove('active')
  chatView.classList.remove('hidden')

  const name = peer.customName || peer.displayName || 'Anonymous'
  chatPeerAvatar.textContent = name.charAt(0).toUpperCase()
  chatPeerName.textContent   = name
  chatPeerStatus.textContent = 'Connecting...'
  chatPeerStatus.className   = 'chat-peer-status'
  chatMessages.innerHTML     = ''
  chatInput.disabled         = true
  sendBtn.disabled           = true

  disconnectFromPeer()
  addSystemMessage('Connecting to peer...')
  connectToPeer(peer)
}

// ── WebRTC ────────────────────────────────────────────────────────

async function connectToPeer(peer) {
  try {
    // Resolve signaling server — prefer the one the peer registered with
    const serverUrl = resolveServerUrl(peer)
    if (!serverUrl) throw new Error('No signaling server found. Run a scan first.')

    console.log('[Chat] Connecting to signaling server:', serverUrl)

    const io = window.io
    if (!io) throw new Error('socket.io not loaded')

    socket = io(serverUrl, {
      transports: ['websocket', 'polling'],
      timeout: 8000,
      reconnection: false,   // don't auto-reconnect for chat socket
    })

    // Room ID is deterministic: sorted deviceIds so both sides compute the same value
    currentRoomId = [state.myDeviceId, peer.deviceId].sort().join('-')

    socket.on('connect', () => {
      console.log('[Chat] Socket connected, joining room:', currentRoomId)
      addSystemMessage('Joined signaling room — waiting for peer...')
      socket.emit('join_room', currentRoomId)
    })

    socket.on('connect_error', err => {
      chatPeerStatus.textContent = 'Connection failed'
      addSystemMessage('Could not reach signaling server: ' + err.message)
    })

    // Server fires 'ready' when exactly 2 sockets are in the room
    socket.on('ready', async data => {
      console.log('[Chat] Ready! initiator=', data.initiator)
      isInitiator = data.initiator
      addSystemMessage(isInitiator ? 'Establishing connection...' : 'Peer joined, connecting...')
      await createPeerConnection()
      if (isInitiator) await makeOffer()
    })

    socket.on('signal', handleSignal)

    socket.on('disconnect', () => {
      chatPeerStatus.textContent = 'Disconnected'
      chatPeerStatus.classList.remove('connected')
      setTitlebarStatus('disconnected')
    })

  } catch (err) {
    console.error('[Chat] Connect error:', err)
    addSystemMessage('Error: ' + err.message)
  }
}

function resolveServerUrl(peer) {
  // 1. Use the serverIp the peer registered with (most reliable)
  if (peer.serverIp) {
    // If serverIp is 127.0.0.1 we're on the same machine — keep it
    return `http://${peer.serverIp}:5000`
  }
  // 2. Fall back to the presence socket's server
  if (state.signalingServerUrl) return state.signalingServerUrl
  // 3. Last resort: localStorage
  return localStorage.getItem('signalingServerUrl') || null
}

function disconnectFromPeer() {
  dataChannel?.close()
  peerConnection?.close()
  socket?.disconnect()
  dataChannel    = null
  peerConnection = null
  socket         = null
  isInitiator    = false
  currentRoomId  = null
}

async function createPeerConnection() {
  peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS })

  peerConnection.onicecandidate = e => {
    if (e.candidate && socket) {
      socket.emit('signal', { type: 'candidate', candidate: e.candidate })
    }
  }

  peerConnection.oniceconnectionstatechange = () => {
    const s = peerConnection.iceConnectionState
    console.log('[Chat] ICE state:', s)
    if (s === 'connected' || s === 'completed') {
      chatPeerStatus.textContent = 'Connected'
      chatPeerStatus.classList.add('connected')
      setTitlebarStatus('connected', `Connected to ${state.currentPeer?.displayName || 'peer'}`)
    } else if (s === 'disconnected' || s === 'failed') {
      chatPeerStatus.textContent = 'Disconnected'
      chatPeerStatus.classList.remove('connected')
      setTitlebarStatus('disconnected')
      addSystemMessage('Peer disconnected')
    }
  }

  if (isInitiator) {
    dataChannel = peerConnection.createDataChannel('officemesh-chat')
    setupDataChannel(dataChannel)
  } else {
    peerConnection.ondatachannel = e => {
      dataChannel = e.channel
      setupDataChannel(dataChannel)
    }
  }
}

function setupDataChannel(ch) {
  ch.binaryType = 'arraybuffer'
  ch.onopen  = () => {
    addSystemMessage('Chat connected!')
    chatInput.disabled = false
    sendBtn.disabled   = !chatInput.value.trim()
    chatInput.focus()
  }
  ch.onclose = () => {
    addSystemMessage('Chat disconnected')
    chatInput.disabled = true
    sendBtn.disabled   = true
  }
  ch.onmessage = e => {
    try {
      const data = JSON.parse(e.data)
      switch (data.type) {
        case 'chat':       addMessage(data.text, data.from, false, data.ts); break
        case 'file_start': handleFileStart(data); break
        case 'file_chunk': handleFileChunk(data); break
        case 'file_end':   handleFileEnd(data);   break
      }
    } catch { /* ignore malformed */ }
  }
}

async function makeOffer() {
  const offer = await peerConnection.createOffer()
  await peerConnection.setLocalDescription(offer)
  socket.emit('signal', { type: 'offer', sdp: peerConnection.localDescription })
}

async function handleSignal(data) {
  if (!peerConnection) await createPeerConnection()
  try {
    if (data.type === 'offer') {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp))
      const answer = await peerConnection.createAnswer()
      await peerConnection.setLocalDescription(answer)
      socket.emit('signal', { type: 'answer', sdp: peerConnection.localDescription })
    } else if (data.type === 'answer') {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp))
    } else if (data.type === 'candidate') {
      await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate))
    }
  } catch (err) {
    console.error('[Chat] Signal error:', err)
  }
}

// ── Messaging ─────────────────────────────────────────────────────

function sendMessage() {
  const text = chatInput.value.trim()
  if (!text || !isChannelOpen()) return
  const msg = { type: 'chat', text, from: state.settings.displayName || 'Me', ts: Date.now() }
  dataChannel.send(JSON.stringify(msg))
  addMessage(text, 'You', true, msg.ts)
  chatInput.value  = ''
  sendBtn.disabled = true
}

export function addMessage(text, from, isSent, ts) {
  const el = document.createElement('div')
  el.className = `message ${isSent ? 'sent' : 'received'}`
  el.innerHTML = `${escapeHtml(text)}<span class="message-time">${formatTime(ts)}</span>`
  chatMessages.appendChild(el)
  scrollBottom()
}

export function addSystemMessage(text) {
  const el = document.createElement('div')
  el.className = 'message system'
  el.textContent = text
  chatMessages.appendChild(el)
  scrollBottom()
}

// ── File Transfer ─────────────────────────────────────────────────

export async function sendFile(file) {
  if (!isChannelOpen()) return
  const fileId = crypto.randomUUID()
  const buffer = await file.arrayBuffer()
  const bytes  = new Uint8Array(buffer)

  addFileBubble(file.name, file.size, 'sent', fileId)
  dataChannel.send(JSON.stringify({
    type: 'file_start', fileId, name: file.name, size: file.size, mimeType: file.type
  }))

  let chunkIndex = 0
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    const slice  = bytes.slice(offset, offset + CHUNK_SIZE)
    const base64 = btoa(String.fromCharCode(...slice))
    dataChannel.send(JSON.stringify({ type: 'file_chunk', fileId, index: chunkIndex++, data: base64 }))
    updateFileBubbleProgress(fileId, offset / bytes.length)
    await new Promise(r => setTimeout(r, 0))
  }
  dataChannel.send(JSON.stringify({ type: 'file_end', fileId }))
  updateFileBubbleProgress(fileId, 1)
}

function handleFileStart(data) {
  pendingFiles.set(data.fileId, { name: data.name, size: data.size, mimeType: data.mimeType, chunks: [], received: 0 })
  addFileBubble(data.name, data.size, 'received', data.fileId)
}

function handleFileChunk(data) {
  const file = pendingFiles.get(data.fileId)
  if (!file) return
  file.chunks[data.index] = data.data
  file.received++
  updateFileBubbleProgress(data.fileId, Math.min(file.received / Math.ceil(file.size / CHUNK_SIZE), 0.99))
}

async function handleFileEnd(data) {
  const file = pendingFiles.get(data.fileId)
  if (!file) return
  pendingFiles.delete(data.fileId)
  updateFileBubbleProgress(data.fileId, 1)
  try {
    const result = await window.electronAPI.saveFile(file.name, file.chunks.join(''))
    if (result.success) addSystemMessage(`Saved "${file.name}" to Downloads`)
  } catch (err) {
    addSystemMessage(`Failed to save "${file.name}": ` + err.message)
  }
}

function addFileBubble(name, size, direction, fileId) {
  const el = document.createElement('div')
  el.className = `message file-msg ${direction}`
  el.dataset.fileId = fileId
  el.innerHTML = `
    <div class="file-msg-row">
      <div class="file-msg-icon">${fileIcon(name)}</div>
      <div class="file-msg-info">
        <div class="file-msg-name">${escapeHtml(name)}</div>
        <div class="file-msg-size">${formatSize(size)}</div>
      </div>
    </div>
    <div class="file-progress"><div class="file-progress-fill" style="width:0%"></div></div>
    <span class="message-time">${formatTime(Date.now())}</span>`
  chatMessages.appendChild(el)
  scrollBottom()
}

function updateFileBubbleProgress(fileId, ratio) {
  const el = chatMessages.querySelector(`[data-file-id="${fileId}"] .file-progress-fill`)
  if (el) el.style.width = Math.round(ratio * 100) + '%'
}

function isChannelOpen() { return dataChannel && dataChannel.readyState === 'open' }
function scrollBottom()   { requestAnimationFrame(() => { chatMessages.scrollTop = chatMessages.scrollHeight }) }
function formatTime(ts)   { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
function formatSize(b)    { return b < 1024 ? b+' B' : b < 1048576 ? (b/1024).toFixed(1)+' KB' : (b/1048576).toFixed(1)+' MB' }
function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase()
  return { pdf:'📄',doc:'📝',docx:'📝',xls:'📊',xlsx:'📊',ppt:'📋',pptx:'📋',
           zip:'🗜️',rar:'🗜️','7z':'🗜️',jpg:'🖼️',jpeg:'🖼️',png:'🖼️',
           gif:'🖼️',mp4:'🎬',mp3:'🎵',txt:'📃' }[ext] || '📁'
}
function escapeHtml(str) { return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }

// DOM refs (resolved once on init)
let chatView, chatMessages, chatInput, sendBtn
let chatPeerAvatar, chatPeerName, chatPeerStatus
let attachBtn, fileInput

// WebRTC state
let socket         = null
let peerConnection = null
let dataChannel    = null
let isInitiator    = false

// File receive state
const pendingFiles = new Map()
const CHUNK_SIZE   = 16 * 1024

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

export function initChat() {
  chatView        = document.getElementById('chat-view')
  chatMessages    = document.getElementById('chat-messages')
  chatInput       = document.getElementById('chat-input')
  sendBtn         = document.getElementById('send-btn')
  chatPeerAvatar  = document.getElementById('chat-peer-avatar')
  chatPeerName    = document.getElementById('chat-peer-name')
  chatPeerStatus  = document.getElementById('chat-peer-status')
  attachBtn       = document.getElementById('attach-btn')
  fileInput       = document.getElementById('file-input')

  sendBtn.addEventListener('click', sendMessage)
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
  })
  chatInput.addEventListener('input', () => {
    sendBtn.disabled = !chatInput.value.trim() || !isChannelOpen()
  })

  attachBtn.addEventListener('click', () => fileInput.click())
  fileInput.addEventListener('change', () => {
    Array.from(fileInput.files).forEach(sendFile)
    fileInput.value = ''
  })
}

export function openChat(peer) {
  // Show chat view
  document.getElementById('welcome-screen').classList.add('hidden')
  document.getElementById('settings-view').classList.add('hidden')
  document.getElementById('settings-btn').classList.remove('active')
  chatView.classList.remove('hidden')

  // Reset UI
  const name = peer.customName || peer.displayName || 'Anonymous'
  chatPeerAvatar.textContent = name.charAt(0).toUpperCase()
  chatPeerName.textContent   = name
  chatPeerStatus.textContent = 'Connecting...'
  chatPeerStatus.className   = 'chat-peer-status'
  chatMessages.innerHTML     = ''
  chatInput.disabled         = true
  sendBtn.disabled           = true

  // Disconnect any existing connection
  disconnectFromPeer()

  addSystemMessage('Connecting to peer...')
  connectToPeer(peer)
}

// ── WebRTC ────────────────────────────────────────────────────────

async function connectToPeer(peer) {
  try {
    const serverIp  = peer.serverIp
      || (state.signalingServerUrl ? new URL(state.signalingServerUrl).hostname : null)
      || localStorage.getItem('signalingServerUrl')?.replace(/^https?:\/\//, '').replace(/:.*/, '')

    if (!serverIp) throw new Error('No signaling server found. Run a scan first.')

    const serverUrl = `http://${serverIp}:5000`
    console.log('[Chat] Connecting to signaling server:', serverUrl)

    const io = window.io
    if (!io) throw new Error('socket.io not loaded')

    socket = io(serverUrl, { transports: ['websocket', 'polling'], timeout: 5000 })

    socket.on('connect', async () => {
      addSystemMessage('Connected to signaling server')
      const roomId = [state.myDeviceId, peer.deviceId].sort().join('-')
      socket.emit('join_room', roomId)
    })

    socket.on('connect_error', err => {
      chatPeerStatus.textContent = 'Connection failed'
      addSystemMessage('Could not reach signaling server: ' + err.message)
    })

    socket.on('ready', async data => {
      isInitiator = data.initiator
      await createPeerConnection()
      if (isInitiator) await makeOffer()
    })

    socket.on('signal', handleSignal)

    socket.on('disconnect', () => {
      chatPeerStatus.textContent = 'Disconnected'
      chatPeerStatus.classList.remove('connected')
      setTitlebarStatus('disconnected')
    })

  } catch (err) {
    console.error('[Chat] Connect error:', err)
    addSystemMessage('Error: ' + err.message)
  }
}

function disconnectFromPeer() {
  dataChannel?.close()
  peerConnection?.close()
  socket?.disconnect()
  dataChannel    = null
  peerConnection = null
  socket         = null
  isInitiator    = false
}

async function createPeerConnection() {
  peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS })

  peerConnection.onicecandidate = e => {
    if (e.candidate && socket) {
      socket.emit('signal', { type: 'candidate', candidate: e.candidate })
    }
  }

  peerConnection.oniceconnectionstatechange = () => {
    const s = peerConnection.iceConnectionState
    if (s === 'connected' || s === 'completed') {
      chatPeerStatus.textContent = 'Connected'
      chatPeerStatus.classList.add('connected')
      const name = state.currentPeer?.displayName || 'peer'
      setTitlebarStatus('connected', `Connected to ${name}`)
    } else if (s === 'disconnected' || s === 'failed') {
      chatPeerStatus.textContent = 'Disconnected'
      chatPeerStatus.classList.remove('connected')
      setTitlebarStatus('disconnected')
      addSystemMessage('Peer disconnected')
    }
  }

  if (isInitiator) {
    dataChannel = peerConnection.createDataChannel('officemesh-chat')
    setupDataChannel(dataChannel)
  } else {
    peerConnection.ondatachannel = e => {
      dataChannel = e.channel
      setupDataChannel(dataChannel)
    }
  }
}

function setupDataChannel(ch) {
  ch.binaryType = 'arraybuffer'

  ch.onopen = () => {
    addSystemMessage('Chat connected!')
    chatInput.disabled = false
    sendBtn.disabled   = !chatInput.value.trim()
    chatInput.focus()
  }

  ch.onclose = () => {
    addSystemMessage('Chat disconnected')
    chatInput.disabled = true
    sendBtn.disabled   = true
  }

  ch.onmessage = e => {
    try {
      const data = JSON.parse(e.data)
      switch (data.type) {
        case 'chat':       addMessage(data.text, data.from, false, data.ts); break
        case 'file_start': handleFileStart(data); break
        case 'file_chunk': handleFileChunk(data); break
        case 'file_end':   handleFileEnd(data);   break
      }
    } catch { /* ignore malformed */ }
  }
}

async function makeOffer() {
  const offer = await peerConnection.createOffer()
  await peerConnection.setLocalDescription(offer)
  socket.emit('signal', { type: 'offer', sdp: peerConnection.localDescription })
}

async function handleSignal(data) {
  if (!peerConnection) await createPeerConnection()
  try {
    if (data.type === 'offer') {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp))
      const answer = await peerConnection.createAnswer()
      await peerConnection.setLocalDescription(answer)
      socket.emit('signal', { type: 'answer', sdp: peerConnection.localDescription })
    } else if (data.type === 'answer') {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp))
    } else if (data.type === 'candidate') {
      await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate))
    }
  } catch (err) {
    console.error('[Chat] Signal error:', err)
  }
}

// ── Messaging ─────────────────────────────────────────────────────

function sendMessage() {
  const text = chatInput.value.trim()
  if (!text || !isChannelOpen()) return

  const msg = { type: 'chat', text, from: state.settings.displayName || 'Me', ts: Date.now() }
  dataChannel.send(JSON.stringify(msg))
  addMessage(text, 'You', true, msg.ts)
  chatInput.value  = ''
  sendBtn.disabled = true
}

export function addMessage(text, from, isSent, ts) {
  const el = document.createElement('div')
  el.className = `message ${isSent ? 'sent' : 'received'}`
  el.innerHTML = `${escapeHtml(text)}<span class="message-time">${formatTime(ts)}</span>`
  chatMessages.appendChild(el)
  scrollBottom()
}

export function addSystemMessage(text) {
  const el = document.createElement('div')
  el.className = 'message system'
  el.textContent = text
  chatMessages.appendChild(el)
  scrollBottom()
}

// ── File Transfer ─────────────────────────────────────────────────

export async function sendFile(file) {
  if (!isChannelOpen()) return

  const fileId = crypto.randomUUID()
  const buffer = await file.arrayBuffer()
  const bytes  = new Uint8Array(buffer)

  // Add sent file bubble
  const bubbleId = addFileBubble(file.name, file.size, 'sent', fileId)

  // Announce
  dataChannel.send(JSON.stringify({
    type: 'file_start', fileId, name: file.name, size: file.size, mimeType: file.type
  }))

  // Send chunks
  let chunkIndex = 0
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    const slice  = bytes.slice(offset, offset + CHUNK_SIZE)
    const base64 = btoa(String.fromCharCode(...slice))
    dataChannel.send(JSON.stringify({ type: 'file_chunk', fileId, index: chunkIndex++, data: base64 }))
    updateFileBubbleProgress(fileId, offset / bytes.length)
    await new Promise(r => setTimeout(r, 0)) // yield
  }

  dataChannel.send(JSON.stringify({ type: 'file_end', fileId }))
  updateFileBubbleProgress(fileId, 1)
}

function handleFileStart(data) {
  pendingFiles.set(data.fileId, {
    name: data.name, size: data.size, mimeType: data.mimeType,
    chunks: [], received: 0
  })
  addFileBubble(data.name, data.size, 'received', data.fileId)
}

function handleFileChunk(data) {
  const file = pendingFiles.get(data.fileId)
  if (!file) return
  file.chunks[data.index] = data.data
  file.received++
  const progress = file.received / Math.ceil(file.size / CHUNK_SIZE)
  updateFileBubbleProgress(data.fileId, Math.min(progress, 0.99))
}

async function handleFileEnd(data) {
  const file = pendingFiles.get(data.fileId)
  if (!file) return
  pendingFiles.delete(data.fileId)

  // Reassemble
  const combined = file.chunks.join('')
  updateFileBubbleProgress(data.fileId, 1)

  // Save via main process
  try {
    const result = await window.electronAPI.saveFile(file.name, combined)
    if (result.success) {
      addSystemMessage(`Saved "${file.name}" to Downloads`)
    }
  } catch (err) {
    addSystemMessage(`Failed to save "${file.name}": ` + err.message)
  }
}

// ── File bubble UI ────────────────────────────────────────────────

function addFileBubble(name, size, direction, fileId) {
  const el = document.createElement('div')
  el.className = `message file-msg ${direction}`
  el.dataset.fileId = fileId
  el.innerHTML = `
    <div class="file-msg-row">
      <div class="file-msg-icon">${fileIcon(name)}</div>
      <div class="file-msg-info">
        <div class="file-msg-name">${escapeHtml(name)}</div>
        <div class="file-msg-size">${formatSize(size)}</div>
      </div>
    </div>
    <div class="file-progress">
      <div class="file-progress-fill" style="width:0%"></div>
    </div>
    <span class="message-time">${formatTime(Date.now())}</span>
  `
  chatMessages.appendChild(el)
  scrollBottom()
  return el
}

function updateFileBubbleProgress(fileId, ratio) {
  const el = chatMessages.querySelector(`[data-file-id="${fileId}"] .file-progress-fill`)
  if (el) el.style.width = Math.round(ratio * 100) + '%'
}

// ── Helpers ───────────────────────────────────────────────────────

function isChannelOpen() {
  return dataChannel && dataChannel.readyState === 'open'
}

function scrollBottom() {
  requestAnimationFrame(() => { chatMessages.scrollTop = chatMessages.scrollHeight })
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatSize(bytes) {
  if (bytes < 1024)       return bytes + ' B'
  if (bytes < 1024*1024)  return (bytes/1024).toFixed(1) + ' KB'
  return (bytes/(1024*1024)).toFixed(1) + ' MB'
}

function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase()
  const map = { pdf:'📄', doc:'📝', docx:'📝', xls:'📊', xlsx:'📊',
                ppt:'📋', pptx:'📋', zip:'🗜️', rar:'🗜️', '7z':'🗜️',
                jpg:'🖼️', jpeg:'🖼️', png:'🖼️', gif:'🖼️', mp4:'🎬',
                mp3:'🎵', txt:'📃' }
  return map[ext] || '📁'
}

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}
