/**
 * Sidebar — renders peer cards and wires scan/settings buttons.
 */

let _onPeerClick = null

export function initSidebar({ onPeerClick, onScanClick }) {
  _onPeerClick = onPeerClick

  document.getElementById('scan-btn').addEventListener('click', onScanClick)

  document.getElementById('settings-btn').addEventListener('click', () => {
    toggleSettings()
  })
}

export function renderPeers(peers) {
  const container  = document.getElementById('sidebar-peers')
  const emptyState = document.getElementById('empty-peers')
  const peerList   = Object.values(peers || {})

  // Remove existing cards (keep empty state node)
  container.querySelectorAll('.peer-card').forEach(el => el.remove())

  if (peerList.length === 0) {
    emptyState.classList.remove('hidden')
    return
  }

  emptyState.classList.add('hidden')

  // Sort: online first, then alphabetically
  peerList.sort((a, b) => {
    if (a.online !== b.online) return b.online ? 1 : -1
    return (a.displayName || '').localeCompare(b.displayName || '')
  })

  for (const peer of peerList) {
    const card = createPeerCard(peer)
    container.appendChild(card)
  }
}

export function setActivePeer(deviceId) {
  document.querySelectorAll('.peer-card').forEach(el => {
    el.classList.toggle('active', el.dataset.deviceId === deviceId)
  })
}

function createPeerCard(peer) {
  const name    = peer.customName || peer.displayName || 'Anonymous'
  const initial = name.charAt(0).toUpperCase()
  const isOnline = !!peer.online

  const card = document.createElement('div')
  card.className = `peer-card${isOnline ? '' : ' offline'}`
  card.dataset.deviceId = peer.deviceId

  card.innerHTML = `
    <div class="peer-avatar${isOnline ? ' online' : ''}">${initial}</div>
    <div class="peer-card-info">
      <div class="peer-card-name">${escapeHtml(name)}</div>
      <div class="peer-card-ip">${isOnline ? peer.ip : 'offline'}</div>
    </div>
  `

  if (isOnline) {
    card.addEventListener('click', () => {
      setActivePeer(peer.deviceId)
      _onPeerClick?.(peer)
    })
  }

  return card
}

function toggleSettings() {
  const settingsView = document.getElementById('settings-view')
  const welcomeScreen = document.getElementById('welcome-screen')
  const chatView = document.getElementById('chat-view')
  const settingsBtn = document.getElementById('settings-btn')
  const isOpen = !settingsView.classList.contains('hidden')

  if (isOpen) {
    settingsView.classList.add('hidden')
    welcomeScreen.classList.remove('hidden')
    settingsBtn.classList.remove('active')
  } else {
    chatView.classList.add('hidden')
    welcomeScreen.classList.add('hidden')
    settingsView.classList.remove('hidden')
    settingsBtn.classList.add('active')
  }
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}
