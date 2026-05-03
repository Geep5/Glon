// Anchor — global ordering and state commitment for chain-mode objects.
//
// Inspired by Chia's consensus design:
//   - Consensus-critical data (merkle_root) is separate from payload (commits_json).
//     The Merkle root is the "trunk" that determines fork choice; the full
//     commits list is "foliage" for inspection only.
//   - Fork choice: longest chain (highest height), ties broken by timestamp.
//   - State commitment: binary Merkle tree over (objectId + headId) pairs.
//
// v1 (pre-PoST):
//   - Anchor creation is permissionless (any node can create).
//   - No VDF proofs required; timestamps provide rough ordering.
//   - Finality is "soft" — social consensus around which anchor chain to follow.
//
// Future (with PoST):
//   - Anchor creation will require a PoST proof (chiapos + chiavdf).
//   - Fastest valid proof wins the right to create the next anchor.
//   - Timestamps become redundant; VDF output provides canonical ordering.

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import { sha256, hexEncode } from "../../crypto.js";

// ── ANSI ─────────────────────────────────────────────────────────

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

function dim(s: string) { return `${DIM}${s}${RESET}`; }
function bold(s: string) { return `${BOLD}${s}${RESET}`; }
function cyan(s: string) { return `${CYAN}${s}${RESET}`; }
function red(s: string) { return `${RED}${s}${RESET}`; }
function green(s: string) { return `${GREEN}${s}${RESET}`; }

// ── Constants ────────────────────────────────────────────────────

/** Anchor block type key. */
export const ANCHOR_TYPE_KEY = "chain.anchor";

/** Auto-anchor tick interval in ms. Set to 0 to disable. */
const AUTO_ANCHOR_MS = 60_000;

/** Chain-mode types that anchors commit to. Extensible as new chain types land. */
const TRACKED_TYPES = ["chain.token"];

// ── Types ────────────────────────────────────────────────────────

interface AnchorCommit {
	objectId: string;
	headId: string;
}

interface PersistedState {
	lastAnchorId: string;
	lastAnchorHeight: number;
}

function loadState(raw: Record<string, unknown>): PersistedState {
	return {
		lastAnchorId: typeof raw.lastAnchorId === "string" ? raw.lastAnchorId : "",
		lastAnchorHeight: typeof raw.lastAnchorHeight === "number" ? raw.lastAnchorHeight : -1,
	};
}

// ── Merkle tree ──────────────────────────────────────────────────

/** Build a leaf hash from an objectId + headId pair. */
function leafHash(objectId: string, headId: string): Uint8Array {
	const data = new TextEncoder().encode(objectId + ":" + headId);
	return sha256(data);
}

/** Build a binary Merkle root from leaf hashes. Leaves are sorted deterministically. */
export function merkleRoot(leaves: Uint8Array[]): Uint8Array {
	if (leaves.length === 0) {
		return sha256(new Uint8Array(0));
	}

	// Sort by hex string for deterministic ordering.
	const level = [...leaves].sort((a, b) => {
		const ha = hexEncode(a);
		const hb = hexEncode(b);
		return ha < hb ? -1 : ha > hb ? 1 : 0;
	});

	while (level.length > 1) {
		const next: Uint8Array[] = [];
		for (let i = 0; i < level.length; i += 2) {
			const left = level[i];
			const right = level[i + 1] ?? left; // duplicate last if odd
			const combined = new Uint8Array(left.length + right.length);
			combined.set(left);
			combined.set(right, left.length);
			next.push(sha256(combined));
		}
		level.length = 0;
		level.push(...next);
	}

	return level[0];
}

/** Verify that a list of commits produces the given Merkle root. */
export function verifyMerkleRoot(rootHex: string, commits: AnchorCommit[]): boolean {
	const leaves = commits.map((c) => leafHash(c.objectId, c.headId));
	const computed = hexEncode(merkleRoot(leaves));
	return computed === rootHex;
}

// ── Anchor construction ──────────────────────────────────────────

