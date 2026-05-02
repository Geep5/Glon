// Comment — discussions on any glon object.
//
// One convention, two surfaces: a `message` block can be added to the block
// tree of any object — a chat room, a memory milestone, a peer record, a
// reminder, a generic page. The same /comment program handles posting,
// threading via reply_to, reactions, attachments, and reading.
//
// Design summary (per Anytype's v0.55.0 lesson, applied to glon's primitives):
//
//   message block           CustomContent { content_type: "message", meta: {
//     text: string                  body of the message,
//     creator?: object_id           who said it (peer / agent),
//     reply_to?: block_id           parent message id (threading),
//     attachments?: JSON list of    [{ object_id, kind }, ...]
//     created_at?: epoch_ms
//   }}
//
//   reaction block          CustomContent { content_type: "reaction", meta: {
//     target: block_id              the message being reacted to (required),
//     emoji: string                 e.g. "👍",
//     creator?: object_id           who reacted (peer / agent),
//     created_at?: epoch_ms
//   }}
//
// Why per-message metadata (not parent-keyed FieldSets like the old /chat):
// the reply_to / reactions belong with the message, not with the room. One
// addBlock change carries the whole post; sync ships less; deletion is
// atomic; rendering doesn't need to scan parent fields.
//
// To "unreact": removeBlock the reaction block. The DAG keeps the history.
//
// Any program that wants comments dispatches /comment.post (and friends) at
// any object id. /chat is now a thin alias around /comment.

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";

// ── ANSI ─────────────────────────────────────────────────────────

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const dim = (s: string) => `${DIM}${s}${RESET}`;
const bold = (s: string) => `${BOLD}${s}${RESET}`;
const cyan = (s: string) => `${CYAN}${s}${RESET}`;
const red = (s: string) => `${RED}${s}${RESET}`;
const green = (s: string) => `${GREEN}${s}${RESET}`;
const yellow = (s: string) => `${YELLOW}${s}${RESET}`;

// ── Constants ────────────────────────────────────────────────────

export const MESSAGE_CONTENT_TYPE = "message";
export const REACTION_CONTENT_TYPE = "reaction";

// ── Types ────────────────────────────────────────────────────────

export interface Attachment {
	object_id: string;
	/** Free-form kind hint: "object", "image", "file", "link", or a typeKey. */
	kind?: string;
}

export interface PostInput {
	objectId: string;
	text: string;
	creator?: string;
	reply_to?: string;
	attachments?: Attachment[];
}

export interface ReplyInput {
	objectId: string;
	parent_block_id: string;
	text: string;
	creator?: string;
	attachments?: Attachment[];
}

export interface ReactInput {
	objectId: string;
	message_block_id: string;
	emoji: string;
	creator?: string;
}

export interface UnreactInput {
	objectId: string;
	reaction_block_id: string;
}

export interface ListInput {
	objectId: string;
	/** Only return root messages (no replies) at the top level. Replies are still returned as nested. */
	rootsOnly?: boolean;
}

export interface ThreadInput {
	objectId: string;
	root_block_id: string;
}

export interface ReactionRecord {
	block_id: string;
	emoji: string;
	creator?: string;
	created_at?: number;
}

export interface MessageRecord {
	block_id: string;
	text: string;
	creator?: string;
	reply_to?: string;
	attachments: Attachment[];
	created_at?: number;
	reactions: ReactionRecord[];
}

// ── Block constructors ───────────────────────────────────────────

function makeMessageBlock(blockId: string, input: PostInput): unknown {
	const meta: Record<string, string> = { text: input.text };
	if (input.creator) meta.creator = input.creator;
	if (input.reply_to) meta.reply_to = input.reply_to;
	if (input.attachments && input.attachments.length > 0) {
		meta.attachments = JSON.stringify(input.attachments);
	}
	meta.created_at = String(Date.now());
	return {
		id: blockId,
		childrenIds: [],
		content: {
			custom: {
				contentType: MESSAGE_CONTENT_TYPE,
				data: "",
				meta,
			},
		},
	};
}

function makeReactionBlock(blockId: string, input: ReactInput): unknown {
	const meta: Record<string, string> = {
		target: input.message_block_id,
		emoji: input.emoji,
	};
	if (input.creator) meta.creator = input.creator;
	meta.created_at = String(Date.now());
	return {
		id: blockId,
		childrenIds: [],
		content: {
			custom: {
				contentType: REACTION_CONTENT_TYPE,
				data: "",
				meta,
			},
		},
	};
}

// ── Validation ───────────────────────────────────────────────────

function validateText(text: unknown): string {
	if (typeof text !== "string" || text.trim() === "") {
		throw new Error("comment: text required (non-empty string)");
	}
	return text;
}

