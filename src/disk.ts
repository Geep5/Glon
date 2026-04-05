/**
 * Disk layer — raw protobuf change files on disk.
 *
 * Each Change is stored as a single file containing its protobuf
 * wire-format bytes, named by its content-address (hex SHA-256).
 *
 * Directory layout:
 *   ~/.glon/
 *     changes/
 *       <hex-hash>.pb    raw protobuf bytes (glon.Change)
 */

import {
	mkdirSync,
	writeFileSync,
	readFileSync,
	readdirSync,
	existsSync,
	unlinkSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { encodeChange, decodeChange, type Change } from "./proto.js";
import { hexEncode } from "./crypto.js";

// ── Paths ──────────────────────────────────────────────────────────

const GLON_ROOT = process.env.GLON_DATA ?? join(homedir(), ".glon");
const CHANGES_DIR = join(GLON_ROOT, "changes");

export function getGlonRoot(): string {
	return GLON_ROOT;
}

/** Ensure the storage directories exist. */
export function initDisk(): void {
	mkdirSync(CHANGES_DIR, { recursive: true });
}

// ── Write ──────────────────────────────────────────────────────────

/** Write a Change to disk as raw protobuf bytes. */
export function writeChange(change: Change): void {
	const bytes = encodeChange(change);
	const hex = hexEncode(change.id);
	writeFileSync(join(CHANGES_DIR, `${hex}.pb`), bytes);
}

// ── Read ───────────────────────────────────────────────────────────

/** Read a Change by its binary id. Returns null if not found. */
export function readChange(id: Uint8Array): Change | null {
	return readChangeByHex(hexEncode(id));
}

/** Read a Change by its hex id. Returns null if not found. */
export function readChangeByHex(hexId: string): Change | null {
	const path = join(CHANGES_DIR, `${hexId}.pb`);
	if (!existsSync(path)) return null;
	return decodeChange(new Uint8Array(readFileSync(path)));
}

// ── List ───────────────────────────────────────────────────────────

/** List hex ids of all stored changes. */
export function listChangeFiles(): string[] {
	if (!existsSync(CHANGES_DIR)) return [];
	return readdirSync(CHANGES_DIR)
		.filter((f) => f.endsWith(".pb"))
		.map((f) => f.slice(0, -3));
}

// ── Delete ─────────────────────────────────────────────────────────

/** Remove a change file by binary id. */
export function deleteChangeFile(id: Uint8Array): boolean {
	const path = join(CHANGES_DIR, `${hexEncode(id)}.pb`);
	if (!existsSync(path)) return false;
	unlinkSync(path);
	return true;
}

// ── Stats ──────────────────────────────────────────────────────────

/** Disk usage stats. */
export function diskStats(): {
	changeCount: number;
	totalBytes: number;
	path: string;
} {
	if (!existsSync(CHANGES_DIR)) {
		return { changeCount: 0, totalBytes: 0, path: GLON_ROOT };
	}
	const files = readdirSync(CHANGES_DIR).filter((f) => f.endsWith(".pb"));
	let totalBytes = 0;
	for (const f of files) {
		totalBytes += statSync(join(CHANGES_DIR, f)).size;
	}
	return { changeCount: files.length, totalBytes, path: GLON_ROOT };
}
