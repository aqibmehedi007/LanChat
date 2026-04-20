# OfficeMesh — Electron Desktop App Implementation Guide

## Design Decisions Summary

| Decision | Choice |
|---|---|
| Layout | Discord-style card-based peer list |
| Accent color | Amber `#e8a838` |
| Window size | Compact 800×600 |
| Drop zone | Appears on drag over window |
| Tray behavior | Minimize to system tray |
| Signaling server | Bundled Python, auto-started |
| Received files | Auto-save to `Downloads` folder |
| Auto-start | Off by default, toggle in Settings |

---

## Part 1 — Project Structure

```
officemesh-desktop/
├── package.json
├── electron-builder.yml
├── .gitignore
│
├── main/                        # Electron main process (Node.js)
│   ├── main.js                  # App entry, BrowserWindow, tray
│   ├── ipc-handlers.js          # IPC bridge between main and renderer
│   ├── server-manager.js        # Spawns/kills the Python signaling server
│   ├── file-handler.js          # File save logic → Downloads folder
│   ├── tray.js                  # System tray icon + context menu
│   └── auto-launch.js           # Windows startup registry helper
│
├── renderer/                    # Electron renderer process (the UI)
│   ├── index.html
│   ├── app.js                   # Main renderer entry point
│   ├── styles/
│   │   ├── main.css             # Global styles, CSS variables
│   │   ├── sidebar.css
│   │   ├── chat.css
│   │   └── dropzone.css
│   └── components/
│       ├── sidebar.js           # Peer list cards
│       ├── chat.js              # Chat view + messages
│       ├── dropzone.js          # Drag-and-drop overlay
│       ├── settings.js          # Settings panel
│       └── titlebar.js          # Custom frameless titlebar
│
├── lib/                         # Shared logic (reused from extension)
│   ├── scanner.js               # LAN scanner (adapted, no chrome.* APIs)
│   └── socket.io.min.js
│
├── server/                      # Python signaling server (unchanged)
│   ├── server.py
│   └── requirements.txt
│
└── assets/
    ├── icon.png                 # App icon (512×512)
    ├── tray-icon.png            # Tray icon (16×16 or 22×22)
    └── tray-icon-active.png     # Tray icon with badge dot
```

---

## Part 2 — Wireframes

### 2.1 Main Window — Peers View

```
┌─────────────────────────────────────────────────────────────────┐
│  ⬡ OfficeMesh          ● Connected to 192.168.1.5   [─][□][✕]  │  ← custom titlebar
├──────────────────┬──────────────────────────────────────────────┤
│  PEERS           │                                              │
│                  │                                              │
│  ┌────────────┐  │                                              │
│  │  AC     ●  │  │         Select a peer to start chatting      │
│  │  Alice     │  │                                              │
│  │  .1.12     │  │         ← Click any peer card on the left    │
│  └────────────┘  │                                              │
│  ┌────────────┐  │                                              │
│  │  BM     ●  │  │                                              │
│  │  Bob       │  │                                              │
│  │  .1.34     │  │                                              │
│  └────────────┘  │                                              │
│  ┌────────────┐  │                                              │
│  │  CW     ○  │  │                                              │
│  │  Carol     │  │                                              │
│  │  offline   │  │                                              │
│  └────────────┘  │                                              │
│                  │                                              │
│  ────────────    │                                              │
│  [🔍 Scan]       │                                              │
│  [⚙ Settings]    │                                              │
└──────────────────┴──────────────────────────────────────────────┘
```

### 2.2 Main Window — Active Chat

```
┌─────────────────────────────────────────────────────────────────┐
│  ⬡ OfficeMesh          ● Connected to 192.168.1.5   [─][□][✕]  │
├──────────────────┬──────────────────────────────────────────────┤
│  PEERS           │  ╭─ Alice Chen ──────────────────────────╮   │
│                  │  │  ● Online · 192.168.1.12              │   │
│  ┌────────────┐  │  ╰───────────────────────────────────────╯   │
│  │  AC     ●  │◄─┤                                              │
│  │  Alice     │  │   Hey, can you send me the Q3 report?        │
│  │  .1.12     │  │                              [you] 10:32     │
│  └────────────┘  │                                              │
│  ┌────────────┐  │   Sure! Dropping it now 📎                   │
│  │  BM     ●  │  │   Alice  10:33                               │
│  │  Bob       │  │                                              │
│  │  .1.34     │  │   📄 Q3-Report.pdf  (2.4 MB)                 │
│  └────────────┘  │   ████████████░░░░  67%  [you] 10:33        │
│  ┌────────────┐  │                                              │
│  │  CW     ○  │  │                                              │
│  │  Carol     │  │                                              │
│  │  offline   │  │                                              │
│  └────────────┘  │                                              │
│                  │  ──────────────────────────────────────────  │
│  [🔍 Scan]       │  [📎]  Write a message...          [Send →]  │
│  [⚙ Settings]    │                                              │
└──────────────────┴──────────────────────────────────────────────┘
```

