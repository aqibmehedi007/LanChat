/**
 * System tray icon and context menu.
 */

const { Tray, Menu, app, nativeImage } = require('electron')
const path = require('path')

let tray = null

function initTray(getWindow) {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray-icon.png')

  // Use a fallback empty image if icon not yet created
  let icon
  try {
    icon = nativeImage.createFromPath(iconPath)
    if (icon.isEmpty()) icon = nativeImage.createEmpty()
  } catch {
    icon = nativeImage.createEmpty()
  }

  tray = new Tray(icon)
  tray.setToolTip('OfficeMesh')

  const buildMenu = () => Menu.buildFromTemplate([
    { label: 'OfficeMesh', enabled: false },
    { type: 'separator' },
    {
      label: 'Open OfficeMesh',
      click: () => {
        const win = getWindow()
        if (win) { win.show(); win.focus() }
      }
    },
    {
      label: 'Scan Network',
      click: () => {
        const win = getWindow()
        win?.webContents.send('tray:scan')
        win?.show()
      }
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit() } },
  ])

  tray.setContextMenu(buildMenu())

  tray.on('click', () => {
    const win = getWindow()
    if (win) {
      if (win.isVisible()) { win.focus() } else { win.show() }
    }
  })

  return tray
}

module.exports = { initTray }
