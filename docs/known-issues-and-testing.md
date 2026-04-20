# OfficeMesh Desktop — Known Issues & Testing Guide

> Last updated: April 2026  
> Status: **Alpha — single-machine tested, two-machine testing pending**

---

## Current Status

| Area | Status |
|---|---|
| App launches and shows UI | ✅ Working |
| Python server auto-starts | ✅ Working |
| Peer discovery (same machine) | ✅ Working |
| Peer list filters out self | ✅ Fixed |
| Socket.io loads correctly | ✅ Fixed |
| Second instance port conflict | ✅ Fixed |
| WiFi subnet auto-detection | ✅ Fixed |
| WebRTC chat connection | ⚠️ Needs two-machine test |
| File drag-and-drop transfer | ⚠️ Needs two-machine test |
| Two separate computers on LAN | ❌ Not yet tested |
| Windows installer (.exe) | ✅ Builds successfully |

---

## Known Bugs

### Bug 1 — "Stuck on Connecting" (same machine)

**Symptom:** Clicking a peer shows "Connecting to peer..." and never progresses.

**Root cause:** WebRTC requires both peers to join the same signaling room at
roughly the same time. The server only fires the `ready` event when **exactly
2 sockets** are in the room simultaneously. If one side connects and the other
hasn't clicked yet, the room sits at 1 and nothing happens.

**Workaround (same machine testing):**
1. Open both app instances side by side
2. On Instance A, click on Instance B's name
3. **Immediately** on Instance B, click on Instance A's name
4. Both should show "Peer joined, connecting..." then "Chat connected!"

**Proper fix (planned):** The server should hold the room open and re-emit
`ready` when the second peer joins, even if the first joined earlier. This
requires a server-side change to `server.py`.

---

### Bug 2 — WiFi Subnet Not Auto-Detected (fixed in latest)

**Symptom:** Scan button scans `192.168.1.x` even when your WiFi is on
`192.168.2.x` or another subnet.

**Fix applied:** The app now uses WebRTC's ICE candidate gathering to detect
your actual local IP on startup, then derives the subnet automatically
(e.g. `192.168.2.45` → subnet `192.168.2`). The detected subnet is saved to
settings and pre-filled in the Settings panel.

**If auto-detection fails:** Open Settings and manually enter your subnet
(first 3 octets of your IP, e.g. `192.168.2`). You can find your IP by
running `ipconfig` in a terminal.

---

### Bug 3 — Server Registers Wrong IP (same-machine scenario)

**Symptom:** Peers show IP `127.0.0.1` instead of their real LAN IP.

**Cause:** When both instances run on the same machine, they connect to the
server via `127.0.0.1`. The server detects the socket's remote address as
`127.0.0.1`.

**Fix applied:** The app now sends its detected LAN IP in the `register_peer`
event so the server stores the real IP regardless of how the socket connected.

---

### Bug 4 — Second Instance Crashes with Port 10048

**Symptom:** Running two instances of the app causes the second one to print
`OSError: [Errno 10048] ... only one usage of each socket address`.

**Fix applied:** Before spawning Python, the server manager now checks if
`127.0.0.1:5000/info` responds. If it does, the second instance skips
spawning and reuses the existing server.

---

## Two-Machine Testing Checklist

This is the **next required testing step**. Use two Windows PCs on the same
WiFi network.

### Setup

```
PC-A (has the server)          PC-B (connects to PC-A's server)
─────────────────────          ──────────────────────────────────
Run: npm start                 Run: npm start
Server starts on :5000         Server detects port in use → skips
                               OR: server starts on :5000 too (see note)
```

> **Note on two-machine setup:** Each machine runs its own server. PC-B's
> server starts on port 5000 on PC-B. PC-A's server starts on port 5000 on
> PC-A. They are separate servers. For peers to find each other, they must
> both register with the **same server**. The scan finds whichever server
> responds first and both clients connect to it.

### Step-by-step test

- [ ] Both PCs connected to the same WiFi network
- [ ] Note PC-A's IP: run `ipconfig`, look for WiFi adapter IPv4 (e.g. `192.168.2.10`)
- [ ] On PC-B, open Settings → set subnet to match (e.g. `192.168.2`)
- [ ] On PC-B, click **Scan** — should find PC-A's server
- [ ] PC-A should appear in PC-B's peer list
- [ ] On PC-A, click **Scan** too — should find itself registered
- [ ] Click on each other's name simultaneously
- [ ] Verify "Chat connected!" appears on both sides
- [ ] Send a text message — verify it appears on the other side
- [ ] Drag a file from Windows Explorer onto the chat window
- [ ] Verify file appears in the other PC's Downloads folder
- [ ] Verify OS notification fires on the receiving PC

### Expected console output on successful connection

```
[Presence] Connected, registering peer...
[App] Peer list refreshed: 1 peers
[Chat] Connecting to signaling server: http://192.168.2.10:5000
[Chat] Socket connected, joining room: <uuid>-<uuid>
[Chat] Ready! initiator= true          ← or false on the other side
[Chat] ICE state: checking
[Chat] ICE state: connected
```

---

## Architecture: Why One Server Per Machine?

Each OfficeMesh instance spawns its own Python signaling server on port 5000.
This is intentional — no central server is needed. The design is:

```
Machine A                    Machine B
┌─────────────────┐          ┌─────────────────┐
│  App Instance   │          │  App Instance   │
│  + Server :5000 │◄────────►│  + Server :5000 │
└─────────────────┘  WebRTC  └─────────────────┘
         ▲
         │  Both clients register
         │  with Machine A's server
         │  (whichever scan finds first)
```

**The key rule:** Both peers must connect their signaling sockets to the
**same server** to be in the same room. The scan finds the first server that
responds and both clients use that one.

**Current limitation:** If PC-A and PC-B each start their own server, and
PC-B's scan finds PC-B's own server first, they'll never meet. The scan
should find PC-A's server (since PC-A started first and PC-B's server
skips if port is in use on the same machine).

**Planned improvement:** Make the server election smarter — if a scan finds
multiple servers, prefer the one with the most registered peers.

---

## Auto-Detected Subnet

The app uses WebRTC ICE candidate gathering to detect your local IP:

```javascript
// Creates a temporary RTCPeerConnection, gathers ICE candidates,
// extracts the first non-loopback IPv4 address found
const pc = new RTCPeerConnection({ iceServers: [] })
pc.createDataChannel('')
pc.onicecandidate = e => { /* parse IP from candidate string */ }
pc.createOffer().then(o => pc.setLocalDescription(o))
```

This works on WiFi, Ethernet, and VPN adapters. If multiple adapters are
present, it picks the first non-loopback IPv4 (usually WiFi).

**Fallback:** If detection fails (firewall, no network), the subnet defaults
to `192.168.1` and the user can override it in Settings.

---

## How to Report a Bug

When filing a bug, include:

1. Which step failed (scan / peer list / connecting / chat / file transfer)
2. Console output from DevTools (F12 → Console tab)
3. Contents of the server log: `%APPDATA%\OfficeMesh\server.log`
4. Whether testing on same machine or two machines
5. Windows version and Node.js version (`node --version`)
