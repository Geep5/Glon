// Memory — durable knowledge store for Glon agents.
//
// Addresses the rolling-summary failure mode in /agent: every compaction
// today rewrites one prose blob, and any fact the model forgets to carry
// forward is gone. /memory gives agents two first-class object types that
// persist across compactions and sync peers like any other Glon object:
//
//   pinned_fact   — atoms. One row per (owner, key). Names, contact info,
//                   preferences, boundaries. Upserting by key replaces the
//                   value in place; the old value remains in object_history.
//
//   milestone     — arcs. Multi-turn outcomes, decisions, phases, projects.
//                   `supersedes` is an ObjectLink list, so amendment chains
//                   are cheap to walk via the store's link index in both
//                   directions. `amend` uses FieldSet so a milestone's prior
//                   state is always reconstructible from its DAG.
//
// Retrieval is pull-based in Phase 1: callers (or tool-using agents) invoke
// `recall` / `digest` / `list_*` actions. A later phase can inject a digest
// into /agent.ask automatically; for now, Gracie carries memory tools and
// the model decides when to write and when to look.
//
// Owner scoping: every memory object carries an ObjectLink in its `owner`
// field pointing at its agent. All list/recall/digest actions filter by
// owner id. Two agents sharing a Glon store have independent memory.

import type { ProgramDef, ProgramContext, ProgramActorDef, ValidatorFn, ValidationResult } from "../runtime.js";
import type { Change } from "../../proto.js";

// ── ANSI ─────────────────────────────────────────────────────────

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";
const RESET = "\x1b[0m";

function dim(s: string) { return `${DIM}${s}${RESET}`; }
function bold(s: string) { return `${BOLD}${s}${RESET}`; }
function cyan(s: string) { return `${CYAN}${s}${RESET}`; }
function red(s: string) { return `${RED}${s}${RESET}`; }
function green(s: string) { return `${GREEN}${s}${RESET}`; }
function yellow(s: string) { return `${YELLOW}${s}${RESET}`; }
function magenta(s: string) { return `${MAGENTA}${s}${RESET}`; }

// ── Types ────────────────────────────────────────────────────────

export type Confidence = "low" | "med" | "high";

export interface PinnedFact {
	id: string;
	owner: string;               // agent id
	key: string;
	value: string;
	confidence: Confidence;
	sourced_from_block_id?: string;
	updated_at: number;
}

export interface Milestone {
	id: string;
	owner: string;               // agent id
	title: string;
	narrative: string;
	topics: string[];
	peers: string[];             // peer ids
	supersedes: string[];        // milestone ids this replaces/amends
	status: "active" | "completed" | "superseded";
	confidence: Confidence;
	sourced_from_blocks: string[];
	started_at?: number;
	ended_at?: number;
	updated_at: number;
}

const CONFIDENCES: readonly Confidence[] = ["low", "med", "high"] as const;
const MILESTONE_STATUSES = ["active", "completed", "superseded"] as const;

// ── Value extraction helpers ─────────────────────────────────────

function extractString(v: any): string | undefined {
	if (v === null || v === undefined) return undefined;
	if (typeof v === "string") return v;
	if (v.stringValue !== undefined) return v.stringValue;
	return undefined;
}

function extractInt(v: any): number | undefined {
	if (v === null || v === undefined) return undefined;
	if (typeof v === "number") return v;
	if (v.intValue !== undefined) {
		const n = v.intValue;
		return typeof n === "number" ? n : parseInt(String(n), 10);
	}
	return undefined;
}

function extractLinkTargetId(v: any): string | undefined {
	if (v === null || v === undefined) return undefined;
	if (v.linkValue?.targetId) return v.linkValue.targetId;
	// Decoded variants also use `linkValue.targetId`.
	return undefined;
}

/** Extract a list of string values from a ValueList field (listVal of stringVal). */
function extractStringList(v: any): string[] {
	if (v === null || v === undefined) return [];
	const items = v.valuesValue?.items ?? v.listValue?.values;
	if (!Array.isArray(items)) return [];
	const out: string[] = [];
	for (const it of items) {
		const s = extractString(it);
		if (s !== undefined) out.push(s);
	}
	return out;
}

/** Extract a list of link target ids from a ValueList of linkVal. */
function extractLinkList(v: any): string[] {
	if (v === null || v === undefined) return [];
	const items = v.valuesValue?.items ?? v.listValue?.values;
	if (!Array.isArray(items)) return [];
	const out: string[] = [];
	for (const it of items) {
		const id = extractLinkTargetId(it);
		if (id) out.push(id);
	}
	return out;
}

