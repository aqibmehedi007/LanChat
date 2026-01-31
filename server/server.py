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

# Peer registry - tracks online extensions (not chat connections)
# deviceId -> {deviceId, displayName, ip, lastSeen, sid}
online_peers: dict[str, dict] = {}
sid_to_device: dict[str, str] = {}  # sid -> deviceId for disconnect cleanup

# Group chat registry
# groupId -> {id, name, members: set[sid], createdAt}
groups: dict[str, dict] = {}
sid_to_groups: dict[str, set[str]] = {}  # sid -> set of groupIds for cleanup


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

    Logging:
    - Remote IP making the request
    - User-Agent header (if present)
    """
    remote = request.remote or "unknown"
    user_agent = request.headers.get("User-Agent", "unknown")
    print(f"[http] /info from {remote} ua={user_agent!r}")
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

    Logging:
    - Remote IP
    - New name (truncated) on success
    """
    remote = request.remote or "unknown"
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


async def handle_peers(request: web.Request) -> web.Response:
    """
    GET /peers
    Returns list of currently online peers (registered extensions).
    Query param: ?exclude=<deviceId> to exclude self from results
    """
    remote = request.remote or "unknown"
    exclude_id = request.query.get("exclude", None)
    
    peers_list = []
    for device_id, peer_info in online_peers.items():
        if exclude_id and device_id == exclude_id:
            continue
        peers_list.append({
            "deviceId": peer_info["deviceId"],
            "displayName": peer_info["displayName"],
            "ip": peer_info["ip"],
            "lastSeen": peer_info["lastSeen"],
        })
    
    print(f"[http] /peers from {remote} exclude={exclude_id} returning {len(peers_list)} peers")
    
    return web.json_response({
        "peers": peers_list,
        "serverDeviceId": device_config["deviceId"],
        "timestamp": int(__import__("time").time() * 1000)
    }, headers={
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
    })


async def handle_groups(request: web.Request) -> web.Response:
    """
    GET /groups
    Returns list of active groups with member counts.
    """
    remote = request.remote or "unknown"
    
    groups_list = []
    for group_id, group_info in groups.items():
        groups_list.append({
            "id": group_id,
            "name": group_info["name"],
            "memberCount": len(group_info["members"]),
            "createdAt": group_info["createdAt"],
        })
    
    print(f"[http] /groups from {remote} returning {len(groups_list)} groups")
    
    return web.json_response({
        "groups": groups_list,
        "timestamp": int(__import__("time").time() * 1000)
    }, headers={
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
    })


# Register HTTP routes
app.router.add_get("/info", handle_info)
app.router.add_get("/peers", handle_peers)
app.router.add_get("/groups", handle_groups)
app.router.add_post("/set-name", handle_set_name)
app.router.add_options("/info", handle_options)
app.router.add_options("/peers", handle_options)
app.router.add_options("/groups", handle_options)
app.router.add_options("/set-name", handle_options)


# ------------------------------------------------------
# Socket.IO signaling events
# ------------------------------------------------------

@sio.event
async def connect(sid, environ):
    """Handle new Socket.IO connection."""
    # Extract client IP from environ
    client_ip = environ.get("REMOTE_ADDR", "unknown")
    # Store IP in session for later use
    await sio.save_session(sid, {"ip": client_ip})
    print(f"[connect] User connected: {sid} from {client_ip}")


@sio.event
async def register_peer(sid, data):
    """
    Register an extension as an online peer.
    
    Data: {deviceId: string, displayName: string}
    
    This allows the server to track which extensions are online
    and provide the peer list via /peers endpoint.
    """
    device_id = data.get("deviceId")
    display_name = data.get("displayName", "Anonymous")
    
    if not device_id:
        print(f"[register_peer] {sid} missing deviceId, ignoring")
        return
    
    session = await sio.get_session(sid)
    client_ip = session.get("ip", "unknown")
    
    import time
    online_peers[device_id] = {
        "deviceId": device_id,
        "displayName": display_name,
        "ip": client_ip,
        "lastSeen": int(time.time() * 1000),
        "sid": sid
    }
    sid_to_device[sid] = device_id
    
    print(f"[register_peer] {sid} registered as {device_id} ({display_name}) from {client_ip}")
    print(f"[register_peer] Online peers: {len(online_peers)}")


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

    # Save room on the session for later events (preserve existing session data)
    session = await sio.get_session(sid)
    session["room"] = room
    await sio.save_session(sid, session)

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


# ------------------------------------------------------
# Call signaling events
# ------------------------------------------------------

@sio.event
async def call_request(sid, data):
    """
    Relay call request to the other peer in the room.
    Data: {from: displayName}
    """
    session = await sio.get_session(sid)
    room = session.get("room")
    if not room:
        print(f"[call_request] {sid} has no room; ignoring")
        return
    
    print(f"[call_request] {sid} requesting call in room {room}")
    
    for peer_sid in rooms.get(room, set()):
        if peer_sid != sid:
            await sio.emit("call_request", data, to=peer_sid)


@sio.event
async def call_accepted(sid, data):
    """
    Relay call accepted to the other peer in the room.
    """
    session = await sio.get_session(sid)
    room = session.get("room")
    if not room:
        return
    
    print(f"[call_accepted] {sid} accepted call in room {room}")
    
    for peer_sid in rooms.get(room, set()):
        if peer_sid != sid:
            await sio.emit("call_accepted", data, to=peer_sid)


@sio.event
async def call_rejected(sid, data):
    """
    Relay call rejected to the other peer in the room.
    """
    session = await sio.get_session(sid)
    room = session.get("room")
    if not room:
        return
    
    print(f"[call_rejected] {sid} rejected call in room {room}")
    
    for peer_sid in rooms.get(room, set()):
        if peer_sid != sid:
            await sio.emit("call_rejected", data, to=peer_sid)


