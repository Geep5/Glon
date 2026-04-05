/**
 * Disk layer — raw protobuf on the hard drive.
 *
 * Each glon.Object is stored as a single file containing its
 * protobuf wire-format bytes. Nothing else. No JSON wrappers,
 * no SQLite, no filesystem metadata. The protobuf IS the file.
 *
 * Directory layout:
 *   ~/.glon/
 *     objects/
 *       <id>.pb          raw protobuf bytes (glon.Object)
 *
 * To inspect with protoc:
 *   protoc --decode=glon.Object proto/glon.proto < ~/.glon/objects/<id>.pb
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
	type GlonObject,
	encodeObject,
	decodeObject,
	createObject,
} from "./proto.js";

// ── Paths ─────────────────────────────────────────────────────────

const GLON_ROOT = process.env.GLON_DATA ?? join(homedir(), ".glon");
const OBJECTS_DIR = join(GLON_ROOT, "objects");

/** Ensure the storage directory exists. */
export function initDisk(): void {
	mkdirSync(OBJECTS_DIR, { recursive: true });
}

/** Sanitize an object ID for use as a filename. */
function idToFilename(id: string): string {
	// Replace characters that are unsafe in filenames
	return id.replace(/[/\\:*?"<>|]/g, "_") + ".pb";
}

function filePathFor(id: string): string {
	return join(OBJECTS_DIR, idToFilename(id));
}

// ── Write ─────────────────────────────────────────────────────────

/** Write a GlonObject to disk as raw protobuf bytes. */
export function writeToDisk(obj: GlonObject): void {
	const bytes = encodeObject(obj);
	writeFileSync(filePathFor(obj.id), bytes);
}

/** Write raw protobuf bytes to disk by ID. */
export function writeRawToDisk(id: string, bytes: Uint8Array): void {
	writeFileSync(filePathFor(id), bytes);
}

// ── Read ──────────────────────────────────────────────────────────

/** Read a GlonObject from disk. Returns null if not found. */
export function readFromDisk(id: string): GlonObject | null {
	const path = filePathFor(id);
	if (!existsSync(path)) return null;
	const bytes = readFileSync(path);
	return decodeObject(new Uint8Array(bytes));
}

/** Read raw protobuf bytes from disk. Returns null if not found. */
export function readRawFromDisk(id: string): Uint8Array | null {
	const path = filePathFor(id);
	if (!existsSync(path)) return null;
	return new Uint8Array(readFileSync(path));
}

// ── Delete ────────────────────────────────────────────────────────

/** Remove an object from disk. */
export function deleteFromDisk(id: string): boolean {
	const path = filePathFor(id);
	if (!existsSync(path)) return false;
	unlinkSync(path);
	return true;
}

// ── List / Stats ──────────────────────────────────────────────────

/** List all object IDs on disk. */
export function listOnDisk(): string[] {
	if (!existsSync(OBJECTS_DIR)) return [];
	return readdirSync(OBJECTS_DIR)
		.filter(f => f.endsWith(".pb"))
		.map(f => f.slice(0, -3).replace(/_/g, ":")); // reverse filename sanitization
}

/** Disk usage stats. */
export function diskStats(): { objectCount: number; totalBytes: number; path: string } {
	if (!existsSync(OBJECTS_DIR)) return { objectCount: 0, totalBytes: 0, path: OBJECTS_DIR };
	const files = readdirSync(OBJECTS_DIR).filter(f => f.endsWith(".pb"));
	let totalBytes = 0;
	for (const f of files) {
		totalBytes += statSync(join(OBJECTS_DIR, f)).size;
	}
	return { objectCount: files.length, totalBytes, path: GLON_ROOT };
}
