// Gracie — Grant's executive-assistant driver program.
//
// Gracie's "brain" is a regular Glon agent object (via /agent). This program
// wraps that agent with:
//   - identity awareness (every message tagged with peer + source + trust)
//   - a principal peer (Grant) who drives `say`
//   - idempotent bootstrap that creates the agent + self peer on first setup
//     and reconstitutes actor state from the store on later wakes
//   - a uniform `ingest` action that bridges (Discord, email, etc.) will
//     call with (source, peerId, text)
//
// The actor holds only cache (gracieAgentId, principalPeerId). Truth lives
// in the DAG — name="Gracie" agent object and kind="self" peer object.
// If the process restarts, `ensureBootstrapped()` rehydrates from the store.

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import { spawnTool } from "./agent.js";

// ── ANSI ─────────────────────────────────────────────────────────

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const MAGENTA = "\x1b[35m";
const RESET = "\x1b[0m";

function dim(s: string) { return `${DIM}${s}${RESET}`; }
function bold(s: string) { return `${BOLD}${s}${RESET}`; }
function cyan(s: string) { return `${CYAN}${s}${RESET}`; }
function red(s: string) { return `${RED}${s}${RESET}`; }
function green(s: string) { return `${GREEN}${s}${RESET}`; }
function magenta(s: string) { return `${MAGENTA}${s}${RESET}`; }

// ── Constants ────────────────────────────────────────────────────

const DEFAULT_MODEL = "claude-sonnet-4-20250514";

const DEFAULT_SYSTEM_PROMPT = `You are Gracie, Grant Farwell's executive assistant.

You manage Grant's life: his calendar, his reminders, his communication with
family and trusted contacts, and his coordination with other agents.

## Identity awareness
Every message you receive is wrapped:
  [from {name} on {source}, trust={level}] {text}
Use the trust level to gate your behavior:

  trust=self      Grant. Full agency. Act decisively.
  trust=family    Inner circle. Act on their requests, but loop Grant in
                  before anything irreversible (spending money, booking,
                  sharing his schedule with outsiders).
  trust=ops       Operational contacts (work, FIG, vendors). Act on what
                  their role implies. When in doubt, ask.
  trust=stranger  Unknown. Reply politely: "I'll pass that along to Grant."
                  Do not call tools. Do not share Grant's information.

## Tone
Calm, specific, proactive but not chatty. Executive assistant, not friend.
Discord-friendly formatting: no markdown tables (Discord doesn't render
them); use bullet points or aligned code blocks.

## Time
Default to America/Los_Angeles unless told otherwise.

## Tools
When tools are registered on you, prefer them over asking Grant to do
things himself. Always be specific about what you did (event IDs, message
IDs, exact times) so Grant can audit or undo.

## Self-awareness and mutation
Your own implementation and state live as Glon objects in the same graph
you manage. Your source code is a set of \`typescript\` objects. Your
conversation (this one) is a set of blocks on your \`agent\` object. The
peers you can reach are \`peer\` objects. Everything is first-class data.

You can READ the graph with:
- object_list: find objects by type_key (program, peer, agent, reminder, typescript, ...)
- object_get: read one object's full state
- object_read_source: read the UTF-8 content of a source-file-like object
- object_search: text search across fields and content
- object_history: see every Change that has touched an object (who, when, which ops)
- object_links: see what an object links to and what links to it

You can MODIFY the graph with:
- object_create, object_set_field, object_delete_field, object_set_content, object_remove, object_add_block

Rules:
- Prefer the domain-specific tools (peer_add, remind_schedule, etc.) when they exist.
  They converge on the same DAG but carry proper validation.
- Every mutation is an immutable Change in the DAG. Nothing is truly destroyed;
  object_history shows prior values and you can restore them.
- Major self-mutations (your own system prompt, your own model, another peer's
  trust level, your own source code) MUST be announced to Grant before you do
  them. When in doubt, ask.
- When Grant says "show me your code", use object_list type_key=program to find
  /gracie, object_get it to read its manifest, and object_read_source on the
  manifest's typescript object. Cite object ids in your reply so Grant can verify.
- Questions about your own architecture, capabilities, current state, or how something
  works internally must be answered from the live DAG, not from this conversation.
  Your source code and agent object both change out of band; conversation history lags
  behind. On any such question:
    - For behavior / how code works: call object_read_source on the relevant handler
      (/discord, /gracie, /agent, /memory) before asserting.
    - For your own current state (model, system prompt, tools wired, compaction knobs,
      tokens used): call object_get on your own agent object (your gracieAgentId) and
      cite the exact field value you read.
  Treat prior claims in this conversation as hearsay until re-verified. Cite the object
  id(s) you read so Grant can audit. If you have not made a tool call this turn that
  produced the evidence, you do not know the answer — say so instead of guessing.

## Memory
Your conversation gets compacted when it grows too long. To keep facts and
decisions across compactions, write them to your memory store — those records
survive forever and sync between instances.

- memory_upsert_fact: pin an atomic fact about Grant or someone in his world.
  One row per \`key\`; upserting the same key replaces the value (the prior
  value stays in object_history). Use for: contact info, preferences, names,
  boundaries, persistent state. The store knows you're the owner; you don't
  pass \`owner\` — it's bound for you.
- memory_upsert_milestone: record a multi-turn arc — a project, a decision,
  a phase. \`supersedes\` is a list of milestone ids this one replaces or amends;
  prior milestones are auto-marked \`superseded\` (still readable for audit).
- memory_amend_milestone: edit fields on an existing milestone in place.
  Use this when you're correcting or extending an old milestone instead of
  writing a new one. Every amendment is a Change in that milestone's DAG.
- memory_recall: scoped lookup by query / topics / peers / time range.
- memory_list_facts, memory_list_milestones, memory_get_milestone: enumerate.

When to write:
- A fact you'd want to know in a fresh conversation → upsert_fact.
- An outcome, decision, or completed/blocked piece of work → upsert_milestone.
- A correction or follow-up to a prior milestone → amend_milestone, or a new
  milestone with \`supersedes=[<old_id>]\` if the change is large.

When to read:
- Before answering a question that may depend on prior context, call recall
  with a focused query. Cheaper than re-asking Grant.
- Memory is heuristic, not authoritative — if it conflicts with what Grant
  just told you, prefer Grant.

## Google Workspace (Calendar / Gmail / Drive / Sheets / Docs)
You have google_* tools that bridge to Grant's local gws CLI. Auth lives in
gws — you never see tokens. Use these for calendar, email, drive, sheets, docs.

Read-only: google_calendar_agenda, google_calendar_list_events,
google_gmail_triage, google_gmail_search, google_gmail_read, google_drive_search,
google_drive_get, google_sheets_read, google_docs_get.

Mutations (google_calendar_insert, google_calendar_delete_event, google_gmail_send,
google_gmail_reply, google_sheets_append, google_docs_write) require EITHER
dry_run=true (safe preview via gws --dry-run) OR confirmed=true (actual execution).
Calling them without either field is an error.

How to handle mutations:
- For anything irreversible or that involves other people (sending email, creating
  a calendar invite, deleting), first describe to Grant exactly what you'll do.
- Only call with confirmed=true after Grant explicitly approves.
- If you're unsure whether an action is fine, call with dry_run=true first to
  preview the exact request that would be sent, show Grant, then confirm.
- For trivial/self-only writes (appending a row to your own log sheet, writing
  to your own scratch doc), you can use confirmed=true directly but mention it.


## Shell access
You have shell_exec on Grant's machine. It's real bash — pipes, redirects, $VARS,
globs, backgrounding, everything works. Sessions persist cwd + env across calls,
so \`cd ~/projekt\` in one call sticks for the next call in the same session.

Use this when:
- You need a specific binary (git, npm, ffmpeg, jq, python, node, gcloud, etc.)
- You're exploring a repo or filesystem (ls, find, grep, cat, head, tree, tail)
- You're inspecting system state (ps, df, du, free, uname, uptime, who)
- You're running tests, builds, or deploys that Grant asked for

Rules of thumb:
- Trusted environment: no confirmation gate on shell_exec. But act like an
  executive assistant, not a script: announce destructive actions (rm, git push,
  kill -9, deploys, anything that changes external state) before running them.
- Prefer one composed command over many round-trips when it's natural —
  \`cd ~/projekt && git status && git log -3\` is one call, not three.
- Use distinct session names for parallel work (\`repo1\`, \`deploy\`, \`scratch\`).
  Default session is 'main'.
- If something hangs, shell_kill the session and start over.
- For Google Workspace operations, prefer the google_* tools over shelling out
  to \`gws\` — the typed actions are clearer and they gate dangerous mutations.


## Web access
You have HTTP tools: web_fetch (full control), web_get_text (GET + UTF-8),
web_get_json (GET + parsed JSON). Responses are capped at 16 KB by default;
request max_bytes up to 1_048_576 when you know you want a whole page. When you
report results, always cite the URL and status code, and surface if the body
was truncated. SSRF guard blocks localhost / private IPs (that's intentional —
don't try to probe internal services).`;

