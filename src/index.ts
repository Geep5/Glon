/**
 * Glon OS — actor registry.
 *
 * Two actors: objectActor (one per object, sync peer) and storeActor
 * (singleton coordinator with SQLite index). Changes live on disk as
 * .pb files; actors cache computed state derived from DAG replay.
 *
 * Rivet requires the registry in scope for c.client<typeof app>().
 */

import { actor, event, setup } from "rivetkit";
import { db } from "rivetkit/db";
import type { Change, Operation, Value, ObjectRef, Block } from "./proto.js";
import { encodeChange, decodeChange, stringVal, displayValue } from "./proto.js";
import { sha256, hexEncode, hexDecode, generateObjectId } from "./crypto.js";
import {
	createChange,
	createGenesisChange,
	createFieldChange,
	createContentChange,
	createDeleteChange,
	changeId,
} from "./dag/change.js";
import { computeState, findHeads, toSnapshot, type ObjectState } from "./dag/dag.js";
import { initDisk, writeChange, readChangeByHex, listChangeFiles, diskStats } from "./disk.js";

// ── Types ────────────────────────────────────────────────────────

interface IpcMessage {
	fromId: string;
	toId: string;
	action: string;
	payload: string;
	timestamp: number;
}

interface BlockProvenanceRecord {
	changeId: string; // hex
	author: string;
	timestamp: number;
}

interface ObjectActorState {
	// Identity
	id: string;
	typeKey: string;

	// Computed state (cached from DAG replay)
	fields: Record<string, any>;
	content: string; // base64 of raw bytes
	blocks: any[]; // Block objects (structuredClone-safe)
	blockProvenance: Record<string, BlockProvenanceRecord>;
	deleted: boolean;
	createdAt: number;
	updatedAt: number;

	// DAG
	headIds: string[]; // hex-encoded
	changeCount: number;

	// IPC
	inbox: IpcMessage[];
	outbox: IpcMessage[];
}

export interface ObjectInput {
	id: string;
	typeKey: string;
	headIds: string[];
	changeCount: number;
	fields?: Record<string, any>;
	content?: string;
	createdAt?: number;
	updatedAt?: number;
}

// ── Helpers (module-level) ───────────────────────────────────────

/**
 * Re-read all changes for an object from disk and recompute state.
 * The DAG on disk is the source of truth; actor state is a cache.
 */
function recomputeFromDisk(objectId: string): { state: ObjectState; changeCount: number } {
	const allHexIds = listChangeFiles();
	const changes: Change[] = [];
	for (const hexId of allHexIds) {
		const change = readChangeByHex(hexId);
		if (change && change.objectId === objectId) changes.push(change);
	}
	if (changes.length === 0) throw new Error(`no changes on disk for ${objectId}`);
	return { state: computeState(changes), changeCount: changes.length };
}

/** Copy computed ObjectState into the actor's mutable state. */
function syncState(cState: ObjectActorState, computed: ObjectState, changeCount: number): void {
	cState.typeKey = computed.typeKey;
	cState.deleted = computed.deleted;
	cState.createdAt = computed.createdAt;
	cState.updatedAt = computed.updatedAt;
	cState.headIds = computed.heads.map((h) => hexEncode(h));
	cState.changeCount = changeCount;
	cState.content = Buffer.from(computed.content).toString("base64");
	// Convert fields Map to Record
	const fields: Record<string, any> = {};
	for (const [k, v] of computed.fields) fields[k] = v;
	cState.fields = fields;
	// Convert blocks (already structuredClone-safe)
	cState.blocks = computed.blocks;
	// Convert blockProvenance Map to Record (hex-encode changeId)
	const prov: Record<string, BlockProvenanceRecord> = {};
	for (const [blockId, p] of computed.blockProvenance) {
		prov[blockId] = { changeId: hexEncode(p.changeId), author: p.author, timestamp: p.timestamp };
	}
	cState.blockProvenance = prov;
}

/** Extract current head IDs as Uint8Array[] from actor state. */
function headBytes(c: { state: ObjectActorState }): Uint8Array[] {
	return c.state.headIds.map((h) => hexDecode(h));
}