### 2.3 Drag-and-Drop Overlay (appears when file dragged over window)

```
┌─────────────────────────────────────────────────────────────────┐
│  ⬡ OfficeMesh          ● Connected           [─][□][✕]         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐   │
│                                                               │  │
│   │          ↓                                               │  │
│              Drop to send to Alice Chen                          │
│   │                                                          │  │
│              Supports any file type · No size limit*             │
│   │                                                          │  │
│    ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─    │
│                                                                 │
│  (rest of UI dimmed behind overlay)                             │
└─────────────────────────────────────────────────────────────────┘
```

### 2.4 Settings Panel

```
┌─────────────────────────────────────────────────────────────────┐
│  ⬡ OfficeMesh                                   [─][□][✕]      │
├──────────────────┬──────────────────────────────────────────────┤
│  PEERS           │  SETTINGS                                    │
│  ...             │  ─────────────────────────────────────────   │
│                  │  Display Name                                │
│                  │  ┌──────────────────────────────────────┐   │
│                  │  │  Alice Chen                          │   │
│                  │  └──────────────────────────────────────┘   │
│                  │                                              │
│                  │  Network Subnet                              │
│                  │  ┌────────────────────┐  .1–255             │
│                  │  │  192.168.1         │                      │
│                  │  └────────────────────┘                      │
│                  │                                              │
│                  │  Auto-scan Interval                          │
│                  │  ┌──────────────────────────────────────┐   │
│                  │  │  Every 30 minutes                  ▾ │   │
│                  │  └──────────────────────────────────────┘   │
│                  │                                              │
│                  │  ☐  Start with Windows                       │
│                  │                                              │
│                  │  Signaling Server                            │
│                  │  ● Running on port 5000   [Restart]          │
│                  │                                              │
│                  │  [  Save Settings  ]                         │
│  [⚙ Settings]◄───┤                                              │
└──────────────────┴──────────────────────────────────────────────┘
```

### 2.5 System Tray Menu

```
  ┌─────────────────────────┐
  │  ⬡ OfficeMesh           │
  │  ─────────────────────  │
  │  ● 2 peers online       │
  │  ─────────────────────  │
  │  Open OfficeMesh        │
  │  Scan Network           │
  │  ─────────────────────  │
  │  Quit                   │
  └─────────────────────────┘
```


---

## Part 3 — Tech Stack & Dependencies

```json
{
  "dependencies": {
    "electron": "^30.0.0",
    "socket.io-client": "^4.7.5"
  },
  "devDependencies": {
    "electron-builder": "^24.13.0"
  }
}
```

| Package | Purpose |
|---|---|
| `electron` | Desktop shell, BrowserWindow, IPC, tray |
| `socket.io-client` | WebRTC signaling (same as extension) |
| `electron-builder` | Package + create Windows installer (.exe) |

No React, no Webpack. Plain HTML/CSS/JS in the renderer — same pattern as the existing extension. This keeps the migration straightforward.

---

## Part 4 — Phase-by-Phase Implementation Plan

### Phase 1 — Scaffold & Bare Window (Day 1)

**Goal:** Electron opens a frameless 800×600 window with the amber dark theme.

**Steps:**

1. Create `officemesh-desktop/` folder alongside `extension/` and `server/`
2. Run `npm init -y` inside it
3. Install electron: `npm install --save-dev electron`
4. Create `main/main.js` — bare BrowserWindow, frameless, 800×600
5. Create `renderer/index.html` — just the shell with CSS variables
6. Add `"start": "electron ."` to package.json scripts
7. Verify window opens with correct background color

**Key code — `main/main.js`:**
```js
const { app, BrowserWindow } = require('electron')
const path = require('path')

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 700,
    minHeight: 500,
    frame: false,          // custom titlebar
    backgroundColor: '#1a1d2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.loadFile('renderer/index.html')
}

app.whenReady().then(createWindow)
```