// ── Helpers ──────────────────────────────────────────────────────

function extractString(v: any): string | undefined {
	if (v === null || v === undefined) return undefined;
	if (typeof v === "string") return v;
	if (v.stringValue !== undefined) return v.stringValue;
	return undefined;
}

interface PeerSnapshot {
	id: string;
	display_name: string;
	trust_level: string;
	kind: string;
}

function formatIngestPrompt(peer: PeerSnapshot, source: string, text: string): string {
	return `[from ${peer.display_name} on ${source}, trust=${peer.trust_level}] ${text}`;
}

// ── Store lookups (reconstitute state from DAG) ──────────────────

async function findAgentByName(ctx: ProgramContext, name: string): Promise<string | null> {
	const store = ctx.store as any;
	const refs = await store.list("agent") as { id: string }[];
	for (const ref of refs) {
		const obj = await store.get(ref.id);
		if (obj?.deleted) continue;
		if (extractString(obj?.fields?.name) === name) return ref.id;
	}
	return null;
}

async function findSelfPeer(ctx: ProgramContext): Promise<string | null> {
	const store = ctx.store as any;
	const refs = await store.list("peer") as { id: string }[];
	for (const ref of refs) {
		const obj = await store.get(ref.id);
		if (obj?.deleted) continue;
		if (extractString(obj?.fields?.kind) === "self") return ref.id;
	}
	return null;
}

// ── Core operations ──────────────────────────────────────────────

interface BootstrapOpts {
	systemPrompt?: string;
	model?: string;
	grantName?: string;
	grantDiscordId?: string;
	grantEmail?: string;
}

interface BootstrapResult {
	gracieAgentId: string;
	principalPeerId: string;
	createdAgent: boolean;
	createdPeer: boolean;
	wiredTools: string[];
	skippedTools: { name: string; reason: string }[];
}

// ── Tool registry ────────────────────────────────────────────────
//
// Each entry is a ToolSpec in the shape /agent.registerTool expects.
// registerTool writes the spec to the agent's `tools` field regardless
// of whether the target program is running right now — it's cheap to
// register and Gracie's tool-use loop reports a clear "Program not
// running" error at call time if a target is unavailable.

interface ToolSpec {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
	target_prefix: string;
	target_action: string;
	/** Partial-application merged over the model's input — use to bind owner etc. */
	bound_args?: Record<string, unknown>;
}

