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
 * @returns {Promise<object|null>} Peer info if found, null otherwise
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

    return {
      ip: ip,
      deviceId: data.deviceId,
      displayName: data.displayName || "Anonymous",
      version: data.version || "unknown",
      lastSeen: Date.now(),
      online: true,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    // Silently ignore errors (timeout, network error, etc.)
    return null;
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
 * Scan the entire subnet for OfficeMesh peers
 * @param {string} subnet - Base subnet (e.g., "192.168.2")
 * @param {object} options - Scan options
 * @param {function} options.onProgress - Progress callback (scanned, total, foundSoFar)
 * @param {function} options.onPeerFound - Called when a peer is found
 * @param {string} options.excludeDeviceId - Device ID to exclude (self)
 * @returns {Promise<object>} Scan results with peers map
 */
export async function scanSubnet(subnet, options = {}) {
  const { onProgress, onPeerFound, excludeDeviceId } = options;

  const allIPs = [];
  for (let i = SCAN_START; i <= SCAN_END; i++) {
    allIPs.push(`${subnet}.${i}`);
  }

  const peers = {};
  let scannedCount = 0;
  const totalCount = allIPs.length;
  const startTime = Date.now();

  // Process in batches
  for (let i = 0; i < allIPs.length; i += BATCH_SIZE) {
    const batch = allIPs.slice(i, i + BATCH_SIZE);

    const found = await scanBatch(batch, (scanned, foundInBatch) => {
      scannedCount += scanned;
      if (onProgress) {
        onProgress(scannedCount, totalCount, Object.keys(peers).length);
      }
    });

    // Add found peers
    for (const peer of found) {
      // Skip self
      if (excludeDeviceId && peer.deviceId === excludeDeviceId) {
        continue;
      }

      peers[peer.deviceId] = peer;

      if (onPeerFound) {
        onPeerFound(peer);
      }
    }
  }

  const duration = Date.now() - startTime;

  return {
    peers,
    scannedCount: totalCount,
    foundCount: Object.keys(peers).length,
    durationMs: duration,
    subnet,
    timestamp: Date.now(),
  };
}

/**
 * Quick scan - check only previously known IPs
 * @param {object} knownPeers - Map of deviceId -> peer info
 * @param {object} options - Scan options
 * @returns {Promise<object>} Updated peers map with online status
 */
export async function quickScan(knownPeers, options = {}) {
  const { onProgress, excludeDeviceId } = options;

  const ips = Object.values(knownPeers).map((p) => p.ip);
  const updatedPeers = {};
  let scannedCount = 0;

  for (const peer of Object.values(knownPeers)) {
    const result = await scanSingleIP(peer.ip);
    scannedCount++;

    if (onProgress) {
      onProgress(scannedCount, ips.length);
    }

    if (result && (!excludeDeviceId || result.deviceId !== excludeDeviceId)) {
      // Peer is online
      updatedPeers[result.deviceId] = {
        ...peer,
        ...result,
        online: true,
      };
    } else {
      // Peer is offline - keep cached data but mark offline
      updatedPeers[peer.deviceId] = {
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