**Key code — CSS variables (`renderer/styles/main.css`):**
```css
:root {
  --bg-base:       #1a1d2e;
  --bg-sidebar:    #16192a;
  --bg-card:       #1e2235;
  --bg-card-hover: #252840;
  --bg-input:      #0f1120;
  --accent:        #e8a838;
  --accent-hover:  #f0b84a;
  --text-primary:  #e8eaf0;
  --text-secondary:#8b8fa8;
  --text-muted:    #555870;
  --online-green:  #22c55e;
  --offline-gray:  #555870;
  --border:        #2a2d42;
  --danger:        #ef4444;
}
```

---

### Phase 2 — Custom Titlebar + Tray (Day 1–2)

**Goal:** Frameless window with working minimize/maximize/close. Closing minimizes to tray.

**Steps:**

1. Create `renderer/components/titlebar.js` — renders the top bar with window controls
2. Wire drag region so user can move the window by dragging the titlebar
3. Create `main/tray.js` — tray icon, context menu (Open, Scan, Quit)
4. In `main/main.js`, intercept `close` event → hide window instead of quitting
5. Create `main/preload.js` — expose safe IPC methods to renderer via `contextBridge`

**Key code — `main/preload.js`:**
```js
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow:    () => ipcRenderer.send('window:close'),

  // File operations
  saveFile: (fileName, buffer) =>
    ipcRenderer.invoke('file:save', fileName, buffer),

  // Server management
  getServerStatus: () => ipcRenderer.invoke('server:status'),
  restartServer:   () => ipcRenderer.invoke('server:restart'),

  // Settings
  getSettings: ()           => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings)  => ipcRenderer.invoke('settings:save', settings),

  // Auto-launch
  setAutoLaunch: (enabled)  => ipcRenderer.invoke('autolaunch:set', enabled),

  // Events from main → renderer
  onTrayOpen:    (cb) => ipcRenderer.on('tray:open', cb),
  onScanTrigger: (cb) => ipcRenderer.on('tray:scan', cb),
})
```

**Key code — titlebar HTML:**
```html
<div class="titlebar" id="titlebar">
  <div class="titlebar-drag">
    <span class="titlebar-icon">⬡</span>
    <span class="titlebar-title">OfficeMesh</span>
    <span class="titlebar-status" id="titlebar-status"></span>
  </div>
  <div class="titlebar-controls">
    <button onclick="window.electronAPI.minimizeWindow()">─</button>
    <button onclick="window.electronAPI.maximizeWindow()">□</button>
    <button class="close" onclick="window.electronAPI.closeWindow()">✕</button>
  </div>
</div>
```

**Tray close behavior — `main/main.js`:**
```js
win.on('close', (e) => {
  e.preventDefault()   // don't destroy
  win.hide()           // hide to tray instead
})
```

---

### Phase 3 — Sidebar + Peer Cards (Day 2)

**Goal:** Left sidebar renders peer cards. Clicking a card opens the chat panel.

**Steps:**

1. Create `renderer/components/sidebar.js`
2. Port `renderPeers()` and `createPeerItem()` from `extension/popup/popup.js` — remove all `chrome.*` calls
3. Replace `chrome.storage` with `localStorage` or IPC calls to main process
4. Style peer cards per the Discord-style wireframe (card with avatar, name, IP, online dot)
5. Add Scan button at bottom of sidebar — triggers LAN scan via IPC

**Peer card HTML structure:**
```html
<div class="peer-card" data-device-id="...">
  <div class="peer-avatar online">AC</div>
  <div class="peer-info">
    <span class="peer-name">Alice Chen</span>
    <span class="peer-ip">192.168.1.12</span>
  </div>
  <div class="peer-online-dot"></div>
</div>
```

**Key CSS for cards:**
```css
.peer-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--bg-card);
  margin-bottom: 6px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background 0.15s, border-color 0.15s;
}
.peer-card:hover,
.peer-card.active {
  background: var(--bg-card-hover);
  border-color: var(--accent);
}
.peer-avatar {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: var(--bg-input);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 13px;
  color: var(--text-primary);
}
.peer-avatar.online {
  background: var(--accent);
  color: #1a1d2e;
}
```

---

### Phase 4 — Chat View (Day 3)

