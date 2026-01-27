## OfficeMesh RTC

A lightweight office chat, video, and file‑sharing tool built on WebRTC.  
Media and files flow **peer‑to‑peer** between browsers; the Python backend is used only for signaling.

### Features

- **Room‑based collaboration**: join a named room (e.g. `team‑standup`) from multiple PCs.
- **Audio/video calls**: WebRTC `RTCPeerConnection` between peers.
- **Secure chat**: text chat over a WebRTC data channel (P2P).
- **File sharing**: chunked file transfer over the same data channel; the server never stores files.

### Tech stack

- **Frontend**: plain HTML/CSS/JavaScript, WebRTC APIs, Socket.IO client.
- **Backend (signaling)**: Python `aiohttp` + `python-socketio`.

### Project structure

- `server.py` – Socket.IO signaling server (rooms, initiator selection, signaling relay).
- `client/`
  - `index.html` – UI for rooms, video, chat, and files.
  - `style.css` – dark, office‑style layout.
  - `main.js` – WebRTC + Socket.IO client logic, chat, and file transfer.
- `requirements.txt` – Python dependencies.

### Prerequisites

- Python 3.12 (or similar) installed.
- All machines must be on the **same network** as the signaling server.

### Installation

From the project root:

```bash
python -m pip install -r requirements.txt
```

> If `pip` is not on PATH, use the full Python path, e.g.  
> `C:\Users\Khalid\AppData\Local\Python\pythoncore-3.12-64\python.exe -m pip install -r requirements.txt`

### Running the signaling server

From the project root:

```bash
python server.py
```

The server listens on port **5000**.  
If the port is already in use, stop the existing process (or change the port in `server.py`).

### Running the web client

Serve the `client/` folder over HTTP (so other PCs can load it):

```bash
cd client
python -m http.server 8000
```

The client will then be available at:

- `http://<SERVER_LAN_IP>:8000/`

In this setup, the server PC’s Wi‑Fi IPv4 is `192.168.2.93`, so:

- `http://192.168.2.93:8000/`

Make sure **`main.js`** uses the same signaling URL, e.g.:

```js
const socket = io("http://192.168.2.93:5000", {
  transports: ["websocket", "polling"],
});
```

### Using the app (from 2+ PCs)

1. On the server PC, run `server.py` and the static server for `client/`.
2. On each PC, open a browser to `http://192.168.2.93:8000/`.
3. Enter the **same Room ID** and your **name**, then click **Join room**.
4. On each PC, click **Start camera & mic** and allow permissions.
5. Once both have joined:
   - The initiator sees: “You are initiator.”
   - The receiver sees: “You are receiver.”
6. Use the **chat** box or **Choose file → Send file** to exchange messages and files.

### Notes & troubleshooting

- If a second instance of `server.py` fails with `winerror 10048`, an old process is already using port 5000.
- Verify connectivity from other PCs:
  - `ping 192.168.2.93`
  - Check Windows Firewall rules for Python on ports **5000** and **8000**.
- WebRTC media is P2P; if the network blocks direct peer connections, calls may fail even though signaling works.

