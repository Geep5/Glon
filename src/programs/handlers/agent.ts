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
				current.content = current.content + item.text;
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

/** Build the model-facing view of the conversation: system extension + turns. */
function buildConversationView(blocks: any[], provenance: Record<string, any>): ConversationView {
	const items = classifyBlocks(blocks, provenance);
	const latest = findLatestCompaction(items);
	if (!latest) {
		return {
			systemExtension: undefined,
			turns: groupIntoTurns(items.filter((i) => i.kind !== "compaction")),
			latestCompaction: null,
		};
	}
	const kept = filterToKept(items, latest.firstKeptBlockId);
	return {
		systemExtension: latest.summary,
		turns: groupIntoTurns(kept),
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

async function callAnthropic(
	messages: { role: string; content: string | AnthropicContent[] }[],
	system: string | undefined,
	model: string,
	temperature: number | undefined,
	tools: ToolSpec[] | undefined,
	onChunk: ((text: string) => void) | undefined,
	maxTokens?: number,
): Promise<InferenceResult> {
	const testFetch = (globalThis as any).__ANTHROPIC_FETCH as
		| undefined
		| ((req: { messages: any[]; tools?: any[]; system?: string; model: string; maxTokens?: number }) => Promise<InferenceResult>);
	if (testFetch) {
		return testFetch({ messages, tools, system, model, maxTokens });
	}

	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

	const stream = !!onChunk && !tools;

	const body: Record<string, any> = {
		model,
		max_tokens: maxTokens ?? 4096,
		messages,
		stream,
		temperature: temperature ?? 0.7,
	};
	if (system) body.system = system;
	if (tools && tools.length > 0) {
		body.tools = tools.map((t) => ({
			name: t.name,
			description: t.description,
			input_schema: t.input_schema,
		}));
	}

	const res = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify(body),
	});

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
	const content: AnthropicContent[] = Array.isArray(data.content) ? data.content : [];
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
			messages, EXTRACTION_SYSTEM, model, SUMMARY_TEMPERATURE, tools, undefined, SUMMARY_MAX_TOKENS,
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

async function runAsk(
	agentId: string,
	prompt: string,
	ctx: ProgramContext,
	opts: { printStream?: boolean } = {},
): Promise<AskResult> {
	const store = ctx.store as any;
	const client = ctx.client as any;
	const { randomUUID, print } = ctx;

	let compactedBeforeAsk = false;
	let compactedOnOverflow = false;

	// Pre-flight: auto-compact if threshold tripped.
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

	const view = buildConversationView(state.blocks ?? [], state.blockProvenance ?? {});
	const memoryDigest = await resolveMemoryDigest(agentId, ctx);
	let effectiveSystem = buildEffectiveSystem(baseSystem, view.systemExtension, memoryDigest);
	const messages: { role: string; content: string | AnthropicContent[] }[] = view.turns.map((t) => ({
		role: t.role,
		content: t.content,
	}));
	messages.push({ role: "user", content: prompt });

	const actor = client.objectActor.getOrCreate([agentId]);
	await actor.addBlock(JSON.stringify(textBlock(randomUUID(), prompt, STYLE_USER)));

	let iterations = 0;
	let toolCalls = 0;
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let finalText = "";

	while (true) {
		if (iterations >= MAX_TOOL_ITERATIONS) {
			throw new Error(`Tool-use loop exceeded ${MAX_TOOL_ITERATIONS} iterations`);
		}
		iterations++;

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
			result = await callAnthropic(messages, effectiveSystem, model, temperature, tools.length > 0 ? tools : undefined, onChunk);
		} catch (err: any) {
			if (iterations === 1 && !compactedOnOverflow && isContextOverflowError(err)) {
				// Overflow recovery: compact once and retry.
				await doCompact(agentId, undefined, ctx);
				compactedOnOverflow = true;
				state = await store.get(agentId);
				const reView = buildConversationView(state.blocks ?? [], state.blockProvenance ?? {});
				// Memory digest may have grown (compaction could have extracted new facts); re-resolve.
				const reDigest = await resolveMemoryDigest(agentId, ctx);
				effectiveSystem = buildEffectiveSystem(baseSystem, reView.systemExtension, reDigest);
				// Rebuild messages (already persisted the user prompt once — don't persist again).
				messages.length = 0;
				for (const t of reView.turns) messages.push({ role: t.role, content: t.content });
				// Rehydrate the new-prompt at the end (it's already a block; but we need it in-flight).
				// The new prompt IS in reView.turns as the last user turn, so no extra push.
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

		if (assistantText) {
			await actor.addBlock(JSON.stringify(textBlock(randomUUID(), assistantText, STYLE_ASSISTANT)));
		}
		for (const tu of toolUses) {
			await actor.addBlock(JSON.stringify(toolUseBlock(randomUUID(), tu.id, tu.name, tu.input)));
		}

		if (toolUses.length === 0) {
			finalText = assistantText;
			break;
		}

		const toolResults: Extract<AnthropicContent, { type: "tool_result" }>[] = [];
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
						? { ...(tu.input ?? {}), ...tool.bound_args }   // bound_args override model input
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
			await actor.addBlock(JSON.stringify(toolResultBlock(randomUUID(), tu.id, contentText, isError)));
		}

		messages.push({ role: "assistant", content: result.content });
		messages.push({ role: "user", content: toolResults });
	}

	return { finalText, iterations, toolCalls, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, compactedBeforeAsk, compactedOnOverflow };
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
};
