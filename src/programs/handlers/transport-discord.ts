// transport-discord — send payloads via Discord DM.
//
// Uses the existing /discord program's sendDM action.
// Address format: `discord://<user_id>`
//
// Payloads > 2000 chars are split into chunks.

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import { dim, bold, cyan, red, green } from "../shared.js";

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print } = ctx;
	if (cmd === "status") {
		print(bold("  transport-discord"));
		print(dim("    Uses /discord sendDM for delivery."));
		return;
	}
	print([
		bold("  transport-discord") + dim(" — Discord DM transport"),
		`    ${cyan("transport-discord status")}  show status`,
		dim("    Address format: discord://<user_id>"),
	].join("\n"));
};

const actorDef: ProgramActorDef = {
	createState: () => ({ sentCount: 0 }),
	typedActions: {
		send: {
			description: "Send a payload to a Discord user via DM.",
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
				const userId = input.endpoint.replace(/^discord:\/\//, "");
				if (!userId) throw new Error("transport-discord: invalid endpoint (expected discord://<user_id>)");

				const { dispatchProgram } = ctx;

				// Build a compact message with metadata
				const meta = input.metadata ?? {};
				const header = [
					`📨 **Glon Transport**`,
					`type: \`${input.content_type}\``,
					`payload: ${input.payload_b64.slice(0, 40)}... (${input.payload_b64.length} chars)`,
					Object.entries(meta).map(([k, v]) => `${k}: ${v}`).join("\n"),
				].filter(Boolean).join("\n");

				const chunks = header.match(/[\s\S]{1,1900}/g) ?? [header];
				for (const chunk of chunks) {
					await dispatchProgram("/discord", "sendDM", [{
						recipientId: userId,
						content: chunk,
					}]);
				}

				const state = ctx.state as any;
				state.sentCount = (state.sentCount ?? 0) + 1;

				return { delivery_id: `discord-${userId}-${Date.now()}` };
			},
		},
		inbox_drain: {
			description: "Discord has no inbox drain — messages are received via the Discord gateway and handled by the /discord program.",
			inputSchema: { type: "object", properties: {} },
			handler: async (_ctx) => {
				// Discord transport is push-only from this side.
				// Inbound messages are handled by the /discord program's gateway listener.
				return [];
			},
		},
	},
};

const program: ProgramDef = { handler, actor: actorDef };
export default program;
