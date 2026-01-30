/**
 * OfficeMesh Background Service Worker
 * 
 * Handles:
 * - Automatic periodic scanning via Chrome alarms
 * - Badge updates showing online peer count
 * - Message passing between popup and background
 */

// Constants
const ALARM_NAME = "officemesh-auto-scan";
const DEFAULT_SCAN_INTERVAL = 30; // minutes
const SCAN_PORT = 5000;
const SCAN_TIMEOUT_MS = 2000;
const BATCH_SIZE = 20;

// State
let isScanning = false;

/**
 * Initialize the extension on install/update
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log("[OfficeMesh] Extension installed/updated:", details.reason);

  // Generate device ID if needed
  await getOrCreateDeviceId();

  // Set up default settings
  const settings = await getSettings();
  if (!settings.subnet) {
    await saveSettings({
      subnet: "192.168.1",
      displayName: "",
      autoScanInterval: DEFAULT_SCAN_INTERVAL,
    });
  }

  // Set up auto-scan alarm
  await setupAlarm(settings.autoScanInterval || DEFAULT_SCAN_INTERVAL);

  // Initial badge
  updateBadge(0);
});

/**
 * Handle Chrome startup
 */
chrome.runtime.onStartup.addListener(async () => {
  console.log("[OfficeMesh] Chrome started");

  const settings = await getSettings();
  await setupAlarm(settings.autoScanInterval || DEFAULT_SCAN_INTERVAL);

  // Do a quick scan on startup
  const peers = await loadPeers();
  const onlineCount = Object.values(peers).filter((p) => p.online).length;
  updateBadge(onlineCount);
});

/**
 * Handle alarm events (periodic scanning)
 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    console.log("[OfficeMesh] Auto-scan triggered");
    await performScan();
  }
});

/**
 * Handle messages from popup
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[OfficeMesh] Message received:", message.type);

  switch (message.type) {
    case "START_SCAN":
      handleStartScan(message.subnet).then(sendResponse);
      return true; // Async response

    case "QUICK_SCAN":
      handleQuickScan().then(sendResponse);
      return true;

    case "GET_STATUS":
      sendResponse({
        isScanning,
        timestamp: Date.now(),
      });
      break;

    case "UPDATE_SETTINGS":
      handleUpdateSettings(message.settings).then(sendResponse);
      return true;

    case "GET_PEERS":
      loadPeers().then(sendResponse);
      return true;

    case "UPDATE_BADGE":
      updateBadge(message.count);
      sendResponse({ success: true });
      break;

    default:
      sendResponse({ error: "Unknown message type" });
  }
});

/**
 * Set up or update the auto-scan alarm
 */
async function setupAlarm(intervalMinutes) {
  // Clear existing alarm
  await chrome.alarms.clear(ALARM_NAME);

  if (intervalMinutes > 0) {
    await chrome.alarms.create(ALARM_NAME, {
      periodInMinutes: intervalMinutes,
    });
    console.log(`[OfficeMesh] Auto-scan alarm set for every ${intervalMinutes} minutes`);
  }
}

/**
 * Handle manual scan request from popup
 */
async function handleStartScan(subnet) {
  if (isScanning) {
    return { success: false, error: "Scan already in progress" };
  }

  const settings = await getSettings();
  const targetSubnet = subnet || settings.subnet || "192.168.1";

  return await performScan(targetSubnet);
}

/**
 * Handle quick scan (fetch fresh peer lists from known servers)
 */
async function handleQuickScan() {
  if (isScanning) {
    return { success: false, error: "Scan already in progress" };
  }

  isScanning = true;
  const deviceId = await getOrCreateDeviceId();
  const existingPeers = await loadPeers();

  try {
    // Collect known server IPs from existing peers and stored signaling server
    const serverIPs = new Set();
    
    // Get stored signaling server
    const stored = await chrome.storage.local.get(["signalingServerUrl"]);
    if (stored.signalingServerUrl) {
      try {
        const url = new URL(stored.signalingServerUrl);
        serverIPs.add(url.hostname);
      } catch {}
    }
    
    // Get server IPs from known peers
    for (const peer of Object.values(existingPeers)) {
      if (peer.serverIp) {
        serverIPs.add(peer.serverIp);
      }
    }

    const foundPeers = {};

    // Fetch peer lists from all known servers
    for (const serverIp of serverIPs) {
      const serverPeers = await fetchPeersFromServer(serverIp, deviceId);
      
      for (const peer of serverPeers) {
        if (peer.deviceId === deviceId) continue;
        
        if (!foundPeers[peer.deviceId] || peer.lastSeen > foundPeers[peer.deviceId].lastSeen) {
          foundPeers[peer.deviceId] = peer;
        }
      }
    }

    // Merge: update found peers as online, mark others as offline
    const updatedPeers = {};
    
    for (const [id, peer] of Object.entries(existingPeers)) {
      if (foundPeers[id]) {
        updatedPeers[id] = {
          ...peer,
          ...foundPeers[id],
          customName: peer.customName, // Preserve custom name
        };
      } else {
        updatedPeers[id] = {
          ...peer,
          online: false,
          lastChecked: Date.now(),
        };
      }
    }
    
    // Add any newly discovered peers
    for (const [id, peer] of Object.entries(foundPeers)) {
      if (!updatedPeers[id]) {
        updatedPeers[id] = peer;
      }
    }

    await savePeers(updatedPeers);
    const onlineCount = Object.values(updatedPeers).filter((p) => p.online).length;
    updateBadge(onlineCount);

    return {
      success: true,
      peers: updatedPeers,
      onlineCount,
    };
  } finally {
    isScanning = false;
  }
}

/**
 * Perform a full subnet scan
 */