const BASE_TOOLS: ToolSpec[] = [
	{
		name: "peer_list",
		description: "List all peers in Gracie's directory. Optionally filter by kind or trust_level.",
		input_schema: {
			type: "object",
			properties: {
				kind: { type: "string", description: "self | human | agent | service" },
				trust_level: { type: "string", description: "self | family | ops | stranger" },
			},
		},
		target_prefix: "/peer",
		target_action: "list",
	},
	{
		name: "peer_get",
		description: "Get full details for a peer by id. Useful when you need Grant's Discord id, Mom's email, etc.",
		input_schema: {
			type: "object",
			properties: { peer_id: { type: "string" } },
			required: ["peer_id"],
		},
		target_prefix: "/peer",
		target_action: "get",
	},
	{
		name: "peer_add",
		description: "Add a new peer (person or agent) to Gracie's directory. Use this when Grant introduces someone new. Defaults to kind=human, trust_level=stranger.",
		input_schema: {
			type: "object",
			properties: {
				display_name: { type: "string" },
				kind: { type: "string", enum: ["self", "human", "agent", "service"] },
				trust_level: { type: "string", enum: ["self", "family", "ops", "stranger"] },
				discord_id: { type: "string" },
				email: { type: "string" },
				notes: { type: "string" },
			},
			required: ["display_name"],
		},
		target_prefix: "/peer",
		target_action: "add",
	},
	{
		name: "peer_set_trust",
		description: "Change a peer's trust level. Only do this when explicitly asked by Grant — it changes what that peer can ask you to do.",
		input_schema: {
			type: "object",
			properties: {
				peer_id: { type: "string" },
				level: { type: "string", enum: ["self", "family", "ops", "stranger"] },
			},
			required: ["peer_id", "level"],
		},
		target_prefix: "/peer",
		target_action: "setTrust",
	},
	{
		name: "discord_send",
		description: "Send a Discord DM to a peer (who must have discord_id set). Use peer_list / peer_get to find the peer id.",
		input_schema: {
			type: "object",
			properties: {
				peer_id: { type: "string" },
				text: { type: "string" },
			},
			required: ["peer_id", "text"],
		},
		target_prefix: "/discord",
		target_action: "send",
	},
	{
		name: "remind_schedule",
		description: [
			"Schedule a future action. fire_at accepts ISO 8601 (2026-04-24T15:00:00) or relative shorthand (+10m, +2h, +30s).",
			"Channels:",
			"  - discord: payload {message: '...'} — Gracie sends exactly that text via DM.",
			"  - gracie_compose: payload {prompt: '...'} — when it fires, you get re-invoked with the prompt and compose a fresh message (use this when the message should reflect current state, e.g. 'remind Grant about dinner, check traffic first').",
			"  - email: payload {subject, body} — requires /mail program (not yet wired).",
		].join("\n"),
		input_schema: {
			type: "object",
			properties: {
				channel: { type: "string", enum: ["discord", "email", "gracie_compose"] },
				target: { type: "string", description: "peer_id for discord/gracie_compose; email address for email" },
				fire_at: { type: "string", description: "ISO 8601 datetime or +Ns/+Nm/+Nh" },
				payload: { type: "object", description: "channel-specific data" },
				note: { type: "string", description: "human-readable label" },
			},
			required: ["channel", "target", "fire_at", "payload"],
		},
		target_prefix: "/remind",
		target_action: "schedule",
	},
	{
		name: "remind_list",
		description: "List scheduled reminders. Filter by status (pending|sent|failed|cancelled), peer_id, channel, or before_iso (date cutoff).",
		input_schema: {
			type: "object",
			properties: {
				peer_id: { type: "string" },
				status: { type: "string" },
				channel: { type: "string" },
				before_iso: { type: "string" },
			},
		},
		target_prefix: "/remind",
		target_action: "list",
	},
	{
		name: "remind_cancel",
		description: "Cancel a pending reminder by id.",
		input_schema: {
			type: "object",
			properties: { reminder_id: { type: "string" } },
			required: ["reminder_id"],
		},
		target_prefix: "/remind",
		target_action: "cancel",
	},

	// ── Graph introspection (read) ──────────────────────────────────

	{
		name: "object_list",
		description: [
			"List Glon objects. Without filters, returns every object in the store.",
			"Common type_keys you can filter by:",
			"  - program   (running programs including /gracie, /agent, /peer, /discord, /remind)",
			"  - peer      (people and agents you talk to)",
			"  - agent     (LLM agent objects — 'Gracie' is one)",
			"  - reminder  (scheduled actions from /remind)",
			"  - typescript, proto, json, markdown (source files of the Glon environment itself)",
		].join("\n"),
		input_schema: {
			type: "object",
			properties: {
				type_key: { type: "string", description: "filter by type_key" },
				limit: { type: "number", description: "cap on results (default 100)" },
			},
		},
		target_prefix: "/crud",
		target_action: "list",
	},
	{
		name: "object_get",
		description: [
			"Read an object's full state: type_key, fields, block count, byte size, DAG heads.",
			"IMPORTANT: The returned payload is a summary. To get raw source code, ALWAYS use",
			"object_read_source with the object_id — do NOT decode the content/manifest fields yourself.",
			"For program objects, source lives in manifest.modules.<filename> as base64 inside a",
			"ValueMap; treat the manifest as opaque and read source via object_read_source on the",
			"typescript object it points at.",
		].join(" "),
		input_schema: {
			type: "object",
			properties: { object_id: { type: "string" } },
			required: ["object_id"],
		},
		target_prefix: "/crud",
		target_action: "get",
	},
	{
		name: "object_read_source",
		description: "Read the raw UTF-8 content of an object (source file, markdown, JSON, etc.). Truncates at max_bytes (default 16384, hard max 65536). Use this to inspect your own source code or read a file-like object.",
		input_schema: {
			type: "object",
			properties: {
				object_id: { type: "string" },
				max_bytes: { type: "number", description: "truncate beyond this size (default 16384)" },
			},
			required: ["object_id"],
		},
		target_prefix: "/crud",
		target_action: "readContent",
	},
	{
		name: "object_search",
		description: "Full-text search across object fields and content. Narrow with type_key when relevant.",
		input_schema: {
			type: "object",
			properties: {
				query: { type: "string" },
				type_key: { type: "string" },
				limit: { type: "number" },
			},
			required: ["query"],
		},
		target_prefix: "/crud",
		target_action: "search",
	},
	{
		name: "object_history",
		description: "Show the DAG history (every Change) of an object: who changed what and when. Use this to audit mutations or find a prior value to restore.",
		input_schema: {
			type: "object",
			properties: {
				object_id: { type: "string" },
				limit: { type: "number", description: "most recent N changes" },
			},
			required: ["object_id"],
		},
		target_prefix: "/inspect",
		target_action: "history",
	},
	{
		name: "object_links",
		description: "List the outgoing and incoming ObjectLink fields of an object. E.g. Gracie's agent has an outgoing 'principal' link to Grant's peer; Grant's peer has it inbound.",
		input_schema: {
			type: "object",
			properties: { object_id: { type: "string" } },
			required: ["object_id"],
		},
		target_prefix: "/graph",
		target_action: "links",
	},

	// ── Graph mutation (write) ───────────────────────────────────────
	// Every write produces a new Change in the DAG. Prior values remain
	// retrievable via object_history — nothing is truly destroyed.
	// Prefer domain-specific tools (peer_add, remind_schedule, etc.) when
	// they exist; reach for these only for general-purpose graph work.

	{
		name: "object_create",
		description: [
			"Create a new Glon object of the given type_key. fields is a {key: primitive|Value} map;",
			"content is optional UTF-8 text for plain file-like objects.",
			"Prefer peer_add / remind_schedule for domain objects — this is for novel types.",
			"IMPORTANT: type_key='program' objects have a specific structure Glon's runtime requires",
			"(manifest.modules.<filename> as a nested ValueMap of base64-encoded source). Do NOT try to",
			"create program objects with this tool — ask Grant to add the program to bootstrap.ts",
			"instead; it's the supported way to register new programs.",
		].join(" "),
		input_schema: {
			type: "object",
			properties: {
				type_key: { type: "string" },
				fields: { type: "object", description: "e.g. {name: 'foo', priority: 1}" },
				content: { type: "string", description: "UTF-8 content, optional" },
			},
			required: ["type_key"],
		},
		target_prefix: "/crud",
		target_action: "create",
	},
	{
		name: "object_set_field",
		description: [
			"Set a single field on an object. Value can be a plain string, number, boolean (auto-coerced),",
			"or a pre-built Value JSON.",
			"Major self-mutations (your own system prompt, your model, a peer's trust level) should be",
			"announced to Grant before you do them.",
			"DO NOT modify your own `tools` field directly with this — the ValueMap shape is easy to",
			"get wrong and will brick your tool access. If Grant wants you to gain a new capability,",
			"ask him to add it in the Gracie source so it auto-registers next setup.",
		].join(" "),
		input_schema: {
			type: "object",
			properties: {
				object_id: { type: "string" },
				key: { type: "string" },
				value: { description: "string | number | boolean | Value object" },
			},
			required: ["object_id", "key", "value"],
		},
		target_prefix: "/crud",
		target_action: "setField",
	},
	{
		name: "object_delete_field",
		description: "Remove a field from an object. History retains the prior value.",
		input_schema: {
			type: "object",
			properties: {
				object_id: { type: "string" },
				key: { type: "string" },
			},
			required: ["object_id", "key"],
		},
		target_prefix: "/crud",
		target_action: "deleteField",
	},
	{
		name: "object_set_content",
		description: "Replace the raw content of an object with new UTF-8 text. Use for editing source-file-like objects. History is preserved.",
		input_schema: {
			type: "object",
			properties: {
				object_id: { type: "string" },
				content: { type: "string", description: "UTF-8 content replacing the current bytes" },
			},
			required: ["object_id", "content"],
		},
		target_prefix: "/crud",
		target_action: "setContent",
	},
	{
		name: "object_remove",
		description: "Tombstone an object (sets deleted=true flag). Recoverable — it stays in the DAG and can be un-deleted by setting the flag back.",
		input_schema: {
			type: "object",
			properties: { object_id: { type: "string" } },
			required: ["object_id"],
		},
		target_prefix: "/crud",
		target_action: "remove",
	},
	{
		name: "object_add_block",
		description: "Append a block to an object. Primarily useful for injecting structured notes into agent conversations or adding messages to chat rooms. block must be a Glon Block shape: {id, childrenIds:[], content:{text:{text,style}} | {custom:{contentType,data,meta}}}.",
		input_schema: {
			type: "object",
			properties: {
				object_id: { type: "string" },
				block: { type: "object", description: "Glon Block shape" },
			},
			required: ["object_id", "block"],
		},
		target_prefix: "/crud",
		target_action: "addBlock",
	},

	// ── Web (HTTP) ────────────────────────────────────────────────
	// Shared primitive: any agent can opt in to web access. Default caps
	// are conservative (16 KB body, 30s timeout); increase max_bytes when
	// you know you want a full page. SSRF guard blocks localhost/private
	// IPs unless allow_internal=true (for testing only).

	{
		name: "web_fetch",
		description: [
			"Make an HTTP request. Returns {status, status_text, headers, body, bytes, truncated, url_fetched}.",
			"Always cite the URL and status in your reply. If truncated=true, tell Grant the full byte size.",
			"Default body cap is 16 KB; pass max_bytes up to 1_048_576 when you genuinely need the full page.",
		].join(" "),
		input_schema: {
			type: "object",
			properties: {
				url: { type: "string" },
				method: { type: "string", description: "GET | POST | PUT | PATCH | DELETE (default GET)" },
				headers: { type: "object", description: "header name → value" },
				body: { description: "string body; non-strings are JSON-stringified" },
				max_bytes: { type: "number", description: "truncate beyond this (default 16384, max 1048576)" },
				timeout_ms: { type: "number", description: "request timeout (default 30000, max 120000)" },
			},
			required: ["url"],
		},
		target_prefix: "/web",
		target_action: "fetch",
	},
	{
		name: "web_get_text",
		description: "Shorthand for an HTTP GET that returns UTF-8 text. Use for reading webpages, markdown, plain text. Default 16 KB cap.",
		input_schema: {
			type: "object",
			properties: {
				url: { type: "string" },
				max_bytes: { type: "number" },
				timeout_ms: { type: "number" },
			},
			required: ["url"],
		},
		target_prefix: "/web",
		target_action: "get_text",
	},
	{
		name: "web_get_json",
		description: "Shorthand for an HTTP GET that parses the response as JSON. Returns {status, json, parse_error?, truncated, url_fetched}. Use for APIs.",
		input_schema: {
			type: "object",
			properties: {
				url: { type: "string" },
				headers: { type: "object" },
				timeout_ms: { type: "number" },
			},
			required: ["url"],
		},
		target_prefix: "/web",
		target_action: "get_json",
	},
];

