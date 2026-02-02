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

// Tab navigation
const tabNav = document.getElementById("tab-nav");
const tabBtns = document.querySelectorAll(".tab-btn");

// Groups view
const groupsView = document.getElementById("groups-view");
const groupsList = document.getElementById("groups-list");
const groupsEmptyState = document.getElementById("groups-empty-state");
const refreshGroupsBtn = document.getElementById("refresh-groups-btn");
const createGroupBtn = document.getElementById("create-group-btn");

// Group chat view
const groupChatView = document.getElementById("group-chat-view");
const groupBackBtn = document.getElementById("group-back-btn");
const groupChatName = document.getElementById("group-chat-name");
const groupMemberCount = document.getElementById("group-member-count");
const leaveGroupBtn = document.getElementById("leave-group-btn");
const groupChatMessages = document.getElementById("group-chat-messages");
const groupChatInput = document.getElementById("group-chat-input");
const groupSendBtn = document.getElementById("group-send-btn");

// Create group modal
const createGroupModal = document.getElementById("create-group-modal");
const newGroupNameInput = document.getElementById("new-group-name");
const cancelGroupBtn = document.getElementById("cancel-group-btn");
const confirmCreateGroupBtn = document.getElementById("confirm-create-group-btn");

// Call controls
const callBtn = document.getElementById("call-btn");
const muteBtn = document.getElementById("mute-btn");
const endCallBtn = document.getElementById("end-call-btn");
const incomingCallOverlay = document.getElementById("incoming-call-overlay");
const incomingCallName = document.getElementById("incoming-call-name");
const acceptCallBtn = document.getElementById("accept-call-btn");
const rejectCallBtn = document.getElementById("reject-call-btn");
const callStatusBar = document.getElementById("call-status-bar");
const callStatusText = document.getElementById("call-status-text");
const callDuration = document.getElementById("call-duration");

// File transfer
const attachBtn = document.getElementById("attach-btn");
const fileInput = document.getElementById("file-input");

// State
let peers = {};
let settings = {};
let myDeviceId = null;
let myLocalIP = null; // Our detected LAN IP
let currentPeer = null;
let signalingServerUrl = null; // URL of the signaling server we're registered with

// WebRTC state
let socket = null;
let peerConnection = null;
let dataChannel = null;
let isInitiator = false;

// Presence registration socket (kept alive while popup is open)
let presenceSocket = null;

// Audio call state
let localStream = null;
let callState = "idle"; // idle, calling, ringing, in-call
let isMuted = false;
let callStartTime = null;
let callTimerInterval = null;

// File transfer state
const pendingFiles = new Map(); // fileId -> { name, size, mimeType, chunks: [], received: 0 }
const CHUNK_SIZE = 16 * 1024; // 16KB chunks

// Group chat state
let groups = [];
let currentGroup = null;

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

// Initialize popup
document.addEventListener("DOMContentLoaded", init);

/**
 * Detect local LAN IP address using WebRTC
 * This creates a temporary RTCPeerConnection to discover local IP
 */
async function detectLocalIP() {
  return new Promise((resolve) => {
    const pc = new RTCPeerConnection({ iceServers: [] });
    const ips = new Set();
    
    pc.createDataChannel("");
    
    pc.onicecandidate = (event) => {
      if (!event.candidate) {
        pc.close();
        // Return the first non-localhost IPv4 address found
        for (const ip of ips) {
          if (!ip.startsWith("127.") && !ip.includes(":")) {
            console.log("[IP Detection] Detected local IP:", ip);
            resolve(ip);
            return;
          }
        }
        // Fallback: use subnet from settings
        resolve(null);
        return;
      }
      
      // Parse IP from candidate string
      const candidate = event.candidate.candidate;
      const ipMatch = candidate.match(/(\d{1,3}\.){3}\d{1,3}/);
      if (ipMatch) {
        ips.add(ipMatch[0]);
      }
    };
    
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch(() => resolve(null));
    
    // Timeout after 3 seconds
    setTimeout(() => {
      pc.close();
      resolve(null);
    }, 3000);
  });
}

