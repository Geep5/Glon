/**
 * Glon OS — actor registry.
 *
 * Three actors: objectActor (one per object, sync peer), storeActor
 * (singleton coordinator with SQLite index), and programActor
 * (one per running program, manages state + tick loops).
 * Changes live on disk as .pb files; actors compute state from disk on every wake.
 * Architecture (per Rivet best practices):
 *   state  → minimal persistent data (id, inbox/outbox)
 *   vars   → computed from disk on every wake (fields, blocks, heads, etc.)
 *   disk   → .pb change files, source of truth
 *   SQLite → derived index in the store actor
 *
 * Rivet requires the registry in scope for c.client<typeof app>().
 */

import { actor, event, setup } from "rivetkit";
import { db } from "rivetkit/db";
import type { Change, Operation, Value, ObjectRef, Block } from "./proto.js";
import { encodeChange, encodeChangeForHashing, decodeChange, stringVal, intVal, floatVal, boolVal, mapVal, listVal, displayValue } from "./proto.js";
import { sha256, hexEncode, hexDecode, generateObjectId } from "./crypto.js";
import {
	createChange,
	createGenesisChange,
	createFieldChange,
	createContentChange,
	createDeleteChange,
	changeId,
} from "./dag/change.js";
import { computeState, findHeads, toSnapshot, type ObjectState, type BlockProvenance } from "./dag/dag.js";
import { initDisk, writeChange, readChangeByHex, listChangeFilesForObject, deleteChangesForObject, diskStats } from "./disk.js";
import { getValidator } from "./programs/runtime.js";

// ── Types ────────────────────────────────────────────────────────

interface IpcMessage {
	fromId: string;
	toId: string;
	action: string;
	payload: string;
	timestamp: number;
}

// Persistent state — survives sleep, crash, restart.
// Minimal: just identity + IPC queues.
interface ObjectActorState {
	id: string;
	inbox: IpcMessage[];
	outbox: IpcMessage[];
}

// Ephemeral vars — recomputed from disk on every wake.
// This is the computed state derived from replaying the Change DAG.
interface ObjectVars {
	typeKey: string;
	fields: Record<string, any>;
	content: string; // base64
	blocks: any[];
	blockProvenance: Record<string, { changeId: string; author: string; timestamp: number }>;
	deleted: boolean;
	createdAt: number;
	updatedAt: number;
	headIds: string[];
	changeCount: number;
}

export interface ObjectInput {
	id: string;
}

// ── Helpers ──────────────────────────────────────────────────────

/** Load all changes for an object from disk and compute state. */
function loadFromDisk(objectId: string): { state: ObjectState; changeCount: number } | null {
	const hexIds = listChangeFilesForObject(objectId);
	const changes: Change[] = [];
	for (const hexId of hexIds) {
		const change = readChangeByHex(hexId, objectId);
		if (change) changes.push(change);
	}
	if (changes.length === 0) return null;
	return { state: computeState(changes), changeCount: changes.length };
}

/** Convert ObjectState into the vars shape (Maps → Records, bytes → base64). */
function computedToVars(computed: ObjectState, changeCount: number): ObjectVars {
	const fields: Record<string, any> = {};
	for (const [k, v] of computed.fields) fields[k] = v;

	const blockProvenance: Record<string, { changeId: string; author: string; timestamp: number }> = {};
	for (const [blockId, p] of computed.blockProvenance) {
		blockProvenance[blockId] = {
			changeId: hexEncode(p.changeId),
			author: p.author,
			timestamp: p.timestamp,
		};
	}

	return {
		typeKey: computed.typeKey,
		fields,
		content: Buffer.from(computed.content).toString("base64"),
		blocks: computed.blocks,
		blockProvenance,
		deleted: computed.deleted,
		createdAt: computed.createdAt,
		updatedAt: computed.updatedAt,
		headIds: computed.heads.map((h) => hexEncode(h)),
		changeCount,
	};
}

/** Current head IDs as Uint8Array[] from vars. */
function headBytes(c: { vars: ObjectVars }): Uint8Array[] {
	return c.vars.headIds.map((h) => hexDecode(h));
}

