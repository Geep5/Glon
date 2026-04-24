/**
 * Gracie program tests.
 *
 * Exercises the driver:
 *   - bootstrap creates Gracie agent + self peer idempotently
 *   - ingest wraps message with peer identity before calling /agent.ask
 *   - say uses the principal peer as the caller
 *   - ensureBootstrapped rehydrates state from the store on a fresh actor
 *   - degrade gracefully when /peer isn't running (unknown peer → stranger)
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import gracieProgram from "../src/programs/handlers/gracie.js";
import peerProgram from "../src/programs/handlers/peer.js";
import { stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue } from "../src/proto.js";
import type { ProgramContext } from "../src/programs/runtime.js";

interface StoredObj {
	id: string;
	typeKey: string;
	fields: Record<string, any>;
	deleted: boolean;
}

interface AskCall { agentId: string; prompt: string; }

function createHarness(opts: { askImpl?: (agentId: string, prompt: string) => string } = {}) {
	const objects = new Map<string, StoredObj>();
	const askCalls: AskCall[] = [];
	const toolRegistrations: { agentId: string; spec: any }[] = [];
	let nextId = 1;

	const askImpl = opts.askImpl ?? ((_id: string, prompt: string) => `Response to: ${prompt}`);

	function actorFor(id: string) {
		return {
			setField: async (key: string, valueJson: string) => {
				const obj = objects.get(id);
				if (!obj) throw new Error(`no object ${id}`);
				obj.fields[key] = JSON.parse(valueJson);
			},
			setFields: async (fieldsJson: string) => {
				const obj = objects.get(id);
				if (!obj) throw new Error(`no object ${id}`);
				Object.assign(obj.fields, JSON.parse(fieldsJson));
			},
			markDeleted: async () => {
				const obj = objects.get(id);
				if (obj) obj.deleted = true;
			},
			addBlock: async () => { /* unused */ },
			setContent: async () => { /* unused */ },
		};
	}

	const store = {
		get: async (id: string) => {
			const o = objects.get(id);
			if (!o) return null;
			return {
				id,
				typeKey: o.typeKey,
				fields: o.fields,
				deleted: o.deleted,
				blocks: [],
				blockProvenance: {},
				content: "",
				createdAt: 0,
				updatedAt: 0,
				headIds: [],
				changeCount: 0,
			};
		},
		create: async (typeKey: string, fieldsJson: string) => {
			const id = `${typeKey}-${nextId++}`;
			objects.set(id, { id, typeKey, fields: fieldsJson ? JSON.parse(fieldsJson) : {}, deleted: false });
			return id;
		},
		list: async (typeKey?: string) => {
			const refs: { id: string; typeKey: string }[] = [];
			for (const o of objects.values()) {
				if (typeKey && o.typeKey !== typeKey) continue;
				refs.push({ id: o.id, typeKey: o.typeKey });
			}
			return refs;
		},
	};

	const client = {
		objectActor: { getOrCreate: (args: string[]) => actorFor(args[0]) },
	};

	// Build a base ctx factory. We then layer program-specific ctx for
	// dispatchProgram by re-using the base with per-call state.
	function buildCtx(overrides: Partial<ProgramContext> = {}): ProgramContext {
		return {
			client,
			store,
			resolveId: async (prefix: string) => {
				for (const k of objects.keys()) if (k === prefix || k.startsWith(prefix)) return k;
				return null;
			},
			stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue,
			listChangeFiles: () => [],
			readChangeByHex: () => null,
			hexEncode: () => "",
			print: () => {},
			randomUUID: () => `uuid-${nextId++}`,
			state: {},
			emit: () => {},
			programId: "test",
			objectActor: (id: string) => actorFor(id),
			dispatchProgram: async (prefix, action, args) => {
				if (prefix === "/peer") {
					const peerCtx = buildCtx({ state: {}, programId: "test-peer" });
					const fn = peerProgram.actor!.actions![action];
					if (!fn) throw new Error(`no /peer action ${action}`);
					return fn(peerCtx, ...(args as any[]));
				}
				if (prefix === "/agent" && action === "ask") {
					const [agentId, prompt] = args as [string, string];
					askCalls.push({ agentId, prompt });
					const finalText = askImpl(agentId, prompt);
					return {
						finalText,
						iterations: 1,
						toolCalls: 0,
						inputTokens: 10,
						outputTokens: 20,
					};
				}
				if (prefix === "/agent" && action === "registerTool") {
					const [agentId, specJson] = args as [string, string];
					toolRegistrations.push({ agentId, spec: JSON.parse(specJson) });
					return "registered (mock)";
				}
				throw new Error(`unhandled dispatch ${prefix} ${action}`);
			},
			...overrides,
		};
	}

	// Gracie's own actor state and ctx.
	const gracieState: Record<string, any> = gracieProgram.actor!.createState!();
	const gracieCtx = buildCtx({ state: gracieState, programId: "test-gracie" });

	return { ctx: gracieCtx, state: gracieState, objects, askCalls, toolRegistrations, buildCtx };
}

