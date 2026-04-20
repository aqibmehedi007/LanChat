/**
 * LAN Scanner — adapted from extension/lib/scanner.js.
 * No chrome.* APIs. Uses plain fetch().
 */

const SCAN_PORT    = 5000
const TIMEOUT_MS   = 2000
const BATCH_SIZE   = 20

/**
 * Scan the subnet for OfficeMesh signaling servers,
 * then fetch peer lists from each discovered server.
 *
 * @param {string} subnet  e.g. '192.168.1'
 * @param {{ onProgress?: (scanned:number, total:number) => void }} opts
 * @returns {Promise<{ peers: object, signalingServerUrl: string|null, foundCount: number }>}
 */
export async function scanNetwork(subnet, opts = {}) {
  const { onProgress } = opts

  const allIPs = []
  // Stop at .254 — .255 is the broadcast address and causes ERR_ADDRESS_INVALID
  for (let i = 1; i <= 254; i++) allIPs.push(`${subnet}.${i}`)

  const servers    = []
  const peers      = {}
  let   scanned    = 0
  const total      = allIPs.length

  // Phase 1 — find signaling servers
  for (let i = 0; i < allIPs.length; i += BATCH_SIZE) {
    const batch   = allIPs.slice(i, i + BATCH_SIZE)
    const results = await Promise.all(batch.map(scanIP))
    scanned += batch.length
    onProgress?.(scanned, total)

    for (const r of results) {
      if (r) servers.push(r)
    }
  }

  // Phase 2 — fetch peer lists
  for (const server of servers) {
    const serverPeers = await fetchPeers(server.ip)
    for (const peer of serverPeers) {
      if (!peers[peer.deviceId] || peer.lastSeen > peers[peer.deviceId].lastSeen) {
        peers[peer.deviceId] = peer
      }
    }
  }

  return {
    peers,
    signalingServerUrl: servers.length > 0 ? `http://${servers[0].ip}:${SCAN_PORT}` : null,
    foundCount: Object.keys(peers).length,
    serversFound: servers.length,
  }
}

async function scanIP(ip) {
  const controller = new AbortController()
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res  = await fetch(`http://${ip}:${SCAN_PORT}/info`, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) return null
    const data = await res.json()
    if (data.type !== 'officemesh-signaling' || !data.deviceId) return null
    return { ip, serverDeviceId: data.deviceId, serverName: data.displayName || 'OfficeMesh Server' }
  } catch {
    clearTimeout(timer)
    return null
  }
}

async function fetchPeers(serverIp) {
  const controller = new AbortController()
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res  = await fetch(`http://${serverIp}:${SCAN_PORT}/peers`, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) return []
    const data = await res.json()
    return (data.peers || []).map(p => ({
      ip:          p.ip,
      deviceId:    p.deviceId,
      displayName: p.displayName || 'Anonymous',
      lastSeen:    p.lastSeen || Date.now(),
      online:      true,
      serverIp,
    }))
  } catch {
    clearTimeout(timer)
    return []
  }
}