function validateObjectId(id: unknown): string {
	if (typeof id !== "string" || !id) {
		throw new Error("comment: objectId required");
	}
	return id;
}

function validateAttachments(raw: unknown): Attachment[] | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (!Array.isArray(raw)) throw new Error("comment: attachments must be an array");
	const out: Attachment[] = [];
	for (const a of raw) {
		if (!a || typeof a !== "object") throw new Error("comment: each attachment must be an object");
		const obj = a as Record<string, unknown>;
		if (typeof obj.object_id !== "string" || !obj.object_id) {
			throw new Error("comment: attachment.object_id required (string)");
		}
		const att: Attachment = { object_id: obj.object_id };
		if (typeof obj.kind === "string") att.kind = obj.kind;
		out.push(att);
	}
	return out;
}

// ── Read helpers ─────────────────────────────────────────────────

function extractMeta(block: any): Record<string, string> {
	return block?.content?.custom?.meta ?? {};
}

function extractContentType(block: any): string | undefined {
	return block?.content?.custom?.contentType ?? block?.content?.custom?.content_type;
}

function parseAttachments(raw: string | undefined): Attachment[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((a) => a && typeof a === "object" && typeof a.object_id === "string");
	} catch {
		return [];
	}
}

function parseEpoch(raw: string | undefined): number | undefined {
	if (!raw) return undefined;
	const n = parseInt(raw, 10);
	return Number.isFinite(n) ? n : undefined;
}

/** Build a flat list of message records from an object's blocks, with reactions
 *  attached to the messages they target. Order: by created_at then by index in
 *  blocks (block tree order is the tiebreaker). */
function buildMessageRecords(blocks: any[]): MessageRecord[] {
	const messages = new Map<string, MessageRecord>();
	const messageOrder: string[] = [];
	const reactionsByTarget = new Map<string, ReactionRecord[]>();

	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i];
		const ct = extractContentType(b);
		if (ct === MESSAGE_CONTENT_TYPE) {
			const meta = extractMeta(b);
			const rec: MessageRecord = {
				block_id: b.id,
				text: meta.text ?? "",
				creator: meta.creator || undefined,
				reply_to: meta.reply_to || undefined,
				attachments: parseAttachments(meta.attachments),
				created_at: parseEpoch(meta.created_at),
				reactions: [],
			};
			messages.set(b.id, rec);
			messageOrder.push(b.id);
		} else if (ct === REACTION_CONTENT_TYPE) {
			const meta = extractMeta(b);
			if (!meta.target) continue;
			const r: ReactionRecord = {
				block_id: b.id,
				emoji: meta.emoji ?? "",
				creator: meta.creator || undefined,
				created_at: parseEpoch(meta.created_at),
			};
			const list = reactionsByTarget.get(meta.target) ?? [];
			list.push(r);
			reactionsByTarget.set(meta.target, list);
		}
	}
	for (const [target, reactions] of reactionsByTarget) {
		const msg = messages.get(target);
		if (msg) msg.reactions = reactions;
	}
	const sorted = messageOrder
		.map((id) => messages.get(id)!)
		.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
	return sorted;
}

// ── Core operations ──────────────────────────────────────────────

async function doPost(input: PostInput, ctx: ProgramContext): Promise<{ block_id: string }> {
	const objectId = validateObjectId(input.objectId);
	const text = validateText(input.text);
	const attachments = validateAttachments(input.attachments);
	const blockId = ctx.randomUUID();
	const block = makeMessageBlock(blockId, {
		objectId, text, creator: input.creator, reply_to: input.reply_to, attachments,
	});
	const actor = (ctx.client as any).objectActor.getOrCreate([objectId]);
	await actor.addBlock(JSON.stringify(block));
	return { block_id: blockId };
}

async function doReply(input: ReplyInput, ctx: ProgramContext): Promise<{ block_id: string }> {
	if (!input.parent_block_id) throw new Error("comment.reply: parent_block_id required");
	return await doPost({
		objectId: input.objectId,
		text: input.text,
		creator: input.creator,
		reply_to: input.parent_block_id,
		attachments: input.attachments,
	}, ctx);
}

async function doReact(input: ReactInput, ctx: ProgramContext): Promise<{ block_id: string }> {
	const objectId = validateObjectId(input.objectId);
	if (!input.message_block_id) throw new Error("comment.react: message_block_id required");
	if (!input.emoji || typeof input.emoji !== "string") throw new Error("comment.react: emoji required");
	const blockId = ctx.randomUUID();
	const block = makeReactionBlock(blockId, { ...input, objectId });
	const actor = (ctx.client as any).objectActor.getOrCreate([objectId]);
	await actor.addBlock(JSON.stringify(block));
	return { block_id: blockId };
}

