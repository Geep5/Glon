// Agent conversation — block classification, turn grouping, token estimation,
// and conversation view construction.
//
// Extracted from agent.ts to reduce omnibus size. Pure functions only:
// given block arrays, produce views and estimates. No store access.

import type { AnthropicContent } from "./agent-llm.js";
import {
	ClassifiedItem,
	Turn,
	ConversationView,
	ToolSpec,
	extractString,
	extractTools,
	BLOCK_TOOL_USE,
	BLOCK_TOOL_RESULT,
	BLOCK_COMPACTION_SUMMARY,
	STYLE_USER,
	STYLE_ASSISTANT,
	CHARS_PER_TOKEN,
	safeJsonParse,
} from "./agent-types.js";

const CHARS_PER_TOKEN = 2.8;

export function estimateTextTokens(s: string): number {
	return Math.ceil(s.length / CHARS_PER_TOKEN);
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

export function estimateItemTokens(item: ClassifiedItem): number {
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

/** Estimate the tokens consumed by tool definitions in the API request.
 *  Each tool sends `name + description + JSON-stringified input_schema`,
 *  plus a constant ~12 tokens of per-tool framing overhead Anthropic adds. */
export function estimateToolDefinitionsTokens(tools: ToolSpec[]): number {
	let total = 0;
	for (const t of tools) {
		total += estimateTextTokens(t.name);
		total += estimateTextTokens(t.description);
		total += estimateTextTokens(JSON.stringify(t.input_schema));
		total += 12;
	}
	return total;
}

/** Estimate the total tokens that will be sent to Anthropic for the next ask:
 *  base system prompt + summary extension + memory digest + tool definitions
 *  + every conversation turn. Mirrors what callAnthropic packs into the body. */
export function estimateAskTokens(
	state: any,
	view: { turns: { content: string | AnthropicContent[] }[]; systemExtension?: string },
	memoryDigest?: string,
): number {
	const baseSystem = extractString(state?.fields?.system);
	const tools = extractTools(state?.fields?.tools);
	let total = 0;
	if (baseSystem) total += estimateTextTokens(baseSystem);
	if (view.systemExtension) total += estimateTextTokens(view.systemExtension);
	if (memoryDigest) total += estimateTextTokens(memoryDigest);
	total += estimateToolDefinitionsTokens(tools);
	for (const t of view.turns) {
		total += typeof t.content === "string" ? estimateTextTokens(t.content) : estimateTokens(t.content);
	}
	return total;
}


// ── Block classification ─────────────────────────────────────────

export function classifyBlocks(blocks: any[], provenance: Record<string, any>): ClassifiedItem[] {
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


export function findLatestCompaction(items: ClassifiedItem[]): Extract<ClassifiedItem, { kind: "compaction" }> | null {
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
export function filterToKept(items: ClassifiedItem[], firstKeptBlockId: string): ClassifiedItem[] {
	const idx = items.findIndex((i) => i.blockId === firstKeptBlockId);
	if (idx === -1) return items.filter((i) => i.kind !== "compaction");
	return items.slice(idx).filter((i) => i.kind !== "compaction");
}


/**
 * Pair every `tool_use` with a `tool_result` AND enforce strict adjacency:
 * each `tool_use` is immediately followed by its matching `tool_result` in
 * the returned items array. Synthesizes an error stub when the DAG has no
 * matching result; drops orphan results whose `tool_use` is missing.
 *
 * Why adjacency, not just pairing: Anthropic rejects messages where a
 * `tool_use` is not immediately followed by its `tool_result`. Two ways the
 * DAG can land in a non-adjacent state:
 *   1. Crash between the `tool_use` block write and the `tool_result` block
 *      write \u2014 handled by the synthetic stub.
 *   2. A steered user message arrives during tool execution, so the user
 *      block (and any assistant reply to it) lands in the DAG with a
 *      timestamp between the tool_use's and the tool_result's. After a
 *      restart, classifyBlocks sorts by timestamp and the result is
 *      tool_use \u2192 user \u2192 assistant \u2192 tool_result. This pass hoists the
 *      tool_result up to immediately follow its tool_use; the intervening
 *      user/assistant blocks shift down and remain in the conversation.
 *
 * The synthetic `tool_result` carries `isError=true` so the model sees the
 * interrupted call for what it was and does not mistake silence for success.
 */
export function repairToolPairs(items: ClassifiedItem[]): ClassifiedItem[] {
	// Index real tool_results by their tool_use_id (first occurrence wins).
	const resultByUseId = new Map<string, Extract<ClassifiedItem, { kind: "tool_result" }>>();
	for (const item of items) {
		if (item.kind === "tool_result" && item.toolUseId && !resultByUseId.has(item.toolUseId)) {
			resultByUseId.set(item.toolUseId, item);
		}
	}
	// Tool_uses present in the conversation \u2014 used to drop orphan results.
	const toolUseIds = new Set<string>();
	for (const item of items) {
		if (item.kind === "tool_use" && item.toolUseId) toolUseIds.add(item.toolUseId);
	}

	const out: ClassifiedItem[] = [];
	for (const item of items) {
		if (item.kind === "tool_result") {
			// Always skip in-place. A real tool_result is emitted immediately after
			// its tool_use (below). An orphan tool_result (no matching tool_use)
			// drops on the floor \u2014 sending it would raise a symmetric API error.
			continue;
		}
		out.push(item);
		if (item.kind === "tool_use" && item.toolUseId) {
			const real = resultByUseId.get(item.toolUseId);
			if (real) {
				out.push(real);
			} else {
				out.push({
					kind: "tool_result",
					blockId: `__synthetic:${item.toolUseId}`,
					toolUseId: item.toolUseId,
					content: "[tool call was interrupted before producing a result \u2014 treat this as a failed call and proceed.]",
					isError: true,
					timestamp: item.timestamp + 1,
				});
			}
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
export function mergeConsecutiveTurns(turns: Turn[]): Turn[] {
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
export function groupIntoTurns(items: ClassifiedItem[]): Turn[] {
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


export function buildConversationView(blocks: any[], provenance: Record<string, any>): ConversationView {
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
export function findCutIndex(items: ClassifiedItem[], keepRecentTokens: number): number | null {
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


// ── Block constructors ───────────────────────────────────────────

export function textBlock(id: string, text: string, style: number) {
	return { id, childrenIds: [], content: { text: { text, style } } };
}


export function toolUseBlock(id: string, toolUseId: string, name: string, input: Record<string, unknown>) {
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


export function toolResultBlock(id: string, toolUseId: string, content: string, isError: boolean) {
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


export function compactionBlock(
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

