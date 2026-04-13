/**
 * Sync Protocol Types
 *
 * Core types for decentralized sync between Glon instances.
 */

import type { Change } from "../proto.js";

// ── Peer Management ──────────────────────────────────────────────

export interface PeerId {
  id: string;           // Unique peer identifier (public key hash)
  publicKey: string;    // Ed25519 public key for verification
}

export interface PeerMetadata {
  id: PeerId;
  endpoint: string;     // HTTP endpoint for sync
  lastSeen: number;     // Timestamp of last successful contact
  reputation: number;   // Trust score (0-100)
  capabilities: Set<string>; // Supported features
}

// ── Vector Clocks ────────────────────────────────────────────────

export interface VectorClock {
  [actorId: string]: number;  // Actor ID -> sequence number
}

export function compareVectorClocks(a: VectorClock, b: VectorClock):
  "concurrent" | "before" | "after" | "equal" {
  let aGreater = false;
  let bGreater = false;

  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);

  for (const key of allKeys) {
    const aVal = a[key] || 0;
    const bVal = b[key] || 0;

    if (aVal > bVal) aGreater = true;
    if (bVal > aVal) bGreater = true;
  }

  if (!aGreater && !bGreater) return "equal";
  if (aGreater && !bGreater) return "after";
  if (bGreater && !aGreater) return "before";
  return "concurrent";
}

export function mergeVectorClocks(a: VectorClock, b: VectorClock): VectorClock {
  const result: VectorClock = {};
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);

  for (const key of allKeys) {
    result[key] = Math.max(a[key] || 0, b[key] || 0);
  }

  return result;
}

// ── Sync Protocol Messages ───────────────────────────────────────

export interface SyncRequest {
  peerId: PeerId;
  objectIds?: string[];      // Specific objects to sync (undefined = all)
  types?: string[];          // Filter by object types
  since?: VectorClock;       // Only changes after this clock
  maxChanges?: number;       // Limit response size
}

export interface SyncResponse {
  peerId: PeerId;
  changes: SignedChange[];
  heads: { [objectId: string]: string[] }; // Current head hashes per object
  vectorClock: VectorClock;  // Peer's current vector clock
  hasMore: boolean;          // Pagination flag
}

export interface SignedChange extends Change {
  signature: Uint8Array;     // Ed25519 signature of change
  vectorClock: VectorClock;  // Causal dependencies
}

// ── Bloom Filters for Content Advertising ────────────────────────

export class BloomFilter {
  private bits: Uint8Array;
  private numHashes: number;

  constructor(size: number = 10000, numHashes: number = 3) {
    this.bits = new Uint8Array(Math.ceil(size / 8));
    this.numHashes = numHashes;
  }

  private hash(item: string, seed: number): number {
    let hash = seed;
    for (let i = 0; i < item.length; i++) {
      hash = ((hash << 5) - hash) + item.charCodeAt(i);
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash) % (this.bits.length * 8);
  }

  add(item: string): void {
    for (let i = 0; i < this.numHashes; i++) {
      const bit = this.hash(item, i);
      const byte = Math.floor(bit / 8);
      const bitInByte = bit % 8;
      this.bits[byte] |= (1 << bitInByte);
    }
  }

  has(item: string): boolean {
    for (let i = 0; i < this.numHashes; i++) {
      const bit = this.hash(item, i);
      const byte = Math.floor(bit / 8);
      const bitInByte = bit % 8;
      if (!(this.bits[byte] & (1 << bitInByte))) {
        return false;
      }
    }
    return true;
  }

  serialize(): Uint8Array {
    return this.bits;
  }

  static deserialize(bits: Uint8Array, numHashes: number = 3): BloomFilter {
    const filter = new BloomFilter(bits.length * 8, numHashes);
    filter.bits = bits;
    return filter;
  }
}

// ── Merkle Tree for Efficient Diff ───────────────────────────────

export class MerkleNode {
  hash: string;
  left?: MerkleNode;
  right?: MerkleNode;

  constructor(hash: string, left?: MerkleNode, right?: MerkleNode) {
    this.hash = hash;
    this.left = left;
    this.right = right;
  }

  isLeaf(): boolean {
    return !this.left && !this.right;
  }
}

export interface MerkleDiff {
  missing: string[];    // Hashes we don't have
  extra: string[];      // Hashes they don't have
  common: string[];     // Shared hashes
}

// ── Gossip Protocol ──────────────────────────────────────────────

export interface GossipMessage {
  peerId: PeerId;
  heads: { [objectId: string]: string[] };  // Advertise current heads
  bloomFilter: Uint8Array;                  // Serialized bloom filter of content
  vectorClock: VectorClock;                 // Peer's vector clock
  peers: PeerMetadata[];                    // Known peers (peer exchange)
}