/** Gather current chain-mode object heads and build an anchor. */
async function buildAnchor(
	ctx: ProgramContext,
	previousAnchorId: string,
	height: number,
): Promise<{ id: string; root: string; commits: AnchorCommit[] }> {
	const store = ctx.store as any;

	// Collect heads from all tracked chain-mode types.
	const commits: AnchorCommit[] = [];
	for (const typeKey of TRACKED_TYPES) {
		const refs = (await store.list(typeKey)) as Array<{ id: string }>;
		for (const ref of refs) {
			const obj = await store.get(ref.id);
			if (!obj || obj.deleted) continue;
			const heads: string[] = obj.headIds ?? [];
			for (const headId of heads) {
				commits.push({ objectId: ref.id, headId });
			}
		}
	}

	const leaves = commits.map((c) => leafHash(c.objectId, c.headId));
	const root = hexEncode(merkleRoot(leaves));

	const fields: Record<string, unknown> = {
		height,
		previous_anchor: previousAnchorId,
		merkle_root: root,
		timestamp: Date.now(),
		creator: "system", // v1: no PoST proof, creator is generic
		commit_count: commits.length,
		commits_json: JSON.stringify(commits),
	};

	const id = (await store.create(ANCHOR_TYPE_KEY, JSON.stringify(fields))) as string;
	return { id, root, commits };
}

/** Find the latest anchor by scanning all chain.anchor objects. */
async function findLatestAnchor(store: any): Promise<{ id: string; height: number; root: string; previous: string; timestamp: number } | null> {
	const refs = (await store.list(ANCHOR_TYPE_KEY)) as Array<{ id: string }>;
	if (refs.length === 0) return null;

	let best: { id: string; height: number; root: string; previous: string; timestamp: number } | null = null;

	for (const ref of refs) {
		const obj = await store.get(ref.id);
		if (!obj || obj.deleted) continue;
		const fields = obj.fields ?? {};
		const height = Number(fields.height?.intValue ?? fields.height ?? 0);
		const timestamp = Number(fields.timestamp?.intValue ?? fields.timestamp ?? 0);
		const root = String(fields.merkle_root?.stringValue ?? fields.merkle_root ?? "");
		const previous = String(fields.previous_anchor?.stringValue ?? fields.previous_anchor ?? "");

		if (!best || height > best.height || (height === best.height && timestamp < best.timestamp)) {
			best = { id: ref.id, height, root, previous, timestamp };
		}
	}

	return best;
}

/** Walk the anchor chain backwards from a given anchor. */
async function getChainFrom(store: any, startId: string, limit: number): Promise<Array<{ id: string; height: number; root: string; previous: string; timestamp: number }>> {
	const out: Array<{ id: string; height: number; root: string; previous: string; timestamp: number }> = [];
	let currentId = startId;
	const seen = new Set<string>();

	while (currentId && out.length < limit && !seen.has(currentId)) {
		seen.add(currentId);
		const obj = await store.get(currentId);
		if (!obj || obj.deleted) break;
		const fields = obj.fields ?? {};
		const height = Number(fields.height?.intValue ?? fields.height ?? 0);
		const timestamp = Number(fields.timestamp?.intValue ?? fields.timestamp ?? 0);
		const root = String(fields.merkle_root?.stringValue ?? fields.merkle_root ?? "");
		const previous = String(fields.previous_anchor?.stringValue ?? fields.previous_anchor ?? "");
		out.push({ id: currentId, height, root, previous, timestamp });
		currentId = previous;
	}

	return out;
}

/** Check whether a given object head is included in any anchor. */
async function isFinalized(store: any, objectId: string, headId: string): Promise<boolean> {
	const refs = (await store.list(ANCHOR_TYPE_KEY)) as Array<{ id: string }>;
	for (const ref of refs) {
		const obj = await store.get(ref.id);
		if (!obj || obj.deleted) continue;
		const fields = obj.fields ?? {};
		const commitsJson = String(fields.commits_json?.stringValue ?? fields.commits_json ?? "[]");
		try {
			const commits = JSON.parse(commitsJson) as AnchorCommit[];
			if (commits.some((c) => c.objectId === objectId && c.headId === headId)) {
				return true;
			}
		} catch {
			// ignore bad json
		}
	}
	return false;
}