function normalizeConfidence(v: unknown): Confidence {
	const s = typeof v === "string" ? v : extractString(v);
	if (s && (CONFIDENCES as readonly string[]).includes(s)) return s as Confidence;
	return "med";
}

// ── Record materialization ───────────────────────────────────────

function factFromState(id: string, state: any): PinnedFact {
	const f = state?.fields ?? {};
	return {
		id,
		owner: extractLinkTargetId(f.owner) ?? "",
		key: extractString(f.key) ?? "",
		value: extractString(f.value) ?? "",
		confidence: normalizeConfidence(f.confidence),
		sourced_from_block_id: extractString(f.sourced_from_block_id),
		updated_at: state?.updatedAt ?? 0,
	};
}

function milestoneFromState(id: string, state: any): Milestone {
	const f = state?.fields ?? {};
	return {
		id,
		owner: extractLinkTargetId(f.owner) ?? "",
		title: extractString(f.title) ?? "",
		narrative: extractString(f.narrative) ?? "",
		topics: extractStringList(f.topics),
		peers: extractLinkList(f.peers),
		supersedes: extractLinkList(f.supersedes),
		status: (() => {
			const s = extractString(f.status);
			return (MILESTONE_STATUSES as readonly string[]).includes(s ?? "")
				? (s as Milestone["status"])
				: "active";
		})(),
		confidence: normalizeConfidence(f.confidence),
		sourced_from_blocks: extractStringList(f.sourced_from_blocks),
		started_at: extractInt(f.started_at),
		ended_at: extractInt(f.ended_at),
		updated_at: state?.updatedAt ?? 0,
	};
}

// ── Value constructors (from ctx, always for writes) ─────────────

function buildStringList(items: string[], ctx: ProgramContext) {
	return ctx.listVal(items.map((s) => ctx.stringVal(s)));
}

function buildLinkList(ids: string[], relationKey: string, ctx: ProgramContext) {
	return ctx.listVal(ids.map((id) => ctx.linkVal(id, relationKey)));
}

// ── Store helpers ────────────────────────────────────────────────

async function listFacts(ownerId: string | undefined, ctx: ProgramContext): Promise<PinnedFact[]> {
	const store = ctx.store as any;
	const refs = await store.list("pinned_fact") as { id: string }[];
	const out: PinnedFact[] = [];
	for (const ref of refs) {
		const state = await store.get(ref.id);
		if (!state || state.deleted) continue;
		if (state.typeKey !== "pinned_fact") continue;
		const rec = factFromState(ref.id, state);
		if (ownerId && rec.owner !== ownerId) continue;
		out.push(rec);
	}
	return out;
}

async function listMilestones(ownerId: string | undefined, ctx: ProgramContext): Promise<Milestone[]> {
	const store = ctx.store as any;
	const refs = await store.list("milestone") as { id: string }[];
	const out: Milestone[] = [];
	for (const ref of refs) {
		const state = await store.get(ref.id);
		if (!state || state.deleted) continue;
		if (state.typeKey !== "milestone") continue;
		const rec = milestoneFromState(ref.id, state);
		if (ownerId && rec.owner !== ownerId) continue;
		out.push(rec);
	}
	return out;
}

async function getFactById(id: string, ctx: ProgramContext): Promise<PinnedFact | null> {
	const store = ctx.store as any;
	const state = await store.get(id);
	if (!state || state.deleted) return null;
	if (state.typeKey !== "pinned_fact") return null;
	return factFromState(id, state);
}

async function getMilestoneById(id: string, ctx: ProgramContext): Promise<Milestone | null> {
	const store = ctx.store as any;
	const state = await store.get(id);
	if (!state || state.deleted) return null;
	if (state.typeKey !== "milestone") return null;
	return milestoneFromState(id, state);
}

// ── Input validation ─────────────────────────────────────────────

function requireOwner(owner: unknown, hint: string): string {
	if (typeof owner !== "string" || !owner) {
		throw new Error(`${hint}: owner (agent id) is required`);
	}
	return owner;
}

function coerceString(v: unknown, field: string, hint: string): string {
	if (typeof v !== "string" || !v) throw new Error(`${hint}: ${field} is required`);
	return v;
}

function coerceOptString(v: unknown): string | undefined {
	return typeof v === "string" && v ? v : undefined;
}

function coerceStringArray(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

function coerceOptInt(v: unknown): number | undefined {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string") {
		const n = Number(v);
		if (Number.isFinite(n)) return n;
	}
	return undefined;
}

// ── Core: facts ──────────────────────────────────────────────────

