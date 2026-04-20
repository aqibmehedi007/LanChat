/**
 * File save handler — writes received files to the Downloads folder.
 */

const { ipcMain, app, Notification } = require('electron')
const path = require('path')
const fs   = require('fs')

function initFileHandler() {
  ipcMain.handle('file:save', async (_event, fileName, base64Data) => {
    try {
      const downloadsDir = app.getPath('downloads')
      const safeName     = path.basename(fileName)  // strip any path traversal

      // Avoid overwriting — add numeric suffix if needed
      let finalPath = path.join(downloadsDir, safeName)
      let counter   = 1
      while (fs.existsSync(finalPath)) {
        const ext  = path.extname(safeName)
        const base = path.basename(safeName, ext)
        finalPath  = path.join(downloadsDir, `${base} (${counter})${ext}`)
        counter++
      }

      const buffer = Buffer.from(base64Data, 'base64')
      fs.writeFileSync(finalPath, buffer)

      // OS notification
      new Notification({
        title: 'OfficeMesh — File Received',
        body:  `Saved "${safeName}" to Downloads`,
      }).show()

      return { success: true, path: finalPath }
    } catch (err) {
      console.error('[FileHandler] Save error:', err)
      return { success: false, error: err.message }
    }
  })
}

module.exports = { initFileHandler }
