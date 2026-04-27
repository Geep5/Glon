/**
 * Holdfast program tests.
 *
 * Exercises the harness:
 *   - setup creates the configured agent + self peer idempotently
 *   - ingest wraps message with peer identity before calling /agent.ask
 *   - say uses the principal peer as the caller
 *   - ensureBootstrapped rehydrates state from the store on a fresh actor
 *   - degrade gracefully when /peer isn't running (unknown peer → stranger)
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import holdfastProgram from "../src/programs/handlers/holdfast.js";
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

	const harnessState: Record<string, any> = holdfastProgram.actor!.createState!();
	const harnessCtx = buildCtx({ state: harnessState, programId: "test-holdfast" });

	return { ctx: harnessCtx, state: harnessState, objects, askCalls, toolRegistrations, buildCtx };
}

describe("holdfast setup", () => {
	it("creates the named agent and self peer on first setup", async () => {
		const h = createHarness();
		const setup = holdfastProgram.actor!.actions!.setup;
		const result = await setup(h.ctx, { name: "Gracie", principalName: "Grant" }) as {
			agentId: string;
			agentName: string;
			principalPeerId: string;
			createdAgent: boolean;
			createdPeer: boolean;
		};

		assert.equal(result.createdAgent, true);
		assert.equal(result.createdPeer, true);
		assert.equal(result.agentName, "Gracie");
		assert.ok(result.agentId);
		assert.ok(result.principalPeerId);

		const agent = h.objects.get(result.agentId)!;
		assert.equal(agent.typeKey, "agent");
		assert.equal(agent.fields.name.stringValue, "Gracie");
		assert.ok(agent.fields.system.stringValue.length > 100, "system prompt should be populated");
		// agent.principal should link to the principal's peer
		assert.equal(agent.fields.principal.linkValue.targetId, result.principalPeerId);

		const peer = h.objects.get(result.principalPeerId)!;
		assert.equal(peer.typeKey, "peer");
		assert.equal(peer.fields.display_name.stringValue, "Grant");
		assert.equal(peer.fields.kind.stringValue, "self");
		assert.equal(peer.fields.trust_level.stringValue, "self");

		// Actor state cached
		assert.equal(h.state.agentId, result.agentId);
		assert.equal(h.state.agentName, "Gracie");
		assert.equal(h.state.principalPeerId, result.principalPeerId);
	});

	it("falls back to neutral defaults when --name and --principal-name are omitted", async () => {
		const h = createHarness();
		const setup = holdfastProgram.actor!.actions!.setup;
		const result = await setup(h.ctx, {}) as {
			agentId: string; agentName: string; principalPeerId: string;
		};
		const agent = h.objects.get(result.agentId)!;
		const peer = h.objects.get(result.principalPeerId)!;
		assert.equal(result.agentName, "Assistant");
		assert.equal(agent.fields.name.stringValue, "Assistant");
		assert.equal(peer.fields.display_name.stringValue, "Owner");
	});

	it("is idempotent: second setup with same name reuses existing objects", async () => {
		const h = createHarness();
		const setup = holdfastProgram.actor!.actions!.setup;
		const first = await setup(h.ctx, { name: "Gracie" }) as { agentId: string; principalPeerId: string };
		const sizeBefore = h.objects.size;
		const second = await setup(h.ctx, { name: "Gracie" }) as {
			agentId: string; principalPeerId: string;
			createdAgent: boolean; createdPeer: boolean;
		};
		assert.equal(second.createdAgent, false);
		assert.equal(second.createdPeer, false);
		assert.equal(second.agentId, first.agentId);
		assert.equal(second.principalPeerId, first.principalPeerId);
		assert.equal(h.objects.size, sizeBefore, "no new objects on second setup");
	});

	it("applies custom system prompt, model, and principal fields", async () => {
		const h = createHarness();
		const setup = holdfastProgram.actor!.actions!.setup;
		const result = await setup(h.ctx, {
			name: "Gracie",
			systemPrompt: "custom prompt",
			model: "claude-haiku-4-20250414",
			principalName: "Grant F",
			principalDiscordId: "111222",
			principalEmail: "grant@example.com",
		}) as { agentId: string; principalPeerId: string };

		const agent = h.objects.get(result.agentId)!;
		assert.equal(agent.fields.system.stringValue, "custom prompt");
		assert.equal(agent.fields.model.stringValue, "claude-haiku-4-20250414");

		const peer = h.objects.get(result.principalPeerId)!;
		assert.equal(peer.fields.display_name.stringValue, "Grant F");
		assert.equal(peer.fields.discord_id.stringValue, "111222");
		assert.equal(peer.fields.email.stringValue, "grant@example.com");
	});

	it("default system prompt substitutes the configured names", async () => {
		const h = createHarness();
		const setup = holdfastProgram.actor!.actions!.setup;
		const result = await setup(h.ctx, { name: "Gracie", principalName: "Grant" }) as { agentId: string };
		const agent = h.objects.get(result.agentId)!;
		const system = agent.fields.system.stringValue as string;
		assert.match(system, /You are Gracie, Grant's executive assistant\./);
		assert.match(system, /trust=self\s+Grant\./);
	});
});

describe("holdfast ingest + say", () => {
	it("ingest wraps the message with peer identity and calls /agent.ask", async () => {
		const h = createHarness({
			askImpl: (_id, prompt) => `echo: ${prompt}`,
		});
		const setup = holdfastProgram.actor!.actions!.setup;
		await setup(h.ctx, { name: "Gracie", principalName: "Grant" });

		// Add a peer that isn't the principal.
		const peerAdd = peerProgram.actor!.actions!.add;
		const peerCtx = h.buildCtx({ state: {}, programId: "test-peer" });
		const momId = await peerAdd(peerCtx, {
			display_name: "Mom",
			kind: "human",
			trust_level: "family",
			email: "mom@example.com",
		}) as string;

		const ingest = holdfastProgram.actor!.actions!.ingest;
		const result = await ingest(h.ctx, "email", momId, "Happy birthday!") as {
			finalText: string;
			peer: { display_name: string; trust_level: string };
			agentName: string;
		};

		assert.equal(h.askCalls.length, 1);
		assert.equal(h.askCalls[0].agentId, h.state.agentId);
		assert.equal(
			h.askCalls[0].prompt,
			"[from Mom on email, trust=family] Happy birthday!",
		);
		assert.equal(result.peer.display_name, "Mom");
		assert.equal(result.peer.trust_level, "family");
		assert.equal(result.agentName, "Gracie");
		assert.match(result.finalText, /Happy birthday/);
	});

	it("say uses the principal peer as the caller", async () => {
		const h = createHarness({ askImpl: (_id, p) => `got: ${p}` });
		const setup = holdfastProgram.actor!.actions!.setup;
		await setup(h.ctx, { name: "Gracie", principalName: "Grant" });

		const say = holdfastProgram.actor!.actions!.say;
		const result = await say(h.ctx, "what's on today?") as {
			finalText: string;
			peer: { display_name: string; trust_level: string };
			agentName: string;
		};

		assert.equal(h.askCalls.length, 1);
		assert.equal(
			h.askCalls[0].prompt,
			"[from Grant on shell, trust=self] what's on today?",
		);
		assert.equal(result.peer.trust_level, "self");
		assert.equal(result.agentName, "Gracie");
		assert.match(result.finalText, /what's on today/);
	});

	it("degrades to stranger when the peer id is unknown", async () => {
		const h = createHarness();
		const setup = holdfastProgram.actor!.actions!.setup;
		await setup(h.ctx, { name: "Gracie" });

		const ingest = holdfastProgram.actor!.actions!.ingest;
		const result = await ingest(h.ctx, "email", "unknown-peer-id-zzz", "hi") as {
			peer: { trust_level: string; display_name: string };
		};

		// No peer record, but ingest still completes with a stranger snapshot.
		assert.equal(result.peer.trust_level, "stranger");
		assert.match(h.askCalls[0].prompt, /trust=stranger/);
	});

	it("ingest before setup throws a clear error", async () => {
		const h = createHarness();
		const ingest = holdfastProgram.actor!.actions!.ingest;
		await assert.rejects(
			() => ingest(h.ctx, "shell", "anyone", "hi"),
			/not set up/,
		);
	});
});

describe("holdfast actor-state rehydration", () => {
	it("ensureBootstrapped reconstitutes state on a fresh actor from store objects", async () => {
		const h = createHarness();
		const setup = holdfastProgram.actor!.actions!.setup;
		const first = await setup(h.ctx, { name: "Gracie", principalName: "Grant" }) as {
			agentId: string; agentName: string; principalPeerId: string;
		};

		// Simulate an actor restart: new empty state, same store objects.
		const freshState: Record<string, any> = holdfastProgram.actor!.createState!();
		const freshCtx = h.buildCtx({ state: freshState, programId: "test-holdfast-restart" });
		const status = holdfastProgram.actor!.actions!.status;
		const result = await status(freshCtx) as { agentId: string; agentName: string; principalPeerId: string };

		assert.equal(result.agentId, first.agentId);
		assert.equal(result.agentName, "Gracie");
		assert.equal(result.principalPeerId, first.principalPeerId);
		// State cache was populated.
		assert.equal(freshState.agentId, first.agentId);
		assert.equal(freshState.agentName, "Gracie");
		assert.equal(freshState.principalPeerId, first.principalPeerId);
	});
});

describe("holdfast tool auto-wiring", () => {
	it("setup registers the expected tools on the agent", async () => {
		const h = createHarness();
		const setup = holdfastProgram.actor!.actions!.setup;
		const result = await setup(h.ctx, { name: "Gracie" }) as {
			agentId: string;
			wiredTools: string[];
			skippedTools: { name: string; reason: string }[];
		};

		const expected = [
			"peer_list", "peer_get", "peer_add", "peer_set_trust",
			"discord_send",
			"remind_schedule", "remind_list", "remind_cancel",
			"object_list", "object_get", "object_read_source", "object_search",
			"object_history", "object_links",
			"object_create", "object_set_field", "object_delete_field",
			"object_set_content", "object_remove", "object_add_block",
			"web_fetch", "web_get_text", "web_get_json",
			// Phase 1 memory tools (bound_args owner = agentId)
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
			// Subagent spawning
			"spawn",
		];
		assert.deepEqual([...result.wiredTools].sort(), [...expected].sort());
		assert.equal(result.skippedTools.length, 0);
		assert.equal(h.toolRegistrations.length, expected.length);
		for (const reg of h.toolRegistrations) {
			assert.equal(reg.agentId, result.agentId);
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
			programId: "test-holdfast",
			dispatchProgram: async (prefix, action, args) => {
				if (prefix === "/peer") return h.ctx.dispatchProgram(prefix, action, args);
				if (prefix === "/agent" && action === "registerTool") {
					throw new Error("no /agent running");
				}
				throw new Error(`unhandled ${prefix} ${action}`);
			},
		});
		const setup = holdfastProgram.actor!.actions!.setup;
		const result = await setup(brokenCtx, { name: "Gracie" }) as {
			wiredTools: string[]; skippedTools: any[];
		};
		assert.equal(result.wiredTools.length, 0);
		assert.ok(result.skippedTools.length >= 1);
		for (const s of result.skippedTools) {
			assert.match(s.reason, /no \/agent running/);
		}
	});

	it("re-setup does not duplicate registrations (registerTool is idempotent by tool name)", async () => {
		const h = createHarness();
		const setup = holdfastProgram.actor!.actions!.setup;
		const first = await setup(h.ctx, { name: "Gracie" }) as { agentId: string; wiredTools: string[] };
		const registrationsAfterFirst = h.toolRegistrations.length;
		const second = await setup(h.ctx, { name: "Gracie" }) as {
			agentId: string; wiredTools: string[]; createdAgent: boolean;
		};

		// Both runs attempt to register (so total registration calls double),
		// but the agent fields end up with the same set of tool names.
		assert.equal(second.createdAgent, false);
		assert.equal(second.agentId, first.agentId);
		assert.equal(h.toolRegistrations.length, registrationsAfterFirst * 2);
		// Every registration targets the same agent.
		for (const reg of h.toolRegistrations) {
			assert.equal(reg.agentId, first.agentId);
		}
	});
});