// ── Memory tools ─────────────────────────────────────────────────
//
// These bind `owner = gracieAgentId` so the model never handles its own id
// (and can't spoof a different one). All memory actions filter by owner.

function buildMemoryTools(gracieAgentId: string): ToolSpec[] {
	const owner = { owner: gracieAgentId };
	return [
		{
			name: "memory_upsert_fact",
			description: "Pin a durable fact you want to remember across compactions. One row per `key` — upserting the same key replaces the value (old value stays in object_history). Use for contact info, preferences, names, boundaries.",
			input_schema: {
				type: "object",
				properties: {
					key: { type: "string", description: "short identifier, e.g. 'grants_birthday' or 'moms_email'" },
					value: { type: "string" },
					confidence: { type: "string", enum: ["low", "med", "high"], description: "defaults to med" },
					sourced_from_block_id: { type: "string", description: "block id in this conversation where the fact came from (optional)" },
				},
				required: ["key", "value"],
			},
			target_prefix: "/memory",
			target_action: "upsert_fact",
			bound_args: owner,
		},
		{
			name: "memory_list_facts",
			description: "List your pinned facts. Optionally filter by `key`.",
			input_schema: {
				type: "object",
				properties: { key: { type: "string" } },
			},
			target_prefix: "/memory",
			target_action: "list_facts",
			bound_args: owner,
		},
		{
			name: "memory_upsert_milestone",
			description: [
				"Record a multi-turn arc: a project, decision, onboarding, phase — anything bigger than a single fact.",
				"Pass `supersedes: [id,...]` when this milestone replaces or amends older ones; they'll be auto-marked 'superseded' but stay readable.",
				"Use amend_milestone instead when editing an existing milestone in place (preferred for small corrections).",
			].join(" "),
			input_schema: {
				type: "object",
				properties: {
					title: { type: "string" },
					narrative: { type: "string", description: "prose — what happened, what was decided, what's next" },
					topics: { type: "array", items: { type: "string" }, description: "short tags for later recall" },
					peers: { type: "array", items: { type: "string" }, description: "peer ids involved" },
					supersedes: { type: "array", items: { type: "string" }, description: "milestone ids this replaces/amends" },
					status: { type: "string", enum: ["active", "completed", "superseded"], description: "defaults to active" },
					confidence: { type: "string", enum: ["low", "med", "high"] },
					sourced_from_blocks: { type: "array", items: { type: "string" }, description: "conversation block ids that informed this milestone" },
					started_at: { type: "number", description: "unix ms; when the arc began" },
					ended_at: { type: "number", description: "unix ms; when it ended (if it did)" },
				},
				required: ["title", "narrative"],
			},
			target_prefix: "/memory",
			target_action: "upsert_milestone",
			bound_args: owner,
		},
		{
			name: "memory_amend_milestone",
			description: "Edit fields on an existing milestone in place. Use when correcting or extending a past milestone; prior field values remain in object_history. Only pass fields you want to change.",
			input_schema: {
				type: "object",
				properties: {
					milestone_id: { type: "string" },
					title: { type: "string" },
					narrative: { type: "string" },
					topics: { type: "array", items: { type: "string" } },
					peers: { type: "array", items: { type: "string" } },
					supersedes: { type: "array", items: { type: "string" } },
					status: { type: "string", enum: ["active", "completed", "superseded"] },
					confidence: { type: "string", enum: ["low", "med", "high"] },
					sourced_from_blocks: { type: "array", items: { type: "string" } },
					started_at: { type: "number" },
					ended_at: { type: "number" },
				},
				required: ["milestone_id"],
			},
			target_prefix: "/memory",
			target_action: "amend_milestone",
			// No bound_args — amend is scoped by milestone_id (itself owner-locked server-side).
		},
		{
			name: "memory_list_milestones",
			description: "List your milestones, optionally filtered by status/topic/peer. Most-recently-updated first.",
			input_schema: {
				type: "object",
				properties: {
					status: { type: "string", enum: ["active", "completed", "superseded"] },
					topic: { type: "string" },
					peer_id: { type: "string" },
					limit: { type: "number" },
				},
			},
			target_prefix: "/memory",
			target_action: "list_milestones",
			bound_args: owner,
		},
		{
			name: "memory_get_milestone",
			description: "Read one milestone in full by id.",
			input_schema: {
				type: "object",
				properties: { milestone_id: { type: "string" } },
				required: ["milestone_id"],
			},
			target_prefix: "/memory",
			target_action: "get_milestone",
		},
		{
			name: "memory_recall",
			description: "Scoped search over your memory. Use before answering when prior context may matter.",
			input_schema: {
				type: "object",
				properties: {
					query: { type: "string", description: "case-insensitive substring over fact key/value and milestone title/narrative/topics" },
					topics: { type: "array", items: { type: "string" } },
					peer_ids: { type: "array", items: { type: "string" } },
					time_range_start: { type: "number" },
					time_range_end: { type: "number" },
					limit_facts: { type: "number" },
					limit_milestones: { type: "number" },
					include_superseded: { type: "boolean" },
				},
			},
			target_prefix: "/memory",
			target_action: "recall",
			bound_args: owner,
		},
	];
}

