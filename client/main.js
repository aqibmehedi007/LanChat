// Basic front-end for office WebRTC chat + file transfer
// ------------------------------------------------------
// - Connects to Python Socket.IO signaling server (server.py)
// - Joins a room
// - Establishes a WebRTC peer connection (1:1)
// - Uses a single RTCDataChannel for text chat and file chunks

// IMPORTANT: use the server machine's LAN IP so that
// other PCs on the same Wi‑Fi can reach the signaling server.
// Here the server's Wi‑Fi IPv4 is 192.168.2.93 (see `ipconfig`).
const socket = io("http://192.168.2.93:5000", {
  transports: ["websocket", "polling"],
});

// DOM references
const roomInput = document.getElementById("room-input");
const nameInput = document.getElementById("name-input");
const joinBtn = document.getElementById("join-btn");
const statusEl = document.getElementById("status");

const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const startCallBtn = document.getElementById("start-call-btn");
const hangupBtn = document.getElementById("hangup-btn");

const chatLog = document.getElementById("chat-log");
const chatInput = document.getElementById("chat-input");
const sendChatBtn = document.getElementById("send-chat-btn");

const fileInput = document.getElementById("file-input");
const sendFileBtn = document.getElementById("send-file-btn");
const fileStatus = document.getElementById("file-status");
const receivedFiles = document.getElementById("received-files");

// WebRTC state
let roomId = null;
let displayName = null;
let isInitiator = false;

let pc = null;
let dataChannel = null;
let localStream = null;
let remoteStream = null;

// File transfer receive state
let incomingFile = null;

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

const FILE_CHUNK_SIZE = 16 * 1024; // 16 KB per chunk

// ------------------------------------------------------
// Socket.IO signaling
// ------------------------------------------------------

socket.on("connect", () => {
  setStatus(`Connected to signaling server (${socket.id})`);
});

socket.on("disconnect", () => {
  setStatus("Disconnected from signaling server");
});

socket.on("ready", async (data) => {
  if (!roomId || data.room !== roomId) return;

  isInitiator = data.initiator;
  console.log("[ready]", data);
  setStatus(
    `Peer joined room. You are ${isInitiator ? "initiator" : "receiver"}.`
  );

  if (!pc) {
    await createPeerConnection();
  }

  // Only the initiator starts the offer
  if (isInitiator) {
    await makeOffer();
  }
});

socket.on("signal", async (data) => {
  if (!pc) {
    await createPeerConnection();
  }

  if (data.type === "offer") {
    console.log("[signal] offer");
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("signal", { type: "answer", sdp: pc.localDescription });
  } else if (data.type === "answer") {
    console.log("[signal] answer");
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
  } else if (data.type === "candidate") {
    console.log("[signal] ice candidate");
    try {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch (err) {
      console.error("Error adding received ice candidate", err);
    }
  }
});

// ------------------------------------------------------
// UI handlers
// ------------------------------------------------------

joinBtn.addEventListener("click", () => {
  const room = roomInput.value.trim();
  const name = nameInput.value.trim() || "Anonymous";

  if (!room) {
    alert("Please enter a room ID.");
    return;
  }

  roomId = room;
  displayName = name;

  socket.emit("join_room", roomId);

  setStatus(`Joined room: ${roomId}. Waiting for peer...`);
  joinBtn.disabled = true;
  roomInput.disabled = true;
  nameInput.disabled = true;

  // Allow user to start camera/mic; the call will connect when signaling finishes
  startCallBtn.disabled = false;
});

startCallBtn.addEventListener("click", async () => {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: true,
    });
    localVideo.srcObject = localStream;

    if (!pc) {
      await createPeerConnection();
    }

    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });

    startCallBtn.disabled = true;
    hangupBtn.disabled = false;
    setStatus("Media started. Waiting for peer or negotiation...");
  } catch (err) {
    console.error("Error accessing media devices", err);
    alert("Could not access camera/microphone. Check permissions.");
  }
});

hangupBtn.addEventListener("click", () => {
  cleanupConnection();
  setStatus("Call ended.");
});

sendChatBtn.addEventListener("click", () => {
  sendChatMessage();
});

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendChatMessage();
  }
});

sendFileBtn.addEventListener("click", () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) {
    alert("Select a file first.");
    return;
  }
  if (!dataChannel || dataChannel.readyState !== "open") {
    alert("Data channel not open yet. Wait for connection.");
    return;
  }
  sendFile(file);
});

// ------------------------------------------------------
// WebRTC helpers
// ------------------------------------------------------

async function createPeerConnection() {
  if (pc) return;

  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("signal", { type: "candidate", candidate: event.candidate });
    }
  };

  pc.ontrack = (event) => {
    if (!remoteStream) {
      remoteStream = new MediaStream();
      remoteVideo.srcObject = remoteStream;
    }
    remoteStream.addTrack(event.track);
  };

  pc.oniceconnectionstatechange = () => {
    console.log("ICE state:", pc.iceConnectionState);
    if (pc.iceConnectionState === "disconnected") {
      setStatus("Peer disconnected.");
    }
  };

  // Data channel: initiator creates, receiver listens
  if (isInitiator) {
    dataChannel = pc.createDataChannel("office-data");
    setupDataChannel(dataChannel);
  } else {
    pc.ondatachannel = (event) => {
      console.log("Data channel received:", event.channel.label);
      dataChannel = event.channel;
      setupDataChannel(dataChannel);
    };
  }
}