interface UpsertFactInput {
	owner: string;
	key: string;
	value: string;
	confidence?: string;
	sourced_from_block_id?: string;
}

interface UpsertFactResult {
	id: string;
	created: boolean;
	prior_value?: string;
}

async function doUpsertFact(input: UpsertFactInput, ctx: ProgramContext): Promise<UpsertFactResult> {
	const owner = requireOwner(input.owner, "upsert_fact");
	const key = coerceString(input.key, "key", "upsert_fact");
	const value = coerceString(input.value, "value", "upsert_fact");
	const confidence = normalizeConfidence(input.confidence ?? "med");
	const sourced = coerceOptString(input.sourced_from_block_id);

	const client = ctx.client as any;
	const store = ctx.store as any;

	// Uniqueness: one fact per (owner, key). If it exists, mutate in place —
	// DAG history retains the old value for object_history audits.
	const existing = (await listFacts(owner, ctx)).find((f) => f.key === key);
	if (existing) {
		if (existing.value === value
			&& existing.confidence === confidence
			&& (existing.sourced_from_block_id ?? "") === (sourced ?? "")) {
			return { id: existing.id, created: false, prior_value: existing.value };
		}
		const actor = client.objectActor.getOrCreate([existing.id]);
		await actor.setField("value", JSON.stringify(ctx.stringVal(value)));
		await actor.setField("confidence", JSON.stringify(ctx.stringVal(confidence)));
		if (sourced) {
			await actor.setField("sourced_from_block_id", JSON.stringify(ctx.stringVal(sourced)));
		}
		return { id: existing.id, created: false, prior_value: existing.value };
	}

	const fields: Record<string, unknown> = {
		owner: ctx.linkVal(owner, "owner"),
		key: ctx.stringVal(key),
		value: ctx.stringVal(value),
		confidence: ctx.stringVal(confidence),
	};
	if (sourced) fields.sourced_from_block_id = ctx.stringVal(sourced);
	const id = await store.create("pinned_fact", JSON.stringify(fields));
	return { id, created: true };
}

async function doListFacts(owner: string, key: string | undefined, ctx: ProgramContext): Promise<PinnedFact[]> {
	const all = await listFacts(owner, ctx);
	if (!key) return all.sort((a, b) => a.key.localeCompare(b.key));
	return all.filter((f) => f.key === key);
}

async function doDeleteFact(factId: string, ctx: ProgramContext): Promise<void> {
	const client = ctx.client as any;
	const actor = client.objectActor.getOrCreate([factId]);
	await actor.markDeleted();
}

// ── Core: milestones ─────────────────────────────────────────────

interface UpsertMilestoneInput {
	owner: string;
	title: string;
	narrative: string;
	topics?: string[];
	peers?: string[];              // peer ids
	supersedes?: string[];         // milestone ids
	status?: string;
	confidence?: string;
	sourced_from_blocks?: string[];
	started_at?: number;
	ended_at?: number;
}

interface UpsertMilestoneResult {
	id: string;
	superseded_ids: string[];
}

async function doUpsertMilestone(input: UpsertMilestoneInput, ctx: ProgramContext): Promise<UpsertMilestoneResult> {
	const owner = requireOwner(input.owner, "upsert_milestone");
	const title = coerceString(input.title, "title", "upsert_milestone");
	const narrative = coerceString(input.narrative, "narrative", "upsert_milestone");
	const topics = coerceStringArray(input.topics);
	const peers = coerceStringArray(input.peers);
	const supersedes = coerceStringArray(input.supersedes);
	const status = (() => {
		const s = coerceOptString(input.status);
		return s && (MILESTONE_STATUSES as readonly string[]).includes(s) ? s : "active";
	})();
	const confidence = normalizeConfidence(input.confidence ?? "med");
	const sourced = coerceStringArray(input.sourced_from_blocks);
	const startedAt = coerceOptInt(input.started_at);
	const endedAt = coerceOptInt(input.ended_at);

	const client = ctx.client as any;
	const store = ctx.store as any;

	const fields: Record<string, unknown> = {
		owner: ctx.linkVal(owner, "owner"),
		title: ctx.stringVal(title),
		narrative: ctx.stringVal(narrative),
		status: ctx.stringVal(status),
		confidence: ctx.stringVal(confidence),
	};
	if (topics.length) fields.topics = buildStringList(topics, ctx);
	if (peers.length) fields.peers = buildLinkList(peers, "peer", ctx);
	if (supersedes.length) fields.supersedes = buildLinkList(supersedes, "supersedes", ctx);
	if (sourced.length) fields.sourced_from_blocks = buildStringList(sourced, ctx);
	if (startedAt !== undefined) fields.started_at = ctx.intVal(startedAt);
	if (endedAt !== undefined) fields.ended_at = ctx.intVal(endedAt);

	const id = await store.create("milestone", JSON.stringify(fields));

	// Mark prior milestones as superseded. Skip self and any that don't exist.
	const superseded: string[] = [];
	for (const priorId of supersedes) {
		if (priorId === id) continue;
		const prior = await getMilestoneById(priorId, ctx);
		if (!prior) continue;
		if (prior.owner !== owner) continue;   // cross-agent supersede is disallowed
		if (prior.status === "superseded") { superseded.push(priorId); continue; }
		const actor = client.objectActor.getOrCreate([priorId]);
		await actor.setField("status", JSON.stringify(ctx.stringVal("superseded")));
		superseded.push(priorId);
	}

	return { id, superseded_ids: superseded };
}

