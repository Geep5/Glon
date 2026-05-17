// transport-http — send payloads via HTTP POST.
//
// Address format: `https://host:port/path` or `http://host:port/path`
//
// Fail-fast: throws on non-2xx responses.

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import { dim, bold, cyan, red, green } from "../shared.js";

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print } = ctx;
	if (cmd === "status") {
		print(bold("  transport-http"));
		print(dim("    Sends POST requests with base64 payload."));
		return;
	}
	print([
		bold("  transport-http") + dim(" — HTTP POST transport"),
		`    ${cyan("transport-http status")}  show status`,
		dim("    Address format: https://host:port/path"),
	].join("\n"));
};

const actorDef: ProgramActorDef = {
	createState: () => ({ sentCount: 0, failedCount: 0 }),
	typedActions: {
		send: {
			description: "Send a payload via HTTP POST. Throws on non-2xx.",
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
			handler: async (ctx, input: {
				endpoint: string;
				payload_b64: string;
				content_type: string;
				metadata?: Record<string, string>;
			}): Promise<{ delivery_id: string }> => {
				const url = input.endpoint;
				if (!url.startsWith("http://") && !url.startsWith("https://")) {
					throw new Error("transport-http: invalid endpoint (expected http:// or https://)");
				}

				const body = JSON.stringify({
					content_type: input.content_type,
					payload: input.payload_b64,
					metadata: input.metadata ?? {},
					sender_endpoint: "", // recipient fills this in
					received_at: Date.now(),
				});

				const resp = await fetch(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body,
				});

				if (!resp.ok) {
					throw new Error(`transport-http: POST ${url} failed: ${resp.status} ${resp.statusText}`);
				}

				const state = ctx.state as any;
				state.sentCount = (state.sentCount ?? 0) + 1;

				return { delivery_id: `http-${Date.now()}` };
			},
		},
		inbox_drain: {
			description: "HTTP transport has no local inbox drain. Inbound messages arrive via POST to the HTTP endpoint.",
			inputSchema: { type: "object", properties: {} },
			handler: async (_ctx) => {
				return [];
			},
		},
	},
};

const program: ProgramDef = { handler, actor: actorDef };
export default program;