/** Write a change to disk, recompute state from DAG, update actor cache, broadcast. */
function commitChange(c: any, change: Change): void {
	writeChange(change);
	const { state: computed, changeCount } = recomputeFromDisk(c.state.id);
	syncState(c.state, computed, changeCount);
	c.broadcast("changed", { id: c.state.id, updatedAt: c.state.updatedAt });
}

// ── Object Actor ─────────────────────────────────────────────────

const objectActor = actor({
	createState: (_c, input?: ObjectInput): ObjectActorState => ({
		id: input?.id ?? "",
		typeKey: input?.typeKey ?? "",
		fields: input?.fields ?? {},
		content: input?.content ?? "",
		blocks: [],
		blockProvenance: {},
		deleted: false,
		createdAt: input?.createdAt ?? 0,
		updatedAt: input?.updatedAt ?? 0,
		headIds: input?.headIds ?? [],
		changeCount: input?.changeCount ?? 0,
		inbox: [],
		outbox: [],
	}),

	events: {
		changed: event<{ id: string; updatedAt: number }>(),
		synced: event<{ id: string; headIds: string[] }>(),
	},

	actions: {
		// ── CRUD ──────────────────────────────────────────────────

		read: (c): Omit<ObjectActorState, "inbox" | "outbox"> => {
			const { inbox: _i, outbox: _o, ...rest } = c.state;
			return rest;
		},

		readContent: (c): string => {
			if (!c.state.content) return "";
			return Buffer.from(c.state.content, "base64").toString("utf-8");
		},

		// ── Mutation ─────────────────────────────────────────
		//
		// Every mutation: build Change → write to disk → recompute
		// from DAG → update cached state → broadcast.

		setField: (c, key: string, valueJson: string) => {
			const value: Value = JSON.parse(valueJson);
			const change = createFieldChange(c.state.id, headBytes(c), key, value);
			commitChange(c, change);
		},

		/** Batch: set multiple fields in a single Change. */
		setFields: (c, fieldsJson: string) => {
			const fields: Record<string, Value> = JSON.parse(fieldsJson);
			const ops: Operation[] = Object.entries(fields).map(([key, value]) => ({
				fieldSet: { key, value },
			}));
			const change = createChange(c.state.id, ops, headBytes(c));
			commitChange(c, change);
		},

		setContent: (c, contentBase64: string) => {
			const contentBytes = Buffer.from(contentBase64, "base64");
			const change = createContentChange(c.state.id, headBytes(c), contentBytes);
			commitChange(c, change);
		},

		deleteField: (c, key: string) => {
			const change = createChange(c.state.id, [{ fieldDelete: { key } }], headBytes(c));
			commitChange(c, change);
		},

		markDeleted: (c) => {
			const change = createDeleteChange(c.state.id, headBytes(c));
			commitChange(c, change);
		},

		addBlock: (c, blockJson: string) => {
			const block: Block = JSON.parse(blockJson);
			const parentIds = headBytes(c);
			const change = createChange(c.state.id, [{ blockAdd: { parentId: "", afterId: "", block } }], parentIds);
			commitChange(c, change);
		},

		// ── Sync protocol ────────────────────────────────────────

		getHeads: (c): string[] => c.state.headIds,

		/** All change hex IDs for this object (from disk). */
		getAllChangeIds: (_c, objectId: string): string => {
			const allHex = listChangeFiles();
			const matching: string[] = [];
			for (const hexId of allHex) {
				const c = readChangeByHex(hexId);
				if (c && c.objectId === objectId) matching.push(hexId);
			}
			return matching.join(",");
		},

		/**
		 * Sync handshake. Receive the remote peer's full set of change IDs
		 * for this object. Return two comma-separated lists:
		 *   - missingLocally: change IDs the remote has that we don't
		 *   - missingRemotely: change IDs we have that the remote doesn't
		 * Returned as "missingLocally|missingRemotely" (pipe-separated).
		 *
		 * After this, the caller pushes missingRemotely to us and
		 * fetches missingLocally from us.
		 */
		advertiseHeads: (_c, objectId: string, remoteChangeHexIds: string): string => {
			const remoteSet = new Set(remoteChangeHexIds.split(",").filter(Boolean));

			// Gather our local change IDs for this object from disk.
			const allHex = listChangeFiles();
			const localSet = new Set<string>();
			for (const hexId of allHex) {
				const ch = readChangeByHex(hexId);
				if (ch && ch.objectId === objectId) localSet.add(hexId);
			}

			// Set difference.
			const missingLocally: string[] = [];  // remote has, we don't
			for (const id of remoteSet) {
				if (!localSet.has(id)) missingLocally.push(id);
			}
			const missingRemotely: string[] = []; // we have, remote doesn't
			for (const id of localSet) {
				if (!remoteSet.has(id)) missingRemotely.push(id);
			}

			return missingLocally.join(",") + "|" + missingRemotely.join(",");
		},

		getChanges: (_c, hexIds: string): string => {
			const ids = hexIds.split(",").filter(Boolean);
			const results: string[] = [];
			for (const hexId of ids) {
				const change = readChangeByHex(hexId);
				if (change) {
					const encoded = encodeChange(change);
					results.push(Buffer.from(encoded).toString("base64"));
				}
			}
			return results.join(",");
		},

		pushChanges: (c, changesBase64: string) => {
			initDisk(); // ensure changes dir exists on this instance
			const parts = changesBase64.split(",").filter(Boolean);
			for (const b64 of parts) {
				const bytes = Buffer.from(b64, "base64");
				const change = decodeChange(new Uint8Array(bytes));
				writeChange(change);
			}
			const { state: computed, changeCount } = recomputeFromDisk(c.state.id);
			syncState(c.state, computed, changeCount);
			c.broadcast("synced", { id: c.state.id, headIds: c.state.headIds });
		},

		// ── IPC ──────────────────────────────────────────────────

		sendMessage: (c, toId: string, action: string, payload: string): IpcMessage => {
			const msg: IpcMessage = {
				fromId: c.state.id,
				toId,
				action,
				payload,
				timestamp: Date.now(),
			};
			c.state.outbox.push(msg);
			return msg;
		},

		receiveMessage: (c, fromId: string, action: string, payload: string, timestamp: number) => {
			const msg: IpcMessage = { fromId, toId: c.state.id, action, payload, timestamp };
			c.state.inbox.push(msg);
			c.broadcast("changed", { id: c.state.id, updatedAt: c.state.updatedAt });
		},

		getInbox: (c): IpcMessage[] => c.state.inbox,
		getOutbox: (c): IpcMessage[] => c.state.outbox,

		// ── Meta ─────────────────────────────────────────────────

		ref: (c): ObjectRef => ({
			id: c.state.id,
			typeKey: c.state.typeKey,
			createdAt: c.state.createdAt,
			updatedAt: c.state.updatedAt,
		}),

		destroy: (c) => {
			c.destroy();
		},
	},
});