// ── Handler (CLI) ────────────────────────────────────────────────

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print } = ctx;
	const store = ctx.store as any;
	const state = loadState(ctx.state ?? {});

	switch (cmd) {
		case "create": {
			const latest = await findLatestAnchor(store);
			const height = latest ? latest.height + 1 : 0;
			const previousId = latest ? latest.id : "";
			const { id, root, commits } = await buildAnchor(ctx, previousId, height);

			// Update actor state.
			state.lastAnchorId = id;
			state.lastAnchorHeight = height;
			ctx.state!.lastAnchorId = id;
			ctx.state!.lastAnchorHeight = height;

			print(green("Anchor created"));
			print(dim("  id:     ") + id);
			print(dim("  height: ") + String(height));
			print(dim("  root:   ") + root.slice(0, 24) + "…");
			print(dim("  commits:") + " " + commits.length + " object head(s)");
			if (previousId) print(dim("  prev:   ") + previousId);
			break;
		}

		case "list": {
			const limit = Number(args[0] ?? 20);
			const latest = await findLatestAnchor(store);
			if (!latest) {
				print(dim("  (no anchors yet)"));
				break;
			}
			const chain = await getChainFrom(store, latest.id, limit);
			for (const a of chain) {
				const shortRoot = a.root ? a.root.slice(0, 16) + "…" : "—";
				print(`  ${bold(String(a.height))}  ${dim(new Date(a.timestamp).toLocaleTimeString())}  ${cyan(a.id.slice(0, 12) + "…")}  root=${shortRoot}`);
			}
			break;
		}

		case "status": {
			const latest = await findLatestAnchor(store);
			if (!latest) {
				print(dim("  No anchors yet. Run: anchor create"));
				break;
			}
			print(bold("Anchor status"));
			print(dim("  latest height: ") + bold(String(latest.height)));
			print(dim("  latest id:     ") + latest.id);
			print(dim("  merkle root:   ") + latest.root.slice(0, 24) + "…");
			print(dim("  timestamp:     ") + new Date(latest.timestamp).toLocaleString());

			// Count pending objects (chain-mode objects not in latest anchor)
			const obj = await store.get(latest.id);
			const fields = obj?.fields ?? {};
			const commitsJson = String(fields.commits_json?.stringValue ?? fields.commits_json ?? "[]");
			let commitCount = 0;
			try {
				commitCount = (JSON.parse(commitsJson) as AnchorCommit[]).length;
			} catch { /* ignore */ }
			print(dim("  commits:       ") + commitCount + " object head(s) in latest anchor");

			// Count total chain-mode objects
			let totalObjects = 0;
			for (const typeKey of TRACKED_TYPES) {
				const refs = (await store.list(typeKey)) as Array<{ id: string }>;
				totalObjects += refs.length;
			}
			print(dim("  chain objects: ") + totalObjects + " tracked type(s)");
			break;
		}

		case "info": {
			const id = args[0];
			if (!id) { print(red("Usage: anchor info <anchor_id>")); break; }
			const obj = await store.get(id);
			if (!obj || obj.deleted || obj.typeKey !== ANCHOR_TYPE_KEY) {
				print(red("Not found or not an anchor"));
				break;
			}
			const f = obj.fields ?? {};
			const height = Number(f.height?.intValue ?? f.height ?? 0);
			const timestamp = Number(f.timestamp?.intValue ?? f.timestamp ?? 0);
			const root = String(f.merkle_root?.stringValue ?? f.merkle_root ?? "");
			const previous = String(f.previous_anchor?.stringValue ?? f.previous_anchor ?? "");
			const creator = String(f.creator?.stringValue ?? f.creator ?? "system");
			const commitCount = Number(f.commit_count?.intValue ?? f.commit_count ?? 0);
			const commitsJson = String(f.commits_json?.stringValue ?? f.commits_json ?? "[]");

			print(bold(`Anchor ${height}`));
			print(dim("  id:       ") + id);
			print(dim("  root:     ") + root);
			print(dim("  creator:  ") + creator);
			print(dim("  previous: ") + (previous || "(genesis)"));
			print(dim("  time:     ") + new Date(timestamp).toLocaleString());
			print(dim("  commits:  ") + commitCount);

			// Verify Merkle root
			try {
				const commits = JSON.parse(commitsJson) as AnchorCommit[];
				const valid = verifyMerkleRoot(root, commits);
				print(dim("  verify:   ") + (valid ? green("ok") : red("MISMATCH")));
			} catch {
				print(dim("  verify:   ") + red("commits_json invalid"));
			}
			break;
		}

		case "verify": {
			const id = args[0];
			if (!id) { print(red("Usage: anchor verify <anchor_id>")); break; }
			const obj = await store.get(id);
			if (!obj || obj.deleted || obj.typeKey !== ANCHOR_TYPE_KEY) {
				print(red("Not found or not an anchor"));
				break;
			}
			const f = obj.fields ?? {};
			const root = String(f.merkle_root?.stringValue ?? f.merkle_root ?? "");
			const commitsJson = String(f.commits_json?.stringValue ?? f.commits_json ?? "[]");
			try {
				const commits = JSON.parse(commitsJson) as AnchorCommit[];
				const valid = verifyMerkleRoot(root, commits);
				print(valid ? green("Merkle root verified") : red("Merkle root MISMATCH"));
			} catch (err: any) {
				print(red("Error: " + (err?.message ?? String(err))));
			}
			break;
		}

		default: {
			print([
				bold("  Anchor") + dim(" — global ordering + state commitment for chain-mode objects"),
				`    ${cyan("anchor create")}                 create a new anchor from current chain-mode state`,
				`    ${cyan("anchor list")} ${dim("[limit]")}        show recent anchors (newest first)`,
				`    ${cyan("anchor status")}               latest height, commit count, pending objects`,
				`    ${cyan("anchor info")} ${dim("<id>")}         full anchor details + Merkle verify`,
				`    ${cyan("anchor verify")} ${dim("<id>")}        verify Merkle root against stored commits`,
				dim(`  Auto-anchors every ${AUTO_ANCHOR_MS / 1000}s when the actor is running.`),
			].join("\n"));
		}
	}
};