async function init() {
  console.log("[Popup] Initializing...");

  // Load device ID
  myDeviceId = await getDeviceId();
  deviceIdEl.textContent = myDeviceId;

  // Detect local IP address
  myLocalIP = await detectLocalIP();
  console.log("[Popup] My local IP:", myLocalIP);

  // Load settings
  settings = await loadSettings();
  displayNameInput.value = settings.displayName || "";
  subnetInput.value = settings.subnet || "192.168.1";
  autoScanInterval.value = String(settings.autoScanInterval || 30);

  // Load signaling server URL from storage
  signalingServerUrl = await getSignalingServerUrl();

  // Load peers
  peers = await loadPeers();
  renderPeers();

  // Set up event listeners
  setupEventListeners();

  // Listen for scan progress from background
  chrome.runtime.onMessage.addListener(handleBackgroundMessage);

  // Connect to signaling server and register presence
  if (signalingServerUrl) {
    connectToSignalingServer(signalingServerUrl);
    // Load groups after connecting
    setTimeout(loadGroups, 1000);
  }

  console.log("[Popup] Initialized with", Object.keys(peers).length, "cached peers");
}

/**
 * Get saved signaling server URL from storage
 */
async function getSignalingServerUrl() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["signalingServerUrl"], (result) => {
      resolve(result.signalingServerUrl || null);
    });
  });
}

/**
 * Save signaling server URL to storage
 */
async function saveSignalingServerUrl(url) {
  signalingServerUrl = url;
  return new Promise((resolve) => {
    chrome.storage.local.set({ signalingServerUrl: url }, resolve);
  });
}

/**
 * Connect to a signaling server and register our presence
 */
function connectToSignalingServer(serverUrl) {
  if (presenceSocket) {
    presenceSocket.disconnect();
  }

  console.log("[Presence] Connecting to signaling server:", serverUrl);

  presenceSocket = io(serverUrl, {
    transports: ["websocket", "polling"],
    timeout: 5000,
  });

  presenceSocket.on("connect", () => {
    console.log("[Presence] Connected to signaling server");
    // Register ourselves as an online peer (include our detected LAN IP)
    presenceSocket.emit("register_peer", {
      deviceId: myDeviceId,
      displayName: settings.displayName || "Anonymous",
      ip: myLocalIP, // Send our detected LAN IP
    });
    updateStatusIndicator(true);
  });

  presenceSocket.on("connect_error", (error) => {
    console.error("[Presence] Connection error:", error);
    updateStatusIndicator(false);
  });

  presenceSocket.on("disconnect", () => {
    console.log("[Presence] Disconnected from signaling server");
    updateStatusIndicator(false);
  });

  // Group chat events
  presenceSocket.on("group_created", (data) => {
    console.log("[Groups] Group created:", data);
    currentGroup = data;
    groupChatName.textContent = data.name;
    groupMemberCount.textContent = `${data.memberCount} online`;
    groupChatMessages.innerHTML = "";
    addGroupSystemMessage("You created this group");
    showView("group-chat");
    groupChatInput.disabled = false;
    groupSendBtn.disabled = true;
  });

  presenceSocket.on("group_joined", (data) => {
    console.log("[Groups] Joined group:", data);
    currentGroup = data;
    groupChatName.textContent = data.name;
    groupMemberCount.textContent = `${data.memberCount} online`;
    groupChatMessages.innerHTML = "";
    addGroupSystemMessage("You joined the group");
    showView("group-chat");
    groupChatInput.disabled = false;
    groupSendBtn.disabled = true;
  });

  presenceSocket.on("group_member_joined", (data) => {
    console.log("[Groups] Member joined:", data);
    if (currentGroup && currentGroup.id === data.groupId) {
      groupMemberCount.textContent = `${data.memberCount} online`;
      addGroupSystemMessage(`${data.displayName} joined the group`);
    }
  });

  presenceSocket.on("group_member_left", (data) => {
    console.log("[Groups] Member left:", data);
    if (currentGroup && currentGroup.id === data.groupId) {
      groupMemberCount.textContent = `${data.memberCount} online`;
      addGroupSystemMessage(`${data.displayName} left the group`);
    }
  });

  presenceSocket.on("group_message_received", (data) => {
    console.log("[Groups] Message received:", data);
    if (currentGroup && currentGroup.id === data.groupId) {
      const isSent = data.from === (settings.displayName || "Anonymous");
      addGroupMessage(data.text, data.from, isSent, data.ts);
    }
  });

  presenceSocket.on("group_error", (data) => {
    console.error("[Groups] Error:", data);
    alert(data.error || "Group error");
  });
}

/**
 * Update the status indicator in the header
 */
function updateStatusIndicator(connected) {
  if (statusIndicator) {
    statusIndicator.classList.toggle("connected", connected);
    statusIndicator.title = connected ? "Connected to signaling server" : "Not connected";
  }
}

