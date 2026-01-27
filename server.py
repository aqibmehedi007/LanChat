import socketio
from aiohttp import web

"""
Very small signaling server for WebRTC.

- Clients connect over Socket.IO
- `join_room`: a client joins a logical room
- `signal`: arbitrary signaling payload relayed to the other peers in the room
- `ready`: when the second peer joins, both get a `ready` event

The server never touches media or files – those go peer‑to‑peer via WebRTC.
"""

sio = socketio.AsyncServer(cors_allowed_origins="*", async_mode="aiohttp")
app = web.Application()
sio.attach(app)

# room_id -> set[sid]
rooms: dict[str, set[str]] = {}

# room_id -> sid that should create the WebRTC offer
room_initiator: dict[str, str] = {}


@sio.event
async def connect(sid, environ):
    print(f"[connect] User connected: {sid}")


@sio.event
async def join_room(sid, room: str):
    """
    Join a logical room.

    The first user that joins a room becomes its "initiator".
    When the second user joins, both get a `ready` event indicating
    who should create the offer.
    """
    print(f"[join_room] {sid} requested room {room}")

    if room not in rooms:
        rooms[room] = set()

    rooms[room].add(sid)

    # Save room on the session so later events can infer it
    await sio.save_session(sid, {"room": room})

    if room not in room_initiator:
        # First person in – mark as initiator
        room_initiator[room] = sid

    print(f"[join_room] {sid} joined room {room} (count={len(rooms[room])})")

    # When we have exactly two peers, tell them to start WebRTC negotiation
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
    Relay signaling data (offer/answer/ICE, etc.) to the other peers in the room.
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
    Remove the user from any rooms on disconnect.
    """
    print(f"[disconnect] {sid} disconnected")

    session = await sio.get_session(sid)
    room = session.get("room") if session else None

    if room and sid in rooms.get(room, set()):
        rooms[room].remove(sid)
        print(f"[disconnect] {sid} removed from room {room}")

        # If the initiator left, forget it so a later join can become initiator
        if room_initiator.get(room) == sid:
            room_initiator.pop(room, None)

        # Remove empty rooms
        if not rooms[room]:
            rooms.pop(room, None)
            room_initiator.pop(room, None)
            print(f"[disconnect] room {room} is now empty and removed")


if __name__ == "__main__":
    web.run_app(app, port=5000)
