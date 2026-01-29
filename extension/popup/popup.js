/**
 * OfficeMesh Popup Script
 *
 * Handles:
 * - Peer list display and management
 * - WebRTC chat connections
 * - Settings management
 * - UI state and navigation
 *
 * Socket.IO is loaded via a separate `<script>` tag in `popup.html`,
 * which exposes the global `io` function used below.
 */

// DOM Elements
const peersView = document.getElementById("peers-view");
const chatView = document.getElementById("chat-view");
const settingsView = document.getElementById("settings-view");

const settingsBtn = document.getElementById("settings-btn");
const settingsBackBtn = document.getElementById("settings-back-btn");
const backBtn = document.getElementById("back-btn");

const quickScanBtn = document.getElementById("quick-scan-btn");
const fullScanBtn = document.getElementById("full-scan-btn");

const scanProgress = document.getElementById("scan-progress");
const progressFill = document.getElementById("progress-fill");
const progressText = document.getElementById("progress-text");

const peersList = document.getElementById("peers-list");
const emptyState = document.getElementById("empty-state");

const chatMessages = document.getElementById("chat-messages");
const chatInput = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");
const chatPeerName = document.getElementById("chat-peer-name");
const chatPeerStatus = document.getElementById("chat-peer-status");

const displayNameInput = document.getElementById("display-name");
const subnetInput = document.getElementById("subnet-input");
const autoScanInterval = document.getElementById("auto-scan-interval");
const deviceIdEl = document.getElementById("device-id");
const saveSettingsBtn = document.getElementById("save-settings-btn");

const statusIndicator = document.getElementById("status-indicator");

// State
let peers = {};
let settings = {};
let myDeviceId = null;
let currentPeer = null;

// WebRTC state
let socket = null;
let peerConnection = null;
let dataChannel = null;
let isInitiator = false;

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

// Initialize popup
document.addEventListener("DOMContentLoaded", init);

async function init() {
  console.log("[Popup] Initializing...");

  // Load device ID
  myDeviceId = await getDeviceId();
  deviceIdEl.textContent = myDeviceId;

  // Load settings
  settings = await loadSettings();
  displayNameInput.value = settings.displayName || "";
  subnetInput.value = settings.subnet || "192.168.1";
  autoScanInterval.value = String(settings.autoScanInterval || 30);

  // Load peers
  peers = await loadPeers();
  renderPeers();

  // Set up event listeners
  setupEventListeners();

  // Listen for scan progress from background
  chrome.runtime.onMessage.addListener(handleBackgroundMessage);

  console.log("[Popup] Initialized with", Object.keys(peers).length, "cached peers");
}

function setupEventListeners() {
  // Navigation
  settingsBtn.addEventListener("click", () => showView("settings"));
  settingsBackBtn.addEventListener("click", () => showView("peers"));
  backBtn.addEventListener("click", () => {
    disconnectFromPeer();
    showView("peers");
  });

  // Scanning
  quickScanBtn.addEventListener("click", handleQuickScan);
  fullScanBtn.addEventListener("click", handleFullScan);

  // Settings
  saveSettingsBtn.addEventListener("click", handleSaveSettings);

  // Chat
  sendBtn.addEventListener("click", sendMessage);
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  chatInput.addEventListener("input", () => {
    sendBtn.disabled = !chatInput.value.trim() || !dataChannel || dataChannel.readyState !== "open";
  });
}

// View navigation
function showView(viewName) {
  peersView.classList.add("hidden");
  chatView.classList.add("hidden");
  settingsView.classList.add("hidden");

  switch (viewName) {
    case "peers":
      peersView.classList.remove("hidden");
      break;
    case "chat":
      chatView.classList.remove("hidden");
      chatInput.focus();
      break;
    case "settings":
      settingsView.classList.remove("hidden");
      break;
  }
}

// Peer list rendering
function renderPeers() {
  const peerList = Object.values(peers);

  if (peerList.length === 0) {
    emptyState.classList.remove("hidden");
    // Clear any peer items but keep empty state
    const items = peersList.querySelectorAll(".peer-item");
    items.forEach((item) => item.remove());
    return;
  }

  emptyState.classList.add("hidden");

  // Sort: online first, then by name
  peerList.sort((a, b) => {
    if (a.online !== b.online) return b.online ? 1 : -1;
    return (a.displayName || "Anonymous").localeCompare(b.displayName || "Anonymous");
  });

  // Clear existing items
  const existingItems = peersList.querySelectorAll(".peer-item");
  existingItems.forEach((item) => item.remove());

  // Render peers
  for (const peer of peerList) {
    const item = createPeerItem(peer);
    peersList.appendChild(item);
  }
}

