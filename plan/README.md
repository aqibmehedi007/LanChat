# OfficeMesh Chrome Extension

A peer-to-peer chat extension for local networks. Discover colleagues on your LAN and chat directly using WebRTC - no central server required once connected.

## Features

- **LAN Peer Discovery**: Automatically scan your local network to find other OfficeMesh users
- **Direct P2P Chat**: Messages travel directly between browsers via WebRTC data channels
- **Persistent Device IDs**: Each device gets a unique ID that persists across sessions
- **Offline Caching**: Previously discovered peers are cached and shown even when offline
- **Auto-Scan**: Optionally scan for new peers every 15/30/60 minutes
- **Dark Theme UI**: Modern, clean interface that's easy on the eyes

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         LAN Network                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────┐              ┌──────────────────┐        │
│  │   User A's PC    │              │   User B's PC    │        │
│  │                  │              │                  │        │
│  │ ┌──────────────┐ │   Scan IPs   │ ┌──────────────┐ │        │
│  │ │   Chrome     │ │ ──────────── │ │   Chrome     │ │        │
│  │ │  Extension   │ │              │ │  Extension   │ │        │
│  │ └──────┬───────┘ │              │ └──────┬───────┘ │        │
│  │        │         │              │        │         │        │
│  │        │ WebRTC  │◄────────────►│        │         │        │
│  │        │ P2P     │  Data Channel│        │         │        │
│  │        │         │              │        │         │        │
│  │ ┌──────▼───────┐ │   Signaling  │ ┌──────▼───────┐ │        │
│  │ │  Signaling   │ │◄────────────►│ │  Signaling   │ │        │
│  │ │  Server.exe  │ │              │ │  Server.exe  │ │        │
│  │ │  (port 5000) │ │              │ │  (port 5000) │ │        │
│  │ └──────────────┘ │              │ └──────────────┘ │        │
│  └──────────────────┘              └──────────────────┘        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

Each user runs:
1. **Signaling Server** (`OfficeMesh-Signaling.exe`) - Handles WebRTC signaling and provides device info for discovery
2. **Chrome Extension** - Scans for peers, displays online users, and manages chat connections

## Project Structure

```
plan/
├── extension/                    # Chrome Extension
│   ├── manifest.json            # Extension manifest (permissions, config)
│   ├── popup/
│   │   ├── popup.html           # Main UI
│   │   ├── popup.css            # Styles
│   │   └── popup.js             # UI logic, WebRTC chat
│   ├── background/
│   │   └── service-worker.js    # Background scanning, alarms
│   ├── lib/
│   │   └── scanner.js           # LAN IP scanning module
│   └── icons/
│       ├── icon16.png           # Extension icons
│       ├── icon48.png
│       ├── icon128.png
│       └── generate-icons.html  # Tool to regenerate icons
│
└── server/                       # Signaling Server
    ├── server.py                # Python signaling server
    ├── requirements.txt         # Python dependencies
    └── build.bat                # PyInstaller build script
```

## Setup Instructions

### Prerequisites

- **Python 3.10+** for the signaling server
- **Google Chrome** or Chromium-based browser
- All users must be on the **same local network** (same subnet)

### Step 1: Build the Signaling Server

1. Open a terminal in the `plan/server/` folder

2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

3. Build the executable:
   ```bash
   build.bat
   ```
   
   This creates `dist/OfficeMesh-Signaling.exe`

4. (Optional) You can also run directly with Python:
   ```bash
   python server.py
   ```

### Step 2: Generate Extension Icons

1. Open `plan/extension/icons/generate-icons.html` in Chrome

2. Click "Generate Icons"

3. Right-click each canvas and save as:
   - `icon16.png`
   - `icon48.png`
   - `icon128.png`

### Step 3: Install the Chrome Extension

1. Open Chrome and go to `chrome://extensions/`

2. Enable **Developer mode** (toggle in top right)

3. Click **Load unpacked**

4. Select the `plan/extension/` folder

5. The OfficeMesh icon should appear in your toolbar

### Step 4: Configure the Extension

