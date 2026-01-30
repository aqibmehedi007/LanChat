/**
 * OfficeMesh LAN Scanner
 * 
 * Scans a subnet (e.g., 192.168.2.x) to discover peers running
 * the OfficeMesh signaling server. Uses parallel batches with
 * short timeouts for fast scanning.
 */

// Configuration
const SCAN_PORT = 5000;
const SCAN_TIMEOUT_MS = 2000; // 2 second timeout per IP
const BATCH_SIZE = 20; // Concurrent requests per batch
const SCAN_START = 1;
const SCAN_END = 255;

/**
 * Scan a single IP address for OfficeMesh signaling server
 * @param {string} ip - Full IP address to scan (e.g., "192.168.2.45")
 * @returns {Promise<object|null>} Server info if found, null otherwise
 */
async function scanSingleIP(ip) {
  const url = `http://${ip}:${SCAN_PORT}/info`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    // Validate this is actually an OfficeMesh server
    if (data.type !== "officemesh-signaling" || !data.deviceId) {
      return null;
    }

    // Return server info (not as a peer, but as a discovered server)
    return {
      ip: ip,
      serverDeviceId: data.deviceId,
      serverName: data.displayName || "OfficeMesh Server",
      version: data.version || "unknown",
    };
  } catch (error) {
    clearTimeout(timeoutId);
    // Silently ignore errors (timeout, network error, etc.)
    return null;
  }
}

/**
 * Fetch the list of online peers from a signaling server
 * @param {string} serverIp - IP address of the signaling server
 * @param {string} excludeDeviceId - Device ID to exclude (self)
 * @returns {Promise<object[]>} Array of peer objects
 */
