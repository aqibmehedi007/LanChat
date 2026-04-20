/**
 * Settings panel — loads/saves user preferences.
 */

import { state } from '../app.js'

let _onSave = null

export function initSettings({ onSave }) {
  _onSave = onSave

  const closeBtn      = document.getElementById('settings-close-btn')
  const saveBtn       = document.getElementById('save-settings-btn')
  const restartBtn    = document.getElementById('restart-server-btn')
  const autolaunchChk = document.getElementById('s-autolaunch')

  closeBtn.addEventListener('click', closeSettings)
  saveBtn.addEventListener('click', handleSave)
  restartBtn.addEventListener('click', handleRestartServer)
  autolaunchChk.addEventListener('change', async () => {
    await window.electronAPI.setAutoLaunch(autolaunchChk.checked)
  })

  // Populate when settings view becomes visible (MutationObserver)
  const settingsView = document.getElementById('settings-view')
  const observer = new MutationObserver(() => {
    if (!settingsView.classList.contains('hidden')) {
      populateSettings()
      refreshServerStatus()
    }
  })
  observer.observe(settingsView, { attributes: true, attributeFilter: ['class'] })
}

async function populateSettings() {
  const s = state.settings

  document.getElementById('s-display-name').value  = s.displayName || ''
  document.getElementById('s-subnet').value         = s.subnet || '192.168.1'
  document.getElementById('s-scan-interval').value  = String(s.autoScanInterval || 30)
  document.getElementById('s-device-id').textContent = state.myDeviceId || 'Unknown'

  const autolaunch = await window.electronAPI.isAutoLaunchEnabled()
  document.getElementById('s-autolaunch').checked = !!autolaunch
}

async function refreshServerStatus() {
  const dot    = document.getElementById('server-dot')
  const text   = document.getElementById('server-status-text')
  try {
    const status = await window.electronAPI.getServerStatus()
    if (status.running) {
      dot.className  = 'server-dot running'
      text.textContent = `Running (PID ${status.pid})`
    } else {
      dot.className  = 'server-dot'
      text.textContent = 'Stopped'
    }
  } catch {
    dot.className  = 'server-dot'
    text.textContent = 'Unknown'
  }
}

async function handleSave() {
  const displayName = document.getElementById('s-display-name').value.trim()
  const subnet      = document.getElementById('s-subnet').value.trim() || '192.168.1'
  const interval    = parseInt(document.getElementById('s-scan-interval').value, 10)

  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(subnet)) {
    alert('Invalid subnet format. Use format like 192.168.1')
    return
  }

  await _onSave?.({ displayName, subnet, autoScanInterval: interval })
  closeSettings()
}

async function handleRestartServer() {
  const text = document.getElementById('server-status-text')
  text.textContent = 'Restarting...'
  try {
    await window.electronAPI.restartServer()
    setTimeout(refreshServerStatus, 1500)
  } catch (err) {
    text.textContent = 'Restart failed'
  }
}

function closeSettings() {
  document.getElementById('settings-view').classList.add('hidden')
  document.getElementById('welcome-screen').classList.remove('hidden')
  document.getElementById('settings-btn').classList.remove('active')
}