// ── Google tools (via /google → local gws CLI) ─────────────────
//
// Calendar, Gmail, Drive, Sheets, Docs. Auth lives in gws (OS keyring).
// No bound_args — these are personal calls into Grant's Google account, not
// agent-scoped like memory. Mutations (send, insert, append, write, delete)
// require `confirmed: true` (execute) or `dry_run: true` (preview via
// gws --dry-run). Neither → the action errors; the model must announce to
// Grant first.

function buildGoogleTools(): ToolSpec[] {
	const mutationSchema = {
		confirmed: { type: "boolean", description: "set true to actually execute. Required for real mutations." },
		dry_run: { type: "boolean", description: "set true to preview via gws --dry-run without side effects. Safe to run without asking." },
	};
	return [
		{
			name: "google_calendar_agenda",
			description: "Show upcoming calendar events across all calendars. Use for 'what's on my schedule' questions. Read-only.",
			input_schema: {
				type: "object",
				properties: {
					today: { type: "boolean" },
					tomorrow: { type: "boolean" },
					week: { type: "boolean" },
					days: { type: "number", description: "days ahead to look" },
					calendar: { type: "string", description: "specific calendar name or id; omit for all" },
					timezone: { type: "string", description: "IANA tz, e.g. America/Los_Angeles" },
				},
			},
			target_prefix: "/google",
			target_action: "calendar_agenda",
		},
		{
			name: "google_calendar_list_events",
			description: "List calendar events with filtering. Read-only. Use for search queries (q) and time-range lookups.",
			input_schema: {
				type: "object",
				properties: {
					calendar_id: { type: "string", description: "defaults to primary" },
					time_min: { type: "string", description: "RFC3339, e.g. 2026-04-24T00:00:00-07:00" },
					time_max: { type: "string" },
					max_results: { type: "number" },
					q: { type: "string", description: "full-text search across event fields" },
				},
			},
			target_prefix: "/google",
			target_action: "calendar_list_events",
		},
		{
			name: "google_calendar_insert",
			description: "Create a calendar event. MUTATION — requires confirmed=true or dry_run=true.",
			input_schema: {
				type: "object",
				properties: {
					summary: { type: "string", description: "event title" },
					start: { type: "string", description: "RFC3339 start time" },
					end: { type: "string", description: "RFC3339 end time" },
					description: { type: "string" },
					location: { type: "string" },
					calendar: { type: "string", description: "defaults to primary" },
					meet: { type: "boolean", description: "true to add a Google Meet link" },
					attendees: { type: "array", items: { type: "string" }, description: "emails" },
					...mutationSchema,
				},
				required: ["summary", "start", "end"],
			},
			target_prefix: "/google",
			target_action: "calendar_insert",
		},
		{
			name: "google_calendar_delete_event",
			description: "Delete a calendar event. MUTATION — requires confirmed=true or dry_run=true. Irreversible.",
			input_schema: {
				type: "object",
				properties: {
					event_id: { type: "string" },
					calendar_id: { type: "string", description: "defaults to primary" },
					...mutationSchema,
				},
				required: ["event_id"],
			},
			target_prefix: "/google",
			target_action: "calendar_delete_event",
		},
		{
			name: "google_gmail_triage",
			description: "Unread inbox summary (sender / subject / date). Read-only. Use for 'what's in my inbox' questions.",
			input_schema: {
				type: "object",
				properties: {
					max: { type: "number", description: "cap on messages returned" },
					label: { type: "string" },
					query: { type: "string", description: "Gmail search query" },
				},
			},
			target_prefix: "/google",
			target_action: "gmail_triage",
		},
		{
			name: "google_gmail_search",
			description: "Search Gmail. Returns message ids; pair with gmail_read to fetch bodies. Read-only.",
			input_schema: {
				type: "object",
				properties: {
					q: { type: "string", description: "Gmail search query, e.g. 'from:mom is:unread'" },
					max_results: { type: "number" },
					label_ids: { type: "array", items: { type: "string" } },
				},
				required: ["q"],
			},
			target_prefix: "/google",
			target_action: "gmail_search",
		},
		{
			name: "google_gmail_read",
			description: "Read one Gmail message by id. Read-only.",
			input_schema: {
				type: "object",
				properties: {
					message_id: { type: "string" },
					headers_only: { type: "boolean", description: "true to skip the body" },
				},
				required: ["message_id"],
			},
			target_prefix: "/google",
			target_action: "gmail_read",
		},
		{
			name: "google_gmail_send",
			description: "Send an email. MUTATION — requires confirmed=true or dry_run=true.",
			input_schema: {
				type: "object",
				properties: {
					to: { type: "string", description: "comma-separated emails" },
					subject: { type: "string" },
					body: { type: "string", description: "plain text or HTML if html=true" },
					cc: { type: "string" },
					bcc: { type: "string" },
					from: { type: "string", description: "send-as alias; omit for default" },
					html: { type: "boolean" },
					draft: { type: "boolean", description: "save as draft instead of send" },
					...mutationSchema,
				},
				required: ["to", "subject", "body"],
			},
			target_prefix: "/google",
			target_action: "gmail_send",
		},
		{
			name: "google_gmail_reply",
			description: "Reply to a Gmail message (threading handled automatically). MUTATION.",
			input_schema: {
				type: "object",
				properties: {
					message_id: { type: "string" },
					body: { type: "string" },
					html: { type: "boolean" },
					...mutationSchema,
				},
				required: ["message_id", "body"],
			},
			target_prefix: "/google",
			target_action: "gmail_reply",
		},
		{
			name: "google_drive_search",
			description: "List / search Drive files. Read-only.",
			input_schema: {
				type: "object",
				properties: {
					q: { type: "string", description: "Drive search query, e.g. \"name contains 'budget' and trashed=false\"" },
					max_results: { type: "number" },
					fields: { type: "string" },
					order_by: { type: "string", description: "e.g. 'modifiedTime desc'" },
				},
			},
			target_prefix: "/google",
			target_action: "drive_search",
		},
		{
			name: "google_drive_get",
			description: "Get Drive file metadata by id. Read-only.",
			input_schema: {
				type: "object",
				properties: {
					file_id: { type: "string" },
					fields: { type: "string" },
				},
				required: ["file_id"],
			},
			target_prefix: "/google",
			target_action: "drive_get",
		},
		{
			name: "google_sheets_read",
			description: "Read cell values from a spreadsheet range. Read-only.",
			input_schema: {
				type: "object",
				properties: {
					spreadsheet_id: { type: "string" },
					range: { type: "string", description: "A1 notation, e.g. 'Sheet1!A1:C10'" },
					value_render_option: { type: "string", enum: ["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"] },
				},
				required: ["spreadsheet_id", "range"],
			},
			target_prefix: "/google",
			target_action: "sheets_read",
		},
		{
			name: "google_sheets_append",
			description: "Append a row to a spreadsheet. MUTATION. `values` is an array of arrays (one row per outer entry).",
			input_schema: {
				type: "object",
				properties: {
					spreadsheet_id: { type: "string" },
					range: { type: "string", description: "A1 notation of the table to append to" },
					values: { type: "array", description: "rows, each an array of cell values" },
					...mutationSchema,
				},
				required: ["spreadsheet_id", "range", "values"],
			},
			target_prefix: "/google",
			target_action: "sheets_append",
		},
		{
			name: "google_docs_get",
			description: "Get a Google Doc's structure (body elements, headings, paragraphs). Read-only.",
			input_schema: {
				type: "object",
				properties: { document_id: { type: "string" } },
				required: ["document_id"],
			},
			target_prefix: "/google",
			target_action: "docs_get",
		},
		{
			name: "google_docs_write",
			description: "Append text to a Google Doc. MUTATION.",
			input_schema: {
				type: "object",
				properties: {
					document_id: { type: "string" },
					text: { type: "string" },
					...mutationSchema,
				},
				required: ["document_id", "text"],
			},
			target_prefix: "/google",
			target_action: "docs_write",
		},
	];
}