function createPeerItem(peer) {
  const item = document.createElement("div");
  item.className = `peer-item${peer.online ? "" : " offline"}`;
  item.dataset.deviceId = peer.deviceId;

  const name = peer.customName || peer.displayName || "Anonymous";
  const initial = name.charAt(0).toUpperCase();
  const lastSeen = peer.lastSeen ? formatTime(peer.lastSeen) : "Never";

  item.innerHTML = `
    <div class="peer-avatar${peer.online ? " online" : ""}">${initial}</div>
    <div class="peer-info">
      <div class="peer-name">${escapeHtml(name)}</div>
      <div class="peer-meta">
        <span class="peer-status">${peer.online ? "Online" : "Last seen " + lastSeen}</span>
        <span>${peer.ip}</span>
      </div>
    </div>
  `;

  item.addEventListener("click", () => {
    if (peer.online) {
      connectToPeer(peer);
    }
  });

  return item;
}

// Scanning
async function handleQuickScan() {
  quickScanBtn.disabled = true;
  fullScanBtn.disabled = true;
  statusIndicator.classList.add("scanning");

  try {
    const result = await chrome.runtime.sendMessage({ type: "QUICK_SCAN" });

    if (result.success) {
      peers = result.peers;
      await savePeers(peers);
      renderPeers();
    }
  } catch (error) {
    console.error("[Popup] Quick scan error:", error);
  } finally {
    quickScanBtn.disabled = false;
    fullScanBtn.disabled = false;
    statusIndicator.classList.remove("scanning");
  }
}

async function handleFullScan() {
  quickScanBtn.disabled = true;
  fullScanBtn.disabled = true;
  statusIndicator.classList.add("scanning");

  // Show progress
  scanProgress.classList.remove("hidden");
  progressFill.style.width = "0%";
  progressText.textContent = "Starting scan...";

  try {
    const result = await chrome.runtime.sendMessage({
      type: "START_SCAN",
      subnet: subnetInput.value || settings.subnet,
    });

    if (result.success) {
      peers = result.peers;
      await savePeers(peers);
      renderPeers();
      progressText.textContent = `Found ${result.foundCount} peer(s)`;
    } else {
      progressText.textContent = result.error || "Scan failed";
    }
  } catch (error) {
    console.error("[Popup] Full scan error:", error);
    progressText.textContent = "Scan error";
  } finally {
    quickScanBtn.disabled = false;
    fullScanBtn.disabled = false;
    statusIndicator.classList.remove("scanning");

    // Hide progress after delay
    setTimeout(() => {
      scanProgress.classList.add("hidden");
    }, 2000);
  }
}

function handleBackgroundMessage(message) {
  if (message.type === "SCAN_PROGRESS") {
    const percent = Math.round((message.scanned / message.total) * 100);
    progressFill.style.width = `${percent}%`;
    progressText.textContent = `Scanning... ${message.scanned}/${message.total} (found ${message.found})`;
  }
}

// Settings
async function handleSaveSettings() {
  const newSettings = {
    displayName: displayNameInput.value.trim(),
    subnet: subnetInput.value.trim() || "192.168.1",
    autoScanInterval: parseInt(autoScanInterval.value, 10),
  };

  // Validate subnet format
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(newSettings.subnet)) {
    alert("Invalid subnet format. Use format like 192.168.1");
    return;
  }

  try {
    // Update local signaling server name if display name changed
    if (newSettings.displayName && newSettings.displayName !== settings.displayName) {
      try {
        await fetch("http://localhost:5000/set-name", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: newSettings.displayName }),
        });
      } catch {
        // Server might not be running locally
      }
    }

    // Save to storage
    await chrome.runtime.sendMessage({
      type: "UPDATE_SETTINGS",
      settings: newSettings,
    });

    settings = { ...settings, ...newSettings };
    showView("peers");
  } catch (error) {
    console.error("[Popup] Save settings error:", error);
    alert("Failed to save settings");
  }
}

// WebRTC Chat
async function connectToPeer(peer) {
  currentPeer = peer;
  showView("chat");

  chatPeerName.textContent = peer.customName || peer.displayName || "Anonymous";
  chatPeerStatus.textContent = "Connecting...";
  chatPeerStatus.classList.remove("connected");
  chatMessages.innerHTML = "";
  chatInput.disabled = true;
  sendBtn.disabled = true;

  addSystemMessage("Connecting to peer...");

  try {
    // Connect to peer's signaling server
    const signalingUrl = `http://${peer.ip}:5000`;
    socket = io(signalingUrl, {
      transports: ["websocket", "polling"],
      timeout: 5000,
    });

    socket.on("connect", async () => {
      console.log("[Chat] Connected to signaling server");
      addSystemMessage("Connected to signaling server");

      // Create unique room ID based on both device IDs (sorted for consistency)
      const roomId = [myDeviceId, peer.deviceId].sort().join("-");

      // Join the room
      socket.emit("join_room", roomId);
    });

    socket.on("connect_error", (error) => {
      console.error("[Chat] Connection error:", error);
      chatPeerStatus.textContent = "Connection failed";
      addSystemMessage("Failed to connect. Is the peer online?");
    });

    socket.on("ready", async (data) => {
      console.log("[Chat] Ready event:", data);
      isInitiator = data.initiator;

      await createPeerConnection();

      if (isInitiator) {
        await makeOffer();
      }
    });

    socket.on("signal", handleSignal);

    socket.on("disconnect", () => {
      console.log("[Chat] Disconnected from signaling");
      chatPeerStatus.textContent = "Disconnected";
      chatPeerStatus.classList.remove("connected");
    });
  } catch (error) {
    console.error("[Chat] Connect error:", error);
    chatPeerStatus.textContent = "Connection failed";
    addSystemMessage("Failed to connect: " + error.message);
  }
}

