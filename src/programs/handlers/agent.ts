// Agent — an LLM-powered conversational agent that runs on Glon.
//
// Each agent is a regular Glon object (type "agent"). Every turn — user
// prompt, assistant text, tool_use, tool_result, compaction summary — is
// a content-addressed block in the DAG. The LLM sees a *view* over these
// blocks; the DAG itself is append-only truth.
//
// Tool-use: agents can register tools that dispatch to other programs'
// actor actions. `ask` runs a ReAct loop until the model produces pure
// text (or hits an iteration cap).
//
// Compaction: mirrors oh-my-pi's model. When token estimate exceeds
// `contextWindow - reserveTokens`, the agent walks backward to the
// first user boundary whose kept-region budget is met (`keepRecentTokens`)
// and emits a `compaction_summary` block summarising everything before
// that boundary. On the next `ask`, `buildConversationView` honours the
// newest compaction block: it injects the summary into the system prompt
// and emits only the kept turns as messages. Pre-compaction blocks stay
// in the DAG — any peer can replay the full history by ignoring compaction
// blocks.

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";

// ── ANSI ─────────────────────────────────────────────────────────

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";
const BLUE = "\x1b[34m";
const RESET = "\x1b[0m";

function dim(s: string) { return `${DIM}${s}${RESET}`; }
function bold(s: string) { return `${BOLD}${s}${RESET}`; }
function cyan(s: string) { return `${CYAN}${s}${RESET}`; }
function red(s: string) { return `${RED}${s}${RESET}`; }
function green(s: string) { return `${GREEN}${s}${RESET}`; }
function yellow(s: string) { return `${YELLOW}${s}${RESET}`; }
function magenta(s: string) { return `${MAGENTA}${s}${RESET}`; }
function blue(s: string) { return `${BLUE}${s}${RESET}`; }

// ── Constants ────────────────────────────────────────────────────

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const MAX_TOOL_ITERATIONS = 20;
const TOOL_RESULT_TRUNCATE = 8192;

// Summarisation prompt settings (during compaction).
const TOOL_RESULT_TRUNCATE_FOR_SUMMARY = 2000;
const SUMMARY_MAX_TOKENS = 2048;
const SUMMARY_TEMPERATURE = 0.3;

// Compaction defaults (override per-agent via /agent config).
const DEFAULT_COMPACTION_CONTEXT_WINDOW = 200000;
const DEFAULT_COMPACTION_RESERVE_TOKENS = 16384;
const DEFAULT_COMPACTION_KEEP_RECENT_TOKENS = 20000;

// ── Subagent spawning ───────────────────────────────────────────
//
// An agent can spawn other agents as durable, content-addressed children
// (typeKey="agent" like any other). The parent's DAG records a single
// tool_use/tool_result pair whose content is the *compressed* batch result;
// per-child ObjectLink references are embedded in the tool_use input so
// glonWorld can render lineage edges. Each child's full transcript remains
// inspectable as its own agent object.
//
// See `buildSubagentSystemPrompt`, `doSpawn`, `doSubmitResult`, `doCancel`.

const DEFAULT_MAX_SPAWN_DEPTH = 4;
const DEFAULT_SPAWN_CONCURRENCY = 6;
const SUBAGENT_ADDENDUM = `

---
SUBAGENT CONTEXT

You are a subagent. Your parent delegated one task to you and is waiting
for your structured answer.

When you are finished, call the \`submit_result\` tool with your final
answer. If you don't, your last assistant message will be used as the
fallback result with a \`no_submit_result\` warning.

You cannot spawn further subagents unless your template permits it.
`;

// Block content-type tags (CustomContent.contentType).
const BLOCK_TOOL_USE = "tool_use";
const BLOCK_TOOL_RESULT = "tool_result";
const BLOCK_COMPACTION_SUMMARY = "compaction_summary";

// Block text styles (TextContent.style), overloaded for role discrimination.
const STYLE_USER = 0;
const STYLE_ASSISTANT = 1;

// ── Types ────────────────────────────────────────────────────────

interface ToolSpec {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
	target_prefix: string;
	target_action: string;
	/**
	 * Optional partial-application: merged over the model's input before dispatch.
	 * Values here override whatever the model passes for the same keys — use to bind
	 * caller identity (e.g. agent owner id) so the model can't spoof it.
	 */
	bound_args?: Record<string, unknown>;
}

