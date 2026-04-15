// Chat — a program that runs on Glon.
import type { ProgramDef, ProgramContext } from "../runtime.js";

// ANSI colors
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

function dim(s: string) { return `${DIM}${s}${RESET}`; }
function bold(s: string) { return `${BOLD}${s}${RESET}`; }
function cyan(s: string) { return `${CYAN}${s}${RESET}`; }
function red(s: string) { return `${RED}${s}${RESET}`; }
function green(s: string) { return `${GREEN}${s}${RESET}`; }

// === Helpers ===

function extractString(v: any) {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v;
  if (v.stringValue !== undefined) return v.stringValue;
  return undefined;
}

function formatTime(ts: number) {
  if (ts === 0) return "--:--";
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// === Message extraction ===

function extractMessages(blocks: any[], provenance: any, fields: any) {
  const messages: any[] = [];

  for (const block of blocks) {
    const text = block.content?.text?.text;
    if (text === undefined || text === null) continue;

    const prov = provenance[block.id];
    const author = prov?.author ?? "unknown";
    const timestamp = prov?.timestamp ?? 0;

    // Reply-to: field key is `reply:<blockId>`, value is a proto Value or plain string.
    const replyRaw = fields[`reply:${block.id}`];
    let replyToId;
    if (replyRaw !== undefined && replyRaw !== null) {
      replyToId = typeof replyRaw === "string"
        ? replyRaw
        : replyRaw.stringValue ?? undefined;
    }

    messages.push({ blockId: block.id, text, author, timestamp, replyToId });
  }

  messages.sort((a: any, b: any) => a.timestamp - b.timestamp);
  return messages;
}

// === Rendering ===

function renderMessage(msg: any) {
  const time = dim(formatTime(msg.timestamp));
  const author = cyan(bold(msg.author));
  return `  ${time}  ${author}  ${msg.text}`;
}

function renderChat(messages: any[], roomName: string | undefined) {
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

// === Command dispatch ===

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
  const { client, store, resolveId, stringVal, print, randomUUID } = ctx as any;

  switch (cmd) {
    case "new": {
      const name = args.join(" ") || undefined;
      const fieldsJson = name ? JSON.stringify({ name: stringVal(name) }) : undefined;
      const id = await store.create("chat", fieldsJson);
      print(green("Chat room: ") + bold(id));
      print(dim("  chat send " + id.slice(0, 8) + " Hello!"));
      break;
    }

    case "send": {
      const raw = args[0];
      const messageText = args.slice(1).join(" ");
      if (!raw || !messageText) { print(red("Usage: chat send <id> <message...>")); break; }
      const id = await resolveId(raw);
      if (!id) { print(red("Not found: ") + raw); break; }
      const actor = client.objectActor.getOrCreate([id]);
      const blockId = randomUUID();
      const block = { id: blockId, childrenIds: [], content: { text: { text: messageText, style: 0 } } };
      await actor.addBlock(JSON.stringify(block));
      print(dim("sent ") + blockId.slice(0, 8));
      break;
    }

    case "read": {
      const raw = args[0];
      if (!raw) { print(red("Usage: chat read <id>")); break; }
      const id = await resolveId(raw);
      if (!id) { print(red("Not found: ") + raw); break; }
      const state = await store.get(id);
      if (!state) { print(red("Object not found")); break; }
      const roomName = extractString(state.fields["name"]);
      const messages = extractMessages(state.blocks, state.blockProvenance, state.fields);
      print(renderChat(messages, roomName));
      break;
    }

    case "reply": {
      const raw = args[0];
      const targetBlockId = args[1];
      const messageText = args.slice(2).join(" ");
      if (!raw || !targetBlockId || !messageText) {
        print(red("Usage: chat reply <id> <msgBlockId> <message...>"));
        break;
      }
      const id = await resolveId(raw);
      if (!id) { print(red("Not found: ") + raw); break; }
      const actor = client.objectActor.getOrCreate([id]);
      const blockId = randomUUID();
      const block = { id: blockId, childrenIds: [], content: { text: { text: messageText, style: 0 } } };
      await actor.addBlock(JSON.stringify(block));
      await actor.setField(`reply:${blockId}`, JSON.stringify(stringVal(targetBlockId)));
      print(dim("replied ") + blockId.slice(0, 8));
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
      const actor = client.objectActor.getOrCreate([id]);
      await actor.setField(`react:${targetBlockId}:${emoji}`, JSON.stringify(stringVal("local")));
      print(dim("reacted ") + emoji);
      break;
    }

    default: {
      print([
        bold("  Chat"),
        `    ${cyan("chat new")} ${dim("[name]")}                  create a chat room`,
        `    ${cyan("chat send")} ${dim("<id> <message...>")}     send a message`,
        `    ${cyan("chat read")} ${dim("<id>")}                   read messages`,
        `    ${cyan("chat reply")} ${dim("<id> <blockId> <msg>")}  reply to a message`,
        `    ${cyan("chat react")} ${dim("<id> <blockId> <emoji>")} react to a message`,
      ].join("\n"));
    }
  }
};

const program: ProgramDef = { handler };
export default program;