describe("gracie bootstrap", () => {
	it("creates Gracie agent and self peer on first setup", async () => {
		const h = createHarness();
		const bootstrap = gracieProgram.actor!.actions!.bootstrap;
		const result = await bootstrap(h.ctx, { grantName: "Grant" }) as {
			gracieAgentId: string;
			principalPeerId: string;
			createdAgent: boolean;
			createdPeer: boolean;
		};

		assert.equal(result.createdAgent, true);
		assert.equal(result.createdPeer, true);
		assert.ok(result.gracieAgentId);
		assert.ok(result.principalPeerId);

		const agent = h.objects.get(result.gracieAgentId)!;
		assert.equal(agent.typeKey, "agent");
		assert.equal(agent.fields.name.stringValue, "Gracie");
		assert.ok(agent.fields.system.stringValue.length > 100, "system prompt should be populated");
		// agent.principal should link to grant's peer
		assert.equal(agent.fields.principal.linkValue.targetId, result.principalPeerId);

		const peer = h.objects.get(result.principalPeerId)!;
		assert.equal(peer.typeKey, "peer");
		assert.equal(peer.fields.display_name.stringValue, "Grant");
		assert.equal(peer.fields.kind.stringValue, "self");
		assert.equal(peer.fields.trust_level.stringValue, "self");

		// Actor state cached
		assert.equal(h.state.gracieAgentId, result.gracieAgentId);
		assert.equal(h.state.principalPeerId, result.principalPeerId);
	});

	it("is idempotent: second bootstrap reuses existing objects", async () => {
		const h = createHarness();
		const bootstrap = gracieProgram.actor!.actions!.bootstrap;
		const first = await bootstrap(h.ctx, {}) as { gracieAgentId: string; principalPeerId: string };
		const sizeBefore = h.objects.size;
		const second = await bootstrap(h.ctx, {}) as {
			gracieAgentId: string; principalPeerId: string;
			createdAgent: boolean; createdPeer: boolean;
		};
		assert.equal(second.createdAgent, false);
		assert.equal(second.createdPeer, false);
		assert.equal(second.gracieAgentId, first.gracieAgentId);
		assert.equal(second.principalPeerId, first.principalPeerId);
		assert.equal(h.objects.size, sizeBefore, "no new objects on second bootstrap");
	});

	it("applies custom system prompt, model, grant fields", async () => {
		const h = createHarness();
		const bootstrap = gracieProgram.actor!.actions!.bootstrap;
		const result = await bootstrap(h.ctx, {
			systemPrompt: "custom prompt",
			model: "claude-haiku-4-20250414",
			grantName: "Grant F",
			grantDiscordId: "111222",
			grantEmail: "grant@example.com",
		}) as { gracieAgentId: string; principalPeerId: string };

		const agent = h.objects.get(result.gracieAgentId)!;
		assert.equal(agent.fields.system.stringValue, "custom prompt");
		assert.equal(agent.fields.model.stringValue, "claude-haiku-4-20250414");

		const peer = h.objects.get(result.principalPeerId)!;
		assert.equal(peer.fields.display_name.stringValue, "Grant F");
		assert.equal(peer.fields.discord_id.stringValue, "111222");
		assert.equal(peer.fields.email.stringValue, "grant@example.com");
	});
});