async function fetchPeersFromServer(serverIp, excludeDeviceId) {
  const url = `http://${serverIp}:${SCAN_PORT}/peers?exclude=${encodeURIComponent(excludeDeviceId || "")}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    
    // Transform server response to peer format
    return (data.peers || []).map(peer => ({
      ip: peer.ip,
      deviceId: peer.deviceId,
      displayName: peer.displayName || "Anonymous",
      lastSeen: peer.lastSeen || Date.now(),
      online: true,
      serverIp: serverIp, // Track which server this peer is registered with
    }));
  } catch (error) {
    clearTimeout(timeoutId);
    console.error(`[Scanner] Failed to fetch peers from ${serverIp}:`, error);
    return [];
  }
}

/**
 * Scan a batch of IP addresses in parallel
 * @param {string[]} ips - Array of IP addresses to scan
 * @param {function} onProgress - Callback for progress updates
 * @returns {Promise<object[]>} Array of found peers
 */
async function scanBatch(ips, onProgress) {
  const results = await Promise.all(ips.map((ip) => scanSingleIP(ip)));
  const found = results.filter((result) => result !== null);

  if (onProgress) {
    onProgress(ips.length, found.length);
  }

  return found;
}

/**
 * Scan the entire subnet for OfficeMesh signaling servers,
 * then fetch the list of online peers from each server.
 * @param {string} subnet - Base subnet (e.g., "192.168.2")
 * @param {object} options - Scan options
 * @param {function} options.onProgress - Progress callback (scanned, total, foundSoFar)
 * @param {function} options.onPeerFound - Called when a peer is found
 * @param {function} options.onServerFound - Called when a server is found
 * @param {string} options.excludeDeviceId - Device ID to exclude (self)
 * @returns {Promise<object>} Scan results with peers map and servers list
 */
export async function scanSubnet(subnet, options = {}) {
  const { onProgress, onPeerFound, onServerFound, excludeDeviceId } = options;

  const allIPs = [];
  for (let i = SCAN_START; i <= SCAN_END; i++) {
    allIPs.push(`${subnet}.${i}`);
  }

  const servers = [];
  const peers = {};
  let scannedCount = 0;
  const totalCount = allIPs.length;
  const startTime = Date.now();

  // Phase 1: Find signaling servers
  for (let i = 0; i < allIPs.length; i += BATCH_SIZE) {
    const batch = allIPs.slice(i, i + BATCH_SIZE);

    const found = await scanBatch(batch, (scanned, foundInBatch) => {
      scannedCount += scanned;
      if (onProgress) {
        onProgress(scannedCount, totalCount, Object.keys(peers).length);
      }
    });

    // Collect found servers
    for (const server of found) {
      servers.push(server);
      if (onServerFound) {
        onServerFound(server);
      }
    }
  }

  // Phase 2: Fetch peer lists from all discovered servers
  for (const server of servers) {
    const serverPeers = await fetchPeersFromServer(server.ip, excludeDeviceId);
    
    for (const peer of serverPeers) {
      // Skip self
      if (excludeDeviceId && peer.deviceId === excludeDeviceId) {
        continue;
      }

      // Add or update peer (if same peer registered on multiple servers, use latest)
      if (!peers[peer.deviceId] || peer.lastSeen > peers[peer.deviceId].lastSeen) {
        peers[peer.deviceId] = peer;

        if (onPeerFound) {
          onPeerFound(peer);
        }
      }
    }
  }

  const duration = Date.now() - startTime;

  return {
    peers,
    servers,
    scannedCount: totalCount,
    foundCount: Object.keys(peers).length,
    serversFound: servers.length,
    durationMs: duration,
    subnet,
    timestamp: Date.now(),
  };
}

/**
 * Quick scan - fetch fresh peer lists from known servers
 * @param {object} knownPeers - Map of deviceId -> peer info (used to get server IPs)
 * @param {object} options - Scan options
 * @returns {Promise<object>} Updated peers map with online status
 */
export async function quickScan(knownPeers, options = {}) {
  const { onProgress, excludeDeviceId, knownServers = [] } = options;

  // Collect unique server IPs from known peers and known servers
  const serverIPs = new Set(knownServers);
  for (const peer of Object.values(knownPeers)) {
    if (peer.serverIp) {
      serverIPs.add(peer.serverIp);
    }
  }

  const updatedPeers = {};
  let scannedCount = 0;
  const totalServers = serverIPs.size;

  // Fetch peer lists from all known servers
  for (const serverIp of serverIPs) {
    const serverPeers = await fetchPeersFromServer(serverIp, excludeDeviceId);
    scannedCount++;

    if (onProgress) {
      onProgress(scannedCount, totalServers);
    }

    for (const peer of serverPeers) {
      if (!updatedPeers[peer.deviceId] || peer.lastSeen > updatedPeers[peer.deviceId].lastSeen) {
        updatedPeers[peer.deviceId] = peer;
      }
    }
  }

  // Mark peers not found as offline
  for (const [deviceId, peer] of Object.entries(knownPeers)) {
    if (!updatedPeers[deviceId]) {
      updatedPeers[deviceId] = {
        ...peer,
        online: false,
        lastChecked: Date.now(),
      };
    }
  }

  return {
    peers: updatedPeers,
    timestamp: Date.now(),
  };
}

/**
 * Load peers from Chrome storage
 * @returns {Promise<object>} Peers map
 */
export async function loadPeersFromStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["peers"], (result) => {
      resolve(result.peers || {});
    });
  });
}

/**
 * Save peers to Chrome storage
 * @param {object} peers - Peers map to save
 * @returns {Promise<void>}
 */
export async function savePeersToStorage(peers) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ peers }, resolve);
  });
}

/**
 * Merge newly found peers with existing cached peers
 * @param {object} existingPeers - Current cached peers
 * @param {object} newPeers - Newly discovered peers
 * @returns {object} Merged peers map
 */
export function mergePeers(existingPeers, newPeers) {
  const merged = { ...existingPeers };

  for (const [deviceId, peer] of Object.entries(newPeers)) {
    if (merged[deviceId]) {
      // Update existing peer
      merged[deviceId] = {
        ...merged[deviceId],
        ...peer,
        // Preserve custom nickname if set
        customName: merged[deviceId].customName,
      };
    } else {
      // New peer
      merged[deviceId] = peer;
    }
  }

  // Mark peers not in newPeers as offline
  for (const deviceId of Object.keys(merged)) {
    if (!newPeers[deviceId]) {
      merged[deviceId].online = false;
      merged[deviceId].lastChecked = Date.now();
    }
  }

  return merged;
}

/**
 * Get settings from Chrome storage
 * @returns {Promise<object>} Settings object
 */
export async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["settings"], (result) => {
      resolve(
        result.settings || {
          subnet: "192.168.1",
          displayName: "",
          autoScanInterval: 30,
        }
      );
    });
  });
}

/**
 * Save settings to Chrome storage
 * @param {object} settings - Settings to save
 * @returns {Promise<void>}
 */
export async function saveSettings(settings) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ settings }, resolve);
  });
}

/**
 * Get or generate device ID
 * @returns {Promise<string>} Device ID
 */
export async function getDeviceId() {
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
