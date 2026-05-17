// Chat — a thin alias around /comment for the "chat room" surface.
//
// Glon used to maintain its own message format here: TextContent blocks for
// each message plus parent-keyed FieldSets for reply (`reply:<blockId>` →
// targetBlockId) and reactions (`react:<blockId>:<emoji>` → "local"). After
// the v0.55.0 Anytype design review we standardised on a single `message`
// block convention (handled by /comment) that any object can host. Chat
// rooms are now just a `chat`-typed object whose discussion happens to be
// its primary content.
//
// New posts go through /comment.post (etc.). The `read` command renders
// both the new message blocks AND the legacy TextContent blocks so old
// rooms (created before the migration) keep displaying — the DAG never
// loses history, but old messages don't get reactions/replies retroactively.
//
// If you're writing a new program that wants discussions on its objects,
// dispatch /comment directly. /chat exists for the standalone-room UX.

import type { ProgramDef, ProgramContext } from "../runtime.js";
import {
	MESSAGE_CONTENT_TYPE,
	REACTION_CONTENT_TYPE,
	type MessageRecord,
	type ReactionRecord,
} from "./comment.js";
import { dim, bold, cyan, red, green, yellow } from "../shared.js";

// ── Helpers ──────────────────────────────────────────────────────

function extractString(v: any): string | undefined {
	if (v === null || v === undefined) return undefined;
	if (typeof v === "string") return v;
	if (v.stringValue !== undefined) return v.stringValue;
	return undefined;
}