interface AmendMilestoneInput {
	milestone_id: string;
	title?: string;
	narrative?: string;
	topics?: string[];
	peers?: string[];
	supersedes?: string[];
	status?: string;
	confidence?: string;
	sourced_from_blocks?: string[];
	started_at?: number;
	ended_at?: number;
}

async function doAmendMilestone(input: AmendMilestoneInput, ctx: ProgramContext): Promise<Milestone> {
	const id = coerceString(input.milestone_id, "milestone_id", "amend_milestone");
	const current = await getMilestoneById(id, ctx);
	if (!current) throw new Error(`amend_milestone: no milestone ${id}`);

	const client = ctx.client as any;
	const actor = client.objectActor.getOrCreate([id]);

	const title = coerceOptString(input.title);
	const narrative = coerceOptString(input.narrative);
	const status = coerceOptString(input.status);
	const confidence = coerceOptString(input.confidence);
	const startedAt = coerceOptInt(input.started_at);
	const endedAt = coerceOptInt(input.ended_at);

	if (title !== undefined) {
		await actor.setField("title", JSON.stringify(ctx.stringVal(title)));
	}
	if (narrative !== undefined) {
		await actor.setField("narrative", JSON.stringify(ctx.stringVal(narrative)));
	}
	if (status !== undefined) {
		if (!(MILESTONE_STATUSES as readonly string[]).includes(status)) {
			throw new Error(`amend_milestone: bad status '${status}' (allowed: ${MILESTONE_STATUSES.join(", ")})`);
		}
		await actor.setField("status", JSON.stringify(ctx.stringVal(status)));
	}
	if (confidence !== undefined) {
		await actor.setField("confidence", JSON.stringify(ctx.stringVal(normalizeConfidence(confidence))));
	}
	if (startedAt !== undefined) {
		await actor.setField("started_at", JSON.stringify(ctx.intVal(startedAt)));
	}
	if (endedAt !== undefined) {
		await actor.setField("ended_at", JSON.stringify(ctx.intVal(endedAt)));
	}
	if (Array.isArray(input.topics)) {
		const topics = coerceStringArray(input.topics);
		await actor.setField("topics", JSON.stringify(buildStringList(topics, ctx)));
	}
	if (Array.isArray(input.peers)) {
		const peers = coerceStringArray(input.peers);
		await actor.setField("peers", JSON.stringify(buildLinkList(peers, "peer", ctx)));
	}
	if (Array.isArray(input.supersedes)) {
		const supersedes = coerceStringArray(input.supersedes);
		await actor.setField("supersedes", JSON.stringify(buildLinkList(supersedes, "supersedes", ctx)));
	}
	if (Array.isArray(input.sourced_from_blocks)) {
		const sourced = coerceStringArray(input.sourced_from_blocks);
		await actor.setField("sourced_from_blocks", JSON.stringify(buildStringList(sourced, ctx)));
	}

	const after = await getMilestoneById(id, ctx);
	if (!after) throw new Error(`amend_milestone: ${id} vanished after edit`);
	return after;
}

interface ListMilestonesFilter {
	owner: string;
	status?: string;
	topic?: string;
	peer_id?: string;
	limit?: number;
}

async function doListMilestones(filter: ListMilestonesFilter, ctx: ProgramContext): Promise<Milestone[]> {
	const owner = requireOwner(filter.owner, "list_milestones");
	let rows = await listMilestones(owner, ctx);
	if (filter.status) rows = rows.filter((m) => m.status === filter.status);
	if (filter.topic) rows = rows.filter((m) => m.topics.includes(filter.topic!));
	if (filter.peer_id) rows = rows.filter((m) => m.peers.includes(filter.peer_id!));
	rows.sort((a, b) => b.updated_at - a.updated_at);
	if (filter.limit && filter.limit > 0) rows = rows.slice(0, filter.limit);
	return rows;
}