**Goal:** Right panel shows chat messages. Reuse WebRTC logic from the extension.

**Steps:**

1. Create `renderer/components/chat.js`
2. Port WebRTC connection logic from `extension/popup/popup.js`:
   - `connectToPeer()`, `createPeerConnection()`, `setupDataChannel()`
   - `makeOffer()`, `handleSignal()`, `sendMessage()`
3. Replace `chrome.storage.local.get` with `window.electronAPI.getSettings()`
4. Replace `chrome.runtime.sendMessage` scan calls with direct fetch calls (no service worker needed in Electron)
5. Render sent/received messages with the same bubble style as the extension

**What changes from the extension:**
```
Extension                          Electron Desktop
─────────────────────────────────────────────────────
chrome.storage.local.get()    →    window.electronAPI.getSettings()
chrome.runtime.sendMessage()  →    direct fetch() or IPC
chrome.storage.sync.get()     →    IPC → electron-store or JSON file
io() from socket.io.min.js    →    import from node_modules socket.io-client
```

---

### Phase 5 — Drag-and-Drop File Transfer (Day 3–4)

**Goal:** User drags a file from Windows Explorer onto the app window. File is sent to the active peer via WebRTC data channel.

This is the core feature. Here is the full flow:

```
Windows Explorer (drag)
        │
        ▼
  dragenter on window
        │
        ▼
  Show drop overlay  ←── renderer/components/dropzone.js
        │
        ▼
  drop event fires
        │
        ▼
  Read file as ArrayBuffer (FileReader API)
        │
        ▼
  Split into 16KB chunks
        │
        ▼
  Send chunks over WebRTC DataChannel
  { type: "file_start", name, size, mimeType, fileId }
  { type: "file_chunk", fileId, chunk (base64), index }
  { type: "file_end",   fileId }
        │
        ▼
  Receiver reassembles chunks
        │
        ▼
  window.electronAPI.saveFile(name, buffer)
        │
        ▼
  Main process writes to Downloads folder
  Shows OS notification: "Received report.pdf from Alice"
```

**`renderer/components/dropzone.js` — core logic:**
```js
// Show overlay when file enters the window
window.addEventListener('dragenter', (e) => {
  if (!currentPeer) return          // only if a chat is open
  e.preventDefault()
  dropOverlay.classList.add('visible')
})

window.addEventListener('dragleave', (e) => {
  // Only hide if leaving the window entirely
  if (e.relatedTarget === null) {
    dropOverlay.classList.remove('visible')
  }
})

window.addEventListener('dragover', (e) => {
  e.preventDefault()                // required to allow drop
})

window.addEventListener('drop', async (e) => {
  e.preventDefault()
  dropOverlay.classList.remove('visible')

  const files = Array.from(e.dataTransfer.files)
  for (const file of files) {
    await sendFile(file)
  }
})

async function sendFile(file) {
  const fileId = crypto.randomUUID()
  const buffer = await file.arrayBuffer()
  const bytes   = new Uint8Array(buffer)
  const CHUNK   = 16 * 1024

  // Announce the file
  dataChannel.send(JSON.stringify({
    type: 'file_start',
    fileId,
    name: file.name,
    size: file.size,
    mimeType: file.type
  }))

  // Send chunks
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const slice  = bytes.slice(offset, offset + CHUNK)
    const base64 = btoa(String.fromCharCode(...slice))
    dataChannel.send(JSON.stringify({
      type: 'file_chunk',
      fileId,
      index: offset / CHUNK,
      data: base64
    }))
    // Yield to avoid blocking the data channel
    await new Promise(r => setTimeout(r, 0))
  }

  // Signal completion
  dataChannel.send(JSON.stringify({ type: 'file_end', fileId }))

  // Show in chat as a sent file bubble
  addFileMessage(file.name, file.size, 'sent')
}
```

**Drop overlay CSS (`renderer/styles/dropzone.css`):**
```css
.drop-overlay {
  position: fixed;
  inset: 0;
  background: rgba(26, 29, 46, 0.92);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s;
  border: 2px dashed transparent;
}
.drop-overlay.visible {
  opacity: 1;
  pointer-events: all;
  border-color: var(--accent);
}
.drop-overlay-inner {
  text-align: center;
  color: var(--accent);
}
.drop-overlay-inner .drop-icon {
  font-size: 48px;
  margin-bottom: 16px;
}
.drop-overlay-inner h2 {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
}
.drop-overlay-inner p {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: 6px;
}
```