describe("gracie ingest + say", () => {
	it("ingest wraps the message with peer identity and calls /agent.ask", async () => {
		const h = createHarness({
			askImpl: (_id, prompt) => `echo: ${prompt}`,
		});
		const bootstrap = gracieProgram.actor!.actions!.bootstrap;
		await bootstrap(h.ctx, {});

		// Add a peer that isn't Grant.
		const peerAdd = peerProgram.actor!.actions!.add;
		const peerCtx = h.buildCtx({ state: {}, programId: "test-peer" });
		const momId = await peerAdd(peerCtx, {
			display_name: "Mom",
			kind: "human",
			trust_level: "family",
			email: "mom@example.com",
		}) as string;

		const ingest = gracieProgram.actor!.actions!.ingest;
		const result = await ingest(h.ctx, "email", momId, "Happy birthday!") as {
			finalText: string; peer: { display_name: string; trust_level: string };
		};

		assert.equal(h.askCalls.length, 1);
		assert.equal(h.askCalls[0].agentId, h.state.gracieAgentId);
		assert.equal(
			h.askCalls[0].prompt,
			"[from Mom on email, trust=family] Happy birthday!",
		);
		assert.equal(result.peer.display_name, "Mom");
		assert.equal(result.peer.trust_level, "family");
		assert.match(result.finalText, /Happy birthday/);
	});

	it("say uses the principal peer as the caller", async () => {
		const h = createHarness({ askImpl: (_id, p) => `got: ${p}` });
		const bootstrap = gracieProgram.actor!.actions!.bootstrap;
		await bootstrap(h.ctx, { grantName: "Grant" });

		const say = gracieProgram.actor!.actions!.say;
		const result = await say(h.ctx, "what's on today?") as {
			finalText: string; peer: { display_name: string; trust_level: string };
		};

		assert.equal(h.askCalls.length, 1);
		assert.equal(
			h.askCalls[0].prompt,
			"[from Grant on shell, trust=self] what's on today?",
		);
		assert.equal(result.peer.trust_level, "self");
		assert.match(result.finalText, /what's on today/);
	});

	it("degrades to stranger when the peer id is unknown", async () => {
		const h = createHarness();
		const bootstrap = gracieProgram.actor!.actions!.bootstrap;
		await bootstrap(h.ctx, {});

		const ingest = gracieProgram.actor!.actions!.ingest;
		const result = await ingest(h.ctx, "email", "unknown-peer-id-zzz", "hi") as {
			peer: { trust_level: string; display_name: string };
		};

		// No peer record, but ingest still completes with a stranger snapshot.
		assert.equal(result.peer.trust_level, "stranger");
		assert.match(h.askCalls[0].prompt, /trust=stranger/);
	});

	it("ingest before bootstrap throws a clear error", async () => {
		const h = createHarness();
		const ingest = gracieProgram.actor!.actions!.ingest;
		await assert.rejects(
			() => ingest(h.ctx, "shell", "anyone", "hi"),
			/not bootstrapped/,
		);
	});
});

describe("gracie actor-state rehydration", () => {
	it("ensureBootstrapped reconstitutes state on a fresh actor from store objects", async () => {
		const h = createHarness();
		const bootstrap = gracieProgram.actor!.actions!.bootstrap;
		const first = await bootstrap(h.ctx, {}) as { gracieAgentId: string; principalPeerId: string };

		// Simulate an actor restart: new empty state, same store objects.
		const freshState: Record<string, any> = gracieProgram.actor!.createState!();
		const freshCtx = h.buildCtx({ state: freshState, programId: "test-gracie-restart" });
		const status = gracieProgram.actor!.actions!.status;
		const result = await status(freshCtx) as { gracieAgentId: string; principalPeerId: string };

		assert.equal(result.gracieAgentId, first.gracieAgentId);
		assert.equal(result.principalPeerId, first.principalPeerId);
		// State cache was populated.
		assert.equal(freshState.gracieAgentId, first.gracieAgentId);
		assert.equal(freshState.principalPeerId, first.principalPeerId);
	});
});

describe("gracie tool auto-wiring", () => {
	it("setup registers the expected tools on the agent", async () => {
		const h = createHarness();
		const bootstrap = gracieProgram.actor!.actions!.bootstrap;
		const result = await bootstrap(h.ctx, {}) as { gracieAgentId: string; wiredTools: string[]; skippedTools: { name: string; reason: string }[] };

		const expected = [
			"peer_list", "peer_get", "peer_add", "peer_set_trust",
			"discord_send",
			"remind_schedule", "remind_list", "remind_cancel",
			"object_list", "object_get", "object_read_source", "object_search",
			"object_history", "object_links",
			"object_create", "object_set_field", "object_delete_field",
			"object_set_content", "object_remove", "object_add_block",
			"web_fetch", "web_get_text", "web_get_json",
			// Phase 1 memory tools (bound_args owner = gracieAgentId)
			"memory_upsert_fact", "memory_list_facts",
			"memory_upsert_milestone", "memory_amend_milestone",
			"memory_list_milestones", "memory_get_milestone",
			"memory_recall",
			// Google Workspace tools (via /google → gws CLI)
			"google_calendar_agenda", "google_calendar_list_events",
			"google_calendar_insert", "google_calendar_delete_event",
			"google_gmail_triage", "google_gmail_search", "google_gmail_read",
			"google_gmail_send", "google_gmail_reply",
			"google_drive_search", "google_drive_get",
			"google_sheets_read", "google_sheets_append",
			"google_docs_get", "google_docs_write",
			// Shell tools (via /shell → persistent bash)
			"shell_exec", "shell_sessions", "shell_kill",
			// Subagent spawning (M2)
			"spawn",
		];
		assert.deepEqual([...result.wiredTools].sort(), [...expected].sort());
		assert.equal(result.skippedTools.length, 0);
		assert.equal(h.toolRegistrations.length, expected.length);
		for (const reg of h.toolRegistrations) {
			assert.equal(reg.agentId, result.gracieAgentId);
			assert.ok(reg.spec.name);
			assert.ok(reg.spec.input_schema);
			assert.ok(reg.spec.target_prefix);
			assert.ok(reg.spec.target_action);
		}
	});

	it("skipped tools are reported when registerTool fails (e.g. unavailable agent)", async () => {
		const h = createHarness();
		// Override the dispatch mock so registerTool always throws.
		const brokenCtx = h.buildCtx({
			state: h.state,
			programId: "test-gracie",
			dispatchProgram: async (prefix, action, args) => {
				if (prefix === "/peer") return h.ctx.dispatchProgram(prefix, action, args);
				if (prefix === "/agent" && action === "registerTool") {
					throw new Error("no /agent running");
				}
				throw new Error(`unhandled ${prefix} ${action}`);
			},
		});
		const bootstrap = gracieProgram.actor!.actions!.bootstrap;
		const result = await bootstrap(brokenCtx, {}) as { wiredTools: string[]; skippedTools: any[] };
		assert.equal(result.wiredTools.length, 0);
		assert.ok(result.skippedTools.length >= 1);
		for (const s of result.skippedTools) {
			assert.match(s.reason, /no \/agent running/);
		}
	});

	it("re-setup does not duplicate registrations (registerTool is idempotent by tool name)", async () => {
		const h = createHarness();
		const bootstrap = gracieProgram.actor!.actions!.bootstrap;
		const first = await bootstrap(h.ctx, {}) as { gracieAgentId: string; wiredTools: string[] };
		const registrationsAfterFirst = h.toolRegistrations.length;
		const second = await bootstrap(h.ctx, {}) as { gracieAgentId: string; wiredTools: string[]; createdAgent: boolean };

		// Both runs attempt to register (so total registration calls double),
		// but the agent fields end up with the same set of tool names.
		assert.equal(second.createdAgent, false);
		assert.equal(second.gracieAgentId, first.gracieAgentId);
		assert.equal(h.toolRegistrations.length, registrationsAfterFirst * 2);
		// Every registration targets the same agent.
		for (const reg of h.toolRegistrations) {
			assert.equal(reg.agentId, first.gracieAgentId);
		}
	});

});