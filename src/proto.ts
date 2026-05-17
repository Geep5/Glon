/**
 * Legacy shim — preserved so the Astrolabe UI (which symlinks this src/
 * tree as the "glon" package) can still boot without all panels working.
 * The AH window doesn't use any of this; it goes through /dispatch.
 * Safe to delete once Astrolabe drops its non-AH panels.
 */

export type Change = { ops?: unknown[]; objectId?: string; timestamp?: number; id?: Uint8Array; author?: string };
export type Block = { content?: any };
export type Value = unknown;
export type ObjectLink = { targetId?: string };

export function decodeChange(_bytes: Uint8Array): Change {
	return { ops: [] };
}
export function unwrapValue(_v: unknown): unknown {
	return null;
}