function disconnectFromPeer() {
  if (dataChannel) {
    dataChannel.close();
    dataChannel = null;
  }

  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  if (socket) {
    socket.disconnect();
    socket = null;
  }

  currentPeer = null;
  isInitiator = false;
}

async function createPeerConnection() {
  peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  peerConnection.onicecandidate = (event) => {
    if (event.candidate && socket) {
      socket.emit("signal", { type: "candidate", candidate: event.candidate });
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    console.log("[Chat] ICE state:", peerConnection.iceConnectionState);

    if (peerConnection.iceConnectionState === "connected") {
      chatPeerStatus.textContent = "Connected";
      chatPeerStatus.classList.add("connected");
    } else if (peerConnection.iceConnectionState === "disconnected") {
      chatPeerStatus.textContent = "Disconnected";
      chatPeerStatus.classList.remove("connected");
      addSystemMessage("Peer disconnected");
    }
  };

  // Data channel setup
  if (isInitiator) {
    dataChannel = peerConnection.createDataChannel("officemesh-chat");
    setupDataChannel(dataChannel);
  } else {
    peerConnection.ondatachannel = (event) => {
      console.log("[Chat] Data channel received");
      dataChannel = event.channel;
      setupDataChannel(dataChannel);
    };
  }
}

function setupDataChannel(channel) {
  channel.onopen = () => {
    console.log("[Chat] Data channel open");
    addSystemMessage("Chat connected!");
    chatInput.disabled = false;
    sendBtn.disabled = !chatInput.value.trim();
    chatInput.focus();
  };

  channel.onclose = () => {
    console.log("[Chat] Data channel closed");
    addSystemMessage("Chat disconnected");
    chatInput.disabled = true;
    sendBtn.disabled = true;
  };

  channel.onerror = (error) => {
    console.error("[Chat] Data channel error:", error);
  };

  channel.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "chat") {
        addMessage(data.text, data.from, false, data.ts);
      }
    } catch {
      console.warn("[Chat] Invalid message:", event.data);
    }
  };
}

async function makeOffer() {
  try {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit("signal", { type: "offer", sdp: peerConnection.localDescription });
  } catch (error) {
    console.error("[Chat] Make offer error:", error);
  }
}

async function handleSignal(data) {
  if (!peerConnection) {
    await createPeerConnection();
  }

  try {
    if (data.type === "offer") {
      console.log("[Chat] Received offer");
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit("signal", { type: "answer", sdp: peerConnection.localDescription });
    } else if (data.type === "answer") {
      console.log("[Chat] Received answer");
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.type === "candidate") {
      console.log("[Chat] Received ICE candidate");
      await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
  } catch (error) {
    console.error("[Chat] Signal handling error:", error);
  }
}

function sendMessage() {
  const text = chatInput.value.trim();
  if (!text || !dataChannel || dataChannel.readyState !== "open") return;

  const message = {
    type: "chat",
    text,
    from: settings.displayName || "Me",
    ts: Date.now(),
  };

  dataChannel.send(JSON.stringify(message));
  addMessage(text, "You", true, message.ts);
  chatInput.value = "";
  sendBtn.disabled = true;
}

function addMessage(text, from, isSent, timestamp) {
  const msg = document.createElement("div");
  msg.className = `message ${isSent ? "sent" : "received"}`;

  const time = formatTime(timestamp);
  msg.innerHTML = `
    ${escapeHtml(text)}
    <span class="message-time">${time}</span>
  `;

  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addSystemMessage(text) {
  const msg = document.createElement("div");
  msg.className = "message system";
  msg.textContent = text;
  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Storage helpers
async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["settings"], (result) => {
      resolve(result.settings || {});
    });
  });
}

async function loadPeers() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["peers"], (result) => {
      resolve(result.peers || {});
    });
  });
}

async function savePeers(peers) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ peers }, resolve);
  });
}

async function getDeviceId() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["deviceId"], (result) => {
      if (result.deviceId) {
        resolve(result.deviceId);
      } else {
        const newId = crypto.randomUUID();
        chrome.storage.sync.set({ deviceId: newId }, () => {
          resolve(newId);
        });
      }
    });
  });
}

// Utility functions
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;

  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;

  return date.toLocaleDateString();
}