// ── Core: recall ─────────────────────────────────────────────────

interface RecallInput {
	owner: string;
	query?: string;                 // case-insensitive substring over fact key/value + milestone title/narrative/topics
	topics?: string[];
	peer_ids?: string[];
	time_range_start?: number;      // ms; milestone intersects [start, end]
	time_range_end?: number;
	limit_facts?: number;
	limit_milestones?: number;
	include_superseded?: boolean;   // default false
}

interface RecallResult {
	facts: PinnedFact[];
	milestones: Milestone[];
}

function factMatchesQuery(f: PinnedFact, q: string): boolean {
	return f.key.toLowerCase().includes(q) || f.value.toLowerCase().includes(q);
}

function milestoneMatchesQuery(m: Milestone, q: string): boolean {
	if (m.title.toLowerCase().includes(q)) return true;
	if (m.narrative.toLowerCase().includes(q)) return true;
	return m.topics.some((t) => t.toLowerCase().includes(q));
}

function milestoneIntersectsRange(m: Milestone, start?: number, end?: number): boolean {
	if (start === undefined && end === undefined) return true;
	const mStart = m.started_at ?? m.updated_at;
	const mEnd = m.ended_at ?? m.updated_at;
	if (start !== undefined && mEnd < start) return false;
	if (end !== undefined && mStart > end) return false;
	return true;
}

async function doRecall(input: RecallInput, ctx: ProgramContext): Promise<RecallResult> {
	const owner = requireOwner(input.owner, "recall");
	const q = input.query?.trim().toLowerCase();
	const topics = coerceStringArray(input.topics);
	const peers = coerceStringArray(input.peer_ids);
	const includeSuperseded = input.include_superseded === true;
	const limitFacts = input.limit_facts && input.limit_facts > 0 ? input.limit_facts : 20;
	const limitMilestones = input.limit_milestones && input.limit_milestones > 0 ? input.limit_milestones : 10;

	let facts = await listFacts(owner, ctx);
	if (q) facts = facts.filter((f) => factMatchesQuery(f, q));
	facts.sort((a, b) => a.key.localeCompare(b.key));
	facts = facts.slice(0, limitFacts);

	let milestones = await listMilestones(owner, ctx);
	if (!includeSuperseded) milestones = milestones.filter((m) => m.status !== "superseded");
	if (q) milestones = milestones.filter((m) => milestoneMatchesQuery(m, q));
	if (topics.length) milestones = milestones.filter((m) => topics.some((t) => m.topics.includes(t)));
	if (peers.length) milestones = milestones.filter((m) => peers.some((p) => m.peers.includes(p)));
	milestones = milestones.filter((m) => milestoneIntersectsRange(m, input.time_range_start, input.time_range_end));
	milestones.sort((a, b) => b.updated_at - a.updated_at);
	milestones = milestones.slice(0, limitMilestones);

	return { facts, milestones };
}

// ── Core: digest (markdown for system-prompt injection) ──────────

interface DigestInput {
	owner: string;
	max_facts?: number;
	max_milestones?: number;
}

function formatDigest(owner: string, facts: PinnedFact[], milestones: Milestone[]): string {
	const lines: string[] = [];
	lines.push("<memory>");

	if (facts.length > 0) {
		lines.push("  <facts>");
		for (const f of facts) {
			const conf = f.confidence === "high" ? "" : ` [${f.confidence}]`;
			lines.push(`    - ${f.key}: ${f.value}${conf}`);
		}
		lines.push("  </facts>");
	} else {
		lines.push("  <facts/>");
	}

	if (milestones.length > 0) {
		lines.push("  <milestones>");
		for (const m of milestones) {
			const topics = m.topics.length ? `  topics=[${m.topics.join(",")}]` : "";
			const statusTag = m.status === "active" ? "" : ` (${m.status})`;
			lines.push(`    - ${m.title}${statusTag}${topics}`);
			for (const line of m.narrative.split("\n")) {
				if (line.trim()) lines.push(`        ${line}`);
			}
		}
		lines.push("  </milestones>");
	} else {
		lines.push("  <milestones/>");
	}

	lines.push("</memory>");
	lines.push("");
	lines.push(`[memory scope: owner=${owner.slice(0, 8)}, ${facts.length} fact(s), ${milestones.length} milestone(s)]`);
	return lines.join("\n");
}

