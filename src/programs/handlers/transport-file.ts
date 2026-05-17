// transport-file — simplest possible transport for Glon.
//
// Writes `.glonenv` files (raw protobuf TransportEnvelope) to a configurable
// outbox directory; reads them from a configurable inbox directory via `inbox_drain`.
// Address format: `file:///path/to/inbox`
//
// This is the test transport. Anything that works here works in
// principle through any transport.

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import { dim, bold, cyan, red, green } from "../shared.js";
import { encodeTransportEnvelope, decodeTransportEnvelope } from "../../proto.js";
import { writeFileSync, readFileSync, unlinkSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ── Config ───────────────────────────────────────────────────────

const DEFAULT_OUTBOX = join(process.cwd(), "transport-outbox");
const DEFAULT_INBOX = join(process.cwd(), "transport-inbox");

function getOutbox(): string {
	return process.env.GLON_TRANSPORT_FILE_OUTBOX ?? DEFAULT_OUTBOX;
}

function getInbox(): string {
	return process.env.GLON_TRANSPORT_FILE_INBOX ?? DEFAULT_INBOX;
}

// ── Handler (CLI) ────────────────────────────────────────────────

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print } = ctx;
	if (cmd === "status") {
		print(bold("  transport-file"));
		print(dim("    outbox: ") + getOutbox());
		print(dim("    inbox:  ") + getInbox());
		return;
	}
	print([
		bold("  transport-file") + dim(" — file-based transport (test/localhost)"),
		`    ${cyan("transport-file status")}  show inbox/outbox paths`,
		dim("    Set GLON_TRANSPORT_FILE_OUTBOX and GLON_TRANSPORT_FILE_INBOX to override."),
	].join("\n"));
};

// ── Actor (typed actions) ────────────────────────────────────────

interface IncomingBlob {
	from_endpoint: string;
	payload_b64: string;
	content_type: string;
	received_at: number;
	metadata: Record<string, string>;
}

const actorDef: ProgramActorDef = {
	createState: () => ({ drainedAt: 0 }),
	typedActions: {
		send: {
			description: "Send a payload to a remote endpoint via file write. Throws on delivery failure.",
			inputSchema: {
				type: "object",
				required: ["endpoint", "payload_b64", "content_type"],
				properties: {
					endpoint: { type: "string" },
					payload_b64: { type: "string" },
					content_type: { type: "string" },
					metadata: { type: "object" },
				},
			},
			handler: async (_ctx, input: {
				endpoint: string;
				payload_b64: string;
				content_type: string;
				metadata?: Record<string, string>;
			}): Promise<{ delivery_id: string }> => {
				const outbox = getOutbox();
				const inbox = input.endpoint.replace(/^file:\/\//, "");
				if (!inbox) throw new Error("transport-file: invalid endpoint (expected file:///path)");

				if (!existsSync(outbox)) mkdirSync(outbox, { recursive: true });
				if (!existsSync(inbox)) mkdirSync(inbox, { recursive: true });

				const filename = `${Date.now()}-${randomUUID().slice(0, 8)}.glonenv`;
				const filepath = join(inbox, filename);

				const envelope = {
					contentType: input.content_type,
					payload: Buffer.from(input.payload_b64, "base64"),
					senderPubkey: new Uint8Array(0),
					metadata: input.metadata ?? {},
				};

				const bytes = encodeTransportEnvelope(envelope);
				writeFileSync(filepath, Buffer.from(bytes));
				return { delivery_id: filename };
			},
		},
		inbox_drain: {
			description: "Drain pending received blobs from the inbox directory.",
			inputSchema: { type: "object", properties: {} },
			handler: async (ctx): Promise<IncomingBlob[]> => {
				const inbox = getInbox();
				if (!existsSync(inbox)) return [];

				const files = readdirSync(inbox).filter((f) => f.endsWith(".glonenv"));
				const outbox = getOutbox();
				const results: IncomingBlob[] = [];

				for (const file of files) {
					const filepath = join(inbox, file);
					try {
						const raw = readFileSync(filepath);
						const envelope = decodeTransportEnvelope(new Uint8Array(raw));
						results.push({
							from_endpoint: `file://${outbox}`,
							payload_b64: Buffer.from(raw).toString("base64"),
							content_type: envelope.contentType ?? "",
							received_at: Date.now(),
							metadata: envelope.metadata ?? {},
						});
						unlinkSync(filepath);
					} catch (err: any) {
						ctx.print?.(dim(`[transport-file] skipping malformed inbox file ${file}: ${err?.message}`));
						unlinkSync(filepath);
					}
				}
				return results;
			},
		},
	},
};

const program: ProgramDef = { handler, actor: actorDef };
export default program;