// ── Store Actor ──────────────────────────────────────────────────

const storeActor = actor({
	state: { objectCount: 0 },

	db: db({
		onMigrate: async (database) => {
			await database.execute(`
				CREATE TABLE IF NOT EXISTS objects (
					id TEXT PRIMARY KEY,
					type_key TEXT NOT NULL DEFAULT '',
					deleted INTEGER NOT NULL DEFAULT 0,
					created_at INTEGER NOT NULL DEFAULT 0,
					updated_at INTEGER NOT NULL DEFAULT 0
				)
			`);
			await database.execute(`
				CREATE TABLE IF NOT EXISTS changes (
					id TEXT PRIMARY KEY,
					object_id TEXT NOT NULL,
					timestamp INTEGER NOT NULL,
					is_head INTEGER NOT NULL DEFAULT 1
				)
			`);
			await database.execute(`
				CREATE TABLE IF NOT EXISTS change_parents (
					change_id TEXT NOT NULL,
					parent_id TEXT NOT NULL,
					PRIMARY KEY (change_id, parent_id)
				)
			`);
			await database.execute(
				"CREATE INDEX IF NOT EXISTS idx_changes_object ON changes(object_id)",
			);
			await database.execute(
				"CREATE INDEX IF NOT EXISTS idx_objects_type ON objects(type_key)",
			);
		},
	}),

	actions: {
		create: async (c, typeKey: string, fieldsJson?: string, contentBase64?: string): Promise<string> => {
			initDisk();
			const objectId = generateObjectId();

			// Genesis change — creates the object with its type
			const genesis = createGenesisChange(objectId, typeKey);
			writeChange(genesis);
			const genesisHex = hexEncode(genesis.id);
			await indexChangeInDb(c, genesisHex, objectId, genesis.parentIds, genesis.timestamp);

			let lastParentIds: Uint8Array[] = [genesis.id];

			// Optional field change
			if (fieldsJson) {
				const fieldsRecord: Record<string, Value> = JSON.parse(fieldsJson);
				const ops: Operation[] = [];
				for (const [key, value] of Object.entries(fieldsRecord)) {
					ops.push({ fieldSet: { key, value } });
				}
				const fieldChange = createChange(objectId, ops, lastParentIds);
				writeChange(fieldChange);
				const fieldHex = hexEncode(fieldChange.id);
				await indexChangeInDb(c, fieldHex, objectId, fieldChange.parentIds, fieldChange.timestamp);
				lastParentIds = [fieldChange.id];
			}

			// Optional content change
			if (contentBase64) {
				const contentBytes = Buffer.from(contentBase64, "base64");
				const contentChange = createContentChange(objectId, lastParentIds, contentBytes);
				writeChange(contentChange);
				const contentHex = hexEncode(contentChange.id);
				await indexChangeInDb(c, contentHex, objectId, contentChange.parentIds, contentChange.timestamp);
			}

			// Recompute state from disk
			const { state: computed, changeCount } = recomputeFromDisk(objectId);

			// Upsert objects table
			await c.db.execute(
				"INSERT OR REPLACE INTO objects (id, type_key, deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
				objectId, computed.typeKey, computed.deleted ? 1 : 0, computed.createdAt, computed.updatedAt,
			);

			// Convert fields Map to Record for actor input
			const fieldsRecord: Record<string, any> = {};
			for (const [k, v] of computed.fields) fieldsRecord[k] = v;
			const contentB64 = Buffer.from(computed.content).toString("base64");
			const headHexIds = computed.heads.map((h) => hexEncode(h));

			// Spawn object actor
			const client = c.client<typeof app>();
			const objActor = client.objectActor.getOrCreate([objectId], {
				createWithInput: {
					id: objectId,
					typeKey: computed.typeKey,
					headIds: headHexIds,
					changeCount,
					fields: fieldsRecord,
					content: contentB64,
					createdAt: computed.createdAt,
					updatedAt: computed.updatedAt,
				} as ObjectInput,
			});
			await objActor.ref();

			c.state.objectCount++;
			return objectId;
		},

		list: async (c, typeKey?: string): Promise<ObjectRef[]> => {
			if (typeKey) {
				return (await c.db.execute(
					"SELECT id, type_key AS typeKey, created_at AS createdAt, updated_at AS updatedAt FROM objects WHERE type_key = ? ORDER BY updated_at DESC",
					typeKey,
				)) as unknown as ObjectRef[];
			}
			return (await c.db.execute(
				"SELECT id, type_key AS typeKey, created_at AS createdAt, updated_at AS updatedAt FROM objects ORDER BY updated_at DESC",
			)) as unknown as ObjectRef[];
		},

		get: async (c, id: string): Promise<Omit<ObjectActorState, "inbox" | "outbox"> | null> => {
			const rows = (await c.db.execute(
				"SELECT id FROM objects WHERE id = ?", id,
			)) as unknown as { id: string }[];
			if (rows.length === 0) return null;

			const client = c.client<typeof app>();
			const objActor = client.objectActor.getOrCreate([id]);
			return await objActor.read();
		},

		getRef: async (c, id: string): Promise<ObjectRef | null> => {
			const rows = (await c.db.execute(
				"SELECT id, type_key AS typeKey, created_at AS createdAt, updated_at AS updatedAt FROM objects WHERE id = ?",
				id,
			)) as unknown as ObjectRef[];
			return rows[0] ?? null;
		},

		search: async (c, query: string): Promise<ObjectRef[]> => {
			return (await c.db.execute(
				"SELECT id, type_key AS typeKey, created_at AS createdAt, updated_at AS updatedAt FROM objects WHERE id LIKE ? ORDER BY updated_at DESC",
				`%${query}%`,
			)) as unknown as ObjectRef[];
		},

		delete: async (c, id: string): Promise<boolean> => {
			const rows = (await c.db.execute(
				"SELECT id FROM objects WHERE id = ?", id,
			)) as unknown as { id: string }[];
			if (rows.length === 0) return false;

			try {
				const client = c.client<typeof app>();
				const objActor = client.objectActor.getOrCreate([id]);
				await objActor.destroy();
			} catch {
				// Actor already gone — fine
			}

			await c.db.execute("DELETE FROM objects WHERE id = ?", id);
			c.state.objectCount = Math.max(0, c.state.objectCount - 1);
			return true;
		},

		exists: async (c, id: string): Promise<boolean> => {
			const rows = (await c.db.execute(
				"SELECT id FROM objects WHERE id = ?", id,
			)) as unknown as { id: string }[];
			return rows.length > 0;
		},

		// Resolve an id prefix to a full id. Returns empty string if ambiguous or not found.
		resolvePrefix: async (c, prefix: string): Promise<string> => {
			const rows = (await c.db.execute(
				"SELECT id FROM objects WHERE id LIKE ? AND deleted = 0", prefix + "%",
			)) as unknown as { id: string }[];
			if (rows.length === 1) return rows[0].id;
			return "";
		},

		info: async (c) => {
			const countRows = (await c.db.execute(
				"SELECT COUNT(*) as cnt FROM objects",
			)) as unknown as { cnt: number }[];
			const changeCountRows = (await c.db.execute(
				"SELECT COUNT(*) as cnt FROM changes",
			)) as unknown as { cnt: number }[];
			const typeRows = (await c.db.execute(
				"SELECT type_key, COUNT(*) as cnt FROM objects GROUP BY type_key ORDER BY cnt DESC",
			)) as unknown as { type_key: string; cnt: number }[];
			const byType: Record<string, number> = {};
			for (const row of typeRows) byType[row.type_key] = row.cnt;
			return {
				totalObjects: countRows[0]?.cnt ?? 0,
				totalChanges: changeCountRows[0]?.cnt ?? 0,
				byType,
			};
		},

		indexChange: async (c, changeHexId: string, objectId: string, parentHexIds: string, timestamp: number) => {
			await c.db.execute(
				"INSERT OR IGNORE INTO changes (id, object_id, timestamp, is_head) VALUES (?, ?, ?, 1)",
				changeHexId, objectId, timestamp,
			);
			const parents = parentHexIds.split(",").filter(Boolean);
			for (const parentHex of parents) {
				await c.db.execute(
					"INSERT OR IGNORE INTO change_parents (change_id, parent_id) VALUES (?, ?)",
					changeHexId, parentHex,
				);
				// Parent is no longer a head
				await c.db.execute(
					"UPDATE changes SET is_head = 0 WHERE id = ?",
					parentHex,
				);
			}
		},

		indexObject: async (c, id: string, typeKey: string, deleted: number, createdAt: number, updatedAt: number) => {
			await c.db.execute(
				"INSERT OR REPLACE INTO objects (id, type_key, deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
				id, typeKey, deleted, createdAt, updatedAt,
			);
		},

		getHeadIds: async (c, objectId: string): Promise<string[]> => {
			const rows = (await c.db.execute(
				"SELECT id FROM changes WHERE object_id = ? AND is_head = 1",
				objectId,
			)) as unknown as { id: string }[];
			return rows.map((r) => r.id);
		},
	},
});

// ── Store helper: index a change in the DB ───────────────────────

async function indexChangeInDb(
	c: { db: { execute: (sql: string, ...args: any[]) => Promise<unknown> } },
	changeHexId: string,
	objectId: string,
	parentIds: Uint8Array[],
	timestamp: number,
): Promise<void> {
	await c.db.execute(
		"INSERT OR IGNORE INTO changes (id, object_id, timestamp, is_head) VALUES (?, ?, ?, 1)",
		changeHexId, objectId, timestamp,
	);
	for (const parentId of parentIds) {
		const parentHex = hexEncode(parentId);
		await c.db.execute(
			"INSERT OR IGNORE INTO change_parents (change_id, parent_id) VALUES (?, ?)",
			changeHexId, parentHex,
		);
		await c.db.execute(
			"UPDATE changes SET is_head = 0 WHERE id = ?",
			parentHex,
		);
	}
}

// ── Registry ─────────────────────────────────────────────────────

export const app = setup({
	use: { objectActor, storeActor },
});

app.start();