/** Write a change to disk, recompute vars from DAG, broadcast. */
function commitChange(c: any, change: Change): void {
	writeChange(change);
	const result = loadFromDisk(c.state.id);
	if (result) {
		Object.assign(c.vars, computedToVars(result.state, result.changeCount));
	}
	c.broadcast("changed", { id: c.state.id, updatedAt: c.vars.updatedAt });
}

// ── Object Actor ─────────────────────────────────────────────────

const objectActor = actor({
	// Persistent state: minimal. Just the object ID and IPC queues.
	createState: (_c, input?: ObjectInput): ObjectActorState => ({
		id: input?.id ?? "",
		inbox: [],
		outbox: [],
	}),

	// Ephemeral vars: recomputed from disk on every wake.
	// This is the computed state derived from replaying the Change DAG.
	createVars: (c): ObjectVars => {
		if (!c.state.id) {
			// Actor not yet initialized (no id). Return empty vars.
			return {
				typeKey: "", fields: {}, content: "", blocks: [],
				blockProvenance: {}, deleted: false, createdAt: 0,
				updatedAt: 0, headIds: [], changeCount: 0,
			};
		}
		initDisk();
		const result = loadFromDisk(c.state.id);
		if (!result) {
			// No changes on disk yet (actor just created, genesis not written yet).
			return {
				typeKey: "", fields: {}, content: "", blocks: [],
				blockProvenance: {}, deleted: false, createdAt: 0,
				updatedAt: 0, headIds: [], changeCount: 0,
			};
		}
		return computedToVars(result.state, result.changeCount);
	},

	events: {
		changed: event<{ id: string; updatedAt: number }>(),
		synced: event<{ id: string; headIds: string[] }>(),
	},

	actions: {
		// ── Read ──────────────────────────────────────────────────
		// Returns the computed state (from vars) + identity (from state).

		read: (c) => ({
			id: c.state.id,
			typeKey: c.vars.typeKey,
			fields: c.vars.fields,
			content: c.vars.content,
			blocks: c.vars.blocks,
			blockProvenance: c.vars.blockProvenance,
			deleted: c.vars.deleted,
			createdAt: c.vars.createdAt,
			updatedAt: c.vars.updatedAt,
			headIds: c.vars.headIds,
			changeCount: c.vars.changeCount,
		}),

		readContent: (c): string => {
			if (!c.vars.content) return "";
			return Buffer.from(c.vars.content, "base64").toString("utf-8");
		},

		// ── Mutation ─────────────────────────────────────────────
		//
		// Every mutation: build Change → write to disk → recompute
		// vars from DAG → broadcast.

		setField: (c, key: string, valueJson: string) => {
			const value: Value = JSON.parse(valueJson);
			const change = createFieldChange(c.state.id, headBytes(c), key, value);
			commitChange(c, change);
		},

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
			const change = createChange(c.state.id, [{ blockAdd: { parentId: "", afterId: "", block } }], headBytes(c));
			commitChange(c, change);
		},

		createSnapshot: (c): string => {
			const result = loadFromDisk(c.state.id);
			if (!result) throw new Error("no changes on disk");
			const snapshot = toSnapshot(result.state);
			const change: Change = {
				id: new Uint8Array(0),
				objectId: c.state.id,
				parentIds: headBytes(c),
				ops: [],
				snapshot,
				timestamp: Date.now(),
				author: "local",
			};
			change.id = sha256(encodeChangeForHashing(change));
			commitChange(c, change);
			return hexEncode(change.id);
		},

		// ── Sync protocol ────────────────────────────────────────

		getHeads: (c): string[] => c.vars.headIds,

		getAllChangeIds: (_c, objectId: string): string => {
			return listChangeFilesForObject(objectId).join(",");
		},

		advertiseHeads: (_c, objectId: string, remoteChangeHexIds: string): string => {
			const remoteSet = new Set(remoteChangeHexIds.split(",").filter(Boolean));
			const localIds = listChangeFilesForObject(objectId);
			const localSet = new Set(localIds);
			const missingLocally: string[] = [];
			for (const id of remoteSet) {
				if (!localSet.has(id)) missingLocally.push(id);
			}
			const missingRemotely: string[] = [];
			for (const id of localSet) {
				if (!remoteSet.has(id)) missingRemotely.push(id);
			}
			return missingLocally.join(",") + "|" + missingRemotely.join(",");
		},

		getChanges: (c, hexIds: string): string => {
			const ids = hexIds.split(",").filter(Boolean);
			const results: string[] = [];
			for (const hexId of ids) {
				const change = readChangeByHex(hexId, c.state.id);
				if (change) {
					const encoded = encodeChange(change);
					results.push(Buffer.from(encoded).toString("base64"));
				}
			}
			return results.join(",");
		},

		pushChanges: async (c, changesBase64: string) => {
			initDisk();
			const parts = changesBase64.split(",").filter(Boolean);
			const decoded: Change[] = [];
			for (const b64 of parts) {
				const bytes = Buffer.from(b64, "base64");
				decoded.push(decodeChange(new Uint8Array(bytes)));
			}

			// Run program validator if registered for this object type
			const validator = getValidator(c.vars.typeKey);
			if (validator) {
				const result = validator(decoded);
				if (!result.valid) {
					throw new Error(`Validation rejected: ${result.error}`);
				}
			}

			// Validation passed — write to disk
			for (const change of decoded) {
				writeChange(change);
			}
			const result = loadFromDisk(c.state.id);
			if (result) {
				Object.assign(c.vars, computedToVars(result.state, result.changeCount));
			}
			// Index synced changes in store's SQLite
			const client = c.client<typeof app>();
			const store = client.storeActor.getOrCreate(["root"]);
			for (const change of decoded) {
				await store.indexSyncedChange(
					hexEncode(change.id),
					change.objectId,
					change.timestamp,
					change.parentIds.map(p => hexEncode(p)),
				);
			}
			if (result) {
				await store.indexSyncedObject(
					result.state.id,
					result.state.typeKey,
					result.state.deleted,
					result.state.createdAt,
					result.state.updatedAt,
				);
			}
			c.broadcast("synced", { id: c.state.id, headIds: c.vars.headIds });
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
			c.broadcast("changed", { id: c.state.id, updatedAt: c.vars.updatedAt });
		},

		getInbox: (c): IpcMessage[] => c.state.inbox,
		getOutbox: (c): IpcMessage[] => c.state.outbox,

		// ── Meta ─────────────────────────────────────────────────

		ref: (c): ObjectRef => ({
			id: c.state.id,
			typeKey: c.vars.typeKey,
			createdAt: c.vars.createdAt,
			updatedAt: c.vars.updatedAt,
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
			await database.execute("CREATE INDEX IF NOT EXISTS idx_changes_object ON changes(object_id)");
			await database.execute("CREATE INDEX IF NOT EXISTS idx_objects_type ON objects(type_key)");
		},
	}),

	actions: {
		create: async (c, typeKey: string, fieldsJson?: string, contentBase64?: string): Promise<string> => {
			const objectId = generateObjectId();
			initDisk();

			// Build changes: genesis + optional fields + optional content.
			const genesis = createGenesisChange(objectId, typeKey);
			writeChange(genesis);
			await indexChange(c, genesis);
			let lastHeads = [genesis.id];

			if (fieldsJson) {
				const fields: Record<string, Value> = JSON.parse(fieldsJson);
				const ops: Operation[] = Object.entries(fields).map(([key, value]) => ({
					fieldSet: { key, value },
				}));
				const fieldChange = createChange(objectId, ops, lastHeads);
				writeChange(fieldChange);
				await indexChange(c, fieldChange);
				lastHeads = [fieldChange.id];
			}

			if (contentBase64) {
				const contentBytes = Buffer.from(contentBase64, "base64");
				const contentChange = createContentChange(objectId, lastHeads, contentBytes);
				writeChange(contentChange);
				await indexChange(c, contentChange);
				lastHeads = [contentChange.id];
			}

			// Compute state and index the object.
			const result = loadFromDisk(objectId);
			if (result) {
				await indexObject(c, result.state);
			}

			// Spawn the object actor. createVars will load state from disk.
			const client = c.client<typeof app>();
			const objActor = client.objectActor.getOrCreate([objectId], {
				createWithInput: { id: objectId } as ObjectInput,
			});
			await objActor.ref();

			c.state.objectCount++;
			return objectId;
		},

		list: async (c, typeKey?: string): Promise<ObjectRef[]> => {
			let sql = "SELECT id, type_key AS typeKey, created_at AS createdAt, updated_at AS updatedAt FROM objects WHERE deleted = 0";
			const params: any[] = [];
			if (typeKey) {
				sql += " AND type_key = ?";
				params.push(typeKey);
			}
			sql += " ORDER BY type_key, created_at";
			return (await c.db.execute(sql, ...params)) as unknown as ObjectRef[];
		},

		get: async (c, id: string): Promise<any | null> => {
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
				"SELECT id, type_key AS typeKey, created_at AS createdAt, updated_at AS updatedAt FROM objects WHERE id LIKE ? AND deleted = 0",
				`%${query}%`,
			)) as unknown as ObjectRef[];
		},

		delete: async (c, id: string): Promise<boolean> => {
			const rows = (await c.db.execute("SELECT id FROM objects WHERE id = ?", id)) as unknown as { id: string }[];
			if (rows.length === 0) return false;
			try {
				const client = c.client<typeof app>();
				const objActor = client.objectActor.getOrCreate([id]);
				await objActor.destroy();
			} catch {
				// Actor already gone.
			}
			// Clean up SQLite (parents before changes due to FK-like dependency)
			await c.db.execute(
				"DELETE FROM change_parents WHERE change_id IN (SELECT id FROM changes WHERE object_id = ?)",
				id,
			);
			await c.db.execute("DELETE FROM changes WHERE object_id = ?", id);
			await c.db.execute("UPDATE objects SET deleted = 1 WHERE id = ?", id);
			// Clean up disk
			deleteChangesForObject(id);
			c.state.objectCount = Math.max(0, c.state.objectCount - 1);
			return true;
		},

		exists: async (c, id: string): Promise<boolean> => {
			const rows = (await c.db.execute(
				"SELECT id FROM objects WHERE id = ? AND deleted = 0", id,
			)) as unknown as { id: string }[];
			return rows.length > 0;
		},

		resolvePrefix: async (c, prefix: string): Promise<string> => {
			const rows = (await c.db.execute(
				"SELECT id FROM objects WHERE id LIKE ? AND deleted = 0", prefix + "%",
			)) as unknown as { id: string }[];
			if (rows.length === 1) return rows[0].id;
			return "";
		},

		info: async (c) => {
			const countRows = (await c.db.execute(
				"SELECT COUNT(*) as cnt FROM objects WHERE deleted = 0",
			)) as unknown as { cnt: number }[];
			const changeRows = (await c.db.execute(
				"SELECT COUNT(*) as cnt FROM changes",
			)) as unknown as { cnt: number }[];
			const typeRows = (await c.db.execute(
				"SELECT type_key, COUNT(*) as cnt FROM objects WHERE deleted = 0 GROUP BY type_key ORDER BY cnt DESC",
			)) as unknown as { type_key: string; cnt: number }[];

			const byType: Record<string, number> = {};
			for (const row of typeRows) byType[row.type_key] = row.cnt;

			return {
				totalObjects: countRows[0]?.cnt ?? 0,
				totalChanges: changeRows[0]?.cnt ?? 0,
				byType,
			};
		},

		getHeadIds: async (c, objectId: string): Promise<string[]> => {
			const rows = (await c.db.execute(
				"SELECT id FROM changes WHERE object_id = ? AND is_head = 1", objectId,
			)) as unknown as { id: string }[];
			return rows.map(r => r.id);
		},

		indexSyncedChange: async (c, hexId: string, objectId: string, timestamp: number, parentHexIds: string[]): Promise<void> => {
			await c.db.execute(
				"INSERT OR IGNORE INTO changes (id, object_id, timestamp, is_head) VALUES (?, ?, ?, 1)",
				hexId, objectId, timestamp,
			);
			for (const parentHex of parentHexIds) {
				await c.db.execute(
					"INSERT OR IGNORE INTO change_parents (change_id, parent_id) VALUES (?, ?)",
					hexId, parentHex,
				);
				await c.db.execute("UPDATE changes SET is_head = 0 WHERE id = ?", parentHex);
			}
		},

		indexSyncedObject: async (c, id: string, typeKey: string, deleted: boolean, createdAt: number, updatedAt: number): Promise<void> => {
			await c.db.execute(
				`INSERT INTO objects (id, type_key, deleted, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
				   type_key = excluded.type_key,
				   deleted = excluded.deleted,
				   created_at = excluded.created_at,
				   updated_at = excluded.updated_at`,
				id, typeKey, deleted ? 1 : 0, createdAt, updatedAt,
			);
		},
	},
});