**Receiving files — `main/file-handler.js`:**
```js
const { ipcMain, app, Notification } = require('electron')
const path = require('path')
const fs   = require('fs')

ipcMain.handle('file:save', async (event, fileName, base64Data) => {
  const downloadsDir = app.getPath('downloads')
  const safeName     = path.basename(fileName)           // strip any path traversal
  const dest         = path.join(downloadsDir, safeName)

  // If file already exists, add a number suffix
  let finalPath = dest
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
    body:  `Saved ${safeName} to Downloads`
  }).show()

  return { success: true, path: finalPath }
})
```

---

### Phase 6 — Bundled Python Server (Day 4)

**Goal:** Python signaling server starts automatically when the app launches. User never has to touch it.

**Steps:**

1. Create `main/server-manager.js`
2. On app `ready`, spawn `server.py` as a child process
3. Pipe stdout/stderr to a log file in `userData` directory
4. On app `quit`, kill the child process cleanly
5. Expose `server:status` and `server:restart` IPC handlers for the Settings panel

**`main/server-manager.js`:**
```js
const { app }    = require('electron')
const { spawn }  = require('child_process')
const path       = require('path')
const fs         = require('fs')

let serverProcess = null

function getServerPath() {
  // In development: use local server/server.py
  // In production (packaged): server.py is in resources/
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'server', 'server.py')
  }
  return path.join(__dirname, '..', 'server', 'server.py')
}

function getPythonCommand() {
  // Try 'python' first, fall back to 'python3'
  return process.platform === 'win32' ? 'python' : 'python3'
}

function startServer() {
  if (serverProcess) return

  const serverPath = getServerPath()
  const logPath    = path.join(app.getPath('userData'), 'server.log')
  const logStream  = fs.createWriteStream(logPath, { flags: 'a' })

  console.log('[ServerManager] Starting Python server:', serverPath)

  serverProcess = spawn(getPythonCommand(), [serverPath], {
    cwd: path.dirname(serverPath)
  })

  serverProcess.stdout.pipe(logStream)
  serverProcess.stderr.pipe(logStream)

  serverProcess.on('exit', (code) => {
    console.log('[ServerManager] Server exited with code:', code)
    serverProcess = null
  })

  serverProcess.on('error', (err) => {
    console.error('[ServerManager] Failed to start server:', err.message)
    serverProcess = null
  })
}

function stopServer() {
  if (!serverProcess) return
  serverProcess.kill()
  serverProcess = null
}

function getStatus() {
  return {
    running: serverProcess !== null && !serverProcess.killed,
    pid:     serverProcess?.pid ?? null
  }
}

module.exports = { startServer, stopServer, getStatus }
```

**Wire into `main/main.js`:**
```js
const { startServer, stopServer } = require('./server-manager')

app.whenReady().then(() => {
  startServer()
  createWindow()
})

app.on('before-quit', () => {
  stopServer()
})
```

**Packaging Python with electron-builder (`electron-builder.yml`):**
```yaml
extraResources:
  - from: server/
    to: server/
    filter:
      - "**/*"
```

> **Note:** The user's machine must have Python 3 and the packages from `requirements.txt` installed. For a fully self-contained build, consider PyInstaller to compile `server.py` into a standalone `.exe` — see Phase 8.

---

### Phase 7 — Settings + Auto-Launch (Day 5)

**Goal:** Settings panel saves preferences. Optional Windows startup toggle.

**Steps:**

1. Create `main/ipc-handlers.js` — handles `settings:get`, `settings:save`, `autolaunch:set`
2. Store settings in a JSON file at `app.getPath('userData')/settings.json`
3. For auto-launch, write/remove a registry entry under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`

**`main/auto-launch.js`:**
```js
const { app } = require('electron')
const { execSync } = require('child_process')

const APP_NAME = 'OfficeMesh'

function setAutoLaunch(enabled) {
  if (process.platform !== 'win32') return

  const exePath = process.execPath.replace(/\\/g, '\\\\')
  const regKey  = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`

  try {
    if (enabled) {
      execSync(`reg add "${regKey}" /v "${APP_NAME}" /t REG_SZ /d "${exePath}" /f`)
    } else {
      execSync(`reg delete "${regKey}" /v "${APP_NAME}" /f`)
    }
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function isAutoLaunchEnabled() {
  if (process.platform !== 'win32') return false
  try {
    const regKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`
    const result = execSync(`reg query "${regKey}" /v "${APP_NAME}"`, { encoding: 'utf8' })
    return result.includes(APP_NAME)
  } catch {
    return false
  }
}