@sio.event
async def call_ended(sid, data):
    """
    Relay call ended to the other peer in the room.
    """
    session = await sio.get_session(sid)
    room = session.get("room")
    if not room:
        return
    
    print(f"[call_ended] {sid} ended call in room {room}")
    
    for peer_sid in rooms.get(room, set()):
        if peer_sid != sid:
            await sio.emit("call_ended", data, to=peer_sid)


# ------------------------------------------------------
# Group chat events
# ------------------------------------------------------

@sio.event
async def create_group(sid, data):
    """
    Create a new group chat.
    Data: {name: string}
    Returns: {id, name, memberCount}
    """
    import time
    
    name = data.get("name", "").strip()
    if not name:
        name = "Unnamed Group"
    
    group_id = str(uuid.uuid4())[:8]  # Short ID for easy sharing
    
    groups[group_id] = {
        "id": group_id,
        "name": name,
        "members": {sid},
        "createdAt": int(time.time() * 1000)
    }
    
    # Track which groups this sid is in
    if sid not in sid_to_groups:
        sid_to_groups[sid] = set()
    sid_to_groups[sid].add(group_id)
    
    print(f"[create_group] {sid} created group {group_id} ({name})")
    
    # Return group info to creator
    await sio.emit("group_created", {
        "id": group_id,
        "name": name,
        "memberCount": 1
    }, to=sid)


@sio.event
async def join_group(sid, data):
    """
    Join an existing group.
    Data: {groupId: string, displayName: string}
    """
    group_id = data.get("groupId")
    display_name = data.get("displayName", "Anonymous")
    
    if not group_id or group_id not in groups:
        await sio.emit("group_error", {"error": "Group not found"}, to=sid)
        return
    
    group = groups[group_id]
    group["members"].add(sid)
    
    # Track which groups this sid is in
    if sid not in sid_to_groups:
        sid_to_groups[sid] = set()
    sid_to_groups[sid].add(group_id)
    
    print(f"[join_group] {sid} joined group {group_id} (members: {len(group['members'])})")
    
    # Notify the joiner
    await sio.emit("group_joined", {
        "id": group_id,
        "name": group["name"],
        "memberCount": len(group["members"])
    }, to=sid)
    
    # Notify other members
    for member_sid in group["members"]:
        if member_sid != sid:
            await sio.emit("group_member_joined", {
                "groupId": group_id,
                "displayName": display_name,
                "memberCount": len(group["members"])
            }, to=member_sid)


@sio.event
async def leave_group(sid, data):
    """
    Leave a group.
    Data: {groupId: string, displayName: string}
    """
    group_id = data.get("groupId")
    display_name = data.get("displayName", "Anonymous")
    
    if not group_id or group_id not in groups:
        return
    
    group = groups[group_id]
    group["members"].discard(sid)
    
    # Remove from tracking
    if sid in sid_to_groups:
        sid_to_groups[sid].discard(group_id)
    
    print(f"[leave_group] {sid} left group {group_id} (members: {len(group['members'])})")
    
    # Notify other members
    for member_sid in group["members"]:
        await sio.emit("group_member_left", {
            "groupId": group_id,
            "displayName": display_name,
            "memberCount": len(group["members"])
        }, to=member_sid)
    
    # Delete empty groups
    if not group["members"]:
        groups.pop(group_id, None)
        print(f"[leave_group] group {group_id} is now empty and removed")


@sio.event
async def group_message(sid, data):
    """
    Send a message to all group members.
    Data: {groupId: string, text: string, from: string}
    """
    import time
    
    group_id = data.get("groupId")
    text = data.get("text", "")
    from_name = data.get("from", "Anonymous")
    
    if not group_id or group_id not in groups:
        return
    
    if not text.strip():
        return
    
    group = groups[group_id]
    
    message = {
        "groupId": group_id,
        "text": text,
        "from": from_name,
        "ts": int(time.time() * 1000)
    }
    
    # Broadcast to all members (including sender for confirmation)
    for member_sid in group["members"]:
        await sio.emit("group_message_received", message, to=member_sid)


@sio.event
async def disconnect(sid):
    """
    Remove user from rooms, groups, and peer registry on disconnect.
    """
    print(f"[disconnect] {sid} disconnected")

    # Remove from peer registry
    device_id = sid_to_device.pop(sid, None)
    if device_id:
        online_peers.pop(device_id, None)
        print(f"[disconnect] {sid} unregistered peer {device_id}")
        print(f"[disconnect] Online peers: {len(online_peers)}")

    # Remove from all groups
    if sid in sid_to_groups:
        for group_id in list(sid_to_groups[sid]):
            if group_id in groups:
                group = groups[group_id]
                group["members"].discard(sid)
                
                # Notify remaining members
                for member_sid in group["members"]:
                    await sio.emit("group_member_left", {
                        "groupId": group_id,
                        "displayName": "Someone",
                        "memberCount": len(group["members"])
                    }, to=member_sid)
                
                # Delete empty groups
                if not group["members"]:
                    groups.pop(group_id, None)
                    print(f"[disconnect] group {group_id} is now empty and removed")
        
        sid_to_groups.pop(sid, None)

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
    print(f"  GET  http://localhost:{PORT}/info      - Device info for discovery")
    print(f"  GET  http://localhost:{PORT}/peers     - List online peers")
    print(f"  GET  http://localhost:{PORT}/groups    - List active groups")
    print(f"  POST http://localhost:{PORT}/set-name  - Set display name")
    print(f"  WS   http://localhost:{PORT}/socket.io - WebRTC signaling")
    print()
    
    web.run_app(app, port=PORT, print=None)


if __name__ == "__main__":
    main()