// ── Store helpers ────────────────────────────────────────────────

async function indexChange(c: any, change: Change): Promise<void> {
	const hexId = hexEncode(change.id);
	await c.db.execute(
		"INSERT OR IGNORE INTO changes (id, object_id, timestamp, is_head) VALUES (?, ?, ?, 1)",
		hexId, change.objectId, change.timestamp,
	);
	for (const pid of change.parentIds) {
		const parentHex = hexEncode(pid);
		await c.db.execute(
			"INSERT OR IGNORE INTO change_parents (change_id, parent_id) VALUES (?, ?)",
			hexId, parentHex,
		);
		await c.db.execute("UPDATE changes SET is_head = 0 WHERE id = ?", parentHex);
	}
}

async function indexObject(c: any, computed: ObjectState): Promise<void> {
	await c.db.execute(
		`INSERT INTO objects (id, type_key, deleted, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   type_key = excluded.type_key,
		   deleted = excluded.deleted,
		   created_at = excluded.created_at,
		   updated_at = excluded.updated_at`,
		computed.id, computed.typeKey, computed.deleted ? 1 : 0,
		computed.createdAt, computed.updatedAt,
	);
}

// ── Program Actor ─────────────────────────────────────────────────
//
// One instance per running program. Manages program-defined state,
// action dispatch, and tick loops. The kernel treats program state as
// an opaque JSON blob — programs own their own serialization.