function setupDataChannel(channel) {
  channel.onopen = () => {
    console.log("Data channel open");
    appendSystemMessage("Data channel open. You can chat and send files.");
  };

  channel.onclose = () => {
    console.log("Data channel closed");
    appendSystemMessage("Data channel closed.");
  };

  channel.onerror = (err) => {
    console.error("Data channel error", err);
  };

  channel.onmessage = (event) => {
    // Distinguish text (JSON) vs binary (ArrayBuffer)
    if (typeof event.data === "string") {
      handleTextData(event.data);
    } else {
      handleBinaryData(event.data);
    }
  };
}

async function makeOffer() {
  if (!pc) return;
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit("signal", { type: "offer", sdp: pc.localDescription });
}

function cleanupConnection() {
  if (pc) {
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.ondatachannel = null;
    pc.close();
    pc = null;
  }

  if (dataChannel) {
    dataChannel.close();
    dataChannel = null;
  }

  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
    localVideo.srcObject = null;
  }

  if (remoteStream) {
    remoteStream.getTracks().forEach((t) => t.stop());
    remoteStream = null;
    remoteVideo.srcObject = null;
  }

  hangupBtn.disabled = true;
  startCallBtn.disabled = false;
}

// ------------------------------------------------------
// Chat over DataChannel
// ------------------------------------------------------

function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  if (!dataChannel || dataChannel.readyState !== "open") {
    alert("Data channel not open yet.");
    return;
  }

  const msg = {
    kind: "chat",
    text,
    from: displayName || "Me",
    ts: Date.now(),
  };

  dataChannel.send(JSON.stringify(msg));
  appendChatMessage(msg, true);
  chatInput.value = "";
}

function handleTextData(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.warn("Received non-JSON text over data channel:", raw);
    return;
  }

  if (data.kind === "chat") {
    appendChatMessage(data, false);
  } else if (data.kind === "file-meta") {
    incomingFile = {
      name: data.name,
      size: data.size,
      type: data.type || "application/octet-stream",
      received: [],
      receivedSize: 0,
    };
    fileStatus.textContent = `Receiving file: ${incomingFile.name} (${Math.round(
      incomingFile.size / 1024
    )} KB)`;
  } else if (data.kind === "file-complete") {
    finalizeIncomingFile();
  }
}

function appendChatMessage(msg, isLocal) {
  const div = document.createElement("div");
  div.className = "chat-message";

  const who = isLocal ? "You" : msg.from || "Peer";
  const when = new Date(msg.ts || Date.now()).toLocaleTimeString();

  div.innerHTML = `
    <div class="meta">${who} • ${when}</div>
    <div class="text">${escapeHtml(msg.text)}</div>
  `;

  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function appendSystemMessage(text) {
  const div = document.createElement("div");
  div.className = "chat-message";
  div.innerHTML = `<div class="meta">System</div><div class="text">${escapeHtml(
    text
  )}</div>`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

// ------------------------------------------------------
// File transfer over DataChannel
// ------------------------------------------------------

function sendFile(file) {
  const meta = {
    kind: "file-meta",
    name: file.name,
    size: file.size,
    type: file.type,
  };

  dataChannel.send(JSON.stringify(meta));

  const reader = new FileReader();
  let offset = 0;

  fileStatus.textContent = `Sending: ${file.name} (0 / ${Math.round(
    file.size / 1024
  )} KB)`;

  reader.addEventListener("error", (err) => {
    console.error("FileReader error", err);
    fileStatus.textContent = "Error reading file.";
  });

  reader.addEventListener("load", (e) => {
    const buffer = e.target.result;
    dataChannel.send(buffer);
    offset += buffer.byteLength;

    const sentKB = Math.round(offset / 1024);
    const totalKB = Math.round(file.size / 1024);
    fileStatus.textContent = `Sending: ${file.name} (${sentKB} / ${totalKB} KB)`;

    if (offset < file.size) {
      readSlice(offset);
    } else {
      dataChannel.send(JSON.stringify({ kind: "file-complete" }));
      fileStatus.textContent = `File sent: ${file.name}`;
    }
  });

  function readSlice(o) {
    const slice = file.slice(o, o + FILE_CHUNK_SIZE);
    reader.readAsArrayBuffer(slice);
  }

  readSlice(0);
}

function handleBinaryData(arrayBuffer) {
  if (!incomingFile) {
    console.warn("Received binary data but no incomingFile state.");
    return;
  }
  incomingFile.received.push(arrayBuffer);
  incomingFile.receivedSize += arrayBuffer.byteLength;

  const receivedKB = Math.round(incomingFile.receivedSize / 1024);
  const totalKB = Math.round(incomingFile.size / 1024);
  fileStatus.textContent = `Receiving: ${incomingFile.name} (${receivedKB} / ${totalKB} KB)`;

  if (incomingFile.receivedSize >= incomingFile.size) {
    finalizeIncomingFile();
  }
}

function finalizeIncomingFile() {
  if (!incomingFile) return;

  const blob = new Blob(incomingFile.received, { type: incomingFile.type });
  const url = URL.createObjectURL(blob);

  const item = document.createElement("div");
  item.className = "received-file-item";
  const sizeKB = Math.round(incomingFile.size / 1024);
  item.innerHTML = `<a href="${url}" download="${escapeHtml(
    incomingFile.name
  )}">${escapeHtml(
    incomingFile.name
  )}</a> <span>(${sizeKB} KB)</span>`;

  receivedFiles.appendChild(item);
  fileStatus.textContent = `Received: ${incomingFile.name}`;

  incomingFile = null;
}

// ------------------------------------------------------
// Utils
// ------------------------------------------------------

function setStatus(text) {
  statusEl.textContent = text;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}