module.exports = { setAutoLaunch, isAutoLaunchEnabled }
```

---

### Phase 8 — Packaging & Distribution (Day 5–6)

**Goal:** Single `.exe` installer that users can double-click to install OfficeMesh.

**`electron-builder.yml`:**
```yaml
appId: com.officemesh.desktop
productName: OfficeMesh
copyright: Copyright © 2026

directories:
  output: dist/

win:
  target:
    - target: nsis
      arch: [x64]
  icon: assets/icon.ico

nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  createStartMenuShortcut: true

extraResources:
  - from: server/
    to: server/

files:
  - main/**
  - renderer/**
  - lib/**
  - assets/**
  - package.json
```

**Build command:**
```bash
npm run build
# produces dist/OfficeMesh Setup 1.0.0.exe
```

**Optional — compile Python to avoid requiring Python on user machines:**
```bash
# Run once on the build machine
pip install pyinstaller
pyinstaller --onefile server/server.py --distpath server-dist/
# Then point electron-builder extraResources at server-dist/server.exe
# and update server-manager.js to call server.exe directly
```

---

## Part 5 — Migration Checklist

Track progress as you build. Check off each item.

### Setup
- [ ] Create `officemesh-desktop/` folder
- [ ] `npm init` and install electron
- [ ] Bare window opens with correct dark background

### Titlebar & Tray
- [ ] Custom frameless titlebar renders
- [ ] Minimize / maximize / close buttons work
- [ ] Dragging titlebar moves the window
- [ ] Closing window hides to tray
- [ ] Tray icon shows with context menu
- [ ] "Open" from tray restores window

### Sidebar
- [ ] Peer cards render with avatar, name, IP
- [ ] Online/offline state shown correctly
- [ ] Clicking a card opens chat panel
- [ ] Scan button triggers LAN scan
- [ ] Settings button opens settings panel

### Chat
- [ ] WebRTC connection establishes between two instances
- [ ] Text messages send and receive
- [ ] Message bubbles styled correctly
- [ ] Attach button opens file picker

### Drag & Drop
- [ ] Dragging a file over the window shows overlay
- [ ] Overlay shows peer name in drop target text
- [ ] Dropping sends file via WebRTC data channel
- [ ] Progress bar shows in chat during transfer
- [ ] File saves to Downloads folder on receiver
- [ ] OS notification fires on receive
- [ ] Multiple files can be dropped at once

### Settings
- [ ] Display name saves and persists
- [ ] Subnet saves and persists
- [ ] Auto-scan interval saves
- [ ] "Start with Windows" toggle works
- [ ] Server status shows Running/Stopped
- [ ] Restart server button works

### Server
- [ ] Python server starts on app launch
- [ ] Server stops cleanly on app quit
- [ ] Server log written to userData folder

### Packaging
- [ ] `npm run build` produces installer
- [ ] Installer runs on a clean Windows machine
- [ ] App icon shows in taskbar and tray

---

## Part 6 — Key Differences from the Extension

| Concern | Chrome Extension | Electron Desktop |
|---|---|---|
| Storage | `chrome.storage.local` | JSON file via `fs` in main process |
| Background tasks | Service worker | Main process (always running) |
| Scanning | Background → popup via `chrome.runtime.sendMessage` | Direct `fetch()` in renderer or main |
| File save | Browser download API | `fs.writeFileSync` to Downloads |
| Notifications | `chrome.notifications` | Electron `Notification` API |
| Auto-start | N/A | Windows registry via `reg add` |
| Packaging | Chrome Web Store `.crx` | `electron-builder` NSIS `.exe` |
| Python server | User runs manually | Spawned as child process |

---

## Part 7 — Recommended Build Order

```
Day 1   Scaffold + bare window + titlebar + tray
Day 2   Sidebar with peer cards + settings panel
Day 3   Chat view + WebRTC connection (port from extension)
Day 4   Drag-and-drop file transfer (core feature)
Day 5   Python server auto-start + settings persistence + auto-launch
Day 6   Polish, icons, packaging, test installer
```

Total estimated effort: **5–6 focused days** for a solo developer familiar with the existing codebase.