async function doDigest(input: DigestInput, ctx: ProgramContext): Promise<string> {
	const owner = requireOwner(input.owner, "digest");
	const maxFacts = input.max_facts && input.max_facts > 0 ? input.max_facts : 40;
	const maxMilestones = input.max_milestones && input.max_milestones > 0 ? input.max_milestones : 8;

	const facts = (await listFacts(owner, ctx)).sort((a, b) => {
		// Sort high-confidence first, then alphabetical.
		const confOrder = { high: 0, med: 1, low: 2 } as const;
		const d = confOrder[a.confidence] - confOrder[b.confidence];
		if (d !== 0) return d;
		return a.key.localeCompare(b.key);
	}).slice(0, maxFacts);

	const milestones = (await listMilestones(owner, ctx))
		.filter((m) => m.status !== "superseded")
		.sort((a, b) => b.updated_at - a.updated_at)
		.slice(0, maxMilestones);

	return formatDigest(owner, facts, milestones);
}

// ── CLI handler ──────────────────────────────────────────────────

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { resolveId, print } = ctx;

	switch (cmd) {
		// /memory facts <agent_id> [--key K]
		case "facts": {
			const raw = args[0];
			if (!raw) { print(red("Usage: memory facts <agent_id> [--key K]")); break; }
			const owner = await resolveId(raw) ?? raw;
			let key: string | undefined;
			for (let i = 1; i < args.length; i++) {
				if (args[i] === "--key" && args[i + 1]) { key = args[++i]; }
			}
			try {
				const rows = await doListFacts(owner, key, ctx);
				if (rows.length === 0) { print(dim("  (no facts)")); break; }
				print(bold(`  ${rows.length} fact(s)`));
				for (const f of rows) {
					const conf = f.confidence === "high" ? "" : dim(` [${f.confidence}]`);
					print(`    ${cyan(f.key.padEnd(20))} ${f.value}${conf} ${dim(f.id.slice(0, 8))}`);
				}
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		// /memory milestones <agent_id> [--status S] [--topic T] [--peer P] [--limit N]
		case "milestones": {
			const raw = args[0];
			if (!raw) { print(red("Usage: memory milestones <agent_id> [--status S] [--topic T] [--peer P] [--limit N]")); break; }
			const owner = await resolveId(raw) ?? raw;
			const filter: ListMilestonesFilter = { owner };
			for (let i = 1; i < args.length; i++) {
				if (args[i] === "--status" && args[i + 1]) filter.status = args[++i];
				else if (args[i] === "--topic" && args[i + 1]) filter.topic = args[++i];
				else if (args[i] === "--peer" && args[i + 1]) filter.peer_id = args[++i];
				else if (args[i] === "--limit" && args[i + 1]) filter.limit = parseInt(args[++i], 10);
			}
			try {
				const rows = await doListMilestones(filter, ctx);
				if (rows.length === 0) { print(dim("  (no milestones)")); break; }
				print(bold(`  ${rows.length} milestone(s)`));
				for (const m of rows) {
					const statusColor = m.status === "active" ? green : m.status === "completed" ? cyan : yellow;
					const topics = m.topics.length ? dim(`  [${m.topics.join(",")}]`) : "";
					print(`    ${dim(m.id.slice(0, 8))}  ${statusColor(m.status.padEnd(10))} ${bold(m.title)}${topics}`);
				}
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		// /memory get <milestone_id>
		case "get": {
			const raw = args[0];
			if (!raw) { print(red("Usage: memory get <milestone_id>")); break; }
			const id = await resolveId(raw) ?? raw;
			const m = await getMilestoneById(id, ctx);
			if (!m) { print(red("  Milestone not found: ") + id); break; }
			print(bold(`  ${m.title}`));
			print(dim(`  id:        ${m.id}`));
			print(dim(`  owner:     ${m.owner}`));
			print(dim(`  status:    ${m.status}`));
			print(dim(`  confidence:${m.confidence}`));
			if (m.topics.length) print(dim(`  topics:    [${m.topics.join(", ")}]`));
			if (m.peers.length) print(dim(`  peers:     [${m.peers.map((p) => p.slice(0, 8)).join(", ")}]`));
			if (m.supersedes.length) print(dim(`  supersedes:[${m.supersedes.map((s) => s.slice(0, 8)).join(", ")}]`));
			if (m.started_at) print(dim(`  started:   ${new Date(m.started_at).toISOString()}`));
			if (m.ended_at) print(dim(`  ended:     ${new Date(m.ended_at).toISOString()}`));
			print("");
			for (const line of m.narrative.split("\n")) print(`  ${line}`);
			break;
		}

		// /memory digest <agent_id>
		case "digest": {
			const raw = args[0];
			if (!raw) { print(red("Usage: memory digest <agent_id>")); break; }
			const owner = await resolveId(raw) ?? raw;
			try {
				const text = await doDigest({ owner }, ctx);
				for (const line of text.split("\n")) print(`  ${line}`);
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		// /memory recall <agent_id> <query...>
		case "recall": {
			const raw = args[0];
			const query = args.slice(1).join(" ");
			if (!raw) { print(red("Usage: memory recall <agent_id> [query...]")); break; }
			const owner = await resolveId(raw) ?? raw;
			try {
				const r = await doRecall({ owner, query: query || undefined }, ctx);
				print(bold(`  ${r.facts.length} fact(s), ${r.milestones.length} milestone(s)`));
				for (const f of r.facts) print(`    ${cyan(f.key)}: ${f.value}`);
				for (const m of r.milestones) print(`    ${magenta(m.title)}  ${dim(m.status)}`);
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		// /memory forget-fact <fact_id>
		case "forget-fact": {
			const raw = args[0];
			if (!raw) { print(red("Usage: memory forget-fact <fact_id>")); break; }
			const id = await resolveId(raw) ?? raw;
			try {
				await doDeleteFact(id, ctx);
				print(green("  Fact tombstoned (recoverable via object_history)"));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		default: {
			print([
				bold("  Memory") + dim(" — durable facts + milestones for Glon agents"),
				`    ${cyan("memory facts")} ${dim("<agent_id> [--key K]")}                list pinned facts for an agent`,
				`    ${cyan("memory milestones")} ${dim("<agent_id> [--status S] [--topic T] [--peer P] [--limit N]")}`,
				`    ${cyan("memory get")} ${dim("<milestone_id>")}                        show a milestone in full`,
				`    ${cyan("memory digest")} ${dim("<agent_id>")}                         system-prompt-ready digest`,
				`    ${cyan("memory recall")} ${dim("<agent_id> [query...]")}              scoped search`,
				`    ${cyan("memory forget-fact")} ${dim("<fact_id>")}                     tombstone a fact`,
			].join("\n"));
		}
	}
};

// ── Actor (programmatic API exposed as tools) ────────────────────

const actorDef: ProgramActorDef = {
	createState: () => ({}),
	actions: {
		/** Upsert a fact. Input: { owner, key, value, confidence?, sourced_from_block_id? } */
		upsert_fact: async (ctx: ProgramContext, input: UpsertFactInput) => {
			return await doUpsertFact(input ?? ({} as UpsertFactInput), ctx);
		},
		/** List facts for an owner. Input: { owner, key? } */
		list_facts: async (ctx: ProgramContext, input: { owner: string; key?: string }) => {
			const owner = requireOwner(input?.owner, "list_facts");
			return await doListFacts(owner, input?.key, ctx);
		},
		/** Create a milestone. Input: UpsertMilestoneInput */
		upsert_milestone: async (ctx: ProgramContext, input: UpsertMilestoneInput) => {
			return await doUpsertMilestone(input ?? ({} as UpsertMilestoneInput), ctx);
		},
		/** Amend fields on an existing milestone. Input: AmendMilestoneInput */
		amend_milestone: async (ctx: ProgramContext, input: AmendMilestoneInput) => {
			return await doAmendMilestone(input ?? ({} as AmendMilestoneInput), ctx);
		},
		/** List milestones. Input: ListMilestonesFilter */
		list_milestones: async (ctx: ProgramContext, input: ListMilestonesFilter) => {
			return await doListMilestones(input ?? ({ owner: "" } as ListMilestonesFilter), ctx);
		},
		/** Get one milestone by id. Input: { milestone_id } */
		get_milestone: async (ctx: ProgramContext, input: { milestone_id: string }) => {
			const id = coerceString(input?.milestone_id, "milestone_id", "get_milestone");
			return await getMilestoneById(id, ctx);
		},
		/** Scoped recall. Input: RecallInput */
		recall: async (ctx: ProgramContext, input: RecallInput) => {
			return await doRecall(input ?? ({} as RecallInput), ctx);
		},
		/** System-prompt-ready digest. Input: DigestInput */
		digest: async (ctx: ProgramContext, input: DigestInput) => {
			return await doDigest(input ?? ({} as DigestInput), ctx);
		},
	},
};


//
// Local writes through actions above go direct and are trusted. This
// validator fires on `pushChanges` — batches arriving from a peer — and
// rejects malformed memory objects before they hit disk.
//
// Scope (intentionally narrow):
// - On objectCreate in the batch: require the same batch to set the
//   required fields with the right Value shape.
// - On amendments (no objectCreate): validate enum shape of status /
//   confidence if they're being set. We don't have cross-object state
//   here, so invariants like (owner, key) uniqueness are out of scope —
//   the action layer handles those for local writes.

interface ValueShape {
	stringValue?: unknown;
	intValue?: unknown;
	linkValue?: unknown;
	valuesValue?: unknown;
	mapValue?: unknown;
}

function isStringValue(v: unknown): boolean {
	return !!v && typeof (v as ValueShape).stringValue === "string" && !!(v as ValueShape).stringValue;
}
function isLinkValue(v: unknown): boolean {
	const lv = (v as ValueShape | undefined)?.linkValue as { targetId?: unknown } | undefined;
	return !!lv && typeof lv.targetId === "string" && !!lv.targetId;
}
function isValuesList(v: unknown): boolean {
	const vv = (v as ValueShape | undefined)?.valuesValue as { items?: unknown } | undefined;
	return !!vv && Array.isArray(vv.items);
}

function invalid(reason: string): ValidationResult {
	return { valid: false, error: `memory-validator: ${reason}` };
}

export const validator: ValidatorFn = (changes: Change[]): ValidationResult => {
	// Per object, accumulate createdTypeKey + fields set in this batch.
	const perObject = new Map<string, { createdTypeKey?: string; fieldsSet: Map<string, unknown> }>();
	for (const ch of changes) {
		let entry = perObject.get(ch.objectId);
		if (!entry) { entry = { fieldsSet: new Map() }; perObject.set(ch.objectId, entry); }
		for (const op of ch.ops ?? []) {
			if (op.objectCreate?.typeKey) entry.createdTypeKey = op.objectCreate.typeKey;
			if (op.fieldSet) entry.fieldsSet.set(op.fieldSet.key, op.fieldSet.value);
		}
	}

	for (const [objectId, entry] of perObject) {
		// Per-op shape checks apply to both create and amend batches.
		const statusVal = entry.fieldsSet.get("status");
		if (statusVal !== undefined) {
			const s = (statusVal as ValueShape).stringValue;
			if (typeof s !== "string" || !(MILESTONE_STATUSES as readonly string[]).includes(s)) {
				return invalid(`object ${objectId}: bad status '${String(s)}' (allowed: ${MILESTONE_STATUSES.join(", ")})`);
			}
		}
		const confVal = entry.fieldsSet.get("confidence");
		if (confVal !== undefined) {
			const s = (confVal as ValueShape).stringValue;
			if (typeof s !== "string" || !(CONFIDENCES as readonly string[]).includes(s)) {
				return invalid(`object ${objectId}: bad confidence '${String(s)}' (allowed: ${CONFIDENCES.join(", ")})`);
			}
		}

		const typeKey = entry.createdTypeKey;
		if (!typeKey) continue;   // amendment-only batch — shape checks above suffice

		if (typeKey === "pinned_fact") {
			if (!isLinkValue(entry.fieldsSet.get("owner"))) return invalid(`pinned_fact ${objectId}: owner (ObjectLink) missing in create batch`);
			if (!isStringValue(entry.fieldsSet.get("key"))) return invalid(`pinned_fact ${objectId}: key (non-empty string) missing in create batch`);
			if (!isStringValue(entry.fieldsSet.get("value"))) return invalid(`pinned_fact ${objectId}: value (non-empty string) missing in create batch`);
		} else if (typeKey === "milestone") {
			if (!isLinkValue(entry.fieldsSet.get("owner"))) return invalid(`milestone ${objectId}: owner (ObjectLink) missing in create batch`);
			if (!isStringValue(entry.fieldsSet.get("title"))) return invalid(`milestone ${objectId}: title (non-empty string) missing in create batch`);
			if (!isStringValue(entry.fieldsSet.get("narrative"))) return invalid(`milestone ${objectId}: narrative (non-empty string) missing in create batch`);
			for (const listField of ["topics", "peers", "supersedes", "sourced_from_blocks"]) {
				const v = entry.fieldsSet.get(listField);
				if (v !== undefined && !isValuesList(v)) {
					return invalid(`milestone ${objectId}: ${listField} must be a values list`);
				}
			}
		}
	}
	return { valid: true };
};

const program: ProgramDef = {
	handler,
	actor: actorDef,
	validator,
	validatedTypes: ["pinned_fact", "milestone"],
};

export default program;

// ── Internal exports for testing ─────────────────────────────────

export const __test = {
	doUpsertFact,
	doListFacts,
	doUpsertMilestone,
	doAmendMilestone,
	doListMilestones,
	doRecall,
	doDigest,
	factFromState,
	milestoneFromState,
};
