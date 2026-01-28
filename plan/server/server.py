"""
OfficeMesh Signaling Server

A lightweight signaling server for WebRTC peer-to-peer connections.
Each user runs this on their machine. The Chrome extension discovers
peers by scanning LAN IPs and querying the /info endpoint.

Features:
- /info endpoint: Returns device ID and display name for peer discovery
- /set-name endpoint: Allows setting a display name
- Socket.IO signaling: Relays WebRTC offer/answer/ICE candidates
- Device ID persistence: Unique ID stored in ~/.officemesh/device.json
"""

import json
import os
import uuid
from pathlib import Path

import socketio
from aiohttp import web

# Configuration
PORT = 5000
VERSION = "1.0.0"
CONFIG_DIR = Path.home() / ".officemesh"
DEVICE_FILE = CONFIG_DIR / "device.json"

# Socket.IO server
sio = socketio.AsyncServer(cors_allowed_origins="*", async_mode="aiohttp")
app = web.Application()
sio.attach(app)

# In-memory state
rooms: dict[str, set[str]] = {}  # room_id -> set[sid]
room_initiator: dict[str, str] = {}  # room_id -> sid that should create offer


def load_or_create_device_config() -> dict:
    """Load device config from disk or create new one with generated ID."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    
    if DEVICE_FILE.exists():
        try:
            with open(DEVICE_FILE, "r", encoding="utf-8") as f:
                config = json.load(f)
                # Ensure required fields exist
                if "deviceId" not in config:
                    config["deviceId"] = str(uuid.uuid4())
                if "displayName" not in config:
                    config["displayName"] = "Anonymous"
                return config
        except (json.JSONDecodeError, IOError):
            pass
    
    # Create new config
    config = {
        "deviceId": str(uuid.uuid4()),
        "displayName": "Anonymous"
    }
    save_device_config(config)
    return config


def save_device_config(config: dict) -> None:
    """Save device config to disk."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    with open(DEVICE_FILE, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)


# Load config at startup
device_config = load_or_create_device_config()


# ------------------------------------------------------
# HTTP Endpoints for peer discovery
# ------------------------------------------------------

async def handle_info(request: web.Request) -> web.Response:
    """
    GET /info
    Returns device information for peer discovery.
    The Chrome extension calls this endpoint when scanning LAN IPs.
    """
    return web.json_response({
        "deviceId": device_config["deviceId"],
        "displayName": device_config["displayName"],
        "version": VERSION,
        "type": "officemesh-signaling"
    }, headers={
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
    })


async def handle_set_name(request: web.Request) -> web.Response:
    """
    POST /set-name
    Sets the display name for this device.
    Body: { "name": "Your Name" }
    """
    try:
        data = await request.json()
        name = data.get("name", "").strip()
        
        if not name:
            return web.json_response(
                {"error": "Name cannot be empty"},
                status=400,
                headers={"Access-Control-Allow-Origin": "*"}
            )
        
        if len(name) > 50:
            return web.json_response(
                {"error": "Name too long (max 50 characters)"},
                status=400,
                headers={"Access-Control-Allow-Origin": "*"}
            )
        
        device_config["displayName"] = name
        save_device_config(device_config)
        
        return web.json_response({
            "success": True,
            "displayName": name
        }, headers={"Access-Control-Allow-Origin": "*"})
        
    except json.JSONDecodeError:
        return web.json_response(
            {"error": "Invalid JSON"},
            status=400,
            headers={"Access-Control-Allow-Origin": "*"}
        )


async def handle_options(request: web.Request) -> web.Response:
    """Handle CORS preflight requests."""
    return web.Response(headers={
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
    })


# Register HTTP routes
app.router.add_get("/info", handle_info)
app.router.add_post("/set-name", handle_set_name)
app.router.add_options("/info", handle_options)
app.router.add_options("/set-name", handle_options)


# ------------------------------------------------------
# Socket.IO signaling events
# ------------------------------------------------------

@sio.event
async def connect(sid, environ):
    """Handle new Socket.IO connection."""
    print(f"[connect] User connected: {sid}")


@sio.event
async def join_room(sid, room: str):
    """
    Join a logical room for WebRTC signaling.
    
    The first user to join becomes the "initiator" who creates the offer.
    When the second user joins, both receive a 'ready' event.
    """
    print(f"[join_room] {sid} requested room {room}")

    if room not in rooms:
        rooms[room] = set()

    rooms[room].add(sid)

    # Save room on the session for later events
    await sio.save_session(sid, {"room": room})

    if room not in room_initiator:
        room_initiator[room] = sid

    print(f"[join_room] {sid} joined room {room} (count={len(rooms[room])})")

    # When we have two peers, start WebRTC negotiation
    if len(rooms[room]) == 2:
        initiator_sid = room_initiator.get(room)
        for peer_sid in rooms[room]:
            await sio.emit(
                "ready",
                {
                    "room": room,
                    "initiator": peer_sid == initiator_sid,
                },
                to=peer_sid,
            )


@sio.event
async def signal(sid, data):
    """
    Relay signaling data (offer/answer/ICE) to other peers in the room.
    """
    session = await sio.get_session(sid)
    room = session.get("room")
    if not room:
        print(f"[signal] {sid} has no room; ignoring message")
        return

    for peer_sid in rooms.get(room, set()):
        if peer_sid != sid:
            await sio.emit("signal", data, to=peer_sid)


@sio.event
async def disconnect(sid):
    """
    Remove user from rooms on disconnect.
    """
    print(f"[disconnect] {sid} disconnected")

    session = await sio.get_session(sid)
    room = session.get("room") if session else None

    if room and sid in rooms.get(room, set()):
        rooms[room].remove(sid)
        print(f"[disconnect] {sid} removed from room {room}")

        # Reset initiator if they left
        if room_initiator.get(room) == sid:
            room_initiator.pop(room, None)

        # Clean up empty rooms
        if not rooms[room]:
            rooms.pop(room, None)
            room_initiator.pop(room, None)
            print(f"[disconnect] room {room} is now empty and removed")


# ------------------------------------------------------
# Main entry point
# ------------------------------------------------------

def main():
    """Start the signaling server."""
    print(f"OfficeMesh Signaling Server v{VERSION}")
    print(f"Device ID: {device_config['deviceId']}")
    print(f"Display Name: {device_config['displayName']}")
    print(f"Config stored at: {DEVICE_FILE}")
    print(f"Starting server on port {PORT}...")
    print()
    print("Endpoints:")
    print(f"  GET  http://localhost:{PORT}/info     - Device info for discovery")
    print(f"  POST http://localhost:{PORT}/set-name - Set display name")
    print(f"  WS   http://localhost:{PORT}/socket.io - WebRTC signaling")
    print()
    
    web.run_app(app, port=PORT, print=None)


if __name__ == "__main__":
    main()
