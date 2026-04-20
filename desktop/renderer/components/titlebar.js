/**
 * Custom frameless titlebar — wires minimize/maximize/close
 * to Electron main process via preload IPC.
 */

export function initTitlebar() {
  document.getElementById('tb-minimize').addEventListener('click', () => {
    window.electronAPI.minimizeWindow()
  })
  document.getElementById('tb-maximize').addEventListener('click', () => {
    window.electronAPI.maximizeWindow()
  })
  document.getElementById('tb-close').addEventListener('click', () => {
    window.electronAPI.closeWindow()
  })
}

/**
 * Update the connection status text in the titlebar.
 * @param {'connected'|'disconnected'|string} status
 * @param {string} [label]
 */
export function setTitlebarStatus(status, label = '') {
  const el = document.getElementById('titlebar-status')
  if (!el) return
  el.className = 'titlebar-status'
  if (status === 'connected') {
    el.classList.add('connected')
    el.textContent = label || 'Connected'
  } else {
    el.textContent = label || ''
  }
}
