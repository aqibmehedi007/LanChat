/**
 * Drag-and-drop overlay — appears when user drags a file over the window.
 * Only active when a chat is open (currentPeer is set).
 */

import { state } from '../app.js'
import { sendFile } from './chat.js'

export function initDropzone() {
  const overlay     = document.getElementById('drop-overlay')
  const targetLabel = document.getElementById('drop-target-label')

  let dragCounter = 0  // track nested dragenter/dragleave

  window.addEventListener('dragenter', e => {
    if (!state.currentPeer) return
    e.preventDefault()
    dragCounter++
    if (dragCounter === 1) {
      const name = state.currentPeer.customName
        || state.currentPeer.displayName
        || 'peer'
      targetLabel.textContent = `to ${name}`
      overlay.classList.add('visible')
    }
  })

  window.addEventListener('dragleave', e => {
    if (!state.currentPeer) return
    dragCounter--
    if (dragCounter <= 0) {
      dragCounter = 0
      overlay.classList.remove('visible')
    }
  })

  window.addEventListener('dragover', e => {
    e.preventDefault()  // required to allow drop
  })

  window.addEventListener('drop', async e => {
    e.preventDefault()
    dragCounter = 0
    overlay.classList.remove('visible')

    if (!state.currentPeer) return

    const files = Array.from(e.dataTransfer.files)
    for (const file of files) {
      await sendFile(file)
    }
  })
}