async function performScan(subnet) {
  isScanning = true;
  const settings = await getSettings();
  const targetSubnet = subnet || settings.subnet || "192.168.1";
  const deviceId = await getOrCreateDeviceId();
  const existingPeers = await loadPeers();

  console.log(`[OfficeMesh] Starting scan of ${targetSubnet}.1-255`);

  try {
    const foundServers = [];
    const foundPeers = {};
    const allIPs = [];

    for (let i = 1; i <= 255; i++) {
      allIPs.push(`${targetSubnet}.${i}`);
    }

    // Phase 1: Find signaling servers
    for (let i = 0; i < allIPs.length; i += BATCH_SIZE) {
      const batch = allIPs.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map((ip) => scanSingleIP(ip)));

      for (const result of results) {
        if (result) {
          foundServers.push(result);
          console.log(`[OfficeMesh] Found server at ${result.ip}`);
        }
      }

      // Send progress update
      chrome.runtime.sendMessage({
        type: "SCAN_PROGRESS",
        scanned: Math.min(i + BATCH_SIZE, allIPs.length),
        total: allIPs.length,
        found: Object.keys(foundPeers).length,
        phase: "servers",
      }).catch(() => {}); // Ignore if popup is closed
    }

    console.log(`[OfficeMesh] Found ${foundServers.length} signaling server(s)`);

    // Phase 2: Fetch peer lists from all discovered servers
    for (const server of foundServers) {
      const serverPeers = await fetchPeersFromServer(server.ip, deviceId);
      console.log(`[OfficeMesh] Server ${server.ip} has ${serverPeers.length} registered peer(s)`);
      
      for (const peer of serverPeers) {
        // Skip self
        if (peer.deviceId === deviceId) continue;
        
        // Add or update peer (use latest if seen on multiple servers)
        if (!foundPeers[peer.deviceId] || peer.lastSeen > foundPeers[peer.deviceId].lastSeen) {
          foundPeers[peer.deviceId] = peer;
        }
      }
    }

    // Save the first server found as our signaling server
    let signalingServerUrl = null;
    if (foundServers.length > 0) {
      signalingServerUrl = `http://${foundServers[0].ip}:${SCAN_PORT}`;
      await chrome.storage.local.set({ signalingServerUrl });
    }

    // Merge with existing peers
    const mergedPeers = mergePeers(existingPeers, foundPeers);
    await savePeers(mergedPeers);

    const onlineCount = Object.values(mergedPeers).filter((p) => p.online).length;
    updateBadge(onlineCount);

    console.log(`[OfficeMesh] Scan complete: found ${onlineCount} online peer(s) on ${foundServers.length} server(s)`);

    return {
      success: true,
      peers: mergedPeers,
      foundCount: Object.keys(foundPeers).length,
      onlineCount,
      serversFound: foundServers.length,
      signalingServerUrl,
    };
  } catch (error) {
    console.error("[OfficeMesh] Scan error:", error);
    return {
      success: false,
      error: error.message,
    };
  } finally {
    isScanning = false;
  }
}

/**
 * Handle settings update from popup
 */
async function handleUpdateSettings(newSettings) {
  const currentSettings = await getSettings();
  const merged = { ...currentSettings, ...newSettings };

  await saveSettings(merged);

  // Update alarm if interval changed
  if (newSettings.autoScanInterval !== undefined) {
    await setupAlarm(newSettings.autoScanInterval);
  }

  return { success: true, settings: merged };
}

/**
 * Scan a single IP for OfficeMesh signaling server
 * Returns server info if found (NOT a peer)
 */
async function scanSingleIP(ip) {
  const url = `http://${ip}:${SCAN_PORT}/info`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) return null;

    const data = await response.json();

    if (data.type !== "officemesh-signaling" || !data.deviceId) {
      return null;
    }

    // Return server info (not a peer)
    return {
      ip,
      serverDeviceId: data.deviceId,
      serverName: data.displayName || "OfficeMesh Server",
      version: data.version || "unknown",
    };
  } catch {
    clearTimeout(timeoutId);
    return null;
  }
}

/**
 * Fetch list of online peers from a signaling server
 */
async function fetchPeersFromServer(serverIp, excludeDeviceId) {
  const url = `http://${serverIp}:${SCAN_PORT}/peers?exclude=${encodeURIComponent(excludeDeviceId || "")}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) return [];

    const data = await response.json();

    // Transform to peer format with serverIp
    return (data.peers || []).map(peer => ({
      ip: peer.ip,
      deviceId: peer.deviceId,
      displayName: peer.displayName || "Anonymous",
      lastSeen: peer.lastSeen || Date.now(),
      online: true,
      serverIp: serverIp,
    }));
  } catch {
    clearTimeout(timeoutId);
    return [];
  }
}

/**
 * Merge new peers with existing cached peers
 */
function mergePeers(existing, newPeers) {
  const merged = {};

  // First, add all existing peers and mark as offline
  for (const [id, peer] of Object.entries(existing)) {
    merged[id] = {
      ...peer,
      online: false,
      lastChecked: Date.now(),
    };
  }

  // Then update/add newly found peers
  for (const [id, peer] of Object.entries(newPeers)) {
    merged[id] = {
      ...merged[id],
      ...peer,
      online: true,
      // Preserve custom name if exists
      customName: merged[id]?.customName,
    };
  }

  return merged;
}

/**
 * Update extension badge with online peer count
 */
function updateBadge(count) {
  const text = count > 0 ? String(count) : "";
  const color = count > 0 ? "#22c55e" : "#6b7280";

  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// Storage helpers
async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["settings"], (result) => {
      resolve(result.settings || {});
    });
  });
}

async function saveSettings(settings) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ settings }, resolve);
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

async function getOrCreateDeviceId() {
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

console.log("[OfficeMesh] Service worker loaded");