function setupEventListeners() {
  // Navigation
  settingsBtn.addEventListener("click", () => showView("settings"));
  settingsBackBtn.addEventListener("click", () => showView("peers"));
  backBtn.addEventListener("click", () => {
    endCall();
    disconnectFromPeer();
    showView("peers");
  });

  // Tab navigation
  tabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      tabBtns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      
      if (tab === "peers") {
        peersView.classList.remove("hidden");
        groupsView.classList.add("hidden");
      } else if (tab === "groups") {
        peersView.classList.add("hidden");
        groupsView.classList.remove("hidden");
        loadGroups();
      }
    });
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

  // Call controls
  callBtn.addEventListener("click", startCall);
  muteBtn.addEventListener("click", toggleMute);
  endCallBtn.addEventListener("click", endCall);
  acceptCallBtn.addEventListener("click", acceptCall);
  rejectCallBtn.addEventListener("click", rejectCall);

  // File transfer
  attachBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", handleFileSelect);

  // Groups
  refreshGroupsBtn.addEventListener("click", loadGroups);
  createGroupBtn.addEventListener("click", () => createGroupModal.classList.remove("hidden"));
  cancelGroupBtn.addEventListener("click", () => {
    createGroupModal.classList.add("hidden");
    newGroupNameInput.value = "";
  });
  confirmCreateGroupBtn.addEventListener("click", createGroup);
  
  // Group chat
  groupBackBtn.addEventListener("click", () => {
    leaveGroup();
    showView("groups");
  });
  leaveGroupBtn.addEventListener("click", () => {
    leaveGroup();
    showView("groups");
  });
  groupSendBtn.addEventListener("click", sendGroupMessage);
  groupChatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendGroupMessage();
    }
  });
  groupChatInput.addEventListener("input", () => {
    groupSendBtn.disabled = !groupChatInput.value.trim() || !currentGroup;
  });
}