interface ProgramActorState {
	programId: string;
	programState: string; // JSON-serialized program state
}

const programActor = actor({
	createState: (_c, input?: { programId: string }): ProgramActorState => ({
		programId: input?.programId ?? "",
		programState: "{}",
	}),

	events: {
		programEvent: event<{ programId: string; channel: string; data: string }>(),
	},

	actions: {
		/** Generic action dispatch: route to the program's named action. */
		dispatch: async (c, action: string, argsJson: string): Promise<string> => {
			const { dispatchActorAction } = await import("./programs/runtime.js");
			const args: any[] = JSON.parse(argsJson);
			const makeCtx = (state: Record<string, any>) => ({
				client: c.client<typeof app>(),
				store: c.client<typeof app>().storeActor.getOrCreate(["root"]),
				resolveId: async (prefix: string) => {
					const store = c.client<typeof app>().storeActor.getOrCreate(["root"]);
					const resolved = await store.resolvePrefix(prefix);
					return resolved || null;
				},
				stringVal, intVal, floatVal, boolVal, mapVal, listVal, displayValue,
				listChangeFiles: () => [],
				readChangeByHex: () => null,
				hexEncode,
				print: (msg: string) => console.log(msg),
				randomUUID: () => generateObjectId(),
				state,
				emit: (channel: string, data: any) => {
					c.broadcast("programEvent", {
						programId: c.state.programId,
						channel,
						data: JSON.stringify(data),
					});
				},
				programId: c.state.programId,
				objectActor: (id: string) => c.client<typeof app>().objectActor.getOrCreate([id]),
			});
			const result = await dispatchActorAction(c.state.programId, action, args, makeCtx);
			return JSON.stringify(result ?? null);
		},

		/** Get the program's current state (for diagnostics). */
		getState: (c): string => c.state.programState,

		/** Update persisted state (called by runtime after mutations). */
		saveState: (c, stateJson: string) => {
			c.state.programState = stateJson;
		},
	},
});

// ── Registry ─────────────────────────────────────────────────────

export const app = setup({
	use: { objectActor, storeActor, programActor },
});

app.start();