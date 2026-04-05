/**
 * Store actor — the coordinator.
 *
 * Single instance (key: ["root"]) that indexes every object in the OS.
 * Uses per-actor SQLite for fast queries by kind, name, id.
 * Creates/destroys object actors and keeps the index in sync.
 *
 * This is the entry point for all OS operations:
 *   store.create(kind, name, content?)  →  spins up an object actor
 *   store.list(kind?)                   →  queries the SQLite index
 *   store.get(id)                       →  looks up a single ref
 *   store.delete(id)                    →  destroys the object actor
 */

import { actor } from "rivetkit";
import { db } from "rivetkit/db";
import { deriveId, type GlonObjectRef } from "../proto.js";

export interface CreateInput {
	kind: string;
	name: string;
	content?: string; // base64
	meta?: Record<string, string>;
}

export const storeActor = actor({
	state: { objectCount: 0 },

	db: db({
		onMigrate: async (database) => {
			await database.execute(`
				CREATE TABLE IF NOT EXISTS objects (
					id   TEXT PRIMARY KEY,
					kind TEXT NOT NULL,
					name TEXT NOT NULL,
					size INTEGER NOT NULL DEFAULT 0,
					created_at INTEGER NOT NULL DEFAULT 0
				)
			`);
			await database.execute(`
				CREATE INDEX IF NOT EXISTS idx_objects_kind ON objects(kind)
			`);
			await database.execute(`
				CREATE INDEX IF NOT EXISTS idx_objects_name ON objects(name)
			`);
		},
	}),

	actions: {
		/** Create a new object. Returns the assigned ID. */
		create: async (c, input: CreateInput): Promise<string> => {
			const id = deriveId(input.kind, input.name);

			// Upsert into local index
			const contentBytes = input.content
				? Buffer.from(input.content, "base64").byteLength
				: 0;
			const now = Date.now();

			await c.db.execute(
				`INSERT OR REPLACE INTO objects (id, kind, name, size, created_at)
				 VALUES (?, ?, ?, ?, ?)`,
				id,
				input.kind,
				input.name,
				contentBytes,
				now,
			);

			c.state.objectCount++;
			return id;
		},

		/** List objects. Optionally filter by kind. */
		list: async (c, kind?: string): Promise<GlonObjectRef[]> => {
			if (kind) {
				return (await c.db.execute(
					"SELECT id, kind, name, size FROM objects WHERE kind = ? ORDER BY name",
					kind,
				)) as unknown as GlonObjectRef[];
			}
			return (await c.db.execute(
				"SELECT id, kind, name, size FROM objects ORDER BY kind, name",
			)) as unknown as GlonObjectRef[];
		},

		/** Get a single object ref by ID. */
		get: async (c, id: string): Promise<GlonObjectRef | null> => {
			const rows = (await c.db.execute(
				"SELECT id, kind, name, size FROM objects WHERE id = ?",
				id,
			)) as unknown as GlonObjectRef[];
			return rows[0] ?? null;
		},

		/** Find objects by name (exact or LIKE). */
		search: async (c, query: string): Promise<GlonObjectRef[]> => {
			return (await c.db.execute(
				"SELECT id, kind, name, size FROM objects WHERE name LIKE ? ORDER BY name",
				`%${query}%`,
			)) as unknown as GlonObjectRef[];
		},

		/** Remove an object from the index. */
		delete: async (c, id: string): Promise<boolean> => {
			const rows = (await c.db.execute(
				"SELECT id FROM objects WHERE id = ?",
				id,
			)) as unknown as { id: string }[];
			if (rows.length === 0) return false;

			await c.db.execute("DELETE FROM objects WHERE id = ?", id);
			c.state.objectCount = Math.max(0, c.state.objectCount - 1);
			return true;
		},

		/** Return total object count. */
		count: (c): number => {
			return c.state.objectCount;
		},

		/** Return system info. */
		info: async (c) => {
			const countRows = (await c.db.execute(
				"SELECT COUNT(*) as cnt FROM objects",
			)) as unknown as { cnt: number }[];
			const kindRows = (await c.db.execute(
				"SELECT kind, COUNT(*) as cnt FROM objects GROUP BY kind ORDER BY cnt DESC",
			)) as unknown as { kind: string; cnt: number }[];

			return {
				totalObjects: countRows[0]?.cnt ?? 0,
				byKind: kindRows,
			};
		},
	},
});