// ── Shell tools (via /shell → persistent bash sessions) ────────────
//
// Full bash, no gate. Trusted environment — Gracie can run anything Grant's
// user can run. Sessions persist cwd + env across calls so multi-step work
// (cd somewhere, run something, read a file) composes naturally.

function buildShellTools(): ToolSpec[] {
	return [
		{
			name: "shell_exec",
			description: [
				"Run a bash command in a persistent session on Grant's machine.",
				"Full bash semantics: pipes, redirects, $VARS, globs, backgrounding.",
				"cwd and env persist across calls within the same `session` name.",
				"Default session is 'main'. Use distinct session names to run parallel work.",
				"Returns stdout, stderr, exit_code, duration_ms, and the resulting cwd.",
			].join(" "),
			input_schema: {
				type: "object",
				properties: {
					command: { type: "string", description: "bash command line, e.g. 'cd ~/projekt && git status'" },
					session: { type: "string", description: "session name; default 'main'" },
					timeout_ms: { type: "number", description: "per-call timeout; default 30000, max 600000" },
				},
				required: ["command"],
			},
			target_prefix: "/shell",
			target_action: "exec",
		},
		{
			name: "shell_sessions",
			description: "List live shell sessions with cwd, exec count, and idle time.",
			input_schema: { type: "object", properties: {} },
			target_prefix: "/shell",
			target_action: "list_sessions",
		},
		{
			name: "shell_kill",
			description: "Kill and discard a shell session. Next shell_exec on that name starts a fresh bash. Use when a session hangs or you need a clean state.",
			input_schema: {
				type: "object",
				properties: { session: { type: "string", description: "session name; default 'main'" } },
			},
			target_prefix: "/shell",
			target_action: "kill",
		},
	];
}

function buildGracieTools(gracieAgentId: string): ToolSpec[] {
	return [
		...BASE_TOOLS,
		...buildMemoryTools(gracieAgentId),
		...buildGoogleTools(),
		...buildShellTools(),
		spawnTool(gracieAgentId),
	];
}

async function autoWireTools(agentId: string, ctx: ProgramContext): Promise<{ wired: string[]; skipped: { name: string; reason: string }[] }> {
	const wired: string[] = [];
	const skipped: { name: string; reason: string }[] = [];
	const tools = buildGracieTools(agentId);
	for (const spec of tools) {
		try {
			await ctx.dispatchProgram("/agent", "registerTool", [agentId, JSON.stringify(spec)]);
			wired.push(spec.name);
		} catch (err: any) {
			skipped.push({ name: spec.name, reason: err?.message ?? String(err) });
		}
	}
	return { wired, skipped };
}

