// Todo — phased task list as a Glon object, plus a follow-up reminder hook.
//
// The program persists one `agent_todos` object per agent. Each object's
// `phases_json` field holds the entire phased task list (small, schema is
// owned by this program, edits go through `write` ops). Every mutation is a
// `FieldSet` Change in the DAG, so the full edit history is recoverable via
// `object_history`.
//
// Why one object per agent (not one per task): tasks are inherently a tiny
// ordered structure (~10s of items), and the model addresses them by short
// ids (`task-3`). One blob per agent keeps writes atomic and round-trips
// cheap. If you ever want per-task DAG history (rare), the migration to
// one-object-per-task is straightforward — the typeKey is reserved.
//
// Pairs with /agent's follow-up hook (see makeTodoFollowUpHook in
// agent.ts). When the model emits a "would-stop" turn while incomplete
// items remain, the hook injects a <system-reminder> turn and the loop
// re-enters. Capped by `max_attempts` to prevent runaway grinding.

import type { ProgramDef, ProgramContext, ProgramActorDef, ValidatorFn, ValidationResult } from "../runtime.js";
import type { Change } from "../../proto.js";

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

// ── Types ────────────────────────────────────────────────────────

const TYPE_KEY = "agent_todos";

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";
const STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed", "abandoned"] as const;

export interface TodoTask {
	id: string;
	content: string;
	status: TodoStatus;
	notes?: string;
}

export interface TodoPhase {
	id: string;
	name: string;
	tasks: TodoTask[];
}

interface TodoState {
	phases: TodoPhase[];
	nextTaskId: number;
	nextPhaseId: number;
}

function emptyState(): TodoState {
	return { phases: [], nextTaskId: 1, nextPhaseId: 1 };
}

export type TodoOp =
	| { op: "replace"; phases: { name: string; tasks?: { content: string; status?: TodoStatus; notes?: string }[] }[] }
	| { op: "add_phase"; name: string; tasks?: { content: string; status?: TodoStatus; notes?: string }[] }
	| { op: "add_task"; phase: string; content: string; notes?: string }
	| { op: "update"; id: string; status?: TodoStatus; content?: string; notes?: string }
	| { op: "remove_task"; id: string };

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
	return undefined;
}

// ── State <-> object round-trip ──────────────────────────────────

function stateFromObject(obj: any): TodoState {
	const f = obj?.fields ?? {};
	const json = extractString(f.phases_json);
	if (!json) return emptyState();
	try {
		const parsed = JSON.parse(json) as TodoState;
		if (!parsed || !Array.isArray(parsed.phases)) return emptyState();
		// Defensive: clamp counters from stored data.
		return {
			phases: parsed.phases,
			nextTaskId: typeof parsed.nextTaskId === "number" && parsed.nextTaskId > 0 ? parsed.nextTaskId : recomputeNextTaskId(parsed.phases),
			nextPhaseId: typeof parsed.nextPhaseId === "number" && parsed.nextPhaseId > 0 ? parsed.nextPhaseId : recomputeNextPhaseId(parsed.phases),
		};
	} catch {
		return emptyState();
	}
}

function recomputeNextTaskId(phases: TodoPhase[]): number {
	let max = 0;
	for (const p of phases) {
		for (const t of p.tasks) {
			const m = /^task-(\d+)$/.exec(t.id);
			if (m) {
				const n = parseInt(m[1], 10);
				if (Number.isFinite(n) && n > max) max = n;
			}
		}
	}
	return max + 1;
}

function recomputeNextPhaseId(phases: TodoPhase[]): number {
	let max = 0;
	for (const p of phases) {
		const m = /^phase-(\d+)$/.exec(p.id);
		if (m) {
			const n = parseInt(m[1], 10);
			if (Number.isFinite(n) && n > max) max = n;
		}
	}
	return max + 1;
}

// ── Mutation logic (pure; mirrors OMP's normalization rules) ─────

function findTask(state: TodoState, id: string): TodoTask | undefined {
	for (const p of state.phases) {
		const t = p.tasks.find((tt) => tt.id === id);
		if (t) return t;
	}
	return undefined;
}

