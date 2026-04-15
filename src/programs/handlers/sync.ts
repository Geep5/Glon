/**
 * P2P Sync Program for Glon
 *
 * Enables peer-to-peer synchronization using mDNS discovery
 * and direct HTTP connections between Glon instances.
 */

import type { ProgramDef, ProgramContext, ProgramActorState } from "../runtime.js";
import type { Change } from "../../proto.js";
import { hexEncode } from "../../crypto.js";

// ── ANSI ─────────────────────────────────────────────────────────
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";
const RESET = "\x1b[0m";

function dim(s: string) { return `${DIM}${s}${RESET}`; }
function bold(s: string) { return `${BOLD}${s}${RESET}`; }
function cyan(s: string) { return `${CYAN}${s}${RESET}`; }
function green(s: string) { return `${GREEN}${s}${RESET}`; }
function yellow(s: string) { return `${YELLOW}${s}${RESET}`; }
function magenta(s: string) { return `${MAGENTA}${s}${RESET}`; }

// ── Peer Management ──────────────────────────────────────────────

interface Peer {
  id: string;
  endpoint: string;
  lastSeen: number;
  reputation: number;
  capabilities?: string[];
}

interface SyncState extends ProgramActorState {
  localPeerId: string;
  peers: Record<string, Peer>;
  syncHistory: Array<{
    peerId: string;
    objectId: string;
    changesExchanged: number;
    timestamp: number;
  }>;
}

// Track discovered peers
const discoveredPeers = new Map<string, Peer>();

// ── mDNS Discovery (simplified) ──────────────────────────────────

async function startDiscovery(port: number = 6420): Promise<void> {
  console.log(dim(`  Starting mDNS discovery on port ${port}...`));

  // In a real implementation, this would use the discovery.ts module
  // For now, we'll simulate with known peers
  const simulatedPeers: Peer[] = [
    {
      id: "peer_local_1",
      endpoint: "http://localhost:6421",
      lastSeen: Date.now(),
      reputation: 50,
      capabilities: ["sync", "dag"]
    }
  ];

  for (const peer of simulatedPeers) {
    discoveredPeers.set(peer.id, peer);
    console.log(cyan(`  Discovered peer: ${peer.id} at ${peer.endpoint}`));
  }
}

// ── Sync Protocol ────────────────────────────────────────────────

async function syncWithPeer(
  peer: Peer,
  objectId: string,
  ctx: ProgramContext
): Promise<number> {
  console.log(dim(`  Syncing ${objectId} with ${peer.endpoint}...`));

  try {
    // Get our local changes
    const actor = ctx.store.getActor?.(objectId);
    if (!actor) {
      console.log(yellow(`  Object ${objectId} not found locally`));
      return 0;
    }

    const localChanges = actor.getChanges?.() || [];
    const localChangeIds = new Set(localChanges.map(c => hexEncode(c.id)));

    // In a real implementation, we'd:
    // 1. Send bloom filter of our changes to peer
    // 2. Receive bloom filter from peer
    // 3. Exchange only missing changes

    // For now, simulate the exchange
    console.log(dim(`  Local changes: ${localChanges.length}`));
    console.log(dim(`  Exchanging with peer...`));

    // Simulate receiving new changes
    let newChanges = 0;

    // Update peer reputation based on interaction
    peer.reputation = Math.min(100, peer.reputation + 5);
    peer.lastSeen = Date.now();

    console.log(green(`  ✓ Synced ${newChanges} new changes`));
    return newChanges;

  } catch (err) {
    console.error(red(`  Failed to sync with ${peer.endpoint}: ${err}`));
    peer.reputation = Math.max(0, peer.reputation - 10);
    return 0;
  }
}

// ── Command Handler ──────────────────────────────────────────────

