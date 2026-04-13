/**
 * Peer Discovery
 *
 * mDNS for local network discovery, manual for remote peers.
 */

import { EventEmitter } from "node:events";
import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";
import { PeerId, PeerMetadata } from "./types.js";
import { generateKeyPair, createPeerId } from "./crypto.js";

// ── mDNS Constants ───────────────────────────────────────────────

const MDNS_PORT = 5353;
const MDNS_MULTICAST_IPV4 = "224.0.0.251";
const MDNS_MULTICAST_IPV6 = "ff02::fb";
const SERVICE_NAME = "_glon._tcp.local";

// ── Peer Discovery Manager ───────────────────────────────────────

export class PeerDiscovery extends EventEmitter {
  private peers = new Map<string, PeerMetadata>();
  private localPeer: PeerId;
  private httpPort: number;
  private mdnsSocket?: ReturnType<typeof createSocket>;
  private announceInterval?: NodeJS.Timeout;

  constructor(httpPort: number = 6420) {
    super();
    this.httpPort = httpPort;

    // Generate local peer identity
    const keyPair = generateKeyPair();
    this.localPeer = createPeerId(keyPair.publicKey);
  }

  // ── Local Network Discovery (mDNS) ──────────────────────────────

  /**
   * Start mDNS discovery and announcement.
   */
  startMDNS(): void {
    this.mdnsSocket = createSocket("udp4");

    this.mdnsSocket.on("message", (msg, rinfo) => {
      this.handleMDNSMessage(msg, rinfo.address);
    });

    this.mdnsSocket.on("listening", () => {
      const address = this.mdnsSocket!.address();
      console.log(`[Discovery] mDNS listening on ${address.address}:${address.port}`);

      // Join multicast group
      this.mdnsSocket!.addMembership(MDNS_MULTICAST_IPV4);

      // Start announcing ourselves
      this.announcePresence();
      this.announceInterval = setInterval(() => {
        this.announcePresence();
      }, 30000); // Announce every 30 seconds
    });

    this.mdnsSocket.bind(MDNS_PORT);
  }

  /**
   * Stop mDNS discovery.
   */
  stopMDNS(): void {
    if (this.announceInterval) {
      clearInterval(this.announceInterval);
    }

    if (this.mdnsSocket) {
      this.mdnsSocket.close();
      this.mdnsSocket = undefined;
    }
  }

  /**
   * Announce our presence on the local network.
   */
  private announcePresence(): void {
    const announcement = this.createAnnouncement();
    const buffer = Buffer.from(JSON.stringify(announcement));

    this.mdnsSocket?.send(
      buffer,
      0,
      buffer.length,
      MDNS_PORT,
      MDNS_MULTICAST_IPV4,
      (err) => {
        if (err) {
          console.error("[Discovery] Failed to announce:", err);
        }
      }
    );
  }

  /**
   * Create an mDNS announcement message.
   */
  private createAnnouncement(): any {
    const localIP = this.getLocalIP();

    return {
      service: SERVICE_NAME,
      peerId: this.localPeer,
      endpoint: `http://${localIP}:${this.httpPort}`,
      timestamp: Date.now(),
      capabilities: ["sync", "gossip", "dag"],
    };
  }

  /**
   * Handle incoming mDNS messages.
   */
  private handleMDNSMessage(msg: Buffer, address: string): void {
    try {
      const data = JSON.parse(msg.toString());

      if (data.service !== SERVICE_NAME) return;
      if (data.peerId.id === this.localPeer.id) return; // Ignore our own messages

      const peer: PeerMetadata = {
        id: data.peerId,
        endpoint: data.endpoint,
        lastSeen: Date.now(),
        reputation: 50, // Start with neutral reputation
        capabilities: new Set(data.capabilities),
      };

      this.addPeer(peer);
    } catch (err) {
      // Ignore malformed messages
    }
  }

  /**
   * Get the local IP address for announcements.
   */
  private getLocalIP(): string {
    const interfaces = networkInterfaces();

    for (const name of Object.keys(interfaces)) {
      const addrs = interfaces[name];
      if (!addrs) continue;

      for (const addr of addrs) {
        if (addr.family === "IPv4" && !addr.internal) {
          return addr.address;
        }
      }
    }

    return "127.0.0.1";
  }

  // ── Manual Peer Management ──────────────────────────────────────

  /**
   * Manually add a remote peer.
   */
  addRemotePeer(endpoint: string, publicKey: string): void {
    const peerId = createPeerId(Buffer.from(publicKey, "base64"));

    const peer: PeerMetadata = {
      id: peerId,
      endpoint,
      lastSeen: Date.now(),
      reputation: 30, // Lower initial trust for manual peers
      capabilities: new Set(), // Will be discovered on first sync
    };

    this.addPeer(peer);
  }

  /**
   * Add or update a peer.
   */
  private addPeer(peer: PeerMetadata): void {
    const existing = this.peers.get(peer.id.id);

    if (!existing) {
      console.log(`[Discovery] New peer discovered: ${peer.id.id} at ${peer.endpoint}`);
      this.peers.set(peer.id.id, peer);
      this.emit("peer:discovered", peer);
    } else {
      // Update last seen and merge capabilities
      existing.lastSeen = peer.lastSeen;
      peer.capabilities.forEach((cap) => existing.capabilities.add(cap));
    }
  }

  /**
   * Remove a peer.
   */
  removePeer(peerId: string): void {
    if (this.peers.delete(peerId)) {
      console.log(`[Discovery] Peer removed: ${peerId}`);
      this.emit("peer:removed", peerId);
    }
  }

  // ── Peer Exchange Protocol ──────────────────────────────────────

  /**
   * Get a list of known peers for exchange.
   */
  getPeersForExchange(limit: number = 10): PeerMetadata[] {
    // Sort by reputation and recency
    const peers = Array.from(this.peers.values())
      .sort((a, b) => {
        const scoreA = a.reputation + (Date.now() - a.lastSeen) / -100000;
        const scoreB = b.reputation + (Date.now() - b.lastSeen) / -100000;
        return scoreB - scoreA;
      })
      .slice(0, limit);

    return peers;
  }

  /**
   * Process peers received from another peer.
   */
  processPeerExchange(peers: PeerMetadata[]): void {
    for (const peer of peers) {
      // Don't add ourselves
      if (peer.id.id === this.localPeer.id) continue;

      // Lower reputation for transitively discovered peers
      peer.reputation = Math.max(10, peer.reputation - 20);

      this.addPeer(peer);
    }
  }

  // ── Reputation Management ────────────────────────────────────────

  /**
   * Update peer reputation based on interaction outcome.
   */
  updateReputation(peerId: string, delta: number): void {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.reputation = Math.max(0, Math.min(100, peer.reputation + delta));

      // Remove peers with very low reputation
      if (peer.reputation < 5) {
        this.removePeer(peerId);
      }
    }
  }

  // ── Getters ──────────────────────────────────────────────────────

  getLocalPeer(): PeerId {
    return this.localPeer;
  }

  getPeer(peerId: string): PeerMetadata | undefined {
    return this.peers.get(peerId);
  }

  getAllPeers(): PeerMetadata[] {
    return Array.from(this.peers.values());
  }

  getHealthyPeers(): PeerMetadata[] {
    const cutoff = Date.now() - 5 * 60 * 1000; // 5 minutes
    return this.getAllPeers().filter(
      (p) => p.lastSeen > cutoff && p.reputation > 20
    );
  }
}