function buildPhaseFromInput(
	input: { name: string; tasks?: { content: string; status?: TodoStatus; notes?: string }[] },
	state: TodoState,
): TodoPhase {
	const phaseId = `phase-${state.nextPhaseId++}`;
	const tasks: TodoTask[] = [];
	for (const t of input.tasks ?? []) {
		tasks.push({
			id: `task-${state.nextTaskId++}`,
			content: t.content,
			status: t.status ?? "pending",
			notes: t.notes,
		});
	}
	return { id: phaseId, name: input.name, tasks };
}

/**
 * Enforce: at most one task in_progress; if none and any pending exist,
 * promote the first pending. Same rule OMP's todo-write uses — keeps the
 * model honest about "what am I working on right now".
 */
function normalizeInProgress(state: TodoState): void {
	const ordered = state.phases.flatMap((p) => p.tasks);
	if (ordered.length === 0) return;

	const inProgress = ordered.filter((t) => t.status === "in_progress");
	if (inProgress.length > 1) {
		// Demote all but the first encountered to pending.
		for (const t of inProgress.slice(1)) t.status = "pending";
	}

	if (inProgress.length > 0) return;

	const firstPending = ordered.find((t) => t.status === "pending");
	if (firstPending) firstPending.status = "in_progress";
}

interface ApplyResult {
	state: TodoState;
	errors: string[];
}

export function applyOps(prior: TodoState, ops: TodoOp[]): ApplyResult {
	let state = { ...prior, phases: prior.phases.map((p) => ({ ...p, tasks: p.tasks.map((t) => ({ ...t })) })) };
	const errors: string[] = [];

	for (const op of ops) {
		switch (op.op) {
			case "replace": {
				state = emptyState();
				for (const ip of op.phases) {
					state.phases.push(buildPhaseFromInput(ip, state));
				}
				break;
			}
			case "add_phase": {
				state.phases.push(buildPhaseFromInput(op, state));
				break;
			}
			case "add_task": {
				const target = state.phases.find((p) => p.id === op.phase);
				if (!target) {
					errors.push(`Phase "${op.phase}" not found`);
					break;
				}
				target.tasks.push({
					id: `task-${state.nextTaskId++}`,
					content: op.content,
					status: "pending",
					notes: op.notes,
				});
				break;
			}
			case "update": {
				const t = findTask(state, op.id);
				if (!t) {
					errors.push(`Task "${op.id}" not found`);
					break;
				}
				if (op.status !== undefined) {
					if (!STATUSES.includes(op.status)) {
						errors.push(`Bad status "${op.status}" for ${op.id}`);
						break;
					}
					t.status = op.status;
				}
				if (op.content !== undefined) t.content = op.content;
				if (op.notes !== undefined) t.notes = op.notes;
				break;
			}
			case "remove_task": {
				let removed = false;
				for (const p of state.phases) {
					const idx = p.tasks.findIndex((t) => t.id === op.id);
					if (idx !== -1) {
						p.tasks.splice(idx, 1);
						removed = true;
						break;
					}
				}
				if (!removed) errors.push(`Task "${op.id}" not found`);
				break;
			}
			default: {
				errors.push(`Unknown op "${(op as { op: string }).op}"`);
			}
		}
	}

	normalizeInProgress(state);
	return { state, errors };
}

// ── Filtering for the follow-up reminder hook ────────────────────

export interface IncompleteSummary {
	phases: { name: string; tasks: { id: string; content: string; status: TodoStatus }[] }[];
	total: number;
}

export function summarizeIncomplete(state: TodoState): IncompleteSummary {
	const phases: IncompleteSummary["phases"] = [];
	for (const p of state.phases) {
		const tasks = p.tasks
			.filter((t) => t.status === "pending" || t.status === "in_progress")
			.map((t) => ({ id: t.id, content: t.content, status: t.status }));
		if (tasks.length > 0) phases.push({ name: p.name, tasks });
	}
	return { phases, total: phases.reduce((acc, p) => acc + p.tasks.length, 0) };
}

// ── Store helpers ────────────────────────────────────────────────