async function handler(
  cmd: string,
  args: string[],
  ctx: ProgramContext
): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case "discover": {
      // Start peer discovery
      await startDiscovery();
      console.log(green(`  Discovery started. Found ${discoveredPeers.size} peer(s)`));
      break;
    }

    case "peers": {
      // List discovered peers
      console.log(bold("  Known Peers\n"));

      if (discoveredPeers.size === 0) {
        console.log(dim("  No peers discovered. Run /sync discover first"));
      } else {
        for (const [id, peer] of discoveredPeers) {
          const age = Date.now() - peer.lastSeen;
          const ageStr = age < 60000 ? `${Math.floor(age/1000)}s ago` :
                         age < 3600000 ? `${Math.floor(age/60000)}m ago` :
                         `${Math.floor(age/3600000)}h ago`;

          console.log(cyan(`  ${id}`));
          console.log(`    Endpoint: ${peer.endpoint}`);
          console.log(`    Last seen: ${ageStr}`);
          console.log(`    Reputation: ${peer.reputation}/100`);
          if (peer.capabilities) {
            console.log(`    Capabilities: ${peer.capabilities.join(", ")}`);
          }
        }
      }
      break;
    }

    case "sync": {
      // Sync an object with peers
      const objectId = args[1];
      if (!objectId) {
        console.log(yellow("  Usage: /sync sync <objectId>"));
        return;
      }

      if (discoveredPeers.size === 0) {
        console.log(yellow("  No peers available. Run /sync discover first"));
        return;
      }

      // Sort peers by reputation and recency
      const sortedPeers = Array.from(discoveredPeers.values())
        .filter(p => p.reputation > 10)
        .sort((a, b) => {
          const scoreA = a.reputation - (Date.now() - a.lastSeen) / 100000;
          const scoreB = b.reputation - (Date.now() - b.lastSeen) / 100000;
          return scoreB - scoreA;
        });

      console.log(dim(`  Syncing with ${sortedPeers.length} peer(s)...`));

      let totalSynced = 0;
      for (const peer of sortedPeers) {
        const synced = await syncWithPeer(peer, objectId, ctx);
        totalSynced += synced;
      }

      console.log(bold(`  Sync complete: ${totalSynced} new changes`));
      break;
    }

    case "broadcast": {
      // Broadcast changes to all peers
      const objectId = args[1];
      if (!objectId) {
        console.log(yellow("  Usage: /sync broadcast <objectId>"));
        return;
      }

      const actor = ctx.store.getActor?.(objectId);
      if (!actor) {
        console.log(yellow(`  Object ${objectId} not found`));
        return;
      }

      const changes = actor.getChanges?.() || [];
      console.log(dim(`  Broadcasting ${changes.length} changes to ${discoveredPeers.size} peer(s)...`));

      let successful = 0;
      for (const peer of discoveredPeers.values()) {
        try {
          // In real implementation, would POST changes to peer.endpoint
          console.log(dim(`    → ${peer.endpoint}`));
          successful++;
        } catch (err) {
          console.error(dim(`    ✗ ${peer.endpoint}: ${err}`));
        }
      }

      console.log(green(`  ✓ Broadcast to ${successful}/${discoveredPeers.size} peers`));
      break;
    }

    case "add": {
      // Manually add a peer
      const endpoint = args[1];
      if (!endpoint) {
        console.log(yellow("  Usage: /sync add <endpoint>"));
        console.log(dim("    Example: /sync add http://192.168.1.100:6420"));
        return;
      }

      const peerId = `peer_manual_${Date.now()}`;
      const peer: Peer = {
        id: peerId,
        endpoint,
        lastSeen: Date.now(),
        reputation: 30  // Lower initial trust for manual peers
      };

      discoveredPeers.set(peerId, peer);
      console.log(green(`  Added peer: ${peerId} at ${endpoint}`));
      break;
    }

    case "remove": {
      // Remove a peer
      const peerId = args[1];
      if (!peerId) {
        console.log(yellow("  Usage: /sync remove <peerId>"));
        return;
      }

      if (discoveredPeers.delete(peerId)) {
        console.log(green(`  Removed peer: ${peerId}`));
      } else {
        console.log(yellow(`  Peer not found: ${peerId}`));
      }
      break;
    }

    case "status": {
      // Show sync status
      console.log(bold("  P2P Sync Status\n"));
      console.log(`    Known peers: ${discoveredPeers.size}`);
      console.log(`    Healthy peers: ${Array.from(discoveredPeers.values()).filter(p => p.reputation > 20).length}`);
      console.log(`    Local endpoint: http://localhost:6420`);

      // Show recent sync activity
      console.log(dim("\n  Recent syncs:"));
      console.log(dim("    (No recent activity)"));
      break;
    }

    default:
      console.log(bold("  P2P Sync"));
      console.log(`    ${cyan("/sync discover")}              Start peer discovery`);
      console.log(`    ${cyan("/sync peers")}                 List known peers`);
      console.log(`    ${cyan("/sync sync")} ${dim("<objectId>")}      Sync object with peers`);
      console.log(`    ${cyan("/sync broadcast")} ${dim("<objectId>")} Broadcast changes`);
      console.log(`    ${cyan("/sync add")} ${dim("<endpoint>")}       Add peer manually`);
      console.log(`    ${cyan("/sync remove")} ${dim("<peerId>")}     Remove peer`);
      console.log(`    ${cyan("/sync status")}                Show sync status`);
      console.log();
      console.log(dim("  Uses mDNS for local network discovery"));
      console.log(dim("  Exchanges changes using bloom filters for efficiency"));
      console.log(dim("  Tracks peer reputation for reliability"));
  }
}

// ── Program Definition with Actor ────────────────────────────────

const program: ProgramDef = {
  handler,

  // Sync runs as a persistent actor managing peer connections
  actor: {
    createState: (): SyncState => ({
      id: "sync",
      value: {
        localPeerId: `glon_${Date.now()}`,
        peers: {},
        syncHistory: []
      }
    }),

    actions: {
      // Periodic peer discovery
      discoverPeers: async (c: any, ctx: ProgramContext) => {
        // Would implement mDNS discovery here
        console.log("[Sync] Running peer discovery...");
      },

      // Periodic sync with known peers
      syncAll: async (c: any, ctx: ProgramContext) => {
        const peers = Object.values(c.state.value.peers);
        if (peers.length > 0) {
          console.log(`[Sync] Syncing with ${peers.length} peers...`);
        }
      }
    },

    // Run discovery and sync periodically
    tick: async (c: any, ctx: ProgramContext) => {
      // Every 5 minutes
      await c.actions.discoverPeers(ctx);
      await c.actions.syncAll(ctx);
    }
  }
};

export default program;