async function doUnreact(input: UnreactInput, ctx: ProgramContext): Promise<{ ok: boolean }> {
	const objectId = validateObjectId(input.objectId);
	if (!input.reaction_block_id) throw new Error("comment.unreact: reaction_block_id required");
	const actor = (ctx.client as any).objectActor.getOrCreate([objectId]);
	await actor.removeBlock(input.reaction_block_id);
	return { ok: true };
}

async function doList(input: ListInput, ctx: ProgramContext): Promise<MessageRecord[]> {
	const objectId = validateObjectId(input.objectId);
	const state = await (ctx.store as any).get(objectId);
	if (!state) throw new Error(`comment.list: object not found: ${objectId}`);
	const records = buildMessageRecords(state.blocks ?? []);
	return input.rootsOnly ? records.filter((r) => !r.reply_to) : records;
}

async function doThread(input: ThreadInput, ctx: ProgramContext): Promise<MessageRecord[]> {
	const objectId = validateObjectId(input.objectId);
	if (!input.root_block_id) throw new Error("comment.thread: root_block_id required");
	const state = await (ctx.store as any).get(objectId);
	if (!state) throw new Error(`comment.thread: object not found: ${objectId}`);
	const all = buildMessageRecords(state.blocks ?? []);
	// BFS from root over reply_to edges.
	const byParent = new Map<string, MessageRecord[]>();
	for (const r of all) {
		if (!r.reply_to) continue;
		const list = byParent.get(r.reply_to) ?? [];
		list.push(r);
		byParent.set(r.reply_to, list);
	}
	const root = all.find((r) => r.block_id === input.root_block_id);
	if (!root) return [];
	const ordered: MessageRecord[] = [];
	const queue: MessageRecord[] = [root];
	while (queue.length > 0) {
		const m = queue.shift()!;
		ordered.push(m);
		const children = byParent.get(m.block_id) ?? [];
		// Sort children by created_at to render replies in chronological order.
		children.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
		for (const c of children) queue.push(c);
	}
	return ordered;
}

// ── CLI handler ──────────────────────────────────────────────────