async function findTodosObject(ownerId: string, ctx: ProgramContext): Promise<{ id: string; state: TodoState } | null> {
	const store = ctx.store as any;
	const refs = (await store.list(TYPE_KEY)) as { id: string }[];
	for (const ref of refs) {
		const obj = await store.get(ref.id);
		if (!obj || obj.deleted) continue;
		if (obj.typeKey !== TYPE_KEY) continue;
		const owner = extractLinkTargetId(obj.fields?.owner);
		if (owner !== ownerId) continue;
		return { id: ref.id, state: stateFromObject(obj) };
	}
	return null;
}

async function persistState(ownerId: string, prior: { id: string } | null, state: TodoState, ctx: ProgramContext): Promise<string> {
	const client = ctx.client as any;
	const store = ctx.store as any;
	const json = JSON.stringify(state);

	if (prior) {
		const actor = client.objectActor.getOrCreate([prior.id]);
		await actor.setField("phases_json", JSON.stringify(ctx.stringVal(json)));
		return prior.id;
	}

	const fields: Record<string, unknown> = {
		owner: ctx.linkVal(ownerId, "owner"),
		phases_json: ctx.stringVal(json),
	};
	const id = await store.create(TYPE_KEY, JSON.stringify(fields));
	return id;
}

// ── Action handlers ──────────────────────────────────────────────

interface WriteInput {
	owner: string;
	ops: TodoOp[];
}

interface WriteResult {
	id: string;
	phases: TodoPhase[];
	errors: string[];
	summary: string;
}

function requireOwner(v: unknown, hint: string): string {
	if (typeof v !== "string" || !v) throw new Error(`${hint}: owner (agent id) is required`);
	return v;
}

async function doWrite(input: WriteInput, ctx: ProgramContext): Promise<WriteResult> {
	const owner = requireOwner(input?.owner, "todo.write");
	const ops = Array.isArray(input?.ops) ? input.ops : [];
	const prior = await findTodosObject(owner, ctx);
	const startState = prior?.state ?? emptyState();
	const { state, errors } = applyOps(startState, ops);
	const id = await persistState(owner, prior, state, ctx);
	return {
		id,
		phases: state.phases,
		errors,
		summary: formatSummary(state, errors),
	};
}

async function doGet(owner: string, ctx: ProgramContext): Promise<{ id: string | null; phases: TodoPhase[] }> {
	const prior = await findTodosObject(owner, ctx);
	if (!prior) return { id: null, phases: [] };
	return { id: prior.id, phases: prior.state.phases };
}

async function doIncomplete(owner: string, ctx: ProgramContext): Promise<IncompleteSummary> {
	const prior = await findTodosObject(owner, ctx);
	if (!prior) return { phases: [], total: 0 };
	return summarizeIncomplete(prior.state);
}

async function doClear(owner: string, ctx: ProgramContext): Promise<{ ok: boolean }> {
	const prior = await findTodosObject(owner, ctx);
	if (!prior) return { ok: false };
	const client = ctx.client as any;
	const actor = client.objectActor.getOrCreate([prior.id]);
	// Reset to an empty state instead of tombstoning — keeps the same id and
	// the full edit history visible via object_history.
	await actor.setField("phases_json", JSON.stringify(ctx.stringVal(JSON.stringify(emptyState()))));
	return { ok: true };
}

// ── Rendering ────────────────────────────────────────────────────

function formatSummary(state: TodoState, errors: string[]): string {
	const tasks = state.phases.flatMap((p) => p.tasks);
	if (tasks.length === 0) {
		return errors.length > 0 ? `Errors: ${errors.join("; ")}` : "Todo list cleared.";
	}
	const remaining = tasks.filter((t) => t.status === "pending" || t.status === "in_progress");
	const lines: string[] = [];
	if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
	lines.push(`${remaining.length} remaining of ${tasks.length} total`);
	for (const phase of state.phases) {
		lines.push(`  ${phase.name}:`);
		for (const t of phase.tasks) {
			const sym =
				t.status === "completed" ? "✓"
					: t.status === "in_progress" ? "→"
						: t.status === "abandoned" ? "✗"
							: "○";
			lines.push(`    ${sym} ${t.id} ${t.content}`);
		}
	}
	return lines.join("\n");
}