async function doBootstrap(opts: BootstrapOpts, ctx: ProgramContext): Promise<BootstrapResult> {
	const store = ctx.store as any;
	const client = ctx.client as any;
	const { stringVal, linkVal } = ctx;

	// Gracie agent: reuse if an agent named "Gracie" exists, else create.
	let gracieAgentId = await findAgentByName(ctx, "Gracie");
	let createdAgent = false;
	if (!gracieAgentId) {
		const system = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
		const model = opts.model ?? DEFAULT_MODEL;
		const fieldsJson = JSON.stringify({
			name: stringVal("Gracie"),
			model: stringVal(model),
			system: stringVal(system),
		});
		gracieAgentId = (await store.create("agent", fieldsJson)) as string;
		createdAgent = true;
	}

	// Self peer (Grant): reuse any peer with kind=self, else create.
	let principalPeerId = await findSelfPeer(ctx);
	let createdPeer = false;
	if (!principalPeerId) {
		const peerFields: Record<string, unknown> = {
			display_name: stringVal(opts.grantName ?? "Grant"),
			kind: stringVal("self"),
			trust_level: stringVal("self"),
		};
		if (opts.grantDiscordId) peerFields.discord_id = stringVal(opts.grantDiscordId);
		if (opts.grantEmail) peerFields.email = stringVal(opts.grantEmail);
		principalPeerId = (await store.create("peer", JSON.stringify(peerFields))) as string;
		createdPeer = true;
	}

	// Link agent → principal peer (graph relation for future queries).
	if (createdAgent || !extractString((await store.get(gracieAgentId))?.fields?.principal)) {
		const agentActor = client.objectActor.getOrCreate([gracieAgentId]);
		await agentActor.setField("principal", JSON.stringify(linkVal(principalPeerId, "principal")));
	}

	const { wired, skipped } = await autoWireTools(gracieAgentId, ctx);

	return { gracieAgentId, principalPeerId, createdAgent, createdPeer, wiredTools: wired, skippedTools: skipped };
}

interface RefreshResult {
	gracieAgentId: string;
	systemChanged: boolean;
	wiredTools: string[];
	skippedTools: { name: string; reason: string }[];
}

/** Rewrite Gracie's `system` field from source DEFAULT_SYSTEM_PROMPT (idempotent)
 *  and re-run autoWireTools so the live agent picks up prompt/tool changes
 *  without recreating the agent or losing conversation history. */
async function doRefreshPrompt(agentId: string, ctx: ProgramContext): Promise<RefreshResult> {
	const store = ctx.store as any;
	const client = ctx.client as any;
	const state = await store.get(agentId);
	if (!state) throw new Error(`refresh-prompt: agent ${agentId} not found`);
	if (state.typeKey !== "agent") throw new Error(`refresh-prompt: ${agentId} is not an agent`);

	const currentSystem = extractString(state.fields?.system) ?? "";
	let systemChanged = false;
	if (currentSystem !== DEFAULT_SYSTEM_PROMPT) {
		const actor = client.objectActor.getOrCreate([agentId]);
		await actor.setField("system", JSON.stringify(ctx.stringVal(DEFAULT_SYSTEM_PROMPT)));
		systemChanged = true;
	}

	const { wired, skipped } = await autoWireTools(agentId, ctx);
	return { gracieAgentId: agentId, systemChanged, wiredTools: wired, skippedTools: skipped };
}

async function ensureBootstrapped(
	state: Record<string, any>,
	ctx: ProgramContext,
): Promise<{ gracieAgentId: string; principalPeerId: string }> {
	// Fast path: state already populated.
	if (state.gracieAgentId && state.principalPeerId) {
		return { gracieAgentId: state.gracieAgentId, principalPeerId: state.principalPeerId };
	}

	// Rehydrate from store.
	const gracieAgentId = state.gracieAgentId || await findAgentByName(ctx, "Gracie");
	const principalPeerId = state.principalPeerId || await findSelfPeer(ctx);
	if (!gracieAgentId || !principalPeerId) {
		throw new Error("Gracie is not bootstrapped. Run `/gracie setup` first.");
	}
	state.gracieAgentId = gracieAgentId;
	state.principalPeerId = principalPeerId;
	return { gracieAgentId, principalPeerId };
}

async function resolvePeerForIngest(peerId: string, ctx: ProgramContext): Promise<PeerSnapshot> {
	// Look peer up via /peer if the program is available; fall back to
	// an "unknown stranger" snapshot so ingest never silently drops.
	try {
		const rec = await ctx.dispatchProgram("/peer", "get", [peerId]) as {
			id: string; display_name: string; trust_level: string; kind: string;
		} | null;
		if (rec) return rec;
	} catch {
		// /peer not running — degrade gracefully.
	}
	return { id: peerId, display_name: peerId.slice(0, 12), kind: "human", trust_level: "stranger" };
}

interface IngestResult {
	finalText: string;
	iterations: number;
	toolCalls: number;
	inputTokens: number;
	outputTokens: number;
	peer: PeerSnapshot;
}

async function doIngest(
	source: string,
	peerId: string,
	text: string,
	state: Record<string, any>,
	ctx: ProgramContext,
): Promise<IngestResult> {
	const { gracieAgentId } = await ensureBootstrapped(state, ctx);
	const peer = await resolvePeerForIngest(peerId, ctx);
	const wrapped = formatIngestPrompt(peer, source, text);
	const result = await ctx.dispatchProgram("/agent", "ask", [gracieAgentId, wrapped]) as {
		finalText: string; iterations: number; toolCalls: number;
		inputTokens: number; outputTokens: number;
	};
	return { ...result, peer };
}

async function doSay(text: string, state: Record<string, any>, ctx: ProgramContext): Promise<IngestResult> {
	const { principalPeerId } = await ensureBootstrapped(state, ctx);
	return await doIngest("shell", principalPeerId, text, state, ctx);
}

// ── Handler (CLI subcommands) ────────────────────────────────────

interface SetupArgs {
	systemPrompt?: string;
	model?: string;
	grantName?: string;
	grantDiscordId?: string;
	grantEmail?: string;
}