function formatTime(ts?: number): string {
	if (!ts) return "--:--";
	const d = new Date(ts);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function renderMessage(rec: MessageRecord, indent = ""): string {
	const lines: string[] = [];
	const time = dim(formatTime(rec.created_at));
	const who = rec.creator ? cyan(bold(rec.creator.slice(0, 8))) : dim("anon");
	const id = dim(rec.block_id.slice(0, 8));
	lines.push(`${indent}${time}  ${who}  ${rec.text}  ${id}`);
	if (rec.reactions.length > 0) {
		const grouped = new Map<string, number>();
		for (const r of rec.reactions) grouped.set(r.emoji, (grouped.get(r.emoji) ?? 0) + 1);
		const summary = [...grouped.entries()].map(([e, n]) => `${e} ${n}`).join("  ");
		lines.push(`${indent}        ${dim(summary)}`);
	}
	if (rec.attachments.length > 0) {
		const refs = rec.attachments.map((a) => `${a.kind ?? "object"}:${a.object_id.slice(0, 8)}`).join(", ");
		lines.push(`${indent}        ${yellow("attached: " + refs)}`);
	}
	return lines.join("\n");
}

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { resolveId, print } = ctx;
	switch (cmd) {
		case "post": {
			const raw = args[0];
			const text = args.slice(1).join(" ");
			if (!raw || !text) { print(red("Usage: comment post <objectId> <text...>")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			try {
				const r = await doPost({ objectId: id, text }, ctx);
				print(green("posted ") + bold(r.block_id));
			} catch (err: any) { print(red("Error: ") + (err?.message ?? String(err))); }
			break;
		}
		case "reply": {
			const raw = args[0];
			const parentBlockId = args[1];
			const text = args.slice(2).join(" ");
			if (!raw || !parentBlockId || !text) { print(red("Usage: comment reply <objectId> <parentBlockId> <text...>")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			try {
				const r = await doReply({ objectId: id, parent_block_id: parentBlockId, text }, ctx);
				print(green("replied ") + bold(r.block_id));
			} catch (err: any) { print(red("Error: ") + (err?.message ?? String(err))); }
			break;
		}
		case "react": {
			const raw = args[0];
			const messageBlockId = args[1];
			const emoji = args[2];
			if (!raw || !messageBlockId || !emoji) { print(red("Usage: comment react <objectId> <messageBlockId> <emoji>")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			try {
				const r = await doReact({ objectId: id, message_block_id: messageBlockId, emoji }, ctx);
				print(green("reacted ") + emoji + dim(" " + r.block_id.slice(0, 8)));
			} catch (err: any) { print(red("Error: ") + (err?.message ?? String(err))); }
			break;
		}
		case "unreact": {
			const raw = args[0];
			const reactionBlockId = args[1];
			if (!raw || !reactionBlockId) { print(red("Usage: comment unreact <objectId> <reactionBlockId>")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			try {
				await doUnreact({ objectId: id, reaction_block_id: reactionBlockId }, ctx);
				print(dim("removed ") + reactionBlockId.slice(0, 8));
			} catch (err: any) { print(red("Error: ") + (err?.message ?? String(err))); }
			break;
		}
		case "list": {
			const raw = args[0];
			if (!raw) { print(red("Usage: comment list <objectId> [--roots]")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			const rootsOnly = args.includes("--roots");
			try {
				const records = await doList({ objectId: id, rootsOnly }, ctx);
				if (records.length === 0) { print(dim("  (no messages)")); break; }
				print(bold(`  ${records.length} message(s)`));
				const byParent = new Map<string, MessageRecord[]>();
				for (const r of records) {
					if (r.reply_to) {
						const list = byParent.get(r.reply_to) ?? [];
						list.push(r);
						byParent.set(r.reply_to, list);
					}
				}
				const roots = records.filter((r) => !r.reply_to);
				const renderTree = (rec: MessageRecord, indent = "  ") => {
					print(renderMessage(rec, indent));
					const children = byParent.get(rec.block_id) ?? [];
					for (const c of children) renderTree(c, indent + "  ↳ ");
				};
				for (const r of roots) renderTree(r);
			} catch (err: any) { print(red("Error: ") + (err?.message ?? String(err))); }
			break;
		}
		case "thread": {
			const raw = args[0];
			const rootBlockId = args[1];
			if (!raw || !rootBlockId) { print(red("Usage: comment thread <objectId> <rootBlockId>")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			try {
				const records = await doThread({ objectId: id, root_block_id: rootBlockId }, ctx);
				if (records.length === 0) { print(dim("  (no messages)")); break; }
				const byParent = new Map<string, MessageRecord[]>();
				for (const r of records) {
					if (r.reply_to) {
						const list = byParent.get(r.reply_to) ?? [];
						list.push(r);
						byParent.set(r.reply_to, list);
					}
				}
				const renderTree = (rec: MessageRecord, indent = "  ") => {
					print(renderMessage(rec, indent));
					const children = byParent.get(rec.block_id) ?? [];
					for (const c of children) renderTree(c, indent + "  ↳ ");
				};
				const root = records[0];
				renderTree(root);
			} catch (err: any) { print(red("Error: ") + (err?.message ?? String(err))); }
			break;
		}
		default: {
			print([
				bold("  Comment") + dim(" — discussions on any object"),
				`    ${cyan("comment post")}    ${dim("<objectId> <text...>")}`,
				`    ${cyan("comment reply")}   ${dim("<objectId> <parentBlockId> <text...>")}`,
				`    ${cyan("comment react")}   ${dim("<objectId> <messageBlockId> <emoji>")}`,
				`    ${cyan("comment unreact")} ${dim("<objectId> <reactionBlockId>")}`,
				`    ${cyan("comment list")}    ${dim("<objectId> [--roots]")}`,
				`    ${cyan("comment thread")}  ${dim("<objectId> <rootBlockId>")}`,
			].join("\n"));
		}
	}
};

// ── Actor (programmatic API for /chat and other programs) ────────

const actorDef: ProgramActorDef = {
	createState: () => ({}),
	actions: {
		post: async (ctx: ProgramContext, input: string | PostInput) => {
			const parsed = typeof input === "string" ? JSON.parse(input) : input;
			return await doPost(parsed, ctx);
		},
		reply: async (ctx: ProgramContext, input: string | ReplyInput) => {
			const parsed = typeof input === "string" ? JSON.parse(input) : input;
			return await doReply(parsed, ctx);
		},
		react: async (ctx: ProgramContext, input: string | ReactInput) => {
			const parsed = typeof input === "string" ? JSON.parse(input) : input;
			return await doReact(parsed, ctx);
		},
		unreact: async (ctx: ProgramContext, input: string | UnreactInput) => {
			const parsed = typeof input === "string" ? JSON.parse(input) : input;
			return await doUnreact(parsed, ctx);
		},
		list: async (ctx: ProgramContext, input: string | ListInput) => {
			const parsed = typeof input === "string" ? JSON.parse(input) : input;
			return await doList(parsed, ctx);
		},
		thread: async (ctx: ProgramContext, input: string | ThreadInput) => {
			const parsed = typeof input === "string" ? JSON.parse(input) : input;
			return await doThread(parsed, ctx);
		},
	},
};

const program: ProgramDef = { handler, actor: actorDef };
export default program;

// ── Internal exports for testing ─────────────────────────────────

export const __test = {
	doPost,
	doReply,
	doReact,
	doUnreact,
	doList,
	doThread,
	buildMessageRecords,
	makeMessageBlock,
	makeReactionBlock,
};