function renderPhases(phases: TodoPhase[], print: (s: string) => void): void {
	if (phases.length === 0) {
		print(dim("  (no todos)"));
		return;
	}
	const total = phases.flatMap((p) => p.tasks).length;
	const remaining = phases.flatMap((p) => p.tasks).filter((t) => t.status === "pending" || t.status === "in_progress").length;
	print(bold(`  ${remaining} remaining of ${total} total`));
	for (const phase of phases) {
		print(cyan(`  ${phase.name}`));
		for (const t of phase.tasks) {
			const sym =
				t.status === "completed" ? green("✓")
					: t.status === "in_progress" ? cyan("→")
						: t.status === "abandoned" ? dim("✗")
							: dim("○");
			const label =
				t.status === "in_progress" ? bold(t.content)
					: t.status === "completed" || t.status === "abandoned" ? dim(t.content)
						: t.content;
			print(`    ${sym} ${dim(t.id)} ${label}`);
		}
	}
}

// ── Handler (CLI subcommands) ────────────────────────────────────

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { resolveId, print } = ctx as any;

	switch (cmd) {
		case "show": {
			const raw = args[0];
			if (!raw) { print(red("Usage: todo show <agent_id>")); break; }
			const owner = (await resolveId(raw)) ?? raw;
			try {
				const r = await doGet(owner, ctx);
				renderPhases(r.phases, print);
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}
		case "clear": {
			const raw = args[0];
			if (!raw) { print(red("Usage: todo clear <agent_id>")); break; }
			const owner = (await resolveId(raw)) ?? raw;
			try {
				const r = await doClear(owner, ctx);
				print(r.ok ? green("  Todos cleared (history preserved via object_history)") : dim("  No todos to clear"));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}
		case "incomplete": {
			const raw = args[0];
			if (!raw) { print(red("Usage: todo incomplete <agent_id>")); break; }
			const owner = (await resolveId(raw)) ?? raw;
			try {
				const r = await doIncomplete(owner, ctx);
				if (r.total === 0) {
					print(dim("  (no incomplete todos)"));
				} else {
					print(bold(`  ${r.total} incomplete`));
					for (const p of r.phases) {
						print(cyan(`  ${p.name}`));
						for (const t of p.tasks) {
							print(`    ${dim(t.id)} ${t.content} ${dim("[" + t.status + "]")}`);
						}
					}
				}
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}
		default: {
			print([
				bold("  Todo") + dim(" — phased task list per agent"),
				`    ${cyan("todo show")} ${dim("<agent_id>")}        render the list`,
				`    ${cyan("todo incomplete")} ${dim("<agent_id>")}  list pending/in_progress only`,
				`    ${cyan("todo clear")} ${dim("<agent_id>")}       reset to empty (history preserved)`,
				dim("  Writes go through the agent's `todo_write` tool, not the CLI."),
			].join("\n"));
		}
	}
};

// ── Actor (programmatic API exposed as actions) ──────────────────

const actorDef: ProgramActorDef = {
	createState: () => ({}),
	actions: {
		/** Apply ops to the agent's todo list. Input: { owner, ops: TodoOp[] } */
		write: async (ctx: ProgramContext, input: WriteInput) => {
			return await doWrite(input ?? ({} as WriteInput), ctx);
		},
		/** Read full phase list. Input: string | { owner } */
		get: async (ctx: ProgramContext, input: string | { owner: string }) => {
			const owner = requireOwner(typeof input === "string" ? input : input?.owner, "todo.get");
			return await doGet(owner, ctx);
		},
		/** Pending + in_progress tasks only. Input: string | { owner } */
		incomplete: async (ctx: ProgramContext, input: string | { owner: string }) => {
			const owner = requireOwner(typeof input === "string" ? input : input?.owner, "todo.incomplete");
			return await doIncomplete(owner, ctx);
		},
		/** Reset list to empty. Input: string | { owner } */
		clear: async (ctx: ProgramContext, input: string | { owner: string }) => {
			const owner = requireOwner(typeof input === "string" ? input : input?.owner, "todo.clear");
			return await doClear(owner, ctx);
		},
	},
};

// ── Validator (peer-synced changes) ──────────────────────────────

interface ValueShape { stringValue?: unknown; linkValue?: unknown }

function isStringValue(v: unknown): boolean {
	const sv = (v as ValueShape | undefined)?.stringValue;
	return typeof sv === "string";
}
function isLinkValue(v: unknown): boolean {
	const lv = (v as ValueShape | undefined)?.linkValue as { targetId?: unknown } | undefined;
	return !!lv && typeof lv.targetId === "string" && !!lv.targetId;
}

function invalid(reason: string): ValidationResult {
	return { valid: false, error: `todo-validator: ${reason}` };
}

export const validator: ValidatorFn = (changes: Change[]): ValidationResult => {
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
		// phases_json must always be a string when present (creates and amends).
		const pj = entry.fieldsSet.get("phases_json");
		if (pj !== undefined && !isStringValue(pj)) {
			return invalid(`object ${objectId}: phases_json must be a string value`);
		}

		if (entry.createdTypeKey === TYPE_KEY) {
			if (!isLinkValue(entry.fieldsSet.get("owner"))) {
				return invalid(`agent_todos ${objectId}: owner (ObjectLink) missing in create batch`);
			}
			if (!isStringValue(entry.fieldsSet.get("phases_json"))) {
				return invalid(`agent_todos ${objectId}: phases_json (string) missing in create batch`);
			}
		}
	}
	return { valid: true };
};

// ── Tool spec (wired by harnesses such as /holdfast) ─────────────

/**
 * Build the `todo_write` tool spec for a specific agent. Bound `owner` so
 * the model can't write into another agent's list.
 */
export function todoWriteToolSpec(agentId: string): {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
	target_prefix: string;
	target_action: string;
	bound_args: Record<string, unknown>;
} {
	const inputTask = {
		type: "object",
		properties: {
			content: { type: "string" },
			status: { type: "string", enum: STATUSES },
			notes: { type: "string" },
		},
		required: ["content"],
	};
	const inputPhase = {
		type: "object",
		properties: {
			name: { type: "string" },
			tasks: { type: "array", items: inputTask },
		},
		required: ["name"],
	};
	const opSchema = {
		type: "array",
		description: "Mutations to apply, in order.",
		items: {
			oneOf: [
				{ type: "object", properties: { op: { const: "replace" }, phases: { type: "array", items: inputPhase } }, required: ["op", "phases"] },
				{ type: "object", properties: { op: { const: "add_phase" }, name: { type: "string" }, tasks: { type: "array", items: inputTask } }, required: ["op", "name"] },
				{ type: "object", properties: { op: { const: "add_task" }, phase: { type: "string" }, content: { type: "string" }, notes: { type: "string" } }, required: ["op", "phase", "content"] },
				{ type: "object", properties: { op: { const: "update" }, id: { type: "string" }, status: { type: "string", enum: STATUSES }, content: { type: "string" }, notes: { type: "string" } }, required: ["op", "id"] },
				{ type: "object", properties: { op: { const: "remove_task" }, id: { type: "string" } }, required: ["op", "id"] },
			],
		},
	};
	return {
		name: "todo_write",
		description: [
			"Manage a phased task list for this conversation. Submit `ops` — each op mutates state incrementally.",
			"You MUST mark a task in_progress before working on it, and completed immediately after.",
			"Keep exactly one task in_progress at a time. The runtime auto-promotes the first pending if none are in_progress, and demotes extras.",
			"Use a list when the task takes 3+ distinct steps; skip it for trivial requests.",
			"Common ops: `update` (status/content/notes), `replace` (initial setup), `add_phase`, `add_task`, `remove_task`.",
		].join(" "),
		input_schema: {
			type: "object",
			properties: { ops: opSchema },
			required: ["ops"],
		},
		target_prefix: "/todo",
		target_action: "write",
		// owner is bound here so the model cannot edit another agent's list.
		bound_args: { owner: agentId },
	};
}

// ── Program export ───────────────────────────────────────────────

const program: ProgramDef = {
	handler,
	actor: actorDef,
	validator,
	validatedTypes: [TYPE_KEY],
};

export default program;

// ── Internal exports for testing ─────────────────────────────────

export const __test = {
	emptyState,
	applyOps,
	summarizeIncomplete,
	stateFromObject,
	formatSummary,
	doWrite,
	doGet,
	doIncomplete,
	doClear,
	TYPE_KEY,
};