function formatTime(ts?: number): string {
	if (!ts) return "--:--";
	const d = new Date(ts);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// Combined record shape: messages from /comment plus legacy TextContent
// messages reconstructed from the old /chat format. Legacy messages carry
// reply_to (from parent fields) but no reactions are rendered for legacy
// blocks — reactions on the old format are still in the parent fields and
// would need a separate scan; we leave them as historical residue rather
// than rebuild old rendering paths.
interface CombinedMessage {
	block_id: string;
	text: string;
	creator?: string;
	reply_to?: string;
	reactions: ReactionRecord[];
	created_at?: number;
	legacy: boolean;
}

function fromMessageRecord(rec: MessageRecord): CombinedMessage {
	return {
		block_id: rec.block_id,
		text: rec.text,
		creator: rec.creator,
		reply_to: rec.reply_to,
		reactions: rec.reactions,
		created_at: rec.created_at,
		legacy: false,
	};
}

/** Read /comment messages and legacy TextContent messages from a chat object,
 *  merge them into one chronologically-sorted list. */
async function readMessages(chatId: string, ctx: ProgramContext): Promise<CombinedMessage[]> {
	const newRecords = await ctx.dispatchProgram("/comment", "list", [{ objectId: chatId }]) as MessageRecord[];
	const newMessages = newRecords.map(fromMessageRecord);
	const newBlockIds = new Set(newMessages.map((m) => m.block_id));

	// Reconstruct legacy messages from the object directly.
	const state = await (ctx.store as any).get(chatId);
	if (!state) return newMessages;
	const blocks = state.blocks ?? [];
	const provenance = state.blockProvenance ?? {};
	const fields = state.fields ?? {};
	const legacy: CombinedMessage[] = [];
	for (const b of blocks) {
		if (newBlockIds.has(b.id)) continue;
		const text = b.content?.text?.text;
		if (typeof text !== "string") continue;
		const prov = provenance[b.id] ?? {};
		const replyKey = `reply:${b.id}`;
		const replyRaw = fields[replyKey];
		const replyToId = replyRaw === undefined ? undefined
			: typeof replyRaw === "string" ? replyRaw
			: replyRaw.stringValue ?? undefined;
		legacy.push({
			block_id: b.id,
			text,
			creator: prov.author,
			reply_to: replyToId,
			reactions: [],
			created_at: prov.timestamp ?? undefined,
			legacy: true,
		});
	}
	const all = [...newMessages, ...legacy];
	all.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
	return all;
}

function renderRoom(messages: CombinedMessage[], roomName: string | undefined): string {
	const lines: string[] = [];
	if (roomName) {
		lines.push(bold(`  # ${roomName}`));
		lines.push("");
	}
	if (messages.length === 0) {
		lines.push(dim("  (no messages)"));
		return lines.join("\n");
	}
	for (const m of messages) {
		if (m.reply_to) {
			lines.push(dim(`  ↳ reply to ${m.reply_to.slice(0, 8)}`));
		}
		const time = dim(formatTime(m.created_at));
		const who = cyan(bold((m.creator ?? "unknown").slice(0, 12)));
		const tag = m.legacy ? dim(" (legacy)") : "";
		lines.push(`  ${time}  ${who}${tag}  ${m.text}  ${dim(m.block_id.slice(0, 8))}`);
		if (m.reactions.length > 0) {
			const counts = new Map<string, number>();
			for (const r of m.reactions) counts.set(r.emoji, (counts.get(r.emoji) ?? 0) + 1);
			const summary = [...counts.entries()].map(([e, n]) => `${e} ${n}`).join("  ");
			lines.push(`        ${dim(summary)}`);
		}
	}
	return lines.join("\n");
}

// ── Command dispatch ─────────────────────────────────────────────

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { store, resolveId, stringVal, print } = ctx;
	switch (cmd) {
		case "new": {
			const name = args.join(" ") || undefined;
			const fieldsJson = name ? JSON.stringify({ name: stringVal(name) }) : undefined;
			const id = await (store as any).create("chat", fieldsJson);
			print(green("Chat room: ") + bold(id));
			print(dim("  chat send " + id.slice(0, 8) + " Hello!"));
			break;
		}
		case "send": {
			const raw = args[0];
			const text = args.slice(1).join(" ");
			if (!raw || !text) { print(red("Usage: chat send <id> <message...>")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			try {
				const r = await ctx.dispatchProgram("/comment", "post", [{ objectId: id, text }]) as { block_id: string };
				print(dim("sent ") + r.block_id.slice(0, 8));
			} catch (err: any) { print(red("Error: ") + (err?.message ?? String(err))); }
			break;
		}
		case "read": {
			const raw = args[0];
			if (!raw) { print(red("Usage: chat read <id>")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			const state = await (store as any).get(id);
			if (!state) { print(red("Object not found")); break; }
			const roomName = extractString(state.fields?.["name"]);
			const messages = await readMessages(id, ctx);
			print(renderRoom(messages, roomName));
			break;
		}
		case "reply": {
			const raw = args[0];
			const targetBlockId = args[1];
			const text = args.slice(2).join(" ");
			if (!raw || !targetBlockId || !text) {
				print(red("Usage: chat reply <id> <msgBlockId> <message...>"));
				break;
			}
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			try {
				const r = await ctx.dispatchProgram("/comment", "reply", [{
					objectId: id, parent_block_id: targetBlockId, text,
				}]) as { block_id: string };
				print(dim("replied ") + r.block_id.slice(0, 8));
			} catch (err: any) { print(red("Error: ") + (err?.message ?? String(err))); }
			break;
		}
		case "react": {
			const raw = args[0];
			const targetBlockId = args[1];
			const emoji = args[2];
			if (!raw || !targetBlockId || !emoji) {
				print(red("Usage: chat react <id> <msgBlockId> <emoji>"));
				break;
			}
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			try {
				await ctx.dispatchProgram("/comment", "react", [{
					objectId: id, message_block_id: targetBlockId, emoji,
				}]);
				print(dim("reacted ") + emoji);
			} catch (err: any) { print(red("Error: ") + (err?.message ?? String(err))); }
			break;
		}
		default: {
			print([
				bold("  Chat") + dim(" — chat-room surface around /comment"),
				`    ${cyan("chat new")}   ${dim("[name]")}                  create a chat room`,
				`    ${cyan("chat send")}  ${dim("<id> <message...>")}       send a message`,
				`    ${cyan("chat read")}  ${dim("<id>")}                    read messages (legacy + new)`,
				`    ${cyan("chat reply")} ${dim("<id> <blockId> <msg>")}    reply to a message`,
				`    ${cyan("chat react")} ${dim("<id> <blockId> <emoji>")}  react to a message`,
				"",
				dim(`  For comments on any non-chat object, use ${cyan("/comment")} directly.`),
			].join("\n"));
		}
	}
};

// Re-export the message constants so `chat` consumers know which CustomContent
// types belong to the discussion convention.
export { MESSAGE_CONTENT_TYPE, REACTION_CONTENT_TYPE };

const program: ProgramDef = { handler };
export default program;