// ── Actor (programmatic API) ─────────────────────────────────────

const actorDef: ProgramActorDef = {
	createState: (): Record<string, unknown> => ({
		lastAnchorId: "",
		lastAnchorHeight: -1,
	}),

	actions: {
		/** Create a new anchor from current chain-mode state. */
		createAnchor: async (ctx: ProgramContext) => {
			const store = ctx.store as any;
			const latest = await findLatestAnchor(store);
			const height = latest ? latest.height + 1 : 0;
			const previousId = latest ? latest.id : "";
			const { id, root, commits } = await buildAnchor(ctx, previousId, height);

			// Update state.
			const s = loadState(ctx.state ?? {});
			s.lastAnchorId = id;
			s.lastAnchorHeight = height;
			ctx.state!.lastAnchorId = id;
			ctx.state!.lastAnchorHeight = height;

			return { id, height, root, commitCount: commits.length, previousId };
		},

		/** Get the latest anchor (highest height). */
		getLatest: async (ctx: ProgramContext) => {
			const latest = await findLatestAnchor(ctx.store as any);
			if (!latest) return null;
			return { id: latest.id, height: latest.height, root: latest.root, timestamp: latest.timestamp };
		},

		/** Get the anchor chain backwards from the latest, up to limit entries. */
		getChain: async (ctx: ProgramContext, limit: number = 20) => {
			const store = ctx.store as any;
			const latest = await findLatestAnchor(store);
			if (!latest) return [];
			return getChainFrom(store, latest.id, limit);
		},

		/** Check if an object head is finalized (appears in any anchor). */
		isFinal: async (ctx: ProgramContext, objectId: string, headId: string) => {
			return await isFinalized(ctx.store as any, objectId, headId);
		},

		/** Verify a specific anchor's Merkle root. */
		verify: async (ctx: ProgramContext, anchorId: string) => {
			const store = ctx.store as any;
			const obj = await store.get(anchorId);
			if (!obj || obj.deleted || obj.typeKey !== ANCHOR_TYPE_KEY) {
				return { valid: false, error: "not found or not an anchor" };
			}
			const f = obj.fields ?? {};
			const root = String(f.merkle_root?.stringValue ?? f.merkle_root ?? "");
			const commitsJson = String(f.commits_json?.stringValue ?? f.commits_json ?? "[]");
			try {
				const commits = JSON.parse(commitsJson) as AnchorCommit[];
				const valid = verifyMerkleRoot(root, commits);
				return { valid, anchorId, height: Number(f.height?.intValue ?? f.height ?? 0) };
			} catch (err: any) {
				return { valid: false, error: err?.message ?? String(err) };
			}
		},
	},

	onTick: async (ctx: ProgramContext) => {
		// Auto-create anchor on tick.
		const store = ctx.store as any;
		const latest = await findLatestAnchor(store);
		const height = latest ? latest.height + 1 : 0;
		const previousId = latest ? latest.id : "";
		const { id, root, commits } = await buildAnchor(ctx, previousId, height);

		const s = loadState(ctx.state ?? {});
		s.lastAnchorId = id;
		s.lastAnchorHeight = height;
		ctx.state!.lastAnchorId = id;
		ctx.state!.lastAnchorHeight = height;

		ctx.emit("anchor_created", { id, height, root, commitCount: commits.length });
	},

	tickMs: AUTO_ANCHOR_MS,
};

const program: ProgramDef = {
	handler,
	actor: actorDef,
};

export default program;

// ── Test exports ─────────────────────────────────────────────────

export const __test = {
	leafHash,
	merkleRoot,
	verifyMerkleRoot,
	ANCHOR_TYPE_KEY,
};
