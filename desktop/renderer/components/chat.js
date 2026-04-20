/**
 * Chat component — WebRTC peer connection, messaging, file transfer.
 *
 * Both peers must click on each other to join the same signaling room.
 * The server fires 'ready' when 2 sockets are in the room.
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

// Track saved file paths for the Open button
const savedFilePaths = new Map() // fileId -> filePath
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

  // Delegate click for file action buttons (Open / Show in folder)
  chatMessages.addEventListener('click', e => {
    const openBtn   = e.target.closest('.file-open-btn')
    const folderBtn = e.target.closest('.file-folder-btn')
    if (openBtn) {
      const fileId = openBtn.dataset.fileId
      const filePath = savedFilePaths.get(fileId)
      if (filePath) window.electronAPI.openFile(filePath)
    }
    if (folderBtn) {
      const fileId = folderBtn.dataset.fileId
      const filePath = savedFilePaths.get(fileId)
      if (filePath) window.electronAPI.showInFolder(filePath)
    }
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

// ── WebRTC Connection ─────────────────────────────────────────────

async function connectToPeer(peer) {
  try {
    const serverUrl = resolveServerUrl(peer)
    if (!serverUrl) throw new Error('No signaling server found. Run a scan first.')

    console.log('[Chat] Connecting to signaling server:', serverUrl)

    const io = window.io
    if (!io) throw new Error('socket.io not loaded')

    socket = io(serverUrl, {
      transports: ['websocket', 'polling'],
      timeout: 8000,
      reconnection: false,
    })

    currentRoomId = [state.myDeviceId, peer.deviceId].sort().join('-')

    socket.on('connect', () => {
      console.log('[Chat] Socket connected, joining room:', currentRoomId)
      addSystemMessage('Joined room — waiting for peer...')
      socket.emit('join_room', currentRoomId)

      // Notify the other peer via the presence socket that we want to chat
      if (state.presenceSocket?.connected) {
        state.presenceSocket.emit('chat_request', {
          targetDeviceId: peer.deviceId,
          fromDeviceId:   state.myDeviceId,
          fromName:       state.settings.displayName || 'Someone',
          roomId:         currentRoomId,
        })
      }
    })

    socket.on('connect_error', err => {
      chatPeerStatus.textContent = 'Connection failed'
      addSystemMessage('Could not reach signaling server: ' + err.message)
    })

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
  if (peer.serverIp) return `http://${peer.serverIp}:5000`
  if (state.signalingServerUrl) return state.signalingServerUrl
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
  const totalChunks = Math.ceil(bytes.length / CHUNK_SIZE)

  addFileBubble(file.name, file.size, 'sent', fileId)
  dataChannel.send(JSON.stringify({
    type: 'file_start', fileId, name: file.name, size: file.size, mimeType: file.type, totalChunks
  }))

  let chunkIndex = 0
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    await waitForBufferDrain(dataChannel)

    const slice  = bytes.slice(offset, offset + CHUNK_SIZE)
    const base64 = uint8ToBase64(slice)
    dataChannel.send(JSON.stringify({ type: 'file_chunk', fileId, index: chunkIndex++, data: base64 }))
    updateFileBubbleProgress(fileId, (offset + CHUNK_SIZE) / bytes.length)
  }
  dataChannel.send(JSON.stringify({ type: 'file_end', fileId }))
  updateFileBubbleProgress(fileId, 1)
  // Sender can also open the file from their own disk
  savedFilePaths.set(fileId, null) // sent files don't have a saved path
}

/**
 * Wait until the DataChannel's bufferedAmount drops below threshold.
 * This prevents overwhelming the channel and losing chunks.
 */
function waitForBufferDrain(channel) {
  const BUFFER_THRESHOLD = 64 * 1024 // 64KB
  if (channel.bufferedAmount < BUFFER_THRESHOLD) {
    return Promise.resolve()
  }
  return new Promise(resolve => {
    const check = () => {
      if (channel.bufferedAmount < BUFFER_THRESHOLD) {
        resolve()
      } else {
        setTimeout(check, 20)
      }
    }
    check()
  })
}

function handleFileStart(data) {
  pendingFiles.set(data.fileId, {
    name: data.name, size: data.size, mimeType: data.mimeType,
    totalChunks: data.totalChunks || Math.ceil(data.size / CHUNK_SIZE),
    chunks: [], received: 0
  })
  addFileBubble(data.name, data.size, 'received', data.fileId)
}