type AnthropicContent =
	| { type: "text"; text: string }
	| { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
	| { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

interface Turn {
	role: "user" | "assistant";
	content: string | AnthropicContent[];
	timestamp: number;
}

interface InferenceResult {
	content: AnthropicContent[];
	stopReason: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
}

interface CompactionConfig {
	enabled: boolean;
	contextWindow: number;
	reserveTokens: number;
	keepRecentTokens: number;
	model?: string;
}

/** One classified block item — the intermediate form before turn grouping. */
type ClassifiedItem =
	| { kind: "user_text"; blockId: string; text: string; timestamp: number }
	| { kind: "assistant_text"; blockId: string; text: string; timestamp: number }
	| { kind: "tool_use"; blockId: string; toolUseId: string; name: string; input: Record<string, unknown>; timestamp: number }
	| { kind: "tool_result"; blockId: string; toolUseId: string; content: string; isError: boolean; timestamp: number }
	| { kind: "compaction"; blockId: string; summary: string; firstKeptBlockId: string; tokensBefore: number; turnCount: number; priorSummaryId?: string; timestamp: number };

// ── Field helpers ────────────────────────────────────────────────

function extractString(v: any): string | undefined {
	if (v === null || v === undefined) return undefined;
	if (typeof v === "string") return v;
	if (v.stringValue !== undefined) return v.stringValue;
	return undefined;
}

function extractInt(v: any, fallback: number): number {
	const s = extractString(v);
	if (s === undefined) return fallback;
	const n = parseInt(s, 10);
	return Number.isFinite(n) ? n : fallback;
}

function extractBool(v: any, fallback: boolean): boolean {
	const s = extractString(v);
	if (s === undefined) return fallback;
	return s === "true" || s === "1";
}

function extractMapEntries(v: any): Record<string, any> | undefined {
	if (v == null) return undefined;
	if (v.mapValue?.entries) return v.mapValue.entries;
	if (v.entries) return v.entries;
	return undefined;
}

function extractTools(toolsField: any): ToolSpec[] {
	const entries = extractMapEntries(toolsField);
	if (!entries) return [];
	const result: ToolSpec[] = [];
	for (const [name, raw] of Object.entries(entries)) {
		const inner = extractMapEntries(raw);
		if (!inner) continue;
		const description = extractString(inner.description) ?? "";
		const schemaStr = extractString(inner.input_schema) ?? "{}";
		const target_prefix = extractString(inner.target_prefix) ?? "";
		const target_action = extractString(inner.target_action) ?? "";
		if (!target_prefix || !target_action) continue;
		let input_schema: Record<string, unknown> = { type: "object" };
		try {
			const parsed = JSON.parse(schemaStr);
			if (parsed && typeof parsed === "object") input_schema = parsed;
		} catch { /* keep default */ }
		let bound_args: Record<string, unknown> | undefined;
		const boundStr = extractString(inner.bound_args);
		if (boundStr) {
			try {
				const parsed = JSON.parse(boundStr);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					bound_args = parsed;
				}
			} catch { /* drop malformed bound_args rather than crash the tool */ }
		}
		result.push({ name, description, input_schema, target_prefix, target_action, bound_args });
	}
	return result;
}

function encodeToolsField(tools: ToolSpec[], mapVal: ProgramContext["mapVal"], stringVal: ProgramContext["stringVal"]) {
	const entries: Record<string, ReturnType<typeof mapVal>> = {};
	for (const t of tools) {
		const inner: Record<string, ReturnType<typeof stringVal>> = {
			description: stringVal(t.description),
			input_schema: stringVal(JSON.stringify(t.input_schema)),
			target_prefix: stringVal(t.target_prefix),
			target_action: stringVal(t.target_action),
		};
		if (t.bound_args && Object.keys(t.bound_args).length > 0) {
			inner.bound_args = stringVal(JSON.stringify(t.bound_args));
		}
		entries[t.name] = mapVal(inner);
	}
	return mapVal(entries);
}

function extractCompactionConfig(fields: Record<string, any>): CompactionConfig {
	return {
		enabled: extractBool(fields?.compaction_enabled, true),
		contextWindow: extractInt(fields?.compaction_context_window, DEFAULT_COMPACTION_CONTEXT_WINDOW),
		reserveTokens: extractInt(fields?.compaction_reserve_tokens, DEFAULT_COMPACTION_RESERVE_TOKENS),
		keepRecentTokens: extractInt(fields?.compaction_keep_recent_tokens, DEFAULT_COMPACTION_KEEP_RECENT_TOKENS),
		model: extractString(fields?.compaction_model),
	};
}

function safeJsonParse(s: string): unknown {
	try { return JSON.parse(s); } catch { return null; }
}

// ── Token estimator ──────────────────────────────────────────────
//
// Cheap heuristic: roughly 3.5 chars per token for English text. Good
// enough for threshold decisions — swap in the real Anthropic tokeniser
// later if precision matters.

function estimateTextTokens(s: string): number {
	return Math.ceil(s.length / 3.5);
}

export function estimateTokens(input: string | AnthropicContent[]): number {
	if (typeof input === "string") return estimateTextTokens(input);
	let total = 0;
	for (const c of input) {
		if (c.type === "text") total += estimateTextTokens(c.text);
		else if (c.type === "tool_use") total += estimateTextTokens(c.name + JSON.stringify(c.input));
		else if (c.type === "tool_result") total += estimateTextTokens(c.content);
	}
	return total;
}

function estimateItemTokens(item: ClassifiedItem): number {
	switch (item.kind) {
		case "user_text":
		case "assistant_text":
			return estimateTextTokens(item.text);
		case "tool_use":
			return estimateTextTokens(item.name + JSON.stringify(item.input));
		case "tool_result":
			return estimateTextTokens(item.content);
		case "compaction":
			return estimateTextTokens(item.summary);
	}
}

// ── Block classification ─────────────────────────────────────────

function classifyBlocks(blocks: any[], provenance: Record<string, any>): ClassifiedItem[] {
	const items: ClassifiedItem[] = [];
	for (const block of blocks ?? []) {
		const prov = provenance?.[block.id];
		const timestamp = prov?.timestamp ?? 0;

		const text = block.content?.text?.text;
		if (typeof text === "string") {
			const style = block.content?.text?.style ?? 0;
			if (style === STYLE_ASSISTANT) {
				items.push({ kind: "assistant_text", blockId: block.id, text, timestamp });
			} else {
				items.push({ kind: "user_text", blockId: block.id, text, timestamp });
			}
			continue;
		}

		const custom = block.content?.custom;
		if (custom) {
			const contentType = custom.contentType ?? custom.content_type;
			const meta = custom.meta ?? {};
			if (contentType === BLOCK_TOOL_USE) {
				const input = (safeJsonParse(meta.input ?? "{}") as Record<string, unknown>) ?? {};
				items.push({
					kind: "tool_use",
					blockId: block.id,
					toolUseId: meta.tool_use_id ?? "",
					name: meta.tool_name ?? "",
					input,
					timestamp,
				});
			} else if (contentType === BLOCK_TOOL_RESULT) {
				items.push({
					kind: "tool_result",
					blockId: block.id,
					toolUseId: meta.tool_use_id ?? "",
					content: meta.content ?? "",
					isError: meta.is_error === "true",
					timestamp,
				});
			} else if (contentType === BLOCK_COMPACTION_SUMMARY) {
				items.push({
					kind: "compaction",
					blockId: block.id,
					summary: meta.summary ?? "",
					firstKeptBlockId: meta.first_kept_block_id ?? "",
					tokensBefore: parseInt(meta.tokens_before ?? "0", 10) || 0,
					turnCount: parseInt(meta.turn_count ?? "0", 10) || 0,
					priorSummaryId: meta.prior_summary_id,
					timestamp,
				});
			}
		}
	}
	items.sort((a, b) => a.timestamp - b.timestamp);
	return items;
}

function findLatestCompaction(items: ClassifiedItem[]): Extract<ClassifiedItem, { kind: "compaction" }> | null {
	let latest: Extract<ClassifiedItem, { kind: "compaction" }> | null = null;
	for (const item of items) {
		if (item.kind === "compaction" && (!latest || item.timestamp > latest.timestamp)) {
			latest = item;
		}
	}
	return latest;
}

/** Filter to the "kept" region: items whose blockId is at or after firstKeptBlockId,
 * excluding compaction blocks themselves. */
function filterToKept(items: ClassifiedItem[], firstKeptBlockId: string): ClassifiedItem[] {
	const idx = items.findIndex((i) => i.blockId === firstKeptBlockId);
	if (idx === -1) return items.filter((i) => i.kind !== "compaction");
	return items.slice(idx).filter((i) => i.kind !== "compaction");
}

/**
 * Pair every `tool_use` with a `tool_result`, synthesizing a stub in-memory
 * when the DAG lacks one. Also drops `tool_result` blocks whose matching
 * `tool_use` no longer exists (e.g. filtered away by compaction).
 *
 * Why: the Anthropic API rejects messages where a `tool_use` is not
 * immediately followed by a `tool_result` with the same id. Writes to the
 * agent object's block list go through RivetKit; if the connection drops
 * after the `tool_use` block lands but before its `tool_result` block does,
 * the on-disk conversation is left inconsistent. Fixing it at read time
 * means the malformed DAG self-heals on the next turn without surgery.
 *
 * The synthetic `tool_result` carries `isError=true` so the model sees the
 * interrupted call for what it was and does not mistake silence for success.
 */
function repairToolPairs(items: ClassifiedItem[]): ClassifiedItem[] {
	const toolUseIds = new Set<string>();
	const resolvedIds = new Set<string>();
	for (const item of items) {
		if (item.kind === "tool_use" && item.toolUseId) toolUseIds.add(item.toolUseId);
		if (item.kind === "tool_result" && item.toolUseId) resolvedIds.add(item.toolUseId);
	}

	const out: ClassifiedItem[] = [];
	for (const item of items) {
		if (item.kind === "tool_result") {
			// Drop orphan tool_results whose tool_use was lost (e.g. trimmed by
			// filterToKept). Sending them to the API would raise a symmetric error.
			if (!item.toolUseId || !toolUseIds.has(item.toolUseId)) continue;
		}
		out.push(item);
		if (item.kind === "tool_use" && item.toolUseId && !resolvedIds.has(item.toolUseId)) {
			out.push({
				kind: "tool_result",
				blockId: `__synthetic:${item.toolUseId}`,
				toolUseId: item.toolUseId,
				content: "[tool call was interrupted before producing a result — treat this as a failed call and proceed.]",
				isError: true,
				timestamp: item.timestamp + 1,
			});
			resolvedIds.add(item.toolUseId);
		}
	}
	return out;
}

/**
 * Merge adjacent same-role turns into one. Anthropic requires `messages[]`
 * to alternate user/assistant; a synthesized `tool_result` turn immediately
 * followed by the runtime-appended user prompt would otherwise produce two
 * user messages in a row.
 */
function mergeConsecutiveTurns(turns: Turn[]): Turn[] {
	const toArray = (c: Turn["content"]): AnthropicContent[] => {
		if (typeof c === "string") return c.length > 0 ? [{ type: "text", text: c }] : [];
		return [...c];
	};
	const out: Turn[] = [];
	for (const t of turns) {
		const last = out[out.length - 1];
		if (last && last.role === t.role) {
			const merged = [...toArray(last.content), ...toArray(t.content)];
			// Preserve the bare-string shape when both sides were simple text so
			// existing tests continue to observe the same content type.
			if (merged.length === 1 && merged[0].type === "text") {
				last.content = merged[0].text;
			} else {
				last.content = merged;
			}
		} else {
			out.push({ ...t });
		}
	}
	return out;
}

/** Group contiguous same-role items into Turn[]. */
function groupIntoTurns(items: ClassifiedItem[]): Turn[] {
	const turns: Turn[] = [];
	let current: Turn | null = null;

	function roleOf(item: ClassifiedItem): "user" | "assistant" | null {
		switch (item.kind) {
			case "user_text":
			case "tool_result":
				return "user";
			case "assistant_text":
			case "tool_use":
				return "assistant";
			case "compaction":
				return null; // should be filtered out before grouping
		}
	}

	for (const item of items) {
		const role = roleOf(item);
		if (role === null) continue;

		if (!current || current.role !== role) {
			current = { role, content: "", timestamp: item.timestamp };
			turns.push(current);
		}

		if (item.kind === "user_text" || item.kind === "assistant_text") {
			if (typeof current.content === "string") {
				// Separate distinct blocks with a blank line so the model can
				// see them as separate inputs (e.g. a user message and a
				// steered follow-up landing in the same turn).
				current.content = current.content
					? current.content + "\n\n" + item.text
					: item.text;
			} else {
				current.content.push({ type: "text", text: item.text });
			}
		} else if (item.kind === "tool_use" || item.kind === "tool_result") {
			if (typeof current.content === "string") {
				const prior = current.content;
				current.content = prior.length > 0 ? [{ type: "text", text: prior }] : [];
			}
			if (item.kind === "tool_use") {
				current.content.push({
					type: "tool_use",
					id: item.toolUseId,
					name: item.name,
					input: item.input,
				});
			} else {
				current.content.push({
					type: "tool_result",
					tool_use_id: item.toolUseId,
					content: item.content,
					is_error: item.isError,
				});
			}
		}
	}

	// Collapse trivial single-text arrays back to bare strings.
	for (const t of turns) {
		if (Array.isArray(t.content) && t.content.length === 1 && t.content[0].type === "text") {
			t.content = t.content[0].text;
		} else if (Array.isArray(t.content) && t.content.length === 0) {
			t.content = "";
		}
	}
	return turns;
}

interface ConversationView {
	/** Summary to inject as a system-prompt extension, if any. */
	systemExtension?: string;
	/** Turns to send as the messages[] array. */
	turns: Turn[];
	/** Latest compaction block, if one exists (for diagnostics). */
	latestCompaction: Extract<ClassifiedItem, { kind: "compaction" }> | null;
}

/**
 * Build the model-facing view of the conversation: system extension + turns.
 *
 * Three defensive passes on top of raw blocks:
 *   1. classifyBlocks  — parse each block into a typed item.
 *   2. repairToolPairs  — synthesize stubs for orphan tool_uses and drop
 *      unpaired tool_results so the Anthropic API never sees a torn pair.
 *   3. mergeConsecutiveTurns — collapse accidental user/user or
 *      assistant/assistant sequences (can arise from synthesis or from the
 *      runtime appending a fresh user prompt after a repaired tool_result).
 */
function buildConversationView(blocks: any[], provenance: Record<string, any>): ConversationView {
	const items = classifyBlocks(blocks, provenance);
	const latest = findLatestCompaction(items);
	if (!latest) {
		const repaired = repairToolPairs(items.filter((i) => i.kind !== "compaction"));
		return {
			systemExtension: undefined,
			turns: mergeConsecutiveTurns(groupIntoTurns(repaired)),
			latestCompaction: null,
		};
	}
	const kept = filterToKept(items, latest.firstKeptBlockId);
	const repaired = repairToolPairs(kept);
	return {
		systemExtension: latest.summary,
		turns: mergeConsecutiveTurns(groupIntoTurns(repaired)),
		latestCompaction: latest,
	};
}

// ── Cut-point finder ─────────────────────────────────────────────

/** Find the index of the item that should be the first "kept" item after a compaction.
 *
 * Walks backward from newest, accumulating token estimates. When the accumulator
 * meets or exceeds `keepRecentTokens` AND the current item is a user_text, returns
 * that index (it's the start of a turn — safe boundary, no tool pairs split).
 *
 * Returns null if the conversation fits under budget, or if no user boundary
 * is found after reaching budget (single turn too large — skip compaction).
 */
function findCutIndex(items: ClassifiedItem[], keepRecentTokens: number): number | null {
	if (items.length === 0) return null;
	let acc = 0;
	for (let i = items.length - 1; i >= 0; i--) {
		acc += estimateItemTokens(items[i]);
		if (items[i].kind === "user_text" && acc >= keepRecentTokens) {
			return i > 0 ? i : null;
		}
	}
	return null;
}

// ── Summarisation prompt + serialisation ─────────────────────────

function serializeItemsForSummary(items: ClassifiedItem[]): string {
	const lines: string[] = [];
	for (const item of items) {
		switch (item.kind) {
			case "user_text":
				lines.push(`[User]: ${item.text}`);
				break;
			case "assistant_text":
				lines.push(`[Assistant]: ${item.text}`);
				break;
			case "tool_use":
				lines.push(`[Assistant tool calls]: ${item.name}(${JSON.stringify(item.input)})`);
				break;
			case "tool_result": {
				let body = item.content;
				if (body.length > TOOL_RESULT_TRUNCATE_FOR_SUMMARY) {
					const omitted = body.length - TOOL_RESULT_TRUNCATE_FOR_SUMMARY;
					body = body.slice(0, TOOL_RESULT_TRUNCATE_FOR_SUMMARY) + `\n[truncated — ${omitted} more bytes]`;
				}
				const tag = item.isError ? "Tool error" : "Tool result";
				lines.push(`[${tag}]: ${body}`);
				break;
			}
			case "compaction":
				// shouldn't be here
				break;
		}
	}
	return lines.join("\n\n");
}

function buildSummaryPrompt(
	items: ClassifiedItem[],
	priorSummary: string | undefined,
	customInstructions: string | undefined,
	extractionRan: boolean = false,
): string {
	const conversation = serializeItemsForSummary(items);
	const priorBlock = priorSummary
		? `\n\nPrior summary being superseded (integrate into the new summary — do not drop facts from it):\n${priorSummary}\n`
		: "";
	const customBlock = customInstructions
		? `\n\nAdditional focus for this summary: ${customInstructions}\n`
		: "";
	const extractionBlock = extractionRan
		? `\n\nDurable facts and narrative milestones have already been extracted to a structured memory store in a prior pass. Keep this summary focused on the short-term arc of the kept region — goal, current state, next steps. Do not re-enumerate every fact; memory covers that.\n`
		: "";

	return `You are summarising an agent's conversation to free up context window space.

Preserve everything the agent will need to continue without re-reading the prior turns:
- What the primary peer is trying to accomplish
- Constraints, preferences, and boundaries stated
- Progress so far — what's done, what's in flight, what's blocked
- Key decisions and their rationale
- Concrete next steps
- Facts that must survive future compactions (names, dates, ids, contact info, pinned context)
- Open threads (things started but not yet resolved)

Write the summary in this exact markdown structure:

## Goal
[1-3 sentences on what the peer wants right now]

## Constraints & Preferences
- [one item per line]

## Progress
### Done
- [x] [completed items]
### In Progress
- [ ] [current work]
### Blocked
- [blockers, if any]

## Key Decisions
- **[decision]**: [rationale]

## Next Steps
1. [most important next action]
2. [...]

## Critical Context
- [concrete facts: names, dates, ids, contact info]

<pinned-facts>
[one short line per fact worth carrying forever]
</pinned-facts>

<open-threads>
[one short line per unresolved thread]
</open-threads>
${customBlock}${priorBlock}${extractionBlock}

Conversation to summarise:

${conversation}`;
}

// ── Anthropic client ─────────────────────────────────────────────
//
// Two auth modes:
//
// 1. OAuth via Claude Pro/Max — set up once with `/auth login anthropic`.
//    The token comes from /auth's actor and we send it as a Bearer header,
//    plus the Claude Code beta strings, User-Agent, and X-Stainless-* fingerprint
//    that the official `claude` CLI sends. Anthropic accepts those requests and
//    bills against the user's plan instead of API credits.
//
// 2. API key — `ANTHROPIC_API_KEY` env var. Plain `x-api-key` auth, billed per token.
//
// The OAuth path imposes two extra constraints we satisfy here:
//   - `system` MUST start with the Claude Code identity string (we prepend it as
//     the first system block when not already present).
//   - Tool names get a `proxy_` prefix on the wire. We strip it from responses so
//     the rest of the agent's dispatch logic stays in Glon's namespace.
//
// These constants are part of the impersonation. Bump them when the official
// Claude CLI updates and our requests start failing with 4xx — see /auth's
// header notes for the rotation surface area.

const CLAUDE_CODE_VERSION = "2.1.39";
const CLAUDE_CODE_SYSTEM_INSTRUCTION = "You are Claude Code, Anthropic's official CLI for Claude.";
const CLAUDE_CODE_TOOL_PREFIX = "proxy_";
const CLAUDE_CODE_BETAS = [
	"claude-code-20250219",
	"oauth-2025-04-20",
	"interleaved-thinking-2025-05-14",
	"prompt-caching-scope-2026-01-05",
].join(",");
// Stainless is Anthropic's SDK generator; the official CLI sends these on every
// request. Drift over time — keep aligned with whatever the current `claude` CLI sends.
const CLAUDE_CODE_STAINLESS_HEADERS: Record<string, string> = {
	"X-Stainless-Helper-Method": "stream",
	"X-Stainless-Retry-Count": "0",
	"X-Stainless-Runtime-Version": "v24.13.1",
	"X-Stainless-Package-Version": "0.73.0",
	"X-Stainless-Runtime": "node",
	"X-Stainless-Lang": "js",
	"X-Stainless-Arch": "arm64",
	"X-Stainless-Os": "MacOS",
	"X-Stainless-Timeout": "600",
};

interface ResolvedAnthropicCredential {
	token: string;
	isOAuth: boolean;
}

/** Transient network failure heuristic — these are all worth one retry. */
function isTransientFetchError(err: unknown): boolean {
	const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
	if (msg.includes("fetch failed")) return true;
	if (msg.includes("econnreset")) return true;
	if (msg.includes("econnrefused")) return true;
	if (msg.includes("etimedout")) return true;
	if (msg.includes("socket hang up")) return true;
	if (msg.includes("enotfound")) return true;
	return false;
}

/**
 * Wrap `fetch` with one retry on transient network errors. Does NOT retry non-2xx
 * HTTP responses — those come back as a resolved Response with `ok: false`, and the
 * caller decides how to surface them. We only retry when the network layer itself threw.
 */
async function fetchWithTransientRetry(url: string, opts: RequestInit, retryDelayMs = 1500): Promise<Response> {
	try {
		return await fetch(url, opts);
	} catch (err) {
		if (!isTransientFetchError(err)) throw err;
		await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
		return await fetch(url, opts);
	}
}

/**
 * Resolve an Anthropic credential. Tries the /auth program first (OAuth and
 * api_key entries in auth.json), falls back to ANTHROPIC_API_KEY env var.
 * Returns null only when nothing is configured — callers turn that into a
 * useful error message at the API boundary.
 */
async function resolveAnthropicCredential(ctx: ProgramContext | undefined): Promise<ResolvedAnthropicCredential | null> {
	if (ctx) {
		try {
			const result = await ctx.dispatchProgram("/auth", "getAnthropic", []) as ResolvedAnthropicCredential | null;
			if (result?.token) return result;
		} catch {
			// /auth not loaded (e.g. before bootstrap, or in a stripped harness).
			// Fall through to env-var.
		}
	}
	const envKey = process.env.ANTHROPIC_API_KEY;
	if (envKey) return { token: envKey, isOAuth: false };
	return null;
}

/**
 * Convert a string system prompt into the array form Anthropic accepts when
 * we need to prepend the Claude Code identity. If the user's prompt already
 * contains the identity string we leave it alone (no double-prepending).
 */
function buildOAuthSystemBlocks(system: string | undefined): { type: "text"; text: string }[] {
	const userPrompt = (system ?? "").trim();
	if (userPrompt.includes(CLAUDE_CODE_SYSTEM_INSTRUCTION)) {
		return [{ type: "text", text: userPrompt }];
	}
	const blocks: { type: "text"; text: string }[] = [
		{ type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION },
	];
	if (userPrompt) blocks.push({ type: "text", text: userPrompt });
	return blocks;
}

async function callAnthropic(
	messages: { role: string; content: string | AnthropicContent[] }[],
	system: string | undefined,
	model: string,
	temperature: number | undefined,
	tools: ToolSpec[] | undefined,
	onChunk: ((text: string) => void) | undefined,
	maxTokens?: number,
	ctx?: ProgramContext,
): Promise<InferenceResult> {
	const testFetch = (globalThis as any).__ANTHROPIC_FETCH as
		| undefined
		| ((req: { messages: any[]; tools?: any[]; system?: string; model: string; maxTokens?: number }) => Promise<InferenceResult>);
	if (testFetch) {
		return testFetch({ messages, tools, system, model, maxTokens });
	}

	const auth = await resolveAnthropicCredential(ctx);
	if (!auth) {
		throw new Error(
			"No Anthropic credentials. Run `/auth login anthropic` to use a Claude Pro/Max plan, " +
			"or set ANTHROPIC_API_KEY in your environment.",
		);
	}

	// Streaming with tool_use is more complex; the existing path only streams when no tools.
	const stream = !!onChunk && !tools;

	const body: Record<string, any> = {
		model,
		max_tokens: maxTokens ?? 4096,
		messages,
		stream,
	};
	// Newer models (Opus 4.7+) reject `temperature` outright. Only include it when
	// the agent has an explicit override; otherwise let the API use its default.
	if (temperature !== undefined) body.temperature = temperature;

	if (auth.isOAuth) {
		body.system = buildOAuthSystemBlocks(system);
	} else if (system) {
		body.system = system;
	}

	if (tools && tools.length > 0) {
		body.tools = tools.map((t) => ({
			name: auth.isOAuth ? `${CLAUDE_CODE_TOOL_PREFIX}${t.name}` : t.name,
			description: t.description,
			input_schema: t.input_schema,
		}));
	}

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"anthropic-version": "2023-06-01",
	};
	if (auth.isOAuth) {
		headers["Authorization"] = `Bearer ${auth.token}`;
		headers["anthropic-beta"] = CLAUDE_CODE_BETAS;
		headers["User-Agent"] = `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`;
		headers["X-App"] = "cli";
		for (const [k, v] of Object.entries(CLAUDE_CODE_STAINLESS_HEADERS)) headers[k] = v;
	} else {
		headers["x-api-key"] = auth.token;
	}

	const doFetch = () => fetchWithTransientRetry("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});

	let res = await doFetch();

	// One refresh-and-retry on 401 in OAuth mode. The token may have expired
	// faster than our buffer suggested (clock drift, or an out-of-band revocation).
	if (!res.ok && res.status === 401 && auth.isOAuth && ctx) {
		try {
			const refreshed = await ctx.dispatchProgram("/auth", "refreshAnthropic", []) as ResolvedAnthropicCredential | null;
			if (refreshed?.token && refreshed.isOAuth) {
				headers["Authorization"] = `Bearer ${refreshed.token}`;
				res = await doFetch();
			}
		} catch {
			// Fall through to the original 401 handling.
		}
	}

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Anthropic API ${res.status}: ${text}`);
	}

	if (stream) {
		let textAccum = "";
		let inputTokens = 0;
		let outputTokens = 0;
		const decoder = new TextDecoder();
		const reader = res.body!.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = decoder.decode(value, { stream: true });
			for (const line of chunk.split("\n")) {
				if (!line.startsWith("data: ")) continue;
				const data = line.slice(6);
				if (data === "[DONE]") continue;
				try {
					const parsed = JSON.parse(data);
					if (parsed.type === "content_block_delta") {
						const t = parsed.delta?.text;
						if (t) { textAccum += t; onChunk!(t); }
					} else if (parsed.type === "message_start") {
						inputTokens = parsed.message?.usage?.input_tokens ?? 0;
					} else if (parsed.type === "message_delta") {
						outputTokens = parsed.usage?.output_tokens ?? 0;
					}
				} catch { /* ignore */ }
			}
		}
		return {
			content: textAccum ? [{ type: "text", text: textAccum }] : [],
			stopReason: "end_turn",
			model,
			inputTokens,
			outputTokens,
		};
	}

	const data = await res.json() as any;
	const rawContent: any[] = Array.isArray(data.content) ? data.content : [];
	// In OAuth mode we sent prefixed tool names; strip the prefix from any tool_use
	// blocks coming back so the agent's dispatch lookup keeps using Glon-native names.
	const content: AnthropicContent[] = rawContent.map((c) => {
		if (auth.isOAuth && c?.type === "tool_use" && typeof c.name === "string" && c.name.startsWith(CLAUDE_CODE_TOOL_PREFIX)) {
			return { ...c, name: c.name.slice(CLAUDE_CODE_TOOL_PREFIX.length) } as AnthropicContent;
		}
		return c as AnthropicContent;
	});
	return {
		content,
		stopReason: data.stop_reason ?? "end_turn",
		model: data.model ?? model,
		inputTokens: data.usage?.input_tokens ?? 0,
		outputTokens: data.usage?.output_tokens ?? 0,
	};
}

/** True when an error looks like an Anthropic context-overflow error. */
function isContextOverflowError(err: any): boolean {
	const msg = err?.message ?? String(err ?? "");
	return /too long|context length|prompt is too long|context_length_exceeded/i.test(msg);
}

// ── Block constructors ───────────────────────────────────────────

function textBlock(id: string, text: string, style: number) {
	return { id, childrenIds: [], content: { text: { text, style } } };
}

function toolUseBlock(id: string, toolUseId: string, name: string, input: Record<string, unknown>) {
	return {
		id,
		childrenIds: [],
		content: {
			custom: {
				contentType: BLOCK_TOOL_USE,
				data: "",
				meta: {
					tool_use_id: toolUseId,
					tool_name: name,
					input: JSON.stringify(input),
				},
			},
		},
	};
}

function toolResultBlock(id: string, toolUseId: string, content: string, isError: boolean) {
	return {
		id,
		childrenIds: [],
		content: {
			custom: {
				contentType: BLOCK_TOOL_RESULT,
				data: "",
				meta: {
					tool_use_id: toolUseId,
					content,
					is_error: isError ? "true" : "false",
				},
			},
		},
	};
}

function compactionBlock(
	id: string,
	summary: string,
	firstKeptBlockId: string,
	tokensBefore: number,
	turnCount: number,
	priorSummaryId: string | undefined,
) {
	const meta: Record<string, string> = {
		summary,
		first_kept_block_id: firstKeptBlockId,
		tokens_before: String(tokensBefore),
		turn_count: String(turnCount),
		created_at: String(Date.now()),
	};
	if (priorSummaryId) meta.prior_summary_id = priorSummaryId;
	return {
		id,
		childrenIds: [],
		content: {
			custom: {
				contentType: BLOCK_COMPACTION_SUMMARY,
				data: "",
				meta,
			},
		},
	};
}

// ── Core: compaction (two-stage) ─────────────────────────
//
// Stage A (optional, opt-in via memory_extraction_enabled): the summariser
// gets a private tool set scoped to the agent's memory and extracts facts /
// milestones via /memory tool calls. Structured, precise, survives future
// compactions.
//
// Stage B (always): single LLM call producing a narrative `compaction_summary`
// block for the kept region. Safety net + short-term context for replies that
// don't need to pull memory.

const EXTRACTION_SYSTEM = `You are extracting durable knowledge from a
conversation slice that is about to be compacted. Write structured memory
via the memory_* tools:

- memory_upsert_fact for atomic, key-value truths (preferences, contact info,
  configuration, boundaries). One row per \`key\`; upserting with the same key
  replaces the value. Use short, stable keys.
- memory_upsert_milestone for narrative arcs: projects, decisions, phases.
  Pass supersedes=[id,...] when this milestone amends or replaces older ones.
- memory_amend_milestone when correcting an existing milestone in place — prefer
  this over creating a new milestone with supersedes when the change is small.
- memory_list_facts / memory_list_milestones / memory_recall to inspect the
  current memory state BEFORE writing, so you don't duplicate what's already known.

Rules:
- Quality over quantity. A terse, accurate set beats a verbose, speculative one.
- Do not invent facts. If the conversation didn't state something, don't pin it.
- Prefer amendments over new milestones when the subject already exists.
- Include sourced_from_block_id / sourced_from_blocks when you can trace the source.
- When done, reply with one short paragraph summarising what you wrote and why.`;

function buildExtractionTools(agentId: string): ToolSpec[] {
	const owner = { owner: agentId };
	return [
		{
			name: "memory_list_facts",
			description: "List existing pinned facts for this agent. Inspect before writing to avoid duplicates.",
			input_schema: { type: "object", properties: { key: { type: "string" } } },
			target_prefix: "/memory",
			target_action: "list_facts",
			bound_args: owner,
		},
		{
			name: "memory_list_milestones",
			description: "List existing milestones. Filter by status/topic/peer_id/limit. Inspect before writing.",
			input_schema: {
				type: "object",
				properties: {
					status: { type: "string", enum: ["active", "completed", "superseded"] },
					topic: { type: "string" },
					peer_id: { type: "string" },
					limit: { type: "number" },
				},
			},
			target_prefix: "/memory",
			target_action: "list_milestones",
			bound_args: owner,
		},
		{
			name: "memory_recall",
			description: "Scoped search over facts + milestones by query/topics/peers/time range.",
			input_schema: {
				type: "object",
				properties: {
					query: { type: "string" },
					topics: { type: "array", items: { type: "string" } },
					peer_ids: { type: "array", items: { type: "string" } },
					limit_facts: { type: "number" },
					limit_milestones: { type: "number" },
					include_superseded: { type: "boolean" },
				},
			},
			target_prefix: "/memory",
			target_action: "recall",
			bound_args: owner,
		},
		{
			name: "memory_upsert_fact",
			description: "Pin a durable atomic fact. One row per `key` — upsert replaces by key.",
			input_schema: {
				type: "object",
				properties: {
					key: { type: "string" },
					value: { type: "string" },
					confidence: { type: "string", enum: ["low", "med", "high"] },
					sourced_from_block_id: { type: "string" },
				},
				required: ["key", "value"],
			},
			target_prefix: "/memory",
			target_action: "upsert_fact",
			bound_args: owner,
		},
		{
			name: "memory_upsert_milestone",
			description: "Record a narrative arc. Pass supersedes=[id,...] to replace older milestones.",
			input_schema: {
				type: "object",
				properties: {
					title: { type: "string" },
					narrative: { type: "string" },
					topics: { type: "array", items: { type: "string" } },
					peers: { type: "array", items: { type: "string" } },
					supersedes: { type: "array", items: { type: "string" } },
					status: { type: "string", enum: ["active", "completed", "superseded"] },
					confidence: { type: "string", enum: ["low", "med", "high"] },
					sourced_from_blocks: { type: "array", items: { type: "string" } },
					started_at: { type: "number" },
					ended_at: { type: "number" },
				},
				required: ["title", "narrative"],
			},
			target_prefix: "/memory",
			target_action: "upsert_milestone",
			bound_args: owner,
		},
		{
			name: "memory_amend_milestone",
			description: "Edit fields on an existing milestone. Prior values remain in object_history.",
			input_schema: {
				type: "object",
				properties: {
					milestone_id: { type: "string" },
					title: { type: "string" },
					narrative: { type: "string" },
					topics: { type: "array", items: { type: "string" } },
					peers: { type: "array", items: { type: "string" } },
					supersedes: { type: "array", items: { type: "string" } },
					status: { type: "string", enum: ["active", "completed", "superseded"] },
					confidence: { type: "string", enum: ["low", "med", "high"] },
					sourced_from_blocks: { type: "array", items: { type: "string" } },
					started_at: { type: "number" },
					ended_at: { type: "number" },
				},
				required: ["milestone_id"],
			},
			target_prefix: "/memory",
			target_action: "amend_milestone",
			// amend is scoped by milestone_id (owner-locked server-side in doAmendMilestone)
		},
	];
}

const EXTRACTION_MAX_ITERATIONS = 8;

interface ExtractionResult {
	extractionSummary: string;
	toolCalls: number;
	iterations: number;
	inputTokens: number;
	outputTokens: number;
}

async function runExtractionLoop(
	serializedConversation: string,
	agentId: string,
	model: string,
	ctx: ProgramContext,
): Promise<ExtractionResult> {
	const tools = buildExtractionTools(agentId);
	const messages: { role: string; content: string | AnthropicContent[] }[] = [
		{ role: "user", content: serializedConversation },
	];
	let iterations = 0;
	let toolCalls = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let extractionSummary = "";

	while (iterations < EXTRACTION_MAX_ITERATIONS) {
		iterations++;
		const result = await callAnthropic(
			messages, EXTRACTION_SYSTEM, model, SUMMARY_TEMPERATURE, tools, undefined, SUMMARY_MAX_TOKENS, ctx,
		);
		inputTokens += result.inputTokens;
		outputTokens += result.outputTokens;

		const assistantText = result.content
			.filter((c): c is Extract<AnthropicContent, { type: "text" }> => c.type === "text")
			.map((c) => c.text)
			.join("");
		const toolUses = result.content.filter(
			(c): c is Extract<AnthropicContent, { type: "tool_use" }> => c.type === "tool_use",
		);

		if (toolUses.length === 0) {
			extractionSummary = assistantText.trim();
			break;
		}

		const toolResults: Extract<AnthropicContent, { type: "tool_result" }>[] = [];
		for (const tu of toolUses) {
			toolCalls++;
			const tool = tools.find((t) => t.name === tu.name);
			let content: string;
			let isError = false;
			if (!tool) {
				content = `Tool '${tu.name}' not registered on extraction loop`;
				isError = true;
			} else {
				try {
					const dispatchInput = tool.bound_args && Object.keys(tool.bound_args).length > 0
						? { ...(tu.input ?? {}), ...tool.bound_args }
						: tu.input;
					const raw = await ctx.dispatchProgram(tool.target_prefix, tool.target_action, [dispatchInput]);
					content = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
				} catch (err: any) {
					content = `Error: ${err?.message ?? String(err)}`;
					isError = true;
				}
			}
			if (content.length > TOOL_RESULT_TRUNCATE_FOR_SUMMARY) {
				content = content.slice(0, TOOL_RESULT_TRUNCATE_FOR_SUMMARY)
					+ `\n[truncated — ${content.length - TOOL_RESULT_TRUNCATE_FOR_SUMMARY} bytes]`;
			}
			toolResults.push({
				type: "tool_result", tool_use_id: tu.id, content, is_error: isError,
			});
		}
		messages.push({ role: "assistant", content: result.content });
		messages.push({ role: "user", content: toolResults });
	}

	return { extractionSummary, toolCalls, iterations, inputTokens, outputTokens };
}

interface CompactResult {
	compacted: boolean;
	reason?: "disabled" | "under_budget" | "no_cut_point";
	blockId?: string;
	firstKeptBlockId?: string;
	turnCount?: number;
	tokensBefore?: number;
	summary?: string;
	extraction?: {
		ran: boolean;
		toolCalls: number;
		iterations: number;
		inputTokens: number;
		outputTokens: number;
		summary: string;
	};
}

async function doCompact(
	agentId: string,
	customInstructions: string | undefined,
	ctx: ProgramContext,
): Promise<CompactResult> {
	const store = ctx.store as any;
	const client = ctx.client as any;
	const { randomUUID } = ctx;

	const state = await store.get(agentId);
	if (!state) throw new Error(`Agent not found: ${agentId}`);
	if (state.typeKey !== "agent") throw new Error(`Object ${agentId} is not an agent`);

	const config = extractCompactionConfig(state.fields ?? {});
	if (!config.enabled) return { compacted: false, reason: "disabled" };

	const items = classifyBlocks(state.blocks ?? [], state.blockProvenance ?? {});
	const latestCompaction = findLatestCompaction(items);
	const effective = latestCompaction
		? filterToKept(items, latestCompaction.firstKeptBlockId)
		: items.filter((i) => i.kind !== "compaction");

	const cutIndex = findCutIndex(effective, config.keepRecentTokens);
	if (cutIndex === null) return { compacted: false, reason: "no_cut_point" };

	const toSummarise = effective.slice(0, cutIndex);
	const firstKeptItem = effective[cutIndex];
	if (toSummarise.length === 0) return { compacted: false, reason: "no_cut_point" };

	const tokensBefore = toSummarise.reduce((acc, it) => acc + estimateItemTokens(it), 0);
	const turnCount = toSummarise.filter((i) => i.kind === "user_text").length;

	const model = config.model || extractString(state.fields?.["model"]) || DEFAULT_MODEL;

	// Stage A — memory extraction (opt-in). Writes structured facts/milestones
	// to /memory via tool calls. Failures degrade gracefully: we log and continue
	// to Stage B so a buggy extraction never blocks compaction.
	const extractionEnabled = extractBool(state.fields?.["memory_extraction_enabled"], false);
	let extractionResult: ExtractionResult | null = null;
	if (extractionEnabled) {
		try {
			const conversation = serializeItemsForSummary(toSummarise);
			extractionResult = await runExtractionLoop(conversation, agentId, model, ctx);
		} catch (err: any) {
			// Degrade: record the failure in the result, skip Stage A contribution.
			extractionResult = {
				extractionSummary: `(extraction failed: ${err?.message ?? String(err)})`,
				toolCalls: 0, iterations: 0, inputTokens: 0, outputTokens: 0,
			};
		}
	}

	const prompt = buildSummaryPrompt(toSummarise, latestCompaction?.summary, customInstructions, !!extractionResult);

	const result = await callAnthropic(
		[{ role: "user", content: prompt }],
		undefined,
		model,
		SUMMARY_TEMPERATURE,
		undefined,
		undefined,
		SUMMARY_MAX_TOKENS,
		ctx,
	);
	const summary = result.content
		.filter((c): c is Extract<AnthropicContent, { type: "text" }> => c.type === "text")
		.map((c) => c.text)
		.join("")
		.trim();
	if (!summary) throw new Error("Compaction summary came back empty");

	const actor = client.objectActor.getOrCreate([agentId]);
	const blockId = randomUUID();
	await actor.addBlock(JSON.stringify(
		compactionBlock(blockId, summary, firstKeptItem.blockId, tokensBefore, turnCount, latestCompaction?.blockId),
	));

	const extraction = extractionResult ? {
		ran: true,
		toolCalls: extractionResult.toolCalls,
		iterations: extractionResult.iterations,
		inputTokens: extractionResult.inputTokens,
		outputTokens: extractionResult.outputTokens,
		summary: extractionResult.extractionSummary,
	} : undefined;

	return {
		compacted: true,
		blockId,
		firstKeptBlockId: firstKeptItem.blockId,
		extraction,
		turnCount,
		tokensBefore,
		summary,
	};
}

// ── Core: tool registration ──────────────────────────────────────

async function doRegisterTool(agentId: string, spec: ToolSpec, ctx: ProgramContext): Promise<string> {
	const store = ctx.store as any;
	const state = await store.get(agentId);
	if (!state) throw new Error(`Agent not found: ${agentId}`);
	if (state.typeKey !== "agent") throw new Error(`Object ${agentId} is not an agent (typeKey=${state.typeKey})`);

	const existing = extractTools(state.fields?.tools);
	const filtered = existing.filter((t) => t.name !== spec.name);
	filtered.push(spec);

	const client = ctx.client as any;
	const actor = client.objectActor.getOrCreate([agentId]);
	const encoded = encodeToolsField(filtered, ctx.mapVal, ctx.stringVal);
	await actor.setField("tools", JSON.stringify(encoded));
	return `Registered tool '${spec.name}' → ${spec.target_prefix} ${spec.target_action}`;
}

async function doUnregisterTool(agentId: string, toolName: string, ctx: ProgramContext): Promise<string> {
	const store = ctx.store as any;
	const state = await store.get(agentId);
	if (!state) throw new Error(`Agent not found: ${agentId}`);

	const existing = extractTools(state.fields?.tools);
	const filtered = existing.filter((t) => t.name !== toolName);
	if (filtered.length === existing.length) return `No tool named '${toolName}' registered`;

	const client = ctx.client as any;
	const actor = client.objectActor.getOrCreate([agentId]);
	const encoded = encodeToolsField(filtered, ctx.mapVal, ctx.stringVal);
	await actor.setField("tools", JSON.stringify(encoded));
	return `Unregistered '${toolName}' (${filtered.length} tool(s) remain)`;
}

async function doListTools(agentId: string, ctx: ProgramContext): Promise<ToolSpec[]> {
	const store = ctx.store as any;
	const state = await store.get(agentId);
	if (!state) throw new Error(`Agent not found: ${agentId}`);
	return extractTools(state.fields?.tools);
}

// ── Core: status ─────────────────────────────────────────────────

interface AgentStatus {
	id: string;
	name: string;
	model: string;
	system: string | undefined;
	tools: number;
	blockCount: number;
	effectiveTurns: number;
	estimatedTokens: number;
	compaction: {
		config: CompactionConfig;
		threshold: number;
		lastCompaction?: { blockId: string; firstKeptBlockId: string; tokensBefore: number; turnCount: number; createdAt: number };
	};
}

async function doStatus(agentId: string, ctx: ProgramContext): Promise<AgentStatus> {
	const store = ctx.store as any;
	const state = await store.get(agentId);
	if (!state) throw new Error(`Agent not found: ${agentId}`);
	if (state.typeKey !== "agent") throw new Error(`Object ${agentId} is not an agent`);

	const items = classifyBlocks(state.blocks ?? [], state.blockProvenance ?? {});
	const latest = findLatestCompaction(items);
	const view = buildConversationView(state.blocks ?? [], state.blockProvenance ?? {});
	const config = extractCompactionConfig(state.fields ?? {});
	const threshold = config.contextWindow - config.reserveTokens;

	const estimatedTokens = view.turns.reduce(
		(acc, t) => acc + (typeof t.content === "string" ? estimateTextTokens(t.content) : estimateTokens(t.content)),
		view.systemExtension ? estimateTextTokens(view.systemExtension) : 0,
	);

	return {
		id: agentId,
		name: extractString(state.fields?.name) ?? "agent",
		model: extractString(state.fields?.model) ?? DEFAULT_MODEL,
		system: extractString(state.fields?.system),
		tools: extractTools(state.fields?.tools).length,
		blockCount: items.length,
		effectiveTurns: view.turns.length,
		estimatedTokens,
		compaction: {
			config,
			threshold,
			lastCompaction: latest ? {
				blockId: latest.blockId,
				firstKeptBlockId: latest.firstKeptBlockId,
				tokensBefore: latest.tokensBefore,
				turnCount: latest.turnCount,
				createdAt: latest.timestamp,
			} : undefined,
		},
	};
}

// ── Core: the tool-use loop (with auto-compaction) ───────────────

interface AskResult {
	finalText: string;
	iterations: number;
	toolCalls: number;
	inputTokens: number;
	outputTokens: number;
	compactedBeforeAsk: boolean;
	compactedOnOverflow: boolean;
}

/** Flag on an agent object enabling auto-injection of /memory digest into the system prompt. */
const FIELD_MEMORY_DIGEST_ENABLED = "memory_digest_enabled";

/** Fetch a /memory digest for the agent, or undefined if disabled / unavailable.
 *  Silent graceful degrade: if /memory isn't running or errors, we return undefined
 *  rather than block the ask. Memory is enhancement, not a hard dependency. */
async function resolveMemoryDigest(agentId: string, ctx: ProgramContext): Promise<string | undefined> {
	const store = ctx.store as any;
	const state = await store.get(agentId);
	if (!state) return undefined;
	if (!extractBool(state.fields?.[FIELD_MEMORY_DIGEST_ENABLED], false)) return undefined;
	try {
		const raw = await ctx.dispatchProgram("/memory", "digest", [{ owner: agentId }]);
		return typeof raw === "string" && raw.length > 0 ? raw : undefined;
	} catch {
		return undefined;
	}
}

function buildEffectiveSystem(
	base: string | undefined,
	extension: string | undefined,
	memoryDigest?: string,
): string | undefined {
	const parts: string[] = [];
	if (base) parts.push(base);
	if (extension) parts.push(`<conversation-summary>\n${extension}\n</conversation-summary>`);
	if (memoryDigest) parts.push(memoryDigest);
	return parts.length === 0 ? undefined : parts.join("\n\n");
}

async function shouldAutoCompact(agentId: string, ctx: ProgramContext): Promise<boolean> {
	const store = ctx.store as any;
	const state = await store.get(agentId);
	if (!state) return false;
	const config = extractCompactionConfig(state.fields ?? {});
	if (!config.enabled) return false;

	const view = buildConversationView(state.blocks ?? [], state.blockProvenance ?? {});
	const memoryDigest = await resolveMemoryDigest(agentId, ctx);
	const est = view.turns.reduce(
		(acc, t) => acc + (typeof t.content === "string" ? estimateTextTokens(t.content) : estimateTokens(t.content)),
		(view.systemExtension ? estimateTextTokens(view.systemExtension) : 0)
			+ (memoryDigest ? estimateTextTokens(memoryDigest) : 0),
	);
	return est > config.contextWindow - config.reserveTokens;
}

 // ── Run coordination (steering) ──────────────────────────────────
 //
 // A "steered" message is a user prompt that arrives while a model run for
 // the same agent is already in flight. Spawning a parallel runAsk would
 // race on the agent's DAG and confuse the model with overlapping context.
 // Instead we serialize per agent: one runner owns the loop, late callers
 // attach as steerers and wait.
 //
 // Glon-spirit choices:
 //   - The queue isn't a sidecar structure. Every prompt is committed as
 //     a normal `user_text` block via objectActor.addBlock — DAG-native,
 //     sync'd to peers, visible to /inspect, replayable. The runner's
 //     loop rebuilds messages from the agent's blocks each iteration, so
 //     steered blocks naturally enter the next model call (the same
 //     mechanism compaction relies on).
 //   - The lock is a synchronous in-process flag (`slot.running`). In a
 //     single-process deployment (REPL or daemon, not both racing on the
 //     same agent) this is sound. Multi-process deployments would still
 //     produce parallel runs, the same as before this patch — fix when
 //     glon's kernel grows a `tryAcquire` action on objectActor.
 //   - Per-message attribution: each pending steerer's promise resolves
 //     with the slice of assistant text generated between their user
 //     block and the next user block (or end of run). When two prompts
 //     are batched into the same iteration, both callers get the same
 //     slice — that's truthful: one model response covered both questions.
 //   - The runner is just a steerer that also owns the loop. Their own
 //     promise rides slot.pending alongside the others; the loop's tail
 //     resolves everyone uniformly.
 //
 // Race tail: a late-arriving steerer can push to slot.pending between
 // the runner's last `pending.length === 0` check and the lock release.
 // We close it by re-checking pending in a synchronous loop in runAsk —
 // single-threaded JS guarantees no microtask interleaves between the
 // check and the `slot.running = null` write below.
 
 interface PendingSteerer {
 	userBlockId: string;
 	resolve: (r: AskResult) => void;
 	reject: (e: Error) => void;
 }
 
 interface RunSlot {
	running: boolean;
 	pending: PendingSteerer[];
 }
 
 const runSlots = new Map<string, RunSlot>();
 
 function ensureSlot(agentId: string): RunSlot {
 	let slot = runSlots.get(agentId);
 	if (!slot) {
		slot = { running: false, pending: [] };
 		runSlots.set(agentId, slot);
 	}
 	return slot;
 }
 
 /**
 * True iff at least one assistant_text block exists strictly after the
 * given user block. Used by the runner to decide whether a pending
 * steerer still needs a model round.
 */
 function hasAssistantTextAfter(blocks: any[], userBlockId: string): boolean {
 	const idx = blocks.findIndex((b) => b.id === userBlockId);
 	if (idx < 0) return false;
 	for (let i = idx + 1; i < blocks.length; i++) {
 		const text = blocks[i].content?.text;
 		if (!text) continue;
 		if ((text.style ?? 0) === STYLE_ASSISTANT) return true;
 	}
 	return false;
 }
 
 /**
 * Slice of the assistant response that addresses a given user block.
 *
 * Walks blocks forward from the user block. Co-drained user blocks
 * (consecutive user_text with no intervening assistant_text) share the
 * next assistant response — both callers get the same slice. Tool blocks
 * are transparent. Stops at the next user_text once at least one
 * assistant_text has been collected, so a steerer arriving after the
 * runner's reply doesn't accidentally swallow a later, unrelated
 * response.
 */
 function computeAssistantSlice(blocks: any[], userBlockId: string): string {
 	const idx = blocks.findIndex((b) => b.id === userBlockId);
 	if (idx < 0) return "";
 	const out: string[] = [];
 	let foundAssistant = false;
 	for (let i = idx + 1; i < blocks.length; i++) {
 		const text = blocks[i].content?.text;
 		if (!text) continue;
 		const style = text.style ?? 0;
 		if (style === STYLE_USER) {
 			if (foundAssistant) break;
 			continue;
 		}
 		if (style === STYLE_ASSISTANT) {
 			out.push(text.text);
 			foundAssistant = true;
 		}
 	}
 	return out.join("\n\n");
 }
 
 /**
 * Public entry point. Owns lock acquisition and the runner-vs-steerer
 * decision. The actual model loop lives in runLoop.
 */
 async function runAsk(
 	agentId: string,
 	prompt: string,
 	ctx: ProgramContext,
 	opts: { printStream?: boolean } = {},
 ): Promise<AskResult> {
 	const slot = ensureSlot(agentId);
 	const userBlockId = ctx.randomUUID();
 	const actor = (ctx.client as any).objectActor.getOrCreate([agentId]);
 
	// Synchronous lock decision. Single-threaded JS guarantees no other
	// caller can interleave between the read and the write.
	const isRunner = !slot.running;
 
 	if (!isRunner) {
 		// Steerer path: commit the user block, then park on a promise the
 		// runner will resolve from runLoop's tail.
 		await actor.addBlock(JSON.stringify(textBlock(userBlockId, prompt, STYLE_USER)));
 		return new Promise<AskResult>((resolve, reject) => {
 			slot.pending.push({ userBlockId, resolve, reject });
 		});
 	}
 
	// Runner path. The runner does NOT join slot.pending — their result is
	// returned directly from runLoop. Only late steerers ride pending.
	slot.running = true;
	await actor.addBlock(JSON.stringify(textBlock(userBlockId, prompt, STYLE_USER)));

	try {
		while (true) {
			const result = await runLoop(agentId, userBlockId, slot, ctx, opts);
			// Synchronous re-check: any straggler pushed during the gap between
			// runLoop's last `pending.length === 0` check and its return? Loop
			// again to address them. Subsequent runLoop calls have nothing to
			// do for the runner (their result is final after the first call).
			if (slot.pending.length === 0) return result;
		}
	} catch (err: any) {
		// Propagate the error to any steerer waiting on a result and to the
		// runner's caller (via this throw).
		const stragglers = slot.pending.splice(0);
		for (const p of stragglers) p.reject(err instanceof Error ? err : new Error(String(err)));
		throw err;
	} finally {
		slot.running = false;
		if (slot.pending.length === 0) runSlots.delete(agentId);
	}
 }
 
 /**
 * Inner model loop. Drives one or more model calls until:
 *   - the model produced an assistant text without tool_use, AND
 *   - every pending steerer has assistant text after their user block
 *     (i.e. the model has spoken to all queued questions).
 *
 * The loop rebuilds messages from the agent's DAG blocks at the top of
 * every iteration. Steered user blocks added between iterations are
 * therefore picked up automatically — no in-memory queue drain needed.
 *
 * On exit, every entry in slot.pending is removed and resolved with its
 * computed assistant slice (which may be the empty string if the model
 * never spoke after that user block — truthful and observable).
 */
async function runLoop(
	agentId: string,
	originalUserBlockId: string,
	slot: RunSlot,
	ctx: ProgramContext,
	opts: { printStream?: boolean },
): Promise<AskResult> {
	const store = ctx.store as any;
	const client = ctx.client as any;
	const { randomUUID, print } = ctx;

	let compactedBeforeAsk = false;
	let compactedOnOverflow = false;

	// Pre-flight auto-compact. Re-evaluates current context size every time
	// runLoop is invoked; if the runner re-enters the loop for a late
	// straggler (extremely rare race), the second call gets a fresh check.
	if (await shouldAutoCompact(agentId, ctx)) {
		const res = await doCompact(agentId, undefined, ctx);
		compactedBeforeAsk = res.compacted;
	}

	let state = await store.get(agentId);
	if (!state) throw new Error(`Agent not found: ${agentId}`);
	if (state.typeKey !== "agent") throw new Error(`Object ${agentId} is not an agent`);

	const baseSystem = extractString(state.fields?.["system"]);
	const model = extractString(state.fields?.["model"]) || DEFAULT_MODEL;
	const tempStr = extractString(state.fields?.["temperature"]);
	const temperature = tempStr ? parseFloat(tempStr) : undefined;
	const tools = extractTools(state.fields?.["tools"]);

	const actor = client.objectActor.getOrCreate([agentId]);

	// Initial messages: compaction-aware translation of every block already
	// in the DAG. From this point we maintain `messages` incrementally so
	// the temporal order the model sees mirrors the order the runner
	// produced it — not the order the DAG happens to record (steered
	// user blocks can land between a model call's submit and its response,
	// so DAG-order rebuilds would interleave them incorrectly).
	const initialView = buildConversationView(state.blocks ?? [], state.blockProvenance ?? {});
	const initialMemoryDigest = await resolveMemoryDigest(agentId, ctx);
	let effectiveSystem = buildEffectiveSystem(baseSystem, initialView.systemExtension, initialMemoryDigest);
	const messages: { role: string; content: string | AnthropicContent[] }[] = initialView.turns.map((t) => ({
		role: t.role,
		content: t.content,
	}));

	// Track every block already represented in `messages`. Anything in the
	// DAG that isn't in this set at the top of an iteration is new — in
	// practice that means a steered user_text block from another caller.
	const incorporatedBlockIds = new Set<string>();
	for (const b of state.blocks ?? []) incorporatedBlockIds.add(b.id);

	// Per-iteration attribution. We track which iteration first submitted each
	// pending user_block to the model, and the assistant text emitted at each
	// iteration. At run-end, every pending caller's slice is determined by
	// the first text-emitting iteration whose batch (users submitted since
	// the previous text-emitting iteration) includes them. This produces:
	//   - co-drained users (submitted in same batch) share the response,
	//   - tool-loop interruptions: the steerer's batch extends through tool
	//     iterations until the model finally emits text addressing all of them,
	//   - the original caller's slice is computed by the same rule.
	const firstSubmittedAtIter = new Map<string, number>();
	const iterationTexts = new Map<number, string>();
	const addressedUserBlockIds = new Set<string>();

	let iterations = 0;
	let toolCalls = 0;
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let lastRoundHadTools = false;

	while (true) {
		if (iterations >= MAX_TOOL_ITERATIONS) {
			throw new Error(`Tool-use loop exceeded ${MAX_TOOL_ITERATIONS} iterations`);
		}

		// Cancel signal (set externally via /agent.cancel or by a parent
		// during a subagent run).
		state = await store.get(agentId);
		if (state && extractString(state.fields?.cancel_requested) === "true") {
			throw new Error("cancelled: cancel_requested was set on this agent");
		}

		// Drain new user_text blocks committed since last iteration. These
		// are steered messages from other callers — their addBlock landed in
		// the DAG, but they aren't in `messages` yet. Append as a fresh user
		// turn (or merge with the previous user turn if that turn was also
		// pure user content; this happens when a steerer arrives before the
		// runner has emitted any assistant_text).
		const newUserBlocks: { id: string; text: string }[] = [];
		for (const block of state?.blocks ?? []) {
			if (incorporatedBlockIds.has(block.id)) continue;
			const text = block.content?.text;
			if (!text) continue;
			if ((text.style ?? 0) !== STYLE_USER) continue;
			newUserBlocks.push({ id: block.id, text: text.text });
		}
		if (newUserBlocks.length > 0) {
			const joined = newUserBlocks.map((b) => b.text).join("\n\n");
			const last = messages[messages.length - 1];
			if (last && last.role === "user" && typeof last.content === "string") {
				last.content = last.content + "\n\n" + joined;
			} else if (last && last.role === "user" && Array.isArray(last.content)) {
				last.content.push({ type: "text", text: joined });
			} else {
				messages.push({ role: "user", content: joined });
			}
			for (const b of newUserBlocks) incorporatedBlockIds.add(b.id);
		}

		// Decide whether another model round is needed: only break if no
		// pending steerer is still waiting on the model to address them.
		if (!lastRoundHadTools) {
			// Runner needs to be addressed too. Their userBlockId isn't in
			// slot.pending, but we still owe them a slice.
			const runnerNeedsAnswer = !addressedUserBlockIds.has(originalUserBlockId);
			const hasUnaddressed = runnerNeedsAnswer || slot.pending.some(
				(p) => !addressedUserBlockIds.has(p.userBlockId),
			);
			if (!hasUnaddressed) break;
		}

		iterations++;

		// Record submission iteration. The runner's userBlockId is incorporated
		// from the initial view; we ensure it's tracked here. Steerers added
		// to slot.pending are also tracked.
		if (!firstSubmittedAtIter.has(originalUserBlockId)) {
			firstSubmittedAtIter.set(originalUserBlockId, iterations);
		}
		for (const p of slot.pending) {
			if (!firstSubmittedAtIter.has(p.userBlockId) && incorporatedBlockIds.has(p.userBlockId)) {
				firstSubmittedAtIter.set(p.userBlockId, iterations);
			}
		}

		let streamBuffer = "";
		const canStream = opts.printStream && tools.length === 0;
		const onChunk = canStream
			? (text: string) => {
				streamBuffer += text;
				const lines = streamBuffer.split("\n");
				for (let i = 0; i < lines.length - 1; i++) print(`  ${lines[i]}`);
				streamBuffer = lines[lines.length - 1];
			}
			: undefined;

		let result: InferenceResult;
		try {
			result = await callAnthropic(messages, effectiveSystem, model, temperature, tools.length > 0 ? tools : undefined, onChunk, undefined, ctx);
		} catch (err: any) {
			if (iterations === 1 && !compactedOnOverflow && isContextOverflowError(err)) {
				// Overflow recovery: compact, then rebuild messages from the
				// new (smaller) DAG view and retry. Steered user blocks added
				// before this point are preserved — they're still in the DAG
				// and the rebuild picks them up.
				await doCompact(agentId, undefined, ctx);
				compactedOnOverflow = true;
				state = await store.get(agentId);
				const reView = buildConversationView(state.blocks ?? [], state.blockProvenance ?? {});
				const reDigest = await resolveMemoryDigest(agentId, ctx);
				effectiveSystem = buildEffectiveSystem(baseSystem, reView.systemExtension, reDigest);
				messages.length = 0;
				for (const t of reView.turns) messages.push({ role: t.role, content: t.content });
				incorporatedBlockIds.clear();
				for (const b of state.blocks ?? []) incorporatedBlockIds.add(b.id);
				iterations--;
				continue;
			}
			throw err;
		}

		if (canStream && streamBuffer) print(`  ${streamBuffer}`);
		totalInputTokens += result.inputTokens;
		totalOutputTokens += result.outputTokens;

		const assistantText = result.content
			.filter((c): c is Extract<AnthropicContent, { type: "text" }> => c.type === "text")
			.map((c) => c.text)
			.join("");
		const toolUses = result.content.filter(
			(c): c is Extract<AnthropicContent, { type: "tool_use" }> => c.type === "tool_use",
		);

		// Append the assistant message (text + tool_uses) to local messages.
		if (result.content.length > 0) {
			messages.push({ role: "assistant", content: result.content });
		}

		// Persist to DAG and record text-emitting iterations for attribution.
		if (assistantText) {
			const id = randomUUID();
			await actor.addBlock(JSON.stringify(textBlock(id, assistantText, STYLE_ASSISTANT)));
			incorporatedBlockIds.add(id);
			iterationTexts.set(iterations, assistantText);
			// Mark every user (runner + pending) submitted up to this iteration
			// as addressed. They share this iteration's text if they were
			// submitted since the previous text-emitting iteration.
			for (const [blockId, fi] of firstSubmittedAtIter) {
				if (fi <= iterations) addressedUserBlockIds.add(blockId);
			}
		}
		for (const tu of toolUses) {
			const id = randomUUID();
			await actor.addBlock(JSON.stringify(toolUseBlock(id, tu.id, tu.name, tu.input)));
			incorporatedBlockIds.add(id);
		}

		if (toolUses.length === 0) {
			lastRoundHadTools = false;
			// Loop's top will recheck pending and break if all are addressed,
			// or drain a steered prompt and run another iteration.
			continue;
		}

		// Run tools sequentially. Each tool_result is appended to a fresh
		// user-role turn (per the Anthropic API contract: tool_result blocks
		// must follow their corresponding tool_use in the next user turn).
		const toolResults: AnthropicContent[] = [];
		for (const tu of toolUses) {
			toolCalls++;
			const tool = tools.find((t) => t.name === tu.name);
			let contentText: string;
			let isError = false;
			if (!tool) {
				contentText = `Tool '${tu.name}' is not registered on this agent`;
				isError = true;
			} else {
				try {
					const dispatchInput = tool.bound_args && Object.keys(tool.bound_args).length > 0
						? { ...(tu.input ?? {}), ...tool.bound_args }
						: tu.input;
					const raw = await ctx.dispatchProgram(tool.target_prefix, tool.target_action, [dispatchInput]);
					contentText = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
				} catch (err: any) {
					contentText = `Error: ${err?.message ?? String(err)}`;
					isError = true;
				}
			}
			if (contentText.length > TOOL_RESULT_TRUNCATE) {
				contentText = contentText.slice(0, TOOL_RESULT_TRUNCATE) + `\n…[truncated, ${contentText.length - TOOL_RESULT_TRUNCATE} bytes omitted]`;
			}
			toolResults.push({
				type: "tool_result",
				tool_use_id: tu.id,
				content: contentText,
				is_error: isError,
			});
			const id = randomUUID();
			await actor.addBlock(JSON.stringify(toolResultBlock(id, tu.id, contentText, isError)));
			incorporatedBlockIds.add(id);
		}
		messages.push({ role: "user", content: toolResults });
		lastRoundHadTools = true;
	}

	// Resolve every pending caller with their slice. Attribution rule:
	// each user's batch is iterations [fi, nextGreaterFi), where fi is the
	// iteration that first submitted them and nextGreaterFi is the first
	// iteration submitting a strictly later user. The slice is the LAST
	// text-emitting iteration inside that batch (so tool-loop runs that
	// emit text in their final iteration give the caller the final answer,
	// not the partial preamble). Co-drained users (same fi) share the
	// batch and therefore the same slice.
	const sortedTextIters = [...iterationTexts.keys()].sort((a, b) => a - b);
	const userToTextIter = new Map<string, number>();
	for (const [userId, fi] of firstSubmittedAtIter) {
		let nextGreaterFi = Infinity;
		for (const otherFi of firstSubmittedAtIter.values()) {
			if (otherFi > fi && otherFi < nextGreaterFi) nextGreaterFi = otherFi;
		}
		let last = -1;
		for (const ti of sortedTextIters) {
			if (ti >= fi && ti < nextGreaterFi) last = ti;
		}
		if (last !== -1) userToTextIter.set(userId, last);
	}

	const metrics = {
		iterations,
		toolCalls,
		inputTokens: totalInputTokens,
		outputTokens: totalOutputTokens,
		compactedBeforeAsk,
		compactedOnOverflow,
	};

	const pending = slot.pending.splice(0);
	for (const p of pending) {
		const textIter = userToTextIter.get(p.userBlockId);
		const finalText = textIter !== undefined ? iterationTexts.get(textIter) ?? "" : "";
		p.resolve({ ...metrics, finalText });
	}

	// Return the runner's own slice. The runner's userBlockId was tracked in
	// firstSubmittedAtIter at the start of iteration 1, so it has an entry
	// in userToTextIter unless the model never emitted text — in which
	// case the runner gets the empty string (truthful and observable).
	const runnerTextIter = userToTextIter.get(originalUserBlockId);
	const runnerFinalText = runnerTextIter !== undefined
		? iterationTexts.get(runnerTextIter) ?? ""
		: "";
	return { ...metrics, finalText: runnerFinalText };
}



// ── Handler (CLI subcommands) ────────────────────────────────────

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { store, resolveId, stringVal, linkVal, print, randomUUID } = ctx as any;
	const client = ctx.client as any;

	switch (cmd) {
		case "new": {
			let name = "agent";
			let model = DEFAULT_MODEL;
			let system: string | undefined;

			const positional: string[] = [];
			for (let i = 0; i < args.length; i++) {
				if (args[i] === "--model" && args[i + 1]) { model = args[++i]; }
				else if (args[i] === "--system" && args[i + 1]) { system = args[++i]; }
				else { positional.push(args[i]); }
			}
			if (positional.length > 0) name = positional.join(" ");

			const fields: Record<string, any> = {
				name: stringVal(name),
				model: stringVal(model),
			};
			if (system) fields.system = stringVal(system);

			const id = await store.create("agent", JSON.stringify(fields));
			print(green("Agent created: ") + bold(id));
			print(dim(`  model: ${model}`));
			if (system) print(dim(`  system: ${system}`));
			print(dim(`  agent ask ${id.slice(0, 8)} Hello!`));
			break;
		}

		case "ask": {
			const raw = args[0];
			const prompt = args.slice(1).join(" ");
			if (!raw || !prompt) { print(red("Usage: agent ask <id> <prompt...>")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }

			try {
				const state = await store.get(id);
				if (!state) { print(red("Agent not found")); break; }
				const model = extractString(state.fields?.["model"]) || DEFAULT_MODEL;
				const toolsCount = extractTools(state.fields?.["tools"]).length;

				print(dim(`  thinking (${model})${toolsCount > 0 ? `, ${toolsCount} tool(s)` : ""}...`));
				print("");
				print(magenta(bold("  assistant")) + dim(toolsCount > 0 ? "" : " streaming..."));
				print("");

				const result = await runAsk(id, prompt, ctx, { printStream: true });

				if (toolsCount > 0 && result.finalText) {
					for (const line of result.finalText.split("\n")) print(`  ${line}`);
				}
				print("");
				const toolSuffix = result.toolCalls > 0
					? `, ${result.toolCalls} tool call(s) over ${result.iterations} iteration(s)`
					: "";
				const compactionNotes: string[] = [];
				if (result.compactedBeforeAsk) compactionNotes.push("auto-compacted before ask");
				if (result.compactedOnOverflow) compactionNotes.push("compacted on overflow + retried");
				const compactionSuffix = compactionNotes.length ? `, ${compactionNotes.join("; ")}` : "";
				print(dim(`  (${result.inputTokens} input + ${result.outputTokens} output = ${result.inputTokens + result.outputTokens} tokens${toolSuffix}${compactionSuffix})`));
				print("");
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "history": {
			const raw = args[0];
			if (!raw) { print(red("Usage: agent history <id>")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }

			const state = await store.get(id);
			if (!state) { print(red("Agent not found")); break; }

			const name = extractString(state.fields?.["name"]) || "agent";
			const model = extractString(state.fields?.["model"]) || DEFAULT_MODEL;
			const system = extractString(state.fields?.["system"]);
			const items = classifyBlocks(state.blocks ?? [], state.blockProvenance ?? {});
			const latest = findLatestCompaction(items);

			print(bold(`  ${name}`) + dim(` (${model})`));
			if (system) print(dim(`  system: ${system.slice(0, 200)}${system.length > 200 ? "…" : ""}`));
			if (latest) {
				const ageMin = Math.round((Date.now() - latest.timestamp) / 60000);
				print(dim(`  compaction: ${latest.turnCount} turn(s), ≈${latest.tokensBefore} tokens, ${ageMin}m ago`));
			}
			print("");

			if (items.length === 0) { print(dim("  (no conversation yet)")); break; }

			for (const item of items) {
				const ts = item.timestamp
					? new Date(item.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
					: "--:--";
				switch (item.kind) {
					case "user_text": {
						print(cyan(bold("  user")) + " " + dim(ts));
						for (const line of item.text.split("\n")) print(`    ${line}`);
						print("");
						break;
					}
					case "assistant_text": {
						print(magenta(bold("  assistant")) + " " + dim(ts));
						for (const line of item.text.split("\n")) print(`    ${line}`);
						print("");
						break;
					}
					case "tool_use": {
						const inputStr = JSON.stringify(item.input);
						const shown = inputStr.length > 120 ? inputStr.slice(0, 120) + "…" : inputStr;
						print(`    ${yellow("→ tool_use")} ${bold(item.name)} ${dim(shown)}`);
						break;
					}
					case "tool_result": {
						const preview = item.content.length > 120 ? item.content.slice(0, 120) + "…" : item.content;
						const tag = item.isError ? red("← tool_error") : blue("← tool_result");
						for (const line of preview.split("\n")) print(`    ${tag} ${line}`);
						break;
					}
					case "compaction": {
						const separator = "─".repeat(2);
						print(dim(`  ${separator} compacted ${item.turnCount} turn(s), ≈${item.tokensBefore} tokens ${separator}`));
						const preview = item.summary.split("\n").slice(0, 4).join("\n");
						for (const line of preview.split("\n")) print(dim(`    ${line}`));
						print(dim(`    (summary continues — /agent view-summary ${id.slice(0, 8)} to see all)`));
						print("");
						break;
					}
				}
			}
			break;
		}

		case "view-summary": {
			const raw = args[0];
			if (!raw) { print(red("Usage: agent view-summary <id>")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			const state = await store.get(id);
			if (!state) { print(red("Agent not found")); break; }
			const items = classifyBlocks(state.blocks ?? [], state.blockProvenance ?? {});
			const latest = findLatestCompaction(items);
			if (!latest) { print(dim("  (no compaction summary yet)")); break; }
			print(bold(`  Compaction summary`) + dim(` — ${latest.turnCount} turns, ≈${latest.tokensBefore} tokens`));
			print("");
			for (const line of latest.summary.split("\n")) print(`  ${line}`);
			break;
		}

		case "compact": {
			const raw = args[0];
			const instructions = args.slice(1).join(" ") || undefined;
			if (!raw) { print(red("Usage: agent compact <id> [instructions...]")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			try {
				print(dim("  compacting..."));
				const result = await doCompact(id, instructions, ctx);
				if (result.compacted) {
					print(green(`  Compacted ${result.turnCount} turn(s), ≈${result.tokensBefore} tokens`));
					print(dim(`  summary block: ${result.blockId?.slice(0, 12)}`));
				} else {
					const msgMap = {
						disabled: "Compaction is disabled on this agent",
						under_budget: "Conversation is under the compaction budget — nothing to do",
						no_cut_point: "No safe cut point (conversation too short or single turn too large)",
					};
					print(dim(`  ${msgMap[result.reason!] ?? "Nothing to compact"}`));
				}
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "config": {
			const raw = args[0];
			const key = args[1];
			const value = args.slice(2).join(" ");
			if (!raw || !key || !value) {
				print(red("Usage: agent config <id> <key> <value>"));
				print(dim("  Keys: model, system, name, temperature,"));
				print(dim("        compaction_enabled, compaction_context_window,"));
				print(dim("        compaction_reserve_tokens, compaction_keep_recent_tokens,"));
				print(dim("        compaction_model"));
				break;
			}
			const allowed = [
				"model", "system", "name", "temperature",
				"compaction_enabled", "compaction_context_window",
				"compaction_reserve_tokens", "compaction_keep_recent_tokens",
				"compaction_model",
				"memory_digest_enabled", "memory_extraction_enabled",
			];
			if (!allowed.includes(key)) {
				print(red(`Unknown config key: ${key}. Use: ${allowed.join(", ")}`));
				break;
			}
			if (key === "temperature") {
				const temp = parseFloat(value);
				if (isNaN(temp) || temp < 0 || temp > 2) {
					print(red("Temperature must be a number between 0 and 2"));
					break;
				}
			}
			if (key.startsWith("compaction_") && key !== "compaction_model" && key !== "compaction_enabled") {
				const n = parseInt(value, 10);
				if (!Number.isFinite(n) || n < 0) {
					print(red(`${key} must be a non-negative integer`));
					break;
				}
			}
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			const actor = client.objectActor.getOrCreate([id]);
			await actor.setField(key, JSON.stringify(stringVal(value)));
			print(dim(`  ${key} = `) + value);
			break;
		}

		case "status": {
			const raw = args[0];
			if (!raw) { print(red("Usage: agent status <id>")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			try {
				const s = await doStatus(id, ctx);
				print(bold(`  ${s.name}`) + dim(` (${s.model})`));
				print(dim(`  blocks: ${s.blockCount}  |  effective turns: ${s.effectiveTurns}  |  tools: ${s.tools}`));
				const pct = s.compaction.threshold > 0
					? Math.round(100 * s.estimatedTokens / s.compaction.threshold)
					: 0;
				const barColor = pct > 80 ? red : pct > 50 ? yellow : green;
				print(dim(`  tokens: ≈${s.estimatedTokens} / ${s.compaction.threshold} threshold  `) + barColor(`(${pct}%)`));
				print(dim(`  compaction: ${s.compaction.config.enabled ? "enabled" : "disabled"}  |  window ${s.compaction.config.contextWindow}, reserve ${s.compaction.config.reserveTokens}, keep-recent ${s.compaction.config.keepRecentTokens}`));
				if (s.compaction.lastCompaction) {
					const c = s.compaction.lastCompaction;
					const ageMin = Math.round((Date.now() - c.createdAt) / 60000);
					print(dim(`  last compaction: ${c.turnCount} turn(s), ≈${c.tokensBefore} tokens, ${ageMin}m ago`));
				}
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "recall": {
			const raw = args[0];
			const blockRaw = args[1];
			if (!raw || !blockRaw) { print(red("Usage: agent recall <agent-id> <block-id>")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			try {
				const state = await store.get(id);
				if (!state) { print(red("Agent not found")); break; }
				// Accept a full block id OR any unique prefix.
				const match = (state.blocks ?? []).find((b: any) => b.id === blockRaw || b.id.startsWith(blockRaw));
				if (!match) { print(red("Block not in this agent: ") + blockRaw); break; }
				const result = await doRecall(id, match.id, ctx);
				print(green("  Recalled ") + result.sourceKind + dim(` → new block ${result.newBlockId.slice(0, 8)}`));
				if (result.truncated) print(dim("  (content was long; truncated at 8192 bytes)"));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "tree": {
			const raw = args[0];
			if (!raw) { print(red("Usage: agent tree <id>")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			try {
				const root = await doGetSubagents(id, ctx);
				print(bold("spawn tree rooted at ") + root.id);
				print(renderSubagentTree(root));
				const count = countDescendants(root);
				print(dim(`  ${count} subagent(s) total`));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "list-templates": {
			try {
				const dagRefs = (await (store as any).list("agent_template")) as Array<{ id: string }> ?? [];
				const seen = new Set<string>();
				print(bold("agent templates:"));
				for (const ref of dagRefs) {
					const s = await store.get(ref.id);
					if (!s || s.deleted) continue;
					const name = extractString(s.fields?.name) ?? ref.id.slice(0, 8);
					const model = extractString(s.fields?.model) ?? DEFAULT_MODEL;
					const spawns = extractString(s.fields?.spawns) ?? "";
					const desc = extractString(s.fields?.description) ?? "";
					seen.add(name);
					print(green(`  ${name}`) + dim(` [DAG ${ref.id.slice(0, 8)}]`));
					print(dim(`    model=${model}  spawns=${spawns || "(none)"}  ${desc}`));
				}
				for (const [name, tpl] of Object.entries(BUILTIN_TEMPLATES)) {
					if (seen.has(name)) continue;
					print(yellow(`  ${name}`) + dim(" [builtin]"));
					print(dim(`    model=${tpl.model}  spawns=${tpl.spawns || "(none)"}  ${tpl.description}`));
				}
			} catch (err: any) {
				print(red("  list-templates failed: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "create-template": {
			let name: string | undefined, model = DEFAULT_MODEL, systemText = "", spawns = "", description = "";
			const positional: string[] = [];
			for (let i = 0; i < args.length; i++) {
				if (args[i] === "--model" && args[i + 1]) model = args[++i];
				else if (args[i] === "--system" && args[i + 1]) systemText = args[++i];
				else if (args[i] === "--spawns" && args[i + 1]) spawns = args[++i];
				else if (args[i] === "--description" && args[i + 1]) description = args[++i];
				else positional.push(args[i]);
			}
			name = positional[0];
			if (!name) {
				print(red("Usage: agent create-template <name> [--model M] [--system S] [--spawns '*'|'' |CSV] [--description D]"));
				break;
			}
			if (!systemText) systemText = `You are a ${name} agent. Finish with submit_result.`;
			const fields: Record<string, any> = {
				name: stringVal(name),
				model: stringVal(model),
				system: stringVal(systemText),
				spawns: stringVal(spawns),
				description: stringVal(description),
			};
			try {
				const id: string = await (store as any).create("agent_template", JSON.stringify(fields));
				print(green("Template created: ") + bold(name) + dim(` (${id})`));
				if (BUILTIN_TEMPLATES[name]) {
					print(dim("  note: this DAG template now overrides the built-in of the same name."));
				}
			} catch (err: any) {
				print(red("  create-template failed: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "delete-template": {
			const raw = args[0];
			if (!raw) { print(red("Usage: agent delete-template <name-or-id>")); break; }
			// Try interpreting as DAG id prefix first; fall back to name lookup.
			let id: string | null = await resolveId(raw);
			if (!id) {
				try {
					const dagRefs = (await (store as any).list("agent_template")) as Array<{ id: string }> ?? [];
					for (const ref of dagRefs) {
						const s = await store.get(ref.id);
						if (s && !s.deleted && extractString(s.fields?.name) === raw) { id = ref.id; break; }
					}
				} catch { /* ignore */ }
			}
			if (!id) { print(red("Template not found: ") + raw); break; }
			const state = await store.get(id);
			if (!state || state.typeKey !== "agent_template") {
				print(red("Not an agent_template: ") + id);
				break;
			}
			const actor = (client as any).objectActor.getOrCreate([id]);
			await actor.markDeleted();
			print(green("Template tombstoned: ") + id);
			break;
		}

		case "read": {
			const raw = args[0];
			if (!raw) { print(red("Usage: agent read <id>")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }

			const state = await store.get(id);
			if (!state) { print(red("Agent not found")); break; }

			const name = extractString(state.fields?.["name"]) || "agent";
			const view = buildConversationView(state.blocks ?? [], state.blockProvenance ?? {});

			print(bold(`  ${name}`) + dim(` — ${view.turns.length} effective turn(s)${view.latestCompaction ? " (compacted)" : ""}`));
			print("");

			const recent = view.turns.slice(-5);
			if (view.turns.length > 5) print(dim(`  ... ${view.turns.length - 5} earlier turns`));
			for (const turn of recent) {
				const label = turn.role === "user" ? cyan("user") : magenta("assistant");
				const str = typeof turn.content === "string"
					? turn.content
					: turn.content.map((c) => c.type === "text" ? c.text : `[${c.type}]`).join(" ");
				const preview = str.length > 120 ? str.slice(0, 120) + "..." : str;
				print(`  ${label}: ${preview}`);
			}
			break;
		}

		case "inject": {
			const targetRaw = args[0];
			const sourceRaw = args[1];
			if (!targetRaw || !sourceRaw) {
				print(red("Usage: agent inject <target-id> <source-id>"));
				break;
			}
			const targetId = await resolveId(targetRaw);
			const sourceId = await resolveId(sourceRaw);
			if (!targetId) { print(red("Target not found: ") + targetRaw); break; }
			if (!sourceId) { print(red("Source not found: ") + sourceRaw); break; }

			const sourceState = await store.get(sourceId);
			if (!sourceState) { print(red("Source agent not found")); break; }
			const sourceName = extractString(sourceState.fields?.["name"]) || "agent";
			const sourceView = buildConversationView(sourceState.blocks ?? [], sourceState.blockProvenance ?? {});
			if (sourceView.turns.length === 0) { print(dim("  Source agent has no conversation to inject")); break; }

			const lines = [`[Context from agent "${sourceName}" (${sourceId.slice(0, 8)})]`];
			for (const turn of sourceView.turns) {
				const str = typeof turn.content === "string"
					? turn.content
					: turn.content.map((c) => c.type === "text" ? c.text : `[${c.type}]`).join(" ");
				lines.push(`${turn.role}: ${str}`);
			}
			lines.push("[End context]");

			const actor = client.objectActor.getOrCreate([targetId]);
			const blockId = randomUUID();
			await actor.addBlock(JSON.stringify(textBlock(blockId, lines.join("\n"), STYLE_USER)));
			await actor.setField("context_source", JSON.stringify(linkVal(sourceId, "context_source")));

			print(green(`  Injected ${sourceView.turns.length} turns from "${sourceName}" into target`));
			print(dim(`  block ${blockId.slice(0, 8)}`));
			break;
		}

		case "register-tool": {
			const raw = args[0];
			const name = args[1];
			const targetPrefix = args[2];
			const targetAction = args[3];
			const description = args.slice(4).join(" ");
			if (!raw || !name || !targetPrefix || !targetAction) {
				print(red("Usage: agent register-tool <agentId> <name> <targetPrefix> <targetAction> [description...]"));
				break;
			}
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			try {
				const msg = await doRegisterTool(id, {
					name,
					description: description || `Call ${targetPrefix} ${targetAction}`,
					input_schema: { type: "object" },
					target_prefix: targetPrefix,
					target_action: targetAction,
				}, ctx);
				print(green("  " + msg));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "unregister-tool": {
			const raw = args[0];
			const name = args[1];
			if (!raw || !name) { print(red("Usage: agent unregister-tool <agentId> <name>")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			try {
				const msg = await doUnregisterTool(id, name, ctx);
				print(green("  " + msg));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "tools": {
			const raw = args[0];
			if (!raw) { print(red("Usage: agent tools <agentId>")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			try {
				const tools = await doListTools(id, ctx);
				if (tools.length === 0) { print(dim("  (no tools registered)")); break; }
				print(bold(`  ${tools.length} tool(s)`));
				for (const t of tools) {
					print(`    ${cyan(bold(t.name))} ${dim("→")} ${t.target_prefix} ${t.target_action}`);
					if (t.description) print(dim(`      ${t.description}`));
				}
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		default: {
			print([
				bold("  Agent"),
				`    ${cyan("agent new")} ${dim("[name] [--model X] [--system \"...\"]")}  create an agent`,
				`    ${cyan("agent ask")} ${dim("<id> <prompt...>")}                      chat with agent`,
				`    ${cyan("agent history")} ${dim("<id>")}                               full block history`,
				`    ${cyan("agent view-summary")} ${dim("<id>")}                          show the latest compaction summary in full`,
				`    ${cyan("agent status")} ${dim("<id>")}                                tokens, turns, compaction state`,
				`    ${cyan("agent compact")} ${dim("<id> [instructions...]")}             manual compaction`,
				`    ${cyan("agent config")} ${dim("<id> <key> <value>")}                  set model/system/temperature/compaction_*`,
				`    ${cyan("agent read")} ${dim("<id>")}                                  peek at effective (post-compaction) conversation`,
				`    ${cyan("agent inject")} ${dim("<target> <source>")}                   inject context from another agent`,
				`    ${cyan("agent register-tool")} ${dim("<id> <name> <prefix> <action>")} register a tool`,
				`    ${cyan("agent unregister-tool")} ${dim("<id> <name>")}                remove a tool`,
				`    ${cyan("agent tools")} ${dim("<id>")}                                 list registered tools`,
				"",
				dim("  Models: claude-sonnet-4-20250514, claude-haiku-4-20250414, etc."),
				dim("  Requires ANTHROPIC_API_KEY env var."),
			].join("\n"));
		}
	}
};

// ── Subagent spawning machinery ────────────────────────────────
//
// Templates are code-constant defaults that can be overridden at runtime
// by DAG objects of typeKey="agent_template" with matching `name`. If a
// matching DAG object exists it wins; otherwise the code default applies.
// This mirrors the "both" storage model: shipping sensible defaults while
// letting each peer customize without touching source.

interface AgentTemplate {
	name: string;
	description: string;
	model: string;
	system: string;
	/** Tools to register on a spawned instance. `submit_result` and `spawn` are
	 *  added by the runtime based on policy; no need to list them here. */
	defaultTools: ToolSpec[];
	/** Spawn policy. `"*"` = unrestricted, `""` = cannot spawn, CSV = whitelist. */
	spawns: string;
}

// Read-only DAG tool bundle — safe for any subagent. Every tool listed
// here targets an existing glon program action and mutates nothing.
const READ_ONLY_TOOLS: ToolSpec[] = [
	{
		name: "object_list",
		description: "List Glon objects in the store. Optional type_key filter narrows to one type.",
		input_schema: { type: "object", properties: { type_key: { type: "string" }, limit: { type: "number" } } },
		target_prefix: "/crud", target_action: "list",
	},
	{
		name: "object_get",
		description: "Read an object's state summary. Use object_read_source for file contents.",
		input_schema: { type: "object", properties: { object_id: { type: "string" } }, required: ["object_id"] },
		target_prefix: "/crud", target_action: "get",
	},
	{
		name: "object_read_source",
		description: "Read raw UTF-8 content of an object. Truncates at max_bytes.",
		input_schema: { type: "object", properties: { object_id: { type: "string" }, max_bytes: { type: "number" } }, required: ["object_id"] },
		target_prefix: "/crud", target_action: "readContent",
	},
	{
		name: "object_search",
		description: "Full-text search across object fields and content. Narrow with type_key.",
		input_schema: { type: "object", properties: { query: { type: "string" }, type_key: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
		target_prefix: "/crud", target_action: "search",
	},
	{
		name: "object_links",
		description: "Show outbound and inbound ObjectLinks for an object.",
		input_schema: { type: "object", properties: { object_id: { type: "string" } }, required: ["object_id"] },
		target_prefix: "/graph", target_action: "links",
	},
	{
		name: "object_neighbors",
		description: "Immediate neighbours (one-hop link targets) of an object.",
		input_schema: { type: "object", properties: { object_id: { type: "string" } }, required: ["object_id"] },
		target_prefix: "/graph", target_action: "neighbors",
	},
];

const BUILTIN_TEMPLATES: Record<string, AgentTemplate> = {
	task: {
		name: "task",
		description: "General-purpose worker agent. Can spawn further subagents.",
		model: DEFAULT_MODEL,
		system: "You are a general-purpose agent running inside Glon. You can use registered tools and may spawn further subagents to parallelize work. Be precise, terse, and finish with submit_result.",
		defaultTools: READ_ONLY_TOOLS,
		spawns: "*",
	},
	explore: {
		name: "explore",
		description: "Read-only investigator. Returns a compressed map of findings.",
		model: DEFAULT_MODEL,
		system: "You are an investigator. Read the DAG via the tools you have. Do not mutate anything. Return a compressed, structured summary via submit_result.",
		defaultTools: READ_ONLY_TOOLS,
		spawns: "",
	},
	quick_task: {
		name: "quick_task",
		description: "Fast small-model worker for mechanical tasks.",
		model: "claude-haiku-4-20250414",
		system: "You are a lightweight worker. Do the single mechanical task you were given and return the answer via submit_result. Do not explore beyond the request.",
		defaultTools: [],
		spawns: "",
	},
};

async function resolveAgentTemplate(name: string, ctx: ProgramContext): Promise<AgentTemplate> {
	const store = ctx.store as any;
	// DAG override: scan agent_template objects, first matching name wins.
	try {
		const refs = (await store.list("agent_template")) as Array<{ id: string }>;
		for (const ref of refs) {
			const state = await store.get(ref.id);
			if (!state || state.deleted) continue;
			const templateName = extractString(state.fields?.name);
			if (templateName !== name) continue;
			const toolsRaw = extractString(state.fields?.default_tools) ?? "[]";
			let defaultTools: ToolSpec[] = [];
			try { defaultTools = JSON.parse(toolsRaw); } catch { /* keep empty */ }
			return {
				name: templateName,
				description: extractString(state.fields?.description) ?? "",
				model: extractString(state.fields?.model) ?? DEFAULT_MODEL,
				system: extractString(state.fields?.system) ?? BUILTIN_TEMPLATES.task.system,
				defaultTools,
				spawns: extractString(state.fields?.spawns) ?? "",
			};
		}
	} catch { /* store may not support list in tests — fall through to code default */ }
	const tpl = BUILTIN_TEMPLATES[name];
	if (!tpl) throw new Error(`Unknown agent template: ${name}`);
	return tpl;
}

interface SpawnTaskInput {
	id: string;
	agentTemplate: string;
	assignment: string;
	model?: string;
	/** If set, cancels the child after this many ms and marks result status="timeout". */
	timeoutMs?: number;
	/** If set, retries the task up to this many times on status in {error, timeout}. Default 0. */
	maxAttempts?: number;
}

interface SpawnInput {
	/** Parent agent id — always bound via tool `bound_args` when invoked by a model. */
	agentId: string;
	context?: string;
	schema?: unknown;
	maxConcurrency?: number;
	tasks: SpawnTaskInput[];
}

interface SingleResult {
	id: string;
	childAgentId: string;
	output: unknown;
	status: "ok" | "no_submit_result" | "cancelled" | "error" | "timeout" | "schema_invalid";
	attempts?: number;
	error?: string;
	durationMs: number;
	tokens: { input: number; output: number };
	compacted: boolean;
}

interface SubmitResultInput {
	/** Child agent id, bound via the tool's bound_args so the model can't spoof another agent. */
	agentId: string;
	result: unknown;
}

function maxSpawnDepth(): number {
	const raw = process.env.GLON_AGENT_MAX_DEPTH;
	if (!raw) return DEFAULT_MAX_SPAWN_DEPTH;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_SPAWN_DEPTH;
}

class Semaphore {
	private avail: number;
	private waiters: Array<() => void> = [];
	constructor(n: number) { this.avail = Math.max(1, n); }
	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.avail > 0) { this.avail--; }
		else await new Promise<void>((res) => this.waiters.push(res));
		try { return await fn(); }
		finally {
			const next = this.waiters.shift();
			if (next) next(); else this.avail++;
		}
	}
}

function buildSubagentSystemPrompt(
	template: AgentTemplate,
	parentId: string,
	task: SpawnTaskInput,
	depth: number,
	sharedContext: string | undefined,
	schema: unknown | undefined,
): string {
	const parts = [template.system.trim(), SUBAGENT_ADDENDUM.trim()];
	parts.push(`Parent agent: ${parentId}`);
	parts.push(`Task id: ${task.id}`);
	parts.push(`Depth: ${depth}`);
	if (sharedContext && sharedContext.trim()) {
		parts.push("--- SHARED CONTEXT ---\n" + sharedContext.trim());
	}
	if (schema !== undefined) {
		parts.push("--- OUTPUT SCHEMA ---\nYour submit_result `result` argument must satisfy:\n" + JSON.stringify(schema, null, 2));
	}
	return parts.join("\n\n");
}

function submitResultTool(childId: string): ToolSpec {
	return {
		name: "submit_result",
		description: "Submit your final structured result to the parent agent and conclude the task.",
		input_schema: {
			type: "object",
			properties: { result: { description: "Your structured answer. Shape must match the output schema if one was given in your system prompt." } },
			required: ["result"],
		},
		target_prefix: "/agent",
		target_action: "submitResult",
		bound_args: { agentId: childId },
	};
}

export function spawnTool(parentId: string): ToolSpec { return {
		name: "spawn",
		description: "Spawn one or more subagents in parallel to complete delegated tasks. Each task runs as a fresh agent with its own DAG. Waits for all children before returning a compressed batch result.",
		input_schema: {
			type: "object",
			properties: {
				context: { type: "string", description: "Shared background prepended to every child's first user turn." },
				schema: { type: "object", description: "Optional output shape every child's submit_result must satisfy." },
				maxConcurrency: { type: "number", description: "Upper bound on parallel children. Default 6." },
				tasks: {
					type: "array",
					minItems: 1,
					items: {
						type: "object",
						required: ["id", "agentTemplate", "assignment"],
						properties: {
							id: { type: "string" },
							agentTemplate: { type: "string", description: "Template name (e.g. 'task', 'explore', 'quick_task') or an agent_template object id." },
							assignment: { type: "string" },
							model: { type: "string" },
						},
					},
				},
			},
			required: ["tasks"],
		},
		target_prefix: "/agent",
		target_action: "spawn",
		bound_args: { agentId: parentId },
	}; }

async function createChildAgent(
	parent: { id: string; depth: number; spawnsPolicy: string },
	task: SpawnTaskInput,
	sharedContext: string | undefined,
	schema: unknown | undefined,
	ctx: ProgramContext,
): Promise<{ childId: string; template: AgentTemplate }> {
	const store = ctx.store as any;
	const { stringVal, linkVal } = ctx as any;

	const template = await resolveAgentTemplate(task.agentTemplate, ctx);
	const childDepth = parent.depth + 1;
	const system = buildSubagentSystemPrompt(template, parent.id, task, childDepth, sharedContext, schema);
	const childCanSpawn = template.spawns !== "" && childDepth < maxSpawnDepth();

	const fields: Record<string, any> = {
		name: stringVal(`${template.name}-${task.id}`),
		model: stringVal(task.model ?? template.model),
		system: stringVal(system),
		spawn_parent: linkVal(parent.id, "spawn_parent"),
		spawn_depth: stringVal(String(childDepth)),
		spawn_task_id: stringVal(task.id),
		spawn_template: stringVal(template.name),
	};
	if (schema !== undefined && schema !== null) {
		fields.output_schema = stringVal(JSON.stringify(schema));
	}
	const childId: string = await store.create("agent", JSON.stringify(fields));

	// Every child always gets submit_result. Children that can spawn get the spawn tool.
	await doRegisterTool(childId, submitResultTool(childId), ctx);
	if (childCanSpawn) {
		await doRegisterTool(childId, spawnTool(childId), ctx);
	}
	for (const t of template.defaultTools) {
		await doRegisterTool(childId, t, ctx);
	}

	return { childId, template };
}

async function doSpawn(input: SpawnInput, ctx: ProgramContext): Promise<{ childAgentIds: string[]; results: SingleResult[]; batchId: string }> {
	const store = ctx.store as any;
	if (!input?.agentId) throw new Error("spawn: agentId required");
	if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
		throw new Error("spawn: tasks[] required");
	}
	const parent = await store.get(input.agentId);
	if (!parent) throw new Error(`spawn: parent agent not found: ${input.agentId}`);
	if (parent.typeKey !== "agent") throw new Error(`spawn: ${input.agentId} is not an agent`);

	const parentDepth = extractInt(parent.fields?.spawn_depth, 0);
	const cap = maxSpawnDepth();
	if (parentDepth >= cap) {
		throw new Error(`spawn: parent is at max depth (${cap}); cannot spawn further`);
	}
	// Policy enforcement: a parent's template's `spawns` field — when we know
	// what template the parent came from — may whitelist templates it can
	// delegate to. For top-level user-created agents without a template, allow
	// anything (back-compat).
	const parentTemplateName = extractString(parent.fields?.spawn_template);
	let allowed: "*" | string[] = "*";
	if (parentTemplateName) {
		const parentTpl = await resolveAgentTemplate(parentTemplateName, ctx);
		if (parentTpl.spawns === "") {
			throw new Error(`spawn: parent template '${parentTemplateName}' is not allowed to spawn subagents`);
		}
		allowed = parentTpl.spawns === "*" ? "*" : parentTpl.spawns.split(",").map((s) => s.trim()).filter(Boolean);
	}
	if (allowed !== "*") {
		for (const t of input.tasks) {
			if (!allowed.includes(t.agentTemplate)) {
				throw new Error(`spawn: template '${t.agentTemplate}' not permitted by parent policy (${allowed.join(",") || "<none>"})`);
			}
		}
	}

	const ids = new Set<string>();
	for (const t of input.tasks) {
		if (!t?.id) throw new Error("spawn: every task needs an id");
		if (ids.has(t.id)) throw new Error(`spawn: duplicate task id '${t.id}'`);
		ids.add(t.id);
		if (!t.agentTemplate) throw new Error(`spawn[${t.id}]: agentTemplate required`);
		if (!t.assignment) throw new Error(`spawn[${t.id}]: assignment required`);
	}

	const sem = new Semaphore(input.maxConcurrency ?? DEFAULT_SPAWN_CONCURRENCY);
	const childAgentIds: string[] = [];
	const parentRef = { id: input.agentId, depth: parentDepth, spawnsPolicy: parentTemplateName ? (await resolveAgentTemplate(parentTemplateName, ctx)).spawns : "*" };

	const batchId = (ctx as any).randomUUID ? (ctx as any).randomUUID() : `batch-${Date.now()}`;
	const emit = (channel: string, data: any) => { try { ctx.emit?.(channel, data); } catch { /* best-effort */ } };
	emit("spawn:start", {
		batchId,
		parentAgentId: input.agentId,
		tasks: input.tasks.map((t) => ({ id: t.id, template: t.agentTemplate })),
		maxConcurrency: input.maxConcurrency ?? DEFAULT_SPAWN_CONCURRENCY,
	});
	const results = await Promise.all(input.tasks.map((task) => sem.run(async (): Promise<SingleResult> => {
		const started = Date.now();
		const maxAttempts = Math.max(1, task.maxAttempts ?? 1);
		let childId = "";
		let lastResult: SingleResult | null = null;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			lastResult = await runOneAttempt(task, attempt, parentRef, input.context, input.schema, ctx, (id) => {
				childId = id; childAgentIds.push(id);
				emit("spawn:child_created", { batchId, taskId: task.id, childAgentId: id, attempt });
			}, started);
			emit("spawn:child_done", { batchId, taskId: task.id, childAgentId: lastResult.childAgentId, status: lastResult.status, attempt, durationMs: lastResult.durationMs });
			if (lastResult.status === "ok" || lastResult.status === "no_submit_result" || lastResult.status === "schema_invalid" || lastResult.status === "cancelled") break;
		}
		return lastResult!;
	})));


	emit("spawn:complete", {
		batchId,
		parentAgentId: input.agentId,
		summary: {
			total: results.length,
			ok: results.filter((r) => r.status === "ok").length,
			no_submit_result: results.filter((r) => r.status === "no_submit_result").length,
			timeout: results.filter((r) => r.status === "timeout").length,
			error: results.filter((r) => r.status === "error").length,
			cancelled: results.filter((r) => r.status === "cancelled").length,
			schema_invalid: results.filter((r) => r.status === "schema_invalid").length,
		},
	});
	return { childAgentIds, results, batchId };
}

async function runOneAttempt(
	task: SpawnTaskInput,
	attempt: number,
	parentRef: { id: string; depth: number; spawnsPolicy: string },
	sharedContext: string | undefined,
	schema: unknown | undefined,
	ctx: ProgramContext,
	onChildCreated: (id: string) => void,
	batchStartedAt: number,
): Promise<SingleResult> {
	const store = ctx.store as any;
	let childId = "";
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const created = await createChildAgent(parentRef, task, sharedContext, schema, ctx);
		childId = created.childId;
		onChildCreated(childId);

		const askPromise = runAsk(childId, task.assignment, ctx);
		const timeoutPromise = task.timeoutMs && task.timeoutMs > 0
			? new Promise<never>((_res, rej) => {
				timer = setTimeout(async () => {
					timedOut = true;
					try { await doCancel(childId, ctx); } catch { /* best-effort */ }
					rej(new Error(`timeout: task exceeded ${task.timeoutMs}ms`));
				}, task.timeoutMs);
			})
			: null;
		const ask = await (timeoutPromise ? Promise.race([askPromise, timeoutPromise]) : askPromise);
		if (timer) clearTimeout(timer);

		const state = await store.get(childId);
		const submitted = extractString(state?.fields?.submitted_result);
		if (submitted !== undefined) {
			let parsed: unknown = submitted;
			try { parsed = JSON.parse(submitted); } catch { /* keep raw */ }
			return {
				id: task.id,
				childAgentId: childId,
				output: parsed,
				status: "ok",
				attempts: attempt,
				durationMs: Date.now() - batchStartedAt,
				tokens: { input: ask.inputTokens, output: ask.outputTokens },
				compacted: ask.compactedBeforeAsk || ask.compactedOnOverflow,
			};
		}
		const submissionErrors = extractString(state?.fields?.submission_errors);
		if (submissionErrors) {
			return {
				id: task.id,
				childAgentId: childId,
				output: null,
				status: "schema_invalid",
				attempts: attempt,
				error: submissionErrors,
				durationMs: Date.now() - batchStartedAt,
				tokens: { input: ask.inputTokens, output: ask.outputTokens },
				compacted: ask.compactedBeforeAsk || ask.compactedOnOverflow,
			};
		}
		return {
			id: task.id,
			childAgentId: childId,
			output: ask.finalText,
			status: "no_submit_result",
			attempts: attempt,
			error: "subagent finished without calling submit_result; falling back to final assistant text",
			durationMs: Date.now() - batchStartedAt,
			tokens: { input: ask.inputTokens, output: ask.outputTokens },
			compacted: ask.compactedBeforeAsk || ask.compactedOnOverflow,
		};
	} catch (err: any) {
		if (timer) clearTimeout(timer);
		const msg = err?.message ?? String(err);
		const isTimeout = timedOut || /^timeout:/i.test(msg);
		const isCancelled = !isTimeout && /cancelled/i.test(msg);
		const isSchemaFail = /schema validation/i.test(msg);
		const status: SingleResult["status"] = isTimeout ? "timeout" : isCancelled ? "cancelled" : isSchemaFail ? "schema_invalid" : "error";
		return {
			id: task.id,
			childAgentId: childId,
			output: null,
			status,
			attempts: attempt,
			error: msg,
			durationMs: Date.now() - batchStartedAt,
			tokens: { input: 0, output: 0 },
			compacted: false,
		};
	}
}

// Minimal JSON-Schema-subset validator for submit_result payloads.
// Supports: type, required, properties, items, enum, const, nullable.
// No external deps. Returns a flat list of path-qualified error strings;
// empty list means valid.
function validateAgainstSchema(value: unknown, schema: any, path: string = "$"): string[] {
	if (schema == null || typeof schema !== "object") return [];
	const errors: string[] = [];
	const expected = schema.type;
	const nullable = schema.nullable === true;
	if (value === null) {
		if (!nullable && expected !== "null" && expected !== undefined) {
			errors.push(`${path}: expected ${expected}, got null`);
		}
		return errors;
	}
	if (expected) {
		const actual = Array.isArray(value) ? "array" : typeof value;
		const hit = Array.isArray(expected) ? expected.includes(actual) : actual === expected;
		if (!hit) errors.push(`${path}: expected ${Array.isArray(expected) ? expected.join("|") : expected}, got ${actual}`);
	}
	if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
		errors.push(`${path}: value not in enum (${JSON.stringify(schema.enum)})`);
	}
	if ("const" in schema && value !== schema.const) {
		errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
	}
	if (schema.properties && typeof value === "object" && !Array.isArray(value) && value !== null) {
		const obj = value as Record<string, unknown>;
		if (Array.isArray(schema.required)) {
			for (const key of schema.required) {
				if (!(key in obj)) errors.push(`${path}.${key}: required`);
			}
		}
		for (const [key, sub] of Object.entries(schema.properties)) {
			if (key in obj) errors.push(...validateAgainstSchema(obj[key], sub, `${path}.${key}`));
		}
	}
	if (schema.items && Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			errors.push(...validateAgainstSchema(value[i], schema.items, `${path}[${i}]`));
		}
	}
	return errors;
}

async function doSubmitResult(input: SubmitResultInput, ctx: ProgramContext): Promise<{ ok: true }> {
	const client = ctx.client as any;
	const store = ctx.store as any;
	const { stringVal } = ctx as any;
	if (!input?.agentId) throw new Error("submitResult: agentId required");

	const state = await store.get(input.agentId);
	const schemaJson = state ? extractString(state.fields?.output_schema) : undefined;
	if (schemaJson) {
		let schema: unknown = null;
		try { schema = JSON.parse(schemaJson); } catch { /* stored malformed — skip */ }
		if (schema) {
			const payload = input.result;
			const errors = validateAgainstSchema(payload, schema);
			if (errors.length > 0) {
				const msg = `submit_result failed schema validation:\n  - ${errors.join("\n  - ")}`;
				// Record the failure on the child so doSpawn can classify status=schema_invalid
				// even if the model doesn't retry or never succeeds. Error is still thrown so the
				// model sees is_error=true on its tool_result and can self-correct.
				const actor = client.objectActor.getOrCreate([input.agentId]);
				await actor.setField("submission_errors", JSON.stringify(stringVal(msg)));
				throw new Error(msg);
			}
		}
	}

	const resultJson = typeof input.result === "string" ? input.result : JSON.stringify(input.result);
	const actor = client.objectActor.getOrCreate([input.agentId]);
	await actor.setField("submitted_result", JSON.stringify(stringVal(resultJson)));
	await actor.setField("submitted_at", JSON.stringify(stringVal(String(Date.now()))));
	return { ok: true };
}

interface SubagentNode {
	id: string;
	name: string;
	template: string | undefined;
	depth: number;
	taskId: string | undefined;
	status: "pending" | "done" | "cancelled" | "unknown";
	children: SubagentNode[];
}

/** Walk the spawn_parent links reachable from an agent and return a tree. */
async function doGetSubagents(rootId: string, ctx: ProgramContext, maxDepth: number = 8): Promise<SubagentNode> {
	const store = ctx.store as any;
	// Scan is O(agents). /agent doesn't maintain a reverse index today; if this
	// becomes a bottleneck we can add one to storeActor.
	let refs: Array<{ id: string }> = [];
	try { refs = (await store.list("agent")) ?? []; } catch { /* minimal harness — single-node tree */ }
	const states = new Map<string, any>();
	for (const ref of refs) {
		const s = await store.get(ref.id);
		if (s && !s.deleted) states.set(ref.id, s);
	}
	const rootState = states.get(rootId) ?? await store.get(rootId);
	if (!rootState) throw new Error(`agent not found: ${rootId}`);
	if (!states.has(rootId)) states.set(rootId, rootState);

	function nodeFor(id: string, state: any, depth: number): SubagentNode {
		const name = extractString(state.fields?.name) ?? id.slice(0, 8);
		const tpl = extractString(state.fields?.spawn_template);
		const taskId = extractString(state.fields?.spawn_task_id);
		const submitted = extractString(state.fields?.submitted_result);
		const cancelled = extractString(state.fields?.cancel_requested) === "true";
		const status: SubagentNode["status"] = cancelled ? "cancelled" : submitted ? "done" : "pending";
		return { id, name, template: tpl, depth, taskId, status, children: [] };
	}

	const rootNode = nodeFor(rootId, rootState, extractInt(rootState.fields?.spawn_depth, 0));
	const byParent = new Map<string, string[]>();
	for (const [id, s] of states) {
		const parentId = s.fields?.spawn_parent?.linkValue?.targetId;
		if (!parentId) continue;
		const bucket = byParent.get(parentId);
		if (bucket) bucket.push(id); else byParent.set(parentId, [id]);
	}

	const startDepth = rootNode.depth;
	function expand(node: SubagentNode) {
		if (node.depth - startDepth >= maxDepth) return;
		const childIds = byParent.get(node.id) ?? [];
		for (const cid of childIds) {
			const cstate = states.get(cid);
			if (!cstate) continue;
			const childNode = nodeFor(cid, cstate, node.depth + 1);
			node.children.push(childNode);
			expand(childNode);
		}
	}
	expand(rootNode);
	return rootNode;
}

function countDescendants(node: SubagentNode): number {
	let n = 0;
	for (const c of node.children) n += 1 + countDescendants(c);
	return n;
}

function renderSubagentTree(node: SubagentNode, indent: string = "", isLast: boolean = true, isRoot: boolean = true): string {
	const branch = isRoot ? "" : (isLast ? "└─ " : "├─ ");
	const statusSym = node.status === "done" ? "✓" : node.status === "cancelled" ? "✗" : "·";
	const tplTag = node.template ? `[${node.template}]` : "";
	const taskTag = node.taskId ? ` task=${node.taskId}` : "";
	const head = `${indent}${branch}${statusSym} ${node.name} ${tplTag}${taskTag}  ${node.id.slice(0, 8)}`;
	const lines = [head];
	const nextIndent = indent + (isRoot ? "" : (isLast ? "   " : "│  "));
	for (let i = 0; i < node.children.length; i++) {
		lines.push(renderSubagentTree(node.children[i], nextIndent, i === node.children.length - 1, false));
	}
	return lines.join("\n");
}

// Render a block's content into text suitable for re-injection as a user turn.
// Each shape produces a clearly-framed quotation so the model knows this is a
// deliberate recall rather than a fresh utterance.
function renderBlockForRecall(block: any, tsIso: string): { text: string; kind: string } {
	const textContent = block?.content?.text;
	if (textContent?.text !== undefined) {
		const role = textContent.style === STYLE_ASSISTANT ? "assistant" : "user";
		return {
			kind: role === "assistant" ? "assistant_text" : "user_text",
			text: `[Recalled ${role} turn from ${tsIso}]:\n${textContent.text}`,
		};
	}
	const custom = block?.content?.custom;
	if (custom) {
		const contentType = custom.contentType ?? custom.content_type;
		const meta = custom.meta ?? {};
		if (contentType === BLOCK_TOOL_USE) {
			const toolName = meta.tool_name ?? "?";
			const input = meta.input ?? "{}";
			return { kind: "tool_use", text: `[Recalled tool call from ${tsIso}]: ${toolName}(${input})` };
		}
		if (contentType === BLOCK_TOOL_RESULT) {
			return { kind: "tool_result", text: `[Recalled tool result from ${tsIso}]:\n${meta.content ?? ""}${meta.is_error === "true" ? "\n(was an error)" : ""}` };
		}
		if (contentType === BLOCK_COMPACTION_SUMMARY) {
			return { kind: "compaction", text: `[Recalled compaction summary from ${tsIso}]:\n${meta.summary ?? ""}` };
		}
	}
	return { kind: "other", text: `[Recalled block ${block?.id ?? "?"} from ${tsIso}]` };
}

/** Re-inject a specific block into this agent's live context by writing a
*  new user_text block that quotes it. The new block's timestamp places it
*  after the latest compaction's firstKeptBlockId, so on the next ask it is
*  part of the model's live context window.
*/
async function doRecall(agentId: string, blockId: string, ctx: ProgramContext): Promise<{ newBlockId: string; sourceKind: string; truncated: boolean }> {
	const store = ctx.store as any;
	const client = ctx.client as any;
	const { randomUUID } = ctx;

	const state = await store.get(agentId);
	if (!state) throw new Error(`recall: agent not found: ${agentId}`);
	if (state.typeKey !== "agent") throw new Error(`recall: ${agentId} is not an agent`);

	const block = (state.blocks ?? []).find((b: any) => b.id === blockId);
	if (!block) throw new Error(`recall: block ${blockId} is not on agent ${agentId}`);

	const prov = state.blockProvenance?.[blockId];
	const tsIso = prov?.timestamp ? new Date(prov.timestamp).toISOString() : "unknown time";
	const rendered = renderBlockForRecall(block, tsIso);

	const RECALL_TRUNCATE = 8192;
	let text = rendered.text;
	let truncated = false;
	if (text.length > RECALL_TRUNCATE) {
		text = text.slice(0, RECALL_TRUNCATE) + `\n…[recall truncated, ${text.length - RECALL_TRUNCATE} bytes omitted]`;
		truncated = true;
	}

	const newBlockId = randomUUID();
	const actor = client.objectActor.getOrCreate([agentId]);
	await actor.addBlock(JSON.stringify(textBlock(newBlockId, text, STYLE_USER)));
	return { newBlockId, sourceKind: rendered.kind, truncated };
}

async function doCancel(agentId: string, ctx: ProgramContext): Promise<{ ok: true }> {
	const client = ctx.client as any;
	const { stringVal } = ctx as any;
	const actor = client.objectActor.getOrCreate([agentId]);
	await actor.setField("cancel_requested", JSON.stringify(stringVal("true")));
	return { ok: true };
}

// ── Actor (programmatic API for other programs) ──────────────────

const actorDef: ProgramActorDef = {
	createState: () => ({}),
	actions: {
		registerTool: async (ctx: ProgramContext, agentId: string, spec: string | ToolSpec) => {
			const parsed: ToolSpec = typeof spec === "string" ? JSON.parse(spec) : spec;
			if (!parsed?.name || !parsed.target_prefix || !parsed.target_action) {
				throw new Error("registerTool: spec must include name, target_prefix, target_action");
			}
			if (!parsed.input_schema) parsed.input_schema = { type: "object" };
			if (!parsed.description) parsed.description = `Call ${parsed.target_prefix} ${parsed.target_action}`;
			return await doRegisterTool(agentId, parsed, ctx);
		},
		unregisterTool: async (ctx: ProgramContext, agentId: string, toolName: string) => {
			return await doUnregisterTool(agentId, toolName, ctx);
		},
		listTools: async (ctx: ProgramContext, agentId: string) => {
			return await doListTools(agentId, ctx);
		},
		ask: async (ctx: ProgramContext, agentId: string, prompt: string) => {
			return await runAsk(agentId, prompt, ctx);
		},
		compact: async (ctx: ProgramContext, agentId: string, instructions?: string) => {
			return await doCompact(agentId, instructions, ctx);
		},
		status: async (ctx: ProgramContext, agentId: string) => {
			return await doStatus(agentId, ctx);
		},
		spawn: async (ctx: ProgramContext, arg: string | SpawnInput) => {
			const input: SpawnInput = typeof arg === "string" ? JSON.parse(arg) : arg;
			return await doSpawn(input, ctx);
		},
		submitResult: async (ctx: ProgramContext, arg: string | SubmitResultInput) => {
			const input: SubmitResultInput = typeof arg === "string" ? JSON.parse(arg) : arg;
			return await doSubmitResult(input, ctx);
		},
		recall: async (ctx: ProgramContext, agentId: string, blockId: string) => {
			return await doRecall(agentId, blockId, ctx);
		},
		cancel: async (ctx: ProgramContext, agentId: string) => {
			return await doCancel(agentId, ctx);
		},
		getSubagents: async (ctx: ProgramContext, agentId: string) => {
			return await doGetSubagents(agentId, ctx);
		},
	},
};

const program: ProgramDef = { handler, actor: actorDef };
export default program;

// ── Internal exports for testing ─────────────────────────────────

export const __test = {
	classifyBlocks,
	findLatestCompaction,
	filterToKept,
	groupIntoTurns,
	repairToolPairs,
	mergeConsecutiveTurns,
	buildConversationView,
	findCutIndex,
	estimateItemTokens,
	serializeItemsForSummary,
	buildSummaryPrompt,
	compactionBlock,
	textBlock,
	toolUseBlock,
	toolResultBlock,
	doCompact,
	doRegisterTool,
	doStatus,
	runAsk,
	shouldAutoCompact,
	isContextOverflowError,
	buildEffectiveSystem,
	// Subagent spawning
	doSpawn,
	doSubmitResult,
	doCancel,
	resolveAgentTemplate,
	BUILTIN_TEMPLATES,
	buildSubagentSystemPrompt,
	submitResultTool,
	spawnTool,
	validateAgainstSchema,
	doGetSubagents,
	renderSubagentTree,
	countDescendants,
	doRecall,
	renderBlockForRecall,
	// Test-only: clear in-memory run coordination state. Tests using
	// mockHangForever leave runners suspended on never-resolving promises;
	// clearing runSlots between such tests prevents cross-test interference
	// in node:test's async tracking.
	_resetRunSlots: () => runSlots.clear(),
	Semaphore,
	maxSpawnDepth,
};
