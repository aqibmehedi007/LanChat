# LanChat

A peer-to-peer chat app for your local network. Discover others on the same LAN and chat (and call) directly in the browser via WebRTC. The extension finds peers by scanning your subnet; a small Python signaling server runs on each machine for discovery and WebRTC handshakes.

## Features

- **LAN peer discovery** — Scan your subnet to find other LanChat users (quick scan of known IPs or full subnet scan).
- **Direct P2P chat** — One-on-one messaging over WebRTC data channels; messages stay between the two browsers.
- **Group chat** — Create groups and chat with multiple peers; the signaling server relays group messages.
- **Voice calls** — Place and receive WebRTC audio calls with peers (mute, end call).
- **File transfer** — Send files directly to a peer over the data channel.
- **Persistent device ID** — Each device gets a stable ID (stored in `~/.officemesh/device.json` by the server).
- **Offline cache** — Previously discovered peers are cached and shown even when they’re offline.
- **Auto-scan** — Optional background scan for new peers (e.g. every 15/30/60 minutes).
- **Dark theme** — Simple, dark UI in the extension popup.

## Try it out

### 1. Install the signaling server dependencies

From the project root:

```bash
cd server
pip install -r requirements.txt
```

### 2. Load the Chrome extension

1. Open Chrome and go to **chrome://extensions/**.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the **`extension`** folder (the one that contains `manifest.json`).
4. The extension icon (OfficeMesh) should appear in the toolbar.

### 3. Run the signaling server

Each person who wants to chat must run the server on their own machine:

```bash
cd server
python server.py
```

You should see something like:

```
OfficeMesh Signaling Server v1.0.0
Device ID: ...
Display Name: Anonymous
Config stored at: C:\Users\...\.officemesh\device.json
Starting server on port 5000...
```

### 4. Configure and use the extension

1. Click the extension icon in the toolbar.
2. Open **Settings** (gear icon) and set:
   - **Your Display Name** — How you appear to others.
   - **Network Subnet** — Your LAN subnet, e.g. `192.168.1` or `192.168.2` (from `ipconfig` / `ifconfig`: first three parts of your IPv4 address).
   - **Auto-scan interval** (optional) — How often to scan for new peers.
3. Click **Save Settings**.
4. In the **Peers** tab, click **Scan** (or **Quick** to re-check known peers).
5. When a peer appears and is online, click them to open a chat. You can send text, files, or start a voice call.

---

## Architecture

- **Signaling server** (`server/server.py`) — Runs on each machine on port 5000. Serves `/info` for discovery, `/set-name` to change display name, and Socket.IO for WebRTC signaling (offer/answer/ICE). Does not relay chat or call media.
- **Chrome extension** — Scans the LAN for other servers, shows peers and groups, and sets up WebRTC connections (data channel for chat/files, audio for calls).

All chat and call traffic is peer-to-peer (WebRTC). The server only helps peers find each other and exchange signaling messages.

## Project structure

```
LanChat/
├── extension/                 # Chrome extension
│   ├── manifest.json
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.css
│   │   └── popup.js
│   ├── background/
│   │   └── service-worker.js
│   ├── lib/
│   │   ├── scanner.js
│   │   └── socket.io.min.js
│   └── icons/
│       └── ...
│
└── server/
    ├── server.py              # Signaling server
    ├── requirements.txt
    └── build.bat              # Optional: build .exe with PyInstaller
```

## Requirements

- **Python 3.10+** for the signaling server.
- **Chrome** (or Chromium-based browser).
- All users on the **same local network** (same subnet).
- **Port 5000** free on each machine (and allowed through firewall if applicable).

## Troubleshooting

- **No peers found** — Check subnet (e.g. `ipconfig` → use first three octets of IPv4). Ensure the other person has `python server.py` running and that port 5000 is allowed (e.g. Windows Firewall).
- **Chat or call won’t connect** — Both sides need the signaling server running. Refresh the extension popup and try again.
- **Extension won’t load** — Load the **`extension`** folder (where `manifest.json` is), not the repo root. Check for errors on `chrome://extensions`.

## Signaling server API (reference)

| Endpoint      | Method | Description |
|---------------|--------|-------------|
| `/info`       | GET    | Device ID, display name, version (used by extension for discovery). |
| `/set-name`   | POST   | Update display name. Body: `{ "name": "New Name" }`. |
| `/socket.io`  | WS     | Socket.IO for WebRTC signaling. |

## License

MIT.
