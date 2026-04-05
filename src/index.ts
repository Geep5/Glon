/**
 * Glon OS -- entry point.
 *
 * All actors and the registry are defined here in one file.
 * This is required by Rivet: c.client<typeof registry>() needs
 * the registry variable in scope at runtime.
 */

import { actor, event, setup } from "rivetkit";
import { db } from "rivetkit/db";
import type { ObjectState, EnvelopeRecord, GlonObjectRef } from "./proto.js";
import { toState, fromState, createObject, toRef, encodeObject, createEnvelope, deriveId } from "./proto.js";

// ── Object Actor ──────────────────────────────────────────────────

export interface ObjectInput {
	id: string;
	kind: string;
	name: string;
	content?: string;
	meta?: Record<string, string>;
}

interface ObjectActorState extends ObjectState {
	inbox: EnvelopeRecord[];
	outbox: EnvelopeRecord[];
}

const objectActor = actor({
	createState: (_c, input?: ObjectInput): ObjectActorState => {
		const id = input?.id ?? "";
		const kind = input?.kind ?? "";
		const name = input?.name ?? "";
		const content = input?.content
			? new Uint8Array(Buffer.from(input.content, "base64"))
			: new Uint8Array(0);

		const base = toState(
			createObject({ id, kind, name, content, meta: input?.meta ?? {} }),
		);
		return { ...base, inbox: [], outbox: [] };
	},

	events: {
		changed: event<{ id: string; updatedAt: number }>(),
		message: event<EnvelopeRecord>(),
	},

	actions: {
		read: (c): ObjectState => {
			const { inbox: _i, outbox: _o, ...state } = c.state;
			return state;
		},

		readProto: (c): string => {
			const { inbox: _i, outbox: _o, ...state } = c.state;
			return Buffer.from(encodeObject(fromState(state))).toString("base64");
		},

		readContent: (c): string => {
			return Buffer.from(c.state.content, "base64").toString("utf-8");
		},

		write: (c, contentBase64: string) => {
			c.state.content = contentBase64;
			c.state.size = Buffer.from(contentBase64, "base64").byteLength;
			c.state.updatedAt = Date.now();
			c.broadcast("changed", { id: c.state.id, updatedAt: c.state.updatedAt });
		},

		setMeta: (c, key: string, value: string) => {
			c.state.meta[key] = value;
			c.state.updatedAt = Date.now();
			c.broadcast("changed", { id: c.state.id, updatedAt: c.state.updatedAt });
		},

		getMeta: (c): Record<string, string> => c.state.meta,

		ref: (c) => toRef(c.state),

		// ── IPC ───────────────────────────────────────────────────

		recordSend: (c, targetId: string, actionName: string, msg = ""): EnvelopeRecord => {
			const envelope = createEnvelope(c.state.id, targetId, actionName, msg);
			c.state.outbox.push(envelope);
			return envelope;
		},

		receive: (c, fromId: string, toId: string, action: string, payload: string, timestamp: number) => {
			const envelope: EnvelopeRecord = { fromId, toId, action, payload, timestamp };
			c.state.inbox.push(envelope);
			c.broadcast("message", envelope);
		},

		getInbox: (c): EnvelopeRecord[] => c.state.inbox,
		getOutbox: (c): EnvelopeRecord[] => c.state.outbox,
	},
});

// ── Store Actor ───────────────────────────────────────────────────

export interface CreateInput {
	kind: string;
	name: string;
	content?: string;
	meta?: Record<string, string>;
}

const storeActor = actor({
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
			await database.execute("CREATE INDEX IF NOT EXISTS idx_objects_kind ON objects(kind)");
			await database.execute("CREATE INDEX IF NOT EXISTS idx_objects_name ON objects(name)");
		},
	}),

	actions: {
		create: async (c, input: CreateInput): Promise<string> => {
			const id = deriveId(input.kind, input.name);
			const contentBytes = input.content ? Buffer.from(input.content, "base64").byteLength : 0;
			await c.db.execute(
				"INSERT OR REPLACE INTO objects (id, kind, name, size, created_at) VALUES (?, ?, ?, ?, ?)",
				id, input.kind, input.name, contentBytes, Date.now(),
			);
			c.state.objectCount++;
			return id;
		},

		list: async (c, kind?: string): Promise<GlonObjectRef[]> => {
			if (kind) {
				return await c.db.execute(
					"SELECT id, kind, name, size FROM objects WHERE kind = ? ORDER BY name", kind,
				) as unknown as GlonObjectRef[];
			}
			return await c.db.execute(
				"SELECT id, kind, name, size FROM objects ORDER BY kind, name",
			) as unknown as GlonObjectRef[];
		},

		get: async (c, id: string): Promise<GlonObjectRef | null> => {
			const rows = await c.db.execute(
				"SELECT id, kind, name, size FROM objects WHERE id = ?", id,
			) as unknown as GlonObjectRef[];
			return rows[0] ?? null;
		},

		search: async (c, query: string): Promise<GlonObjectRef[]> => {
			return await c.db.execute(
				"SELECT id, kind, name, size FROM objects WHERE name LIKE ? ORDER BY name", `%${query}%`,
			) as unknown as GlonObjectRef[];
		},

		delete: async (c, id: string): Promise<boolean> => {
			const rows = await c.db.execute("SELECT id FROM objects WHERE id = ?", id) as unknown as { id: string }[];
			if (rows.length === 0) return false;
			await c.db.execute("DELETE FROM objects WHERE id = ?", id);
			c.state.objectCount = Math.max(0, c.state.objectCount - 1);
			return true;
		},

		count: (c): number => c.state.objectCount,

		info: async (c) => {
			const countRows = await c.db.execute("SELECT COUNT(*) as cnt FROM objects") as unknown as { cnt: number }[];
			const kindRows = await c.db.execute(
				"SELECT kind, COUNT(*) as cnt FROM objects GROUP BY kind ORDER BY cnt DESC",
			) as unknown as { kind: string; cnt: number }[];
			return { totalObjects: countRows[0]?.cnt ?? 0, byKind: kindRows };
		},
	},
});

// ── Registry ──────────────────────────────────────────────────────

export const app = setup({
	use: { objectActor, storeActor },
});

app.start();