// View navigation
function showView(viewName) {
  peersView.classList.add("hidden");
  groupsView.classList.add("hidden");
  chatView.classList.add("hidden");
  groupChatView.classList.add("hidden");
  settingsView.classList.add("hidden");
  
  // Show/hide tab nav based on view
  const showTabs = ["peers", "groups"].includes(viewName);
  tabNav.classList.toggle("hidden", !showTabs);

  switch (viewName) {
    case "peers":
      peersView.classList.remove("hidden");
      // Update tab state
      tabBtns.forEach(b => b.classList.toggle("active", b.dataset.tab === "peers"));
      break;
    case "groups":
      groupsView.classList.remove("hidden");
      // Update tab state
      tabBtns.forEach(b => b.classList.toggle("active", b.dataset.tab === "groups"));
      break;
    case "chat":
      chatView.classList.remove("hidden");
      chatInput.focus();
      break;
    case "group-chat":
      groupChatView.classList.remove("hidden");
      groupChatInput.focus();
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
      
      // Connect to the signaling server if found
      if (result.signalingServerUrl) {
        await saveSignalingServerUrl(result.signalingServerUrl);
        connectToSignalingServer(result.signalingServerUrl);
      }
      
      const serverMsg = result.serversFound ? ` (${result.serversFound} server)` : "";
      progressText.textContent = `Found ${result.foundCount} peer(s)${serverMsg}`;
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
    // Use the signaling server where the peer is registered
    // Both peers must connect to the SAME server to meet in the room
    const serverIp = peer.serverIp || (signalingServerUrl ? new URL(signalingServerUrl).hostname : null);
    
    if (!serverIp) {
      throw new Error("No signaling server available. Try scanning first.");
    }
    
    const serverUrl = `http://${serverIp}:5000`;
    console.log(`[Chat] Connecting to signaling server: ${serverUrl}`);
    
    socket = io(serverUrl, {
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
      endCall();
    });

    // Call signaling events
    socket.on("call_request", (data) => {
      console.log("[Call] Incoming call from:", data.from);
      if (callState === "idle") {
        callState = "ringing";
        incomingCallName.textContent = data.from || "Unknown";
        incomingCallOverlay.classList.remove("hidden");
      }
    });

    socket.on("call_accepted", async (data) => {
      console.log("[Call] Call accepted");
      if (callState === "calling") {
        callState = "in-call";
        updateCallUI();
        addSystemMessage("Call connected");
      }
    });

    socket.on("call_rejected", (data) => {
      console.log("[Call] Call rejected");
      if (callState === "calling") {
        callState = "idle";
        updateCallUI();
        stopLocalStream();
        addSystemMessage("Call was declined");
      }
    });

    socket.on("call_ended", (data) => {
      console.log("[Call] Call ended by peer");
      endCall();
      addSystemMessage("Call ended");
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
      
      switch (data.type) {
        case "chat":
          addMessage(data.text, data.from, false, data.ts);
          break;
        case "file_start":
          handleFileStart(data);
          break;
        case "file_chunk":
          handleFileChunk(data);
          break;
        case "file_end":
          handleFileEnd(data);
          break;
        default:
          console.warn("[Chat] Unknown message type:", data.type);
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

function scrollToBottom(container) {
  // Use requestAnimationFrame to ensure DOM has updated before scrolling
  requestAnimationFrame(() => {
    container.scrollTop = container.scrollHeight;
  });
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
  scrollToBottom(chatMessages);
}

function addSystemMessage(text) {
  const msg = document.createElement("div");
  msg.className = "message system";
  msg.textContent = text;
  chatMessages.appendChild(msg);
  scrollToBottom(chatMessages);
}

// ============================================
// Audio Calling
// ============================================

async function startCall() {
  if (callState !== "idle" || !socket) return;
  
  console.log("[Call] Starting call...");
  
  try {
    // Request microphone access
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    // Add audio track to peer connection
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
    
    callState = "calling";
    updateCallUI();
    
    // Signal call request
    socket.emit("call_request", {
      from: settings.displayName || "Anonymous"
    });
    
    addSystemMessage("Calling...");
    
    // Set up remote audio handling
    peerConnection.ontrack = (event) => {
      console.log("[Call] Remote track received");
      const audio = new Audio();
      audio.srcObject = event.streams[0];
      audio.play().catch(e => console.error("[Call] Audio play error:", e));
    };
  } catch (error) {
    console.error("[Call] Failed to start call:", error);
    addSystemMessage("Failed to access microphone");
    callState = "idle";
    updateCallUI();
  }
}

async function acceptCall() {
  if (callState !== "ringing" || !socket) return;
  
  console.log("[Call] Accepting call...");
  incomingCallOverlay.classList.add("hidden");
  
  try {
    // Request microphone access
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    // Add audio track to peer connection
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
    
    callState = "in-call";
    updateCallUI();
    
    // Signal call accepted
    socket.emit("call_accepted", {});
    
    addSystemMessage("Call connected");
    
    // Set up remote audio handling
    peerConnection.ontrack = (event) => {
      console.log("[Call] Remote track received");
      const audio = new Audio();
      audio.srcObject = event.streams[0];
      audio.play().catch(e => console.error("[Call] Audio play error:", e));
    };
    
    // Renegotiate to include audio
    if (isInitiator) {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      socket.emit("signal", { type: "offer", sdp: peerConnection.localDescription });
    }
  } catch (error) {
    console.error("[Call] Failed to accept call:", error);
    addSystemMessage("Failed to access microphone");
    rejectCall();
  }
}

function rejectCall() {
  if (callState !== "ringing" || !socket) return;
  
  console.log("[Call] Rejecting call...");
  incomingCallOverlay.classList.add("hidden");
  
  socket.emit("call_rejected", {});
  callState = "idle";
  updateCallUI();
}

function endCall() {
  if (callState === "idle") return;
  
  console.log("[Call] Ending call...");
  
  if (socket && callState !== "idle") {
    socket.emit("call_ended", {});
  }
  
  stopLocalStream();
  incomingCallOverlay.classList.add("hidden");
  callState = "idle";
  updateCallUI();
}

function toggleMute() {
  if (!localStream) return;
  
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(track => {
    track.enabled = !isMuted;
  });
  
  muteBtn.classList.toggle("muted", isMuted);
  muteBtn.title = isMuted ? "Unmute microphone" : "Mute microphone";
}

function stopLocalStream() {
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  isMuted = false;
  
  // Stop call timer
  if (callTimerInterval) {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
  }
  callStartTime = null;
}

function updateCallUI() {
  const isIdle = callState === "idle";
  const isCalling = callState === "calling";
  const isInCall = callState === "in-call";
  
  // Show/hide buttons
  callBtn.classList.toggle("hidden", !isIdle);
  muteBtn.classList.toggle("hidden", isIdle);
  endCallBtn.classList.toggle("hidden", isIdle);
  
  // Call status bar
  callStatusBar.classList.toggle("hidden", isIdle);
  callStatusBar.classList.toggle("calling", isCalling);
  
  if (isCalling) {
    callStatusText.textContent = "Calling...";
    callDuration.textContent = "";
  } else if (isInCall) {
    callStatusText.textContent = "In call";
    // Start call timer
    callStartTime = Date.now();
    callTimerInterval = setInterval(updateCallDuration, 1000);
  }
}

function updateCallDuration() {
  if (!callStartTime) return;
  
  const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  callDuration.textContent = `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

// ============================================
// File Transfer
// ============================================

function handleFileSelect(event) {
  const files = event.target.files;
  if (!files.length || !dataChannel || dataChannel.readyState !== "open") return;
  
  for (const file of files) {
    sendFile(file);
  }
  
  // Clear input
  fileInput.value = "";
}

async function sendFile(file) {
  const fileId = crypto.randomUUID();
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  
  console.log(`[File] Sending ${file.name} (${formatFileSize(file.size)}) in ${totalChunks} chunks`);
  
  // Add file message to UI
  const msgId = addFileMessage(file.name, file.size, true, 0);
  
  // Send file metadata
  dataChannel.send(JSON.stringify({
    type: "file_start",
    fileId,
    name: file.name,
    size: file.size,
    mimeType: file.type || "application/octet-stream",
    totalChunks
  }));
  
  // Read and send chunks
  const reader = new FileReader();
  let offset = 0;
  let chunkIndex = 0;
  
  const readNextChunk = () => {
    const slice = file.slice(offset, offset + CHUNK_SIZE);
    reader.readAsDataURL(slice);
  };
  
  reader.onload = () => {
    // Extract base64 data (remove data URL prefix)
    const base64Data = reader.result.split(",")[1];
    
    dataChannel.send(JSON.stringify({
      type: "file_chunk",
      fileId,
      index: chunkIndex,
      data: base64Data
    }));
    
    offset += CHUNK_SIZE;
    chunkIndex++;
    
    // Update progress
    const progress = Math.round((offset / file.size) * 100);
    updateFileProgress(msgId, Math.min(progress, 100));
    
    if (offset < file.size) {
      // Small delay to prevent overwhelming the data channel
      setTimeout(readNextChunk, 10);
    } else {
      // Send file complete
      dataChannel.send(JSON.stringify({
        type: "file_end",
        fileId
      }));
      console.log(`[File] Finished sending ${file.name}`);
    }
  };
  
  readNextChunk();
}

function handleFileStart(data) {
  console.log(`[File] Receiving ${data.name} (${formatFileSize(data.size)})`);
  
  pendingFiles.set(data.fileId, {
    name: data.name,
    size: data.size,
    mimeType: data.mimeType,
    totalChunks: data.totalChunks,
    chunks: [],
    received: 0,
    msgId: addFileMessage(data.name, data.size, false, 0)
  });
}

function handleFileChunk(data) {
  const file = pendingFiles.get(data.fileId);
  if (!file) return;
  
  file.chunks[data.index] = data.data;
  file.received++;
  
  // Update progress
  const progress = Math.round((file.received / file.totalChunks) * 100);
  updateFileProgress(file.msgId, progress);
}

function handleFileEnd(data) {
  const file = pendingFiles.get(data.fileId);
  if (!file) return;
  
  console.log(`[File] Finished receiving ${file.name}`);
  
  // Combine chunks and create blob
  const binaryData = file.chunks.map(chunk => {
    const binary = atob(chunk);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  });
  
  const blob = new Blob(binaryData, { type: file.mimeType });
  const url = URL.createObjectURL(blob);
  
  // Update UI with download button
  completeFileMessage(file.msgId, url, file.name);
  
  pendingFiles.delete(data.fileId);
}

function addFileMessage(name, size, isSent, progress) {
  const msgId = `file-${Date.now()}`;
  const msg = document.createElement("div");
  msg.className = `message file-message ${isSent ? "sent" : "received"}`;
  msg.id = msgId;
  
  msg.innerHTML = `
    <div class="file-message-content">
      <div class="file-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
        </svg>
      </div>
      <div class="file-info">
        <span class="file-name">${escapeHtml(name)}</span>
        <span class="file-size">${formatFileSize(size)}</span>
        <div class="file-progress">
          <div class="file-progress-fill" style="width: ${progress}%"></div>
        </div>
      </div>
    </div>
  `;
  
  chatMessages.appendChild(msg);
  scrollToBottom(chatMessages);
  
  return msgId;
}

function updateFileProgress(msgId, progress) {
  const msg = document.getElementById(msgId);
  if (!msg) return;
  
  const progressFill = msg.querySelector(".file-progress-fill");
  if (progressFill) {
    progressFill.style.width = `${progress}%`;
  }
}

function completeFileMessage(msgId, downloadUrl, fileName) {
  const msg = document.getElementById(msgId);
  if (!msg) return;
  
  const progressEl = msg.querySelector(".file-progress");
  if (progressEl) {
    progressEl.remove();
  }
  
  const fileInfo = msg.querySelector(".file-info");
  if (fileInfo) {
    const downloadBtn = document.createElement("button");
    downloadBtn.className = "btn btn-sm file-download-btn";
    downloadBtn.textContent = "Download";
    downloadBtn.addEventListener("click", () => {
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = fileName;
      a.click();
    });
    fileInfo.appendChild(downloadBtn);
  }
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
}

// ============================================
// Group Chat
// ============================================

async function loadGroups() {
  if (!signalingServerUrl) {
    console.log("[Groups] No signaling server URL");
    return;
  }
  
  try {
    const url = new URL(signalingServerUrl);
    const response = await fetch(`http://${url.hostname}:5000/groups`);
    const data = await response.json();
    
    groups = data.groups || [];
    renderGroups();
  } catch (error) {
    console.error("[Groups] Failed to load groups:", error);
  }
}

function renderGroups() {
  if (groups.length === 0) {
    groupsEmptyState.classList.remove("hidden");
    const items = groupsList.querySelectorAll(".group-item");
    items.forEach(item => item.remove());
    return;
  }
  
  groupsEmptyState.classList.add("hidden");
  
  // Clear existing items
  const existingItems = groupsList.querySelectorAll(".group-item");
  existingItems.forEach(item => item.remove());
  
  // Render groups
  for (const group of groups) {
    const item = createGroupItem(group);
    groupsList.appendChild(item);
  }
}

function createGroupItem(group) {
  const item = document.createElement("div");
  item.className = "group-item";
  item.dataset.groupId = group.id;
  
  const initial = group.name.charAt(0).toUpperCase();
  
  item.innerHTML = `
    <div class="group-avatar">${initial}</div>
    <div class="group-info">
      <div class="group-name">${escapeHtml(group.name)}</div>
      <div class="group-meta">${group.memberCount} member${group.memberCount !== 1 ? "s" : ""} online</div>
    </div>
  `;
  
  item.addEventListener("click", () => joinGroup(group.id));
  
  return item;
}

function createGroup() {
  const name = newGroupNameInput.value.trim() || "Office Chat";
  
  if (!presenceSocket) {
    alert("Not connected to server");
    return;
  }
  
  createGroupModal.classList.add("hidden");
  newGroupNameInput.value = "";
  
  presenceSocket.emit("create_group", { name });
}

function joinGroup(groupId) {
  if (!presenceSocket) {
    alert("Not connected to server");
    return;
  }
  
  presenceSocket.emit("join_group", {
    groupId,
    displayName: settings.displayName || "Anonymous"
  });
}

function leaveGroup() {
  if (!presenceSocket || !currentGroup) return;
  
  presenceSocket.emit("leave_group", {
    groupId: currentGroup.id,
    displayName: settings.displayName || "Anonymous"
  });
  
  currentGroup = null;
  groupChatInput.disabled = true;
  groupSendBtn.disabled = true;
}

function sendGroupMessage() {
  const text = groupChatInput.value.trim();
  if (!text || !presenceSocket || !currentGroup) return;
  
  presenceSocket.emit("group_message", {
    groupId: currentGroup.id,
    text,
    from: settings.displayName || "Anonymous"
  });
  
  groupChatInput.value = "";
  groupSendBtn.disabled = true;
}

function addGroupMessage(text, from, isSent, timestamp) {
  const msg = document.createElement("div");
  msg.className = `message ${isSent ? "sent" : "received"}`;
  
  const time = formatTime(timestamp);
  msg.innerHTML = `
    <span class="message-sender">${escapeHtml(from)}</span>
    ${escapeHtml(text)}
    <span class="message-time">${time}</span>
  `;
  
  groupChatMessages.appendChild(msg);
  scrollToBottom(groupChatMessages);
}

function addGroupSystemMessage(text) {
  const msg = document.createElement("div");
  msg.className = "message system";
  msg.textContent = text;
  groupChatMessages.appendChild(msg);
  scrollToBottom(groupChatMessages);
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
