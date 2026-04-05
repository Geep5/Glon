/**
 * Chat program — message extraction and ANSI rendering.
 * Pure functions; no Rivet API calls.
 */

import type { Block } from "../proto.js";

// ── ANSI ────────────────────────────────────────────────────────

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

function dim(s: string): string { return `${DIM}${s}${RESET}`; }
function bold(s: string): string { return `${BOLD}${s}${RESET}`; }
function cyan(s: string): string { return `${CYAN}${s}${RESET}`; }

// ── Types ───────────────────────────────────────────────────────

interface BlockProvenanceRecord {
	changeId: string;
	author: string;
	timestamp: number;
}

export interface ChatMessage {
	blockId: string;
	text: string;
	author: string;
	timestamp: number;
	replyToId?: string;
}

// ── Extraction ──────────────────────────────────────────────────

/**
 * Extract ChatMessages from object state components.
 * Each block with text content becomes a message. Provenance supplies
 * author/timestamp; fields supply reply-to relations.
 */
export function extractMessages(
	blocks: Block[],
	provenance: Record<string, BlockProvenanceRecord>,
	fields: Record<string, any>,
): ChatMessage[] {
	const messages: ChatMessage[] = [];

	for (const block of blocks) {
		const text = block.content?.text?.text;
		if (text === undefined || text === null) continue;

		const prov = provenance[block.id];
		const author = prov?.author ?? "unknown";
		const timestamp = prov?.timestamp ?? 0;

		// Reply-to: field key is `reply:<blockId>`, value is a proto Value or plain string.
		const replyRaw = fields[`reply:${block.id}`];
		let replyToId: string | undefined;
		if (replyRaw !== undefined && replyRaw !== null) {
			replyToId = typeof replyRaw === "string"
				? replyRaw
				: replyRaw.stringValue ?? undefined;
		}

		messages.push({ blockId: block.id, text, author, timestamp, replyToId });
	}

	messages.sort((a, b) => a.timestamp - b.timestamp);
	return messages;
}

// ── Rendering ───────────────────────────────────────────────────

function formatTime(ts: number): string {
	if (ts === 0) return "--:--";
	const d = new Date(ts);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	return `${hh}:${mm}`;
}

/** Render a single message line. */
export function renderMessage(msg: ChatMessage): string {
	const time = dim(formatTime(msg.timestamp));
	const author = cyan(bold(msg.author));
	return `  ${time}  ${author}  ${msg.text}`;
}

/** Render a full chat log with optional room header. */
export function renderChat(messages: ChatMessage[], roomName?: string): string {
	const lines: string[] = [];

	if (roomName) {
		lines.push(bold(`  # ${roomName}`));
		lines.push("");
	}

	if (messages.length === 0) {
		lines.push(dim("  (no messages)"));
		return lines.join("\n");
	}

	for (const msg of messages) {
		if (msg.replyToId) {
			lines.push(dim(`  ↳ reply to ${msg.replyToId.slice(0, 8)}`));
		}
		lines.push(renderMessage(msg));
	}

	return lines.join("\n");
}
