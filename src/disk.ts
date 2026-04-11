/**
 * Disk layer — raw protobuf change files on disk.
 *
 * Each Change is stored as a single file containing its protobuf
 * wire-format bytes, named by its content-address (hex SHA-256).
 *
 * Directory layout:
 *   ~/.glon/
 *     changes/
 *       <objectId>/
 *         <hex-hash>.pb    raw protobuf bytes (glon.Change)
 */

import {
	mkdirSync,
	writeFileSync,
	readFileSync,
	readdirSync,
	existsSync,
	unlinkSync,
	statSync,
	renameSync,
	rmSync,
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

/** Ensure the storage directories exist, then migrate any flat-layout files. */
export function initDisk(): void {
	mkdirSync(CHANGES_DIR, { recursive: true });
	migrateFlatToNested();
}

// ── Migration ─────────────────────────────────────────────────────

/**
 * Move any `.pb` files sitting directly in `changes/` into per-object
 * subdirectories (`changes/<objectId>/<hex>.pb`). Idempotent — no-op
 * when the flat dir contains no `.pb` files.
 */
function migrateFlatToNested(): void {
	const entries = readdirSync(CHANGES_DIR, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".pb")) continue;
		const flatPath = join(CHANGES_DIR, entry.name);
		try {
			const change = decodeChange(new Uint8Array(readFileSync(flatPath)));
			const objectDir = join(CHANGES_DIR, change.objectId);
			mkdirSync(objectDir, { recursive: true });
			renameSync(flatPath, join(objectDir, entry.name));
		} catch {
			// Corrupt file — leave it in place; don't block startup.
		}
	}
}

// ── Write ──────────────────────────────────────────────────────────

/** Write a Change to disk as raw protobuf bytes under its object subdirectory. */
export function writeChange(change: Change): void {
	const objectDir = join(CHANGES_DIR, change.objectId);
	mkdirSync(objectDir, { recursive: true });
	const bytes = encodeChange(change);
	const hex = hexEncode(change.id);
	writeFileSync(join(objectDir, `${hex}.pb`), bytes);
}

// ── Read ───────────────────────────────────────────────────────────

/** Read a Change by its binary id. Returns null if not found. */
export function readChange(id: Uint8Array, objectId?: string): Change | null {
	return readChangeByHex(hexEncode(id), objectId);
}

/**
 * Read a Change by its hex id. If `objectId` is provided, reads directly
 * from `changes/<objectId>/<hex>.pb` (fast path). Otherwise scans all
 * subdirectories (cold path for CLI inspection).
 */
export function readChangeByHex(hexId: string, objectId?: string): Change | null {
	if (objectId) {
		const path = join(CHANGES_DIR, objectId, `${hexId}.pb`);
		if (!existsSync(path)) return null;
		return decodeChange(new Uint8Array(readFileSync(path)));
	}
	// Cold path: scan all object subdirs
	if (!existsSync(CHANGES_DIR)) return null;
	for (const entry of readdirSync(CHANGES_DIR, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const path = join(CHANGES_DIR, entry.name, `${hexId}.pb`);
		if (existsSync(path)) {
			return decodeChange(new Uint8Array(readFileSync(path)));
		}
	}
	return null;
}

// ── List ───────────────────────────────────────────────────────────

/** List hex ids of changes for a specific object (hot path). */
export function listChangeFilesForObject(objectId: string): string[] {
	const dir = join(CHANGES_DIR, objectId);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".pb"))
		.map((f) => f.slice(0, -3));
}

/** List hex ids of all stored changes across all objects (cold path). */
export function listChangeFiles(): string[] {
	if (!existsSync(CHANGES_DIR)) return [];
	const result: string[] = [];
	for (const entry of readdirSync(CHANGES_DIR, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const subdir = join(CHANGES_DIR, entry.name);
		for (const f of readdirSync(subdir)) {
			if (f.endsWith(".pb")) result.push(f.slice(0, -3));
		}
	}
	return result;
}

// ── Delete ─────────────────────────────────────────────────────────

/** Remove a change file by binary id. Reads the change to find its objectId. */
export function deleteChangeFile(id: Uint8Array, objectId?: string): boolean {
	const hex = hexEncode(id);
	if (objectId) {
		const path = join(CHANGES_DIR, objectId, `${hex}.pb`);
		if (!existsSync(path)) return false;
		unlinkSync(path);
		return true;
	}
	// No objectId — scan subdirs
	if (!existsSync(CHANGES_DIR)) return false;
	for (const entry of readdirSync(CHANGES_DIR, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const path = join(CHANGES_DIR, entry.name, `${hex}.pb`);
		if (existsSync(path)) {
			unlinkSync(path);
			return true;
		}
	}
	return false;
}

/** Remove the entire object subdirectory (all changes for that object). */
export function deleteChangesForObject(objectId: string): void {
	const dir = join(CHANGES_DIR, objectId);
	if (!existsSync(dir)) return;
	rmSync(dir, { recursive: true, force: true });
}

// ── Stats ──────────────────────────────────────────────────────────

/** Disk usage stats across all object subdirectories. */
export function diskStats(): {
	changeCount: number;
	totalBytes: number;
	path: string;
} {
	if (!existsSync(CHANGES_DIR)) {
		return { changeCount: 0, totalBytes: 0, path: GLON_ROOT };
	}
	let changeCount = 0;
	let totalBytes = 0;
	for (const entry of readdirSync(CHANGES_DIR, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const subdir = join(CHANGES_DIR, entry.name);
		for (const f of readdirSync(subdir)) {
			if (!f.endsWith(".pb")) continue;
			changeCount++;
			totalBytes += statSync(join(subdir, f)).size;
		}
	}
	return { changeCount, totalBytes, path: GLON_ROOT };
}