function handleFileChunk(data) {
  const file = pendingFiles.get(data.fileId)
  if (!file) return
  file.chunks[data.index] = data.data
  file.received++
  updateFileBubbleProgress(data.fileId, Math.min(file.received / file.totalChunks, 0.99))
}

async function handleFileEnd(data) {
  const file = pendingFiles.get(data.fileId)
  if (!file) return
  pendingFiles.delete(data.fileId)

  // Verify all chunks arrived
  const missing = []
  for (let i = 0; i < file.totalChunks; i++) {
    if (!file.chunks[i]) missing.push(i)
  }
  if (missing.length > 0) {
    addSystemMessage(`⚠ "${file.name}" is incomplete — ${missing.length} chunks missing`)
    updateFileBubbleProgress(data.fileId, 1)
    return
  }

  updateFileBubbleProgress(data.fileId, 1)
  try {
    // Decode each base64 chunk to binary, combine, then re-encode as one base64 string
    const allBytes = []
    let totalLen = 0
    for (let i = 0; i < file.totalChunks; i++) {
      const chunkBytes = base64ToUint8(file.chunks[i])
      allBytes.push(chunkBytes)
      totalLen += chunkBytes.length
    }
    const combined = new Uint8Array(totalLen)
    let offset = 0
    for (const chunk of allBytes) {
      combined.set(chunk, offset)
      offset += chunk.length
    }
    // Convert the full binary back to base64 for the main process
    const fullBase64 = uint8ToBase64(combined)
    const result = await window.electronAPI.saveFile(file.name, fullBase64)
    if (result.success) {
      savedFilePaths.set(data.fileId, result.path)
      addSystemMessage(`Saved "${file.name}" to Downloads`)
    }
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
    <div class="file-actions hidden" data-actions-for="${fileId}">
      <button class="file-open-btn" data-file-id="${fileId}">Open</button>
      <button class="file-folder-btn" data-file-id="${fileId}">Show in folder</button>
    </div>
    <span class="message-time">${formatTime(Date.now())}</span>`
  chatMessages.appendChild(el)
  scrollBottom()
}

function updateFileBubbleProgress(fileId, ratio) {
  const el = chatMessages.querySelector(`[data-file-id="${fileId}"] .file-progress-fill`)
  if (el) el.style.width = Math.round(ratio * 100) + '%'
  // Show action buttons when complete
  if (ratio >= 1) {
    const actions = chatMessages.querySelector(`[data-actions-for="${fileId}"]`)
    if (actions) actions.classList.remove('hidden')
    const progress = chatMessages.querySelector(`[data-file-id="${fileId}"] .file-progress`)
    if (progress) progress.classList.add('hidden')
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function isChannelOpen() { return dataChannel && dataChannel.readyState === 'open' }
function scrollBottom()  { requestAnimationFrame(() => { chatMessages.scrollTop = chatMessages.scrollHeight }) }
function formatTime(ts)  { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
function formatSize(b)   { return b < 1024 ? b+' B' : b < 1048576 ? (b/1024).toFixed(1)+' KB' : (b/1048576).toFixed(1)+' MB' }
function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase()
  return { pdf:'📄',doc:'📝',docx:'📝',xls:'📊',xlsx:'📊',ppt:'📋',pptx:'📋',
           zip:'🗜️',rar:'🗜️','7z':'🗜️',jpg:'🖼️',jpeg:'🖼️',png:'🖼️',
           gif:'🖼️',mp4:'🎬',mp3:'🎵',txt:'📃' }[ext] || '📁'
}
function escapeHtml(str) { return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }

/**
 * Convert Uint8Array to base64 string safely (no spread operator).
 * The spread approach `btoa(String.fromCharCode(...arr))` fails silently
 * on chunks > ~8KB because it exceeds max function arguments.
 */
function uint8ToBase64(uint8) {
  let binary = ''
  for (let i = 0; i < uint8.length; i++) {
    binary += String.fromCharCode(uint8[i])
  }
  return btoa(binary)
}

/**
 * Convert base64 string back to Uint8Array.
 */
function base64ToUint8(base64) {
  const binary = atob(base64)
  const bytes  = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
