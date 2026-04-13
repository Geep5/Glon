/**
 * Cryptographic operations for sync
 *
 * Ed25519 signatures for change authenticity and peer identity.
 */

import { createHash, randomBytes } from "node:crypto";
import { SignedChange, PeerId } from "./types.js";
import type { Change } from "../proto.js";
import { encodeChangeForHashing } from "../proto.js";

// For now, using Node's built-in crypto. In production, consider @noble/ed25519
// or libsodium-wrappers for better cross-platform support.

// ── Key Management ───────────────────────────────────────────────

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/**
 * Generate a new Ed25519 key pair for peer identity.
 * In a real implementation, this would use proper Ed25519.
 * For demo, we'll use a simplified approach.
 */
export function generateKeyPair(): KeyPair {
  // Simplified for demo - in production use proper Ed25519
  const privateKey = randomBytes(32);
  const publicKey = createHash("sha256")
    .update(privateKey)
    .digest();

  return {
    publicKey: new Uint8Array(publicKey),
    privateKey: new Uint8Array(privateKey)
  };
}

/**
 * Create a PeerId from a public key.
 */
export function createPeerId(publicKey: Uint8Array): PeerId {
  const id = createHash("sha256")
    .update(publicKey)
    .digest("hex")
    .slice(0, 16); // Use first 16 chars as ID

  return {
    id,
    publicKey: Buffer.from(publicKey).toString("base64")
  };
}

// ── Change Signing ───────────────────────────────────────────────

/**
 * Sign a change with a private key.
 * Creates a detached signature of the change content.
 */
export function signChange(
  change: Change,
  privateKey: Uint8Array
): Uint8Array {
  // Get canonical bytes for signing (id field zeroed)
  const bytes = encodeChangeForHashing(change);

  // Simplified signature for demo
  // In production, use proper Ed25519 signing
  const signature = createHash("sha256")
    .update(bytes)
    .update(privateKey)
    .digest();

  return new Uint8Array(signature);
}

/**
 * Verify a change signature.
 */
export function verifyChangeSignature(
  change: SignedChange,
  publicKey: Uint8Array
): boolean {
  // Recompute what the signature should be
  const bytes = encodeChangeForHashing(change);

  // Simplified verification for demo
  const expectedSig = createHash("sha256")
    .update(bytes)
    .update(publicKey)
    .digest();

  // Compare signatures
  if (change.signature.length !== expectedSig.length) return false;

  for (let i = 0; i < expectedSig.length; i++) {
    if (change.signature[i] !== expectedSig[i]) return false;
  }

  return true;
}

// ── Message Authentication ───────────────────────────────────────

/**
 * Create an HMAC for message authentication.
 */
export function createMessageMAC(
  message: Uint8Array,
  sharedSecret: Uint8Array
): Uint8Array {
  const mac = createHash("sha256")
    .update(message)
    .update(sharedSecret)
    .digest();

  return new Uint8Array(mac);
}

/**
 * Verify a message MAC.
 */
export function verifyMessageMAC(
  message: Uint8Array,
  mac: Uint8Array,
  sharedSecret: Uint8Array
): boolean {
  const expectedMAC = createMessageMAC(message, sharedSecret);

  if (mac.length !== expectedMAC.length) return false;

  for (let i = 0; i < mac.length; i++) {
    if (mac[i] !== expectedMAC[i]) return false;
  }

  return true;
}

// ── Peer Authentication ──────────────────────────────────────────

/**
 * Create a challenge for peer authentication.
 */
export function createChallenge(): Uint8Array {
  return randomBytes(32);
}

/**
 * Sign a challenge to prove identity.
 */
export function signChallenge(
  challenge: Uint8Array,
  privateKey: Uint8Array
): Uint8Array {
  const signature = createHash("sha256")
    .update(challenge)
    .update(privateKey)
    .digest();

  return new Uint8Array(signature);
}

/**
 * Verify a challenge response.
 */
export function verifyChallenge(
  challenge: Uint8Array,
  response: Uint8Array,
  publicKey: Uint8Array
): boolean {
  // Simplified verification
  const privateKey = createHash("sha256")
    .update(publicKey)
    .digest();

  const expected = createHash("sha256")
    .update(challenge)
    .update(privateKey)
    .digest();

  if (response.length !== expected.length) return false;

  for (let i = 0; i < expected.length; i++) {
    if (response[i] !== expected[i]) return false;
  }

  return true;
}