1. Click the OfficeMesh icon in Chrome toolbar

2. Click the gear icon (⚙️) to open Settings

3. Configure:
   - **Your Display Name**: How you appear to others
   - **Network Subnet**: Your LAN subnet (e.g., `192.168.1`, `192.168.2`, `10.0.0`)
   - **Auto-scan Interval**: How often to scan for new peers

4. Click **Save Settings**

## Usage

### Running the Signaling Server

Each user must run the signaling server on their machine:

```bash
# Run the built executable
OfficeMesh-Signaling.exe

# Or run with Python
python server.py
```

The server will display:
```
OfficeMesh Signaling Server v1.0.0
Device ID: abc123-def456-...
Display Name: Anonymous
Config stored at: C:\Users\YourName\.officemesh\device.json
Starting server on port 5000...
```

### Discovering Peers

1. Click the OfficeMesh icon in Chrome

2. Click **Scan** to perform a full subnet scan

3. Found peers will appear in the list with their:
   - Display name
   - IP address
   - Online/offline status

### Chatting

1. Click on an online peer in the list

2. Wait for the connection to establish (uses WebRTC)

3. Type your message and press Enter or click Send

4. Messages are sent directly peer-to-peer (not through any server)

### How Scanning Works

1. Extension reads your configured subnet (e.g., `192.168.1`)

2. Scans all IPs from `.1` to `.255` in parallel batches

3. For each IP, tries to connect to `http://{ip}:5000/info`

4. If successful, the response includes:
   ```json
   {
     "deviceId": "unique-id",
     "displayName": "User Name",
     "version": "1.0.0",
     "type": "officemesh-signaling"
   }
   ```

5. Found peers are cached in Chrome storage

## Troubleshooting

### Can't find peers on the network

1. **Check your subnet setting**: Make sure it matches your network
   - Run `ipconfig` (Windows) or `ifconfig` (Mac/Linux)
   - Look for your IPv4 address (e.g., `192.168.2.45`)
   - Use the first 3 octets as your subnet (`192.168.2`)

2. **Check if signaling server is running**: The peer must have `OfficeMesh-Signaling.exe` running

3. **Check Windows Firewall**: Allow Python/the exe through firewall on port 5000

### Chat won't connect

1. **Both users need signaling servers running**

2. **Check WebRTC connectivity**: Some networks block peer-to-peer connections

3. **Try refreshing**: Close and reopen the extension popup

### Extension not loading

1. Make sure you loaded from the `extension/` folder (not `plan/`)

2. Check for errors in `chrome://extensions/`

3. Icons must be valid PNG files (use the generator tool)

## Security Notes

- All chat messages are **end-to-end encrypted** by WebRTC
- The signaling server only relays connection metadata, never message content
- Device IDs are random UUIDs, not linked to personal information
- No data leaves your local network

## API Reference

### Signaling Server Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/info` | GET | Returns device ID, display name, and version |
| `/set-name` | POST | Update display name. Body: `{ "name": "New Name" }` |
| `/socket.io` | WS | Socket.IO endpoint for WebRTC signaling |

### Chrome Storage Schema

```javascript
// chrome.storage.local
{
  "settings": {
    "subnet": "192.168.1",
    "displayName": "Your Name",
    "autoScanInterval": 30
  },
  "peers": {
    "device-id-123": {
      "ip": "192.168.1.45",
      "deviceId": "device-id-123",
      "displayName": "Peer Name",
      "lastSeen": 1706900000000,
      "online": true
    }
  }
}

// chrome.storage.sync (persists across devices if signed into Chrome)
{
  "deviceId": "your-unique-device-id"
}
```

## Development

### Testing locally

1. Run signaling server: `python server.py`
2. Load extension in Chrome
3. Use Chrome DevTools to inspect:
   - Extension popup: Right-click popup → Inspect
   - Service worker: `chrome://extensions/` → Details → Inspect views

### Building for production

1. Update version in `manifest.json`
2. Generate fresh icons
3. Zip the `extension/` folder
4. Submit to Chrome Web Store (optional)

## License

MIT License - feel free to use and modify for your needs.