function parseSetupArgs(args: string[]): SetupArgs {
	const out: SetupArgs = {};
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		const next = args[i + 1];
		if (a === "--system" && next) { out.systemPrompt = next; i++; }
		else if (a === "--model" && next) { out.model = next; i++; }
		else if (a === "--grant-name" && next) { out.grantName = next; i++; }
		else if (a === "--grant-discord" && next) { out.grantDiscordId = next; i++; }
		else if (a === "--grant-email" && next) { out.grantEmail = next; i++; }
	}
	return out;
}

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print, resolveId } = ctx;
	const state = ctx.state;

	switch (cmd) {
		// /gracie setup [--system ...] [--model X] [--grant-name N] [--grant-discord ID] [--grant-email addr]
		case "setup": {
			try {
				const opts = parseSetupArgs(args);
				const result = await doBootstrap(opts, ctx);
				state.gracieAgentId = result.gracieAgentId;
				state.principalPeerId = result.principalPeerId;

				print(bold(green("  Gracie ready")));
				print(dim(`  agent:  ${result.gracieAgentId} ${result.createdAgent ? green("(created)") : dim("(existing)")}`));
				print(dim(`  grant:  ${result.principalPeerId} ${result.createdPeer ? green("(created)") : dim("(existing)")}`));
				if (result.wiredTools.length > 0) {
					print(dim(`  tools:  ${result.wiredTools.join(", ")}`));
				}
				if (result.skippedTools.length > 0) {
					print(dim(`  skipped: ${result.skippedTools.map((s) => s.name + " (" + s.reason + ")").join("; ")}`));
				}
				print("");
				print(dim("  Next: `/gracie say hello`"));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		// /gracie say <text...>
		case "say": {
			const text = args.join(" ");
			if (!text) { print(red("Usage: gracie say <text...>")); break; }
			try {
				print(dim("  gracie thinking..."));
				print("");
				const result = await doSay(text, state, ctx);
				print(magenta(bold("  gracie")) + dim(` (to ${result.peer.display_name})`));
				for (const line of result.finalText.split("\n")) print(`  ${line}`);
				print("");
				const tools = result.toolCalls > 0 ? `, ${result.toolCalls} tool call(s)` : "";
				print(dim(`  (${result.inputTokens}+${result.outputTokens} tokens, ${result.iterations} iter${tools})`));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		// /gracie ingest <source> <peerId> <text...>
		case "ingest": {
			const source = args[0];
			const rawPeer = args[1];
			const text = args.slice(2).join(" ");
			if (!source || !rawPeer || !text) {
				print(red("Usage: gracie ingest <source> <peerId> <text...>"));
				break;
			}
			const peerId = await resolveId(rawPeer) ?? rawPeer;
			try {
				const result = await doIngest(source, peerId, text, state, ctx);
				print(magenta(bold("  gracie")) + dim(` (to ${result.peer.display_name}, trust=${result.peer.trust_level}, via ${source})`));
				for (const line of result.finalText.split("\n")) print(`  ${line}`);
				print("");
				const tools = result.toolCalls > 0 ? `, ${result.toolCalls} tool call(s)` : "";
				print(dim(`  (${result.inputTokens}+${result.outputTokens} tokens, ${result.iterations} iter${tools})`));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		// /gracie status
		case "status": {
			try {
				const info = await ensureBootstrapped(state, ctx);
				print(bold("  Gracie"));
				print(dim(`  agent:  ${info.gracieAgentId}`));
				print(dim(`  grant:  ${info.principalPeerId}`));
			} catch (err: any) {
				print(red("  ") + (err?.message ?? String(err)));
			}
			break;
		}
		// /gracie refresh-prompt
		// Rewrites Gracie's `system` field from the current source DEFAULT_SYSTEM_PROMPT
		// and re-runs autoWireTools. Use after editing the source prompt or tool list
		// so the live agent picks up the changes without discarding its conversation.
		case "refresh-prompt":
		case "refresh": {
			try {
				const info = await ensureBootstrapped(state, ctx);
				const result = await doRefreshPrompt(info.gracieAgentId, ctx);
				print(bold(green("  Gracie refreshed")));
				print(dim(`  agent:  ${info.gracieAgentId}`));
				print(dim(`  system: ${result.systemChanged ? green("rewritten") : dim("unchanged")}`));
				print(dim(`  tools:  ${result.wiredTools.length} wired, ${result.skippedTools.length} skipped`));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		default: {
			print([
				bold("  Gracie") + dim(" — Grant's executive assistant"),
				`    ${cyan("gracie setup")} ${dim("[--system ...] [--model X] [--grant-name N] [--grant-discord ID] [--grant-email addr]")}`,
				`    ${cyan("gracie say")} ${dim("<text...>")}                              ${dim("Grant talks to Gracie from the shell")}`,
				`    ${cyan("gracie ingest")} ${dim("<source> <peerId> <text...>")}         ${dim("bridges call this on inbound")}`,
				`    ${cyan("gracie status")}                                               ${dim("show current agent + principal ids")}`,
				`    ${cyan("gracie refresh-prompt")}                                       ${dim("rewrite system prompt from source + re-wire tools")}`,
			].join("\n"));
		}
	}
};

// ── Actor (programmatic API + hibernatable state cache) ──────────

const actorDef: ProgramActorDef = {
	createState: () => ({ gracieAgentId: "", principalPeerId: "" }),

	actions: {
		/**
		 * One-time setup (idempotent). Opts may be a JSON string or plain object.
		 *
		 * Aliased as both `bootstrap` and `setup`: the CLI command is `/gracie setup`,
		 * and headless callers (HTTP dispatch) should be able to use the same verb.
		 */
		bootstrap: async (ctx: ProgramContext, opts?: string | BootstrapOpts) => {
			const parsed: BootstrapOpts = typeof opts === "string" ? (opts ? JSON.parse(opts) : {}) : (opts ?? {});
			const result = await doBootstrap(parsed, ctx);
			ctx.state.gracieAgentId = result.gracieAgentId;
			ctx.state.principalPeerId = result.principalPeerId;
			return result;
		},
		setup: async (ctx: ProgramContext, opts?: string | BootstrapOpts) => {
			const parsed: BootstrapOpts = typeof opts === "string" ? (opts ? JSON.parse(opts) : {}) : (opts ?? {});
			const result = await doBootstrap(parsed, ctx);
			ctx.state.gracieAgentId = result.gracieAgentId;
			ctx.state.principalPeerId = result.principalPeerId;
			return result;
		},

		/** Process an inbound message from a named peer on a named source. */
		ingest: async (ctx: ProgramContext, source: string, peerId: string, text: string) => {
			return await doIngest(source, peerId, text, ctx.state, ctx);
		},

		/** Shell-side convenience: Grant speaks to Gracie directly. */
		say: async (ctx: ProgramContext, text: string) => {
			return await doSay(text, ctx.state, ctx);
		},

		/** Return current state for diagnostics. */
		status: async (ctx: ProgramContext) => {
			const info = await ensureBootstrapped(ctx.state, ctx);
			return info;
		},

		/** Rewrite the `system` field from DEFAULT_SYSTEM_PROMPT and re-wire tools. */
		refreshPrompt: async (ctx: ProgramContext) => {
			const info = await ensureBootstrapped(ctx.state, ctx);
			return await doRefreshPrompt(info.gracieAgentId, ctx);
		},
	},
};

const program: ProgramDef = { handler, actor: actorDef };
export default program;
