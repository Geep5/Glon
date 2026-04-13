/**
 * IPC (Inter-Process Communication) program — messaging between objects.
 *
 * Allows objects to send and receive messages through their inbox/outbox
 * queues. Used for coordination between different actors in the system.
 */

import type { ProgramDef, ProgramContext } from "../runtime.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function dim(s: string): string { return `${DIM}${s}${RESET}`; }
function bold(s: string): string { return `${BOLD}${s}${RESET}`; }
function cyan(s: string): string { return `${CYAN}${s}${RESET}`; }
function green(s: string): string { return `${GREEN}${s}${RESET}`; }
function red(s: string): string { return `${RED}${s}${RESET}`; }

async function cmdSend(args: string[], ctx: ProgramContext): Promise<void> {
	if (args.length < 3) {
		ctx.print(red("Usage: /ipc send <from-id> <to-id> <action> [payload]"));
		return;
	}
	const [rawFrom, rawTo, action, ...rest] = args;
	const payload = rest.join(" ");

	const fromId = await ctx.resolveId(rawFrom);
	if (!fromId) {
		ctx.print(red("Sender not found: ") + rawFrom);
		return;
	}
	const toId = await ctx.resolveId(rawTo);
	if (!toId) {
		ctx.print(red("Receiver not found: ") + rawTo);
		return;
	}

	const sender = ctx.objectActor(fromId);
	await sender.sendMessage(toId, action, payload);

	const receiver = ctx.objectActor(toId);
	await receiver.receiveMessage(fromId, action, payload, Date.now());

	ctx.print(green("Sent: ") + `${action} from ${dim(fromId.slice(0, 12))} → ${dim(toId.slice(0, 12))}`);
}

async function cmdInbox(args: string[], ctx: ProgramContext): Promise<void> {
	const raw = args[0];
	if (!raw) {
		ctx.print(red("Usage: /ipc inbox <id>"));
		return;
	}
	const id = await ctx.resolveId(raw);
	if (!id) {
		ctx.print(red("Not found: ") + raw);
		return;
	}
	const objActor = ctx.objectActor(id);
	const msgs = await objActor.getInbox();
	if (msgs.length === 0) {
		ctx.print(dim("(empty inbox)"));
		return;
	}
	for (const m of msgs) {
		const ts = new Date(m.timestamp).toISOString();
		ctx.print(
			dim(ts.slice(11, 19)) + "  " +
			cyan(m.action.padEnd(14)) +
			"from " + dim(m.fromId.slice(0, 12)) +
			(m.payload ? "  " + m.payload.slice(0, 60) : ""),
		);
	}
	ctx.print(dim(`\n${msgs.length} message(s)`));
}

async function cmdOutbox(args: string[], ctx: ProgramContext): Promise<void> {
	const raw = args[0];
	if (!raw) {
		ctx.print(red("Usage: /ipc outbox <id>"));
		return;
	}
	const id = await ctx.resolveId(raw);
	if (!id) {
		ctx.print(red("Not found: ") + raw);
		return;
	}
	const objActor = ctx.objectActor(id);
	const msgs = await objActor.getOutbox();
	if (msgs.length === 0) {
		ctx.print(dim("(empty outbox)"));
		return;
	}
	for (const m of msgs) {
		const ts = new Date(m.timestamp).toISOString();
		ctx.print(
			dim(ts.slice(11, 19)) + "  " +
			cyan(m.action.padEnd(14)) +
			"to " + dim(m.toId.slice(0, 12)) +
			(m.payload ? "  " + m.payload.slice(0, 60) : ""),
		);
	}
	ctx.print(dim(`\n${msgs.length} message(s)`));
}

async function cmdClear(args: string[], ctx: ProgramContext): Promise<void> {
	const [raw, box] = args;
	if (!raw || (box !== "inbox" && box !== "outbox")) {
		ctx.print(red("Usage: /ipc clear <id> inbox|outbox"));
		return;
	}
	const id = await ctx.resolveId(raw);
	if (!id) {
		ctx.print(red("Not found: ") + raw);
		return;
	}
	const objActor = ctx.objectActor(id);

	if (box === "inbox") {
		await objActor.clearInbox();
		ctx.print(green("Cleared inbox for ") + id);
	} else {
		await objActor.clearOutbox();
		ctx.print(green("Cleared outbox for ") + id);
	}
}

const programDef: ProgramDef = {
	handler: async (cmd: string, args: string[], ctx: ProgramContext) => {
		switch (cmd) {
			case "send": await cmdSend(args, ctx); break;
			case "inbox": await cmdInbox(args, ctx); break;
			case "outbox": await cmdOutbox(args, ctx); break;
			case "clear": await cmdClear(args, ctx); break;
			default:
				ctx.print(`Unknown command: ${cmd}`);
				ctx.print("Commands: send, inbox, outbox, clear");
		}
	},
};

export default programDef;