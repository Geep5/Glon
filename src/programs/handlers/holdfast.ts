// Holdfast — the generic agent harness.
//
// Holdfast is the structural part of running an LLM-driven assistant on Glon:
// identity-aware ingest, a peer directory wired in, durable memory tools,
// scheduled reminders, Google Workspace bridges, shell access, and subagent
// spawning. It does not have an opinion about who the agent is — you give
// it a name and a principal during setup and the harness wraps an /agent
// object configured for that identity.
//
// In kelp biology, a holdfast is the root-like structure that anchors
// macroalgae to rock. Same pattern here: the harness anchors an LLM to the
// world (peers, calendars, mailboxes, shells, the DAG) without being the
// kelp itself. The kelp — your specific assistant's name, system prompt,
// custom tools, preferred peers — lives in your own configuration. A
// personal repo can drive `/holdfast setup --name "Graice" --principal-name
// "Grant" ...` from a bootstrap script and treat this program as the engine.
//
// What the harness wraps:
//   - identity awareness (every message tagged with peer + source + trust)
//   - a principal peer (the human who drives `say`)
//   - idempotent setup that creates the agent + self peer on first run
//     and reconstitutes actor state from the store on later wakes
//   - a uniform `ingest` action that bridges (Discord, email, future inputs)
//     call with (source, peerId, text)
//
// The actor holds only a cache: { agentId, agentName, principalPeerId }.
// Truth lives in the DAG — the agent object's `name` field is canonical, and
// the self peer is the one with kind=self. If the process restarts,
// `ensureBootstrapped()` rehydrates from the store using the cached id, or
// (on a fresh actor) by walking the store for a self peer + an agent linked
// to it via the `principal` field.

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

/**
 * Render the default system prompt with the configured names substituted in.
 * Personal repos that want a fully custom voice should pass `--system` to
 * setup; this is the harness's structural default.
 */
function renderDefaultSystemPrompt(args: { agentName: string; principalName: string }): string {
	const { agentName, principalName } = args;
	const them = principalName;
	const themPossessive = `${principalName}'s`;
	return `You are ${agentName}, ${themPossessive} executive assistant.

You manage ${themPossessive} life: ${them}'s calendar, reminders, communication
with family and trusted contacts, and coordination with other agents.

## Identity awareness
Every message you receive is wrapped:
  [from {name} on {source}, trust={level}] {text}
Use the trust level to gate your behavior:

  trust=self      ${them}. Full agency. Act decisively.
  trust=family    Inner circle. Act on their requests, but loop ${them} in
                  before anything irreversible (spending money, booking,
                  sharing ${themPossessive} schedule with outsiders).
  trust=ops       Operational contacts (work, vendors, coworkers). Act on
                  what their role implies. When in doubt, ask.
  trust=stranger  Unknown. Reply politely: "I'll pass that along to ${them}."
                  Do not call tools. Do not share ${themPossessive} information.

## Tone
Calm, specific, proactive but not chatty. Executive assistant, not friend.
Discord-friendly formatting: no markdown tables (Discord doesn't render
them); use bullet points or aligned code blocks.

## Tools
When tools are registered on you, prefer them over asking ${them} to do
things ${them === principalName ? "themselves" : "themself"}. Always be specific about what you did
(event IDs, message IDs, exact times) so ${them} can audit or undo.

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
  trust level, your own source code) MUST be announced to ${them} before you do
  them. When in doubt, ask.
- When ${them} says "show me your code", use object_list type_key=program to find
  /holdfast, object_get it to read its manifest, and object_read_source on the
  manifest's typescript object. Cite object ids in your reply so ${them} can verify.
- Questions about your own architecture, capabilities, current state, or how something
  works internally must be answered from the live DAG, not from this conversation.
  Your source code and agent object both change out of band; conversation history lags
  behind. On any such question:
    - For behavior / how code works: call object_read_source on the relevant handler
      (/discord, /holdfast, /agent, /memory) before asserting.
    - For your own current state (model, system prompt, tools wired, compaction knobs,
      tokens used): call object_get on your own agent object and cite the exact field
      value you read.
  Treat prior claims in this conversation as hearsay until re-verified. Cite the object
  id(s) you read so ${them} can audit. If you have not made a tool call this turn that
  produced the evidence, you do not know the answer — say so instead of guessing.

## Memory
Your conversation gets compacted when it grows too long. To keep facts and
decisions across compactions, write them to your memory store — those records
survive forever and sync between instances.

- memory_upsert_fact: pin an atomic fact about ${them} or someone in ${themPossessive} world.
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
  with a focused query. Cheaper than re-asking ${them}.
- Memory is heuristic, not authoritative — if it conflicts with what ${them}
  just told you, prefer ${them}.

## Google Workspace (Calendar / Gmail / Drive / Sheets / Docs)
You have google_* tools that bridge to ${themPossessive} local gws CLI. Auth lives in
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
  a calendar invite, deleting), first describe to ${them} exactly what you'll do.
- Only call with confirmed=true after ${them} explicitly approves.
- If you're unsure whether an action is fine, call with dry_run=true first to
  preview the exact request that would be sent, show ${them}, then confirm.
- For trivial/self-only writes (appending a row to your own log sheet, writing
  to your own scratch doc), you can use confirmed=true directly but mention it.


## Shell access
You have shell_exec on ${themPossessive} machine. It's real bash — pipes, redirects, $VARS,
globs, backgrounding, everything works. Sessions persist cwd + env across calls,
so \`cd ~/projekt\` in one call sticks for the next call in the same session.

Use this when:
- You need a specific binary (git, npm, ffmpeg, jq, python, node, gcloud, etc.)
- You're exploring a repo or filesystem (ls, find, grep, cat, head, tree, tail)
- You're inspecting system state (ps, df, du, free, uname, uptime, who)
- You're running tests, builds, or deploys that ${them} asked for

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
The shell has \`curl\`, \`jq\`, \`pandoc\`, and \`html2text\` on the path. There are
no dedicated HTTP tools — shell_exec is the path. Cite the URL and HTTP
status in any report; if the body was truncated, surface the byte count.
Don't probe localhost / private IPs unless ${them} explicitly asks.

Recipes:
- JSON: \`curl -s URL | jq .\`
- HTML → readable: \`curl -sL URL | pandoc -f html -t plain\`
  (or \`html2text\`, or \`lynx -dump -nolist URL\`)
- Bytes only: \`curl -sLI URL\` (HEAD; status + headers, no body)
- Big page: \`curl -sL URL > /tmp/p && wc -c /tmp/p && head -c 16384 /tmp/p\`
  (write to scratch first, then sample — don't blast unbounded text into a tool result)


## Anytype
${them} runs Anytype locally. Its REST API lives at $ANYTYPE_API_BASE with
$ANYTYPE_API_KEY (Bearer auth) and $ANYTYPE_VERSION (date string the API spec
is pinned to). All three live in your shell env. There is no Glon tool
wrapper — talk to it directly via shell_exec.

Common patterns (all need the two headers):
  curl -sH "Authorization: Bearer $ANYTYPE_API_KEY" \\
       -H "Anytype-Version: $ANYTYPE_VERSION" \\
       $ANYTYPE_API_BASE/v1/spaces

  curl -s ...same headers... $ANYTYPE_API_BASE/v1/spaces/<SPACE_ID>/objects?limit=20

  curl -s ...same headers... -H 'Content-Type: application/json' \\
       -X POST $ANYTYPE_API_BASE/v1/spaces/<SPACE_ID>/search \\
       -d '{"query":"..."}'

Pipe to jq for parsing. Full OpenAPI spec: https://developers.anytype.io
If the key ever expires, re-issue with \`npx -y @anyproto/anytype-mcp get-key\`
(interactive — needs ${them} to enter a 4-digit code Anytype shows in the app)
and overwrite ANYTYPE_API_KEY in .env.`;
}

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

/**
 * Find the agent linked to the self peer via its `principal` field. Used on
 * a fresh actor wake when state is empty: walk every agent, return the first
 * whose `principal` link points at the self peer. Falls back to `null` if
 * no such pairing exists yet (i.e. setup hasn't been run).
 */
async function findHarnessAgent(ctx: ProgramContext, principalPeerId: string): Promise<string | null> {
	const store = ctx.store as any;
	const refs = await store.list("agent") as { id: string }[];
	for (const ref of refs) {
		const obj = await store.get(ref.id);
		if (obj?.deleted) continue;
		const principal = obj?.fields?.principal;
		// Field may be raw object or proto Value wrapper.
		const targetId = principal?.linkValue?.targetId ?? principal?.targetId;
		if (targetId === principalPeerId) return ref.id;
	}
	return null;
}

// ── Core operations ──────────────────────────────────────────────

interface SetupOpts {
	/** Display name for the agent (required on first setup; persisted). */
	name?: string;
	/** Override the system prompt. Defaults to the rendered template. */
	systemPrompt?: string;
	/** Override the model. */
	model?: string;
	/** Display name for the principal peer (kind=self). */
	principalName?: string;
	/** Principal's Discord user id, for DM routing. */
	principalDiscordId?: string;
	/** Principal's email address. */
	principalEmail?: string;
}

interface SetupResult {
	agentId: string;
	agentName: string;
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
// register and the tool-use loop reports a clear "Program not running"
// error at call time if a target is unavailable.

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
		description: "List all peers in your directory. Optionally filter by kind or trust_level.",
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
		description: "Get full details for a peer by id. Useful when you need someone's Discord id, email, etc.",
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
		description: "Add a new peer (person or agent) to your directory. Use when your principal introduces someone new. Defaults to kind=human, trust_level=stranger.",
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
		description: "Change a peer's trust level. Only do this when explicitly asked by your principal — it changes what that peer can ask you to do.",
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
			"  - discord: payload {message: '...'} — send exactly that text via DM.",
			"  - agent_compose: payload {prompt: '...'} — when it fires, you get re-invoked with the prompt and compose a fresh message (use this when the message should reflect current state, e.g. 'remind me about dinner, check traffic first').",
			"  - email: payload {subject, body} — requires /mail program (not yet wired).",
		].join("\n"),
		input_schema: {
			type: "object",
			properties: {
				channel: { type: "string", enum: ["discord", "email", "agent_compose"] },
				target: { type: "string", description: "peer_id for discord/agent_compose; email address for email" },
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
			"  - program   (running programs including /holdfast, /agent, /peer, /discord, /remind)",
			"  - peer      (people and agents you talk to)",
			"  - agent     (LLM agent objects — you are one)",
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
		description: "List the outgoing and incoming ObjectLink fields of an object. E.g. your agent has an outgoing 'principal' link to your principal's peer; that peer has it inbound.",
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
			"create program objects with this tool — ask your principal to add the program to bootstrap.ts",
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
			"announced to your principal before you do them.",
			"DO NOT modify your own `tools` field directly with this — the ValueMap shape is easy to",
			"get wrong and will brick your tool access. If your principal wants you to gain a new capability,",
			"ask them to add it in the harness source so it auto-registers next setup.",
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
];

// ── Memory tools ─────────────────────────────────────────────────
//
// These bind `owner = agentId` so the model never handles its own id
// (and can't spoof a different one). All memory actions filter by owner.

function buildMemoryTools(agentId: string): ToolSpec[] {
	const owner = { owner: agentId };
	return [
		{
			name: "memory_upsert_fact",
			description: "Pin a durable fact you want to remember across compactions. One row per `key` — upserting the same key replaces the value (old value stays in object_history). Use for contact info, preferences, names, boundaries.",
			input_schema: {
				type: "object",
				properties: {
					key: { type: "string", description: "short identifier, e.g. 'principal_birthday' or 'moms_email'" },
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
// No bound_args — these are personal calls into the principal's Google
// account, not agent-scoped like memory. Mutations (send, insert, append,
// write, delete) require `confirmed: true` (execute) or `dry_run: true`
// (preview via gws --dry-run). Neither → the action errors; the model
// must announce to the principal first.

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
// Full bash, no gate. Trusted environment — the agent can run anything the
// principal's user can run. Sessions persist cwd + env across calls so
// multi-step work composes naturally.

function buildShellTools(): ToolSpec[] {
	return [
		{
			name: "shell_exec",
			description: [
				"Run a bash command in a persistent session on the principal's machine.",
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

function buildHarnessTools(agentId: string): ToolSpec[] {
	return [
		...BASE_TOOLS,
		...buildMemoryTools(agentId),
		...buildGoogleTools(),
		...buildShellTools(),
		spawnTool(agentId),
	];
}

async function autoWireTools(agentId: string, ctx: ProgramContext): Promise<{ wired: string[]; skipped: { name: string; reason: string }[] }> {
	const wired: string[] = [];
	const skipped: { name: string; reason: string }[] = [];
	const tools = buildHarnessTools(agentId);
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

interface HarnessState {
	agentId: string;
	agentName: string;
	principalPeerId: string;
}

async function doSetup(opts: SetupOpts, ctx: ProgramContext): Promise<SetupResult> {
	const store = ctx.store as any;
	const client = ctx.client as any;
	const { stringVal, linkVal } = ctx;

	// Resolve names with sensible defaults so an empty `setup` still produces
	// a working harness on first run. Personal repos pass --name + --principal-name.
	const agentName = opts.name?.trim() || "Assistant";
	const principalName = opts.principalName?.trim() || "Owner";

	// Reuse if an agent with this name already exists, else create.
	let agentId = await findAgentByName(ctx, agentName);
	let createdAgent = false;
	if (!agentId) {
		const system = opts.systemPrompt ?? renderDefaultSystemPrompt({ agentName, principalName });
		const model = opts.model ?? DEFAULT_MODEL;
		const fieldsJson = JSON.stringify({
			name: stringVal(agentName),
			model: stringVal(model),
			system: stringVal(system),
		});
		agentId = (await store.create("agent", fieldsJson)) as string;
		createdAgent = true;
	}

	// Self peer (the principal): reuse any peer with kind=self, else create.
	let principalPeerId = await findSelfPeer(ctx);
	let createdPeer = false;
	if (!principalPeerId) {
		const peerFields: Record<string, unknown> = {
			display_name: stringVal(principalName),
			kind: stringVal("self"),
			trust_level: stringVal("self"),
		};
		if (opts.principalDiscordId) peerFields.discord_id = stringVal(opts.principalDiscordId);
		if (opts.principalEmail) peerFields.email = stringVal(opts.principalEmail);
		principalPeerId = (await store.create("peer", JSON.stringify(peerFields))) as string;
		createdPeer = true;
	}

	// Link agent → principal peer (graph relation for future queries).
	if (createdAgent || !extractString((await store.get(agentId))?.fields?.principal)) {
		const agentActor = client.objectActor.getOrCreate([agentId]);
		await agentActor.setField("principal", JSON.stringify(linkVal(principalPeerId, "principal")));
	}

	const { wired, skipped } = await autoWireTools(agentId, ctx);

	return {
		agentId,
		agentName,
		principalPeerId,
		createdAgent,
		createdPeer,
		wiredTools: wired,
		skippedTools: skipped,
	};
}

interface RefreshResult {
	agentId: string;
	systemChanged: boolean;
	wiredTools: string[];
	skippedTools: { name: string; reason: string }[];
}

/**
 * Re-render the default system prompt from the current agent name and the
 * current principal's display name, write it to the agent's `system` field
 * (idempotent), and re-run autoWireTools so the live agent picks up prompt
 * and tool changes without recreating the agent or losing conversation
 * history.
 *
 * If the agent was set up with a `--system` override, refresh-prompt has
 * nothing useful to compute; the operator should set `system` directly via
 * /agent config in that case.
 */
async function doRefreshPrompt(state: HarnessState, ctx: ProgramContext): Promise<RefreshResult> {
	const store = ctx.store as any;
	const client = ctx.client as any;
	const obj = await store.get(state.agentId);
	if (!obj) throw new Error(`refresh-prompt: agent ${state.agentId} not found`);
	if (obj.typeKey !== "agent") throw new Error(`refresh-prompt: ${state.agentId} is not an agent`);

	// Re-resolve names from the live store rather than trusting the cache —
	// the principal might have been renamed between actor wakes.
	const agentName = extractString(obj.fields?.name) ?? state.agentName;
	const principal = await store.get(state.principalPeerId);
	const principalName = extractString(principal?.fields?.display_name) ?? "Owner";
	const target = renderDefaultSystemPrompt({ agentName, principalName });

	const currentSystem = extractString(obj.fields?.system) ?? "";
	let systemChanged = false;
	if (currentSystem !== target) {
		const actor = client.objectActor.getOrCreate([state.agentId]);
		await actor.setField("system", JSON.stringify(ctx.stringVal(target)));
		systemChanged = true;
	}

	const { wired, skipped } = await autoWireTools(state.agentId, ctx);
	return { agentId: state.agentId, systemChanged, wiredTools: wired, skippedTools: skipped };
}

async function ensureBootstrapped(
	state: Record<string, any>,
	ctx: ProgramContext,
): Promise<HarnessState> {
	// Fast path: state already populated.
	if (state.agentId && state.principalPeerId && state.agentName) {
		return {
			agentId: state.agentId,
			agentName: state.agentName,
			principalPeerId: state.principalPeerId,
		};
	}

	// Rehydrate from store. Find the self peer first; that's the anchor.
	const principalPeerId: string | null = state.principalPeerId || await findSelfPeer(ctx);
	if (!principalPeerId) {
		throw new Error("Holdfast is not set up. Run `/holdfast setup --name <name> --principal-name <name>` first.");
	}

	// Find the agent: prefer the cached id, else walk for one whose `principal`
	// link points at this self peer.
	const agentId: string | null = state.agentId || await findHarnessAgent(ctx, principalPeerId);
	if (!agentId) {
		throw new Error("Holdfast self peer exists but no agent is linked to it. Run `/holdfast setup --name <name>`.");
	}

	const agentObj = (ctx.store as any).get ? await (ctx.store as any).get(agentId) : null;
	const agentName = state.agentName || extractString(agentObj?.fields?.name) || "Assistant";

	state.agentId = agentId;
	state.agentName = agentName;
	state.principalPeerId = principalPeerId;
	return { agentId, agentName, principalPeerId };
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
	/** The agent's display name, so callers can render output consistently. */
	agentName: string;
}

async function doIngest(
	source: string,
	peerId: string,
	text: string,
	state: Record<string, any>,
	ctx: ProgramContext,
): Promise<IngestResult> {
	const harness = await ensureBootstrapped(state, ctx);
	const peer = await resolvePeerForIngest(peerId, ctx);
	const wrapped = formatIngestPrompt(peer, source, text);
	const result = await ctx.dispatchProgram("/agent", "ask", [harness.agentId, wrapped]) as {
		finalText: string; iterations: number; toolCalls: number;
		inputTokens: number; outputTokens: number;
	};
	return { ...result, peer, agentName: harness.agentName };
}

async function doSay(text: string, state: Record<string, any>, ctx: ProgramContext): Promise<IngestResult> {
	const harness = await ensureBootstrapped(state, ctx);
	return await doIngest("shell", harness.principalPeerId, text, state, ctx);
}

// ── Handler (CLI subcommands) ────────────────────────────────────

function parseSetupArgs(args: string[]): SetupOpts {
	const out: SetupOpts = {};
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		const next = args[i + 1];
		if (a === "--name" && next) { out.name = next; i++; }
		else if (a === "--system" && next) { out.systemPrompt = next; i++; }
		else if (a === "--model" && next) { out.model = next; i++; }
		else if (a === "--principal-name" && next) { out.principalName = next; i++; }
		else if (a === "--principal-discord" && next) { out.principalDiscordId = next; i++; }
		else if (a === "--principal-email" && next) { out.principalEmail = next; i++; }
	}
	return out;
}

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print, resolveId } = ctx;
	const state = ctx.state;

	switch (cmd) {
		// /holdfast setup --name <NAME> [--principal-name N] [--system ...] [--model X]
		//                 [--principal-discord ID] [--principal-email addr]
		case "setup": {
			try {
				const opts = parseSetupArgs(args);
				const result = await doSetup(opts, ctx);
				state.agentId = result.agentId;
				state.agentName = result.agentName;
				state.principalPeerId = result.principalPeerId;

				print(bold(green(`  Holdfast ready — ${result.agentName}`)));
				print(dim(`  agent:     ${result.agentId} ${result.createdAgent ? green("(created)") : dim("(existing)")}`));
				print(dim(`  principal: ${result.principalPeerId} ${result.createdPeer ? green("(created)") : dim("(existing)")}`));
				if (result.wiredTools.length > 0) {
					print(dim(`  tools:     ${result.wiredTools.join(", ")}`));
				}
				if (result.skippedTools.length > 0) {
					print(dim(`  skipped:   ${result.skippedTools.map((s) => s.name + " (" + s.reason + ")").join("; ")}`));
				}
				print("");
				print(dim(`  Next: \`/holdfast say hello\``));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		// /holdfast say <text...>
		case "say": {
			const text = args.join(" ");
			if (!text) { print(red("Usage: holdfast say <text...>")); break; }
			try {
				print(dim("  thinking..."));
				print("");
				const result = await doSay(text, state, ctx);
				print(magenta(bold(`  ${result.agentName}`)) + dim(` (to ${result.peer.display_name})`));
				for (const line of result.finalText.split("\n")) print(`  ${line}`);
				print("");
				const tools = result.toolCalls > 0 ? `, ${result.toolCalls} tool call(s)` : "";
				print(dim(`  (${result.inputTokens}+${result.outputTokens} tokens, ${result.iterations} iter${tools})`));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		// /holdfast ingest <source> <peerId> <text...>
		case "ingest": {
			const source = args[0];
			const rawPeer = args[1];
			const text = args.slice(2).join(" ");
			if (!source || !rawPeer || !text) {
				print(red("Usage: holdfast ingest <source> <peerId> <text...>"));
				break;
			}
			const peerId = await resolveId(rawPeer) ?? rawPeer;
			try {
				const result = await doIngest(source, peerId, text, state, ctx);
				print(magenta(bold(`  ${result.agentName}`)) + dim(` (to ${result.peer.display_name}, trust=${result.peer.trust_level}, via ${source})`));
				for (const line of result.finalText.split("\n")) print(`  ${line}`);
				print("");
				const tools = result.toolCalls > 0 ? `, ${result.toolCalls} tool call(s)` : "";
				print(dim(`  (${result.inputTokens}+${result.outputTokens} tokens, ${result.iterations} iter${tools})`));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		// /holdfast status
		case "status": {
			try {
				const info = await ensureBootstrapped(state, ctx);
				print(bold(`  Holdfast — ${info.agentName}`));
				print(dim(`  agent:     ${info.agentId}`));
				print(dim(`  principal: ${info.principalPeerId}`));
			} catch (err: any) {
				print(red("  ") + (err?.message ?? String(err)));
			}
			break;
		}
		// /holdfast refresh-prompt
		// Re-renders the default system prompt with the current names and writes
		// it to the agent's `system` field, then re-runs autoWireTools. Use
		// after editing the harness source so the live agent picks up changes
		// without discarding its conversation. Skips silently if you've set a
		// custom prompt via --system or /agent config.
		case "refresh-prompt":
		case "refresh": {
			try {
				const info = await ensureBootstrapped(state, ctx);
				const result = await doRefreshPrompt(info, ctx);
				print(bold(green(`  Holdfast refreshed — ${info.agentName}`)));
				print(dim(`  agent:  ${info.agentId}`));
				print(dim(`  system: ${result.systemChanged ? green("rewritten") : dim("unchanged")}`));
				print(dim(`  tools:  ${result.wiredTools.length} wired, ${result.skippedTools.length} skipped`));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		default: {
			print([
				bold("  Holdfast") + dim(" — generic agent harness"),
				`    ${cyan("holdfast setup")} ${dim("--name <NAME> [--principal-name N] [--system ...] [--model X]")}`,
				`    ${"".padStart(15)}${dim("[--principal-discord ID] [--principal-email addr]")}`,
				`    ${cyan("holdfast say")} ${dim("<text...>")}                              ${dim("principal talks to the agent from the shell")}`,
				`    ${cyan("holdfast ingest")} ${dim("<source> <peerId> <text...>")}         ${dim("bridges call this on inbound")}`,
				`    ${cyan("holdfast status")}                                               ${dim("show current agent + principal ids")}`,
				`    ${cyan("holdfast refresh-prompt")}                                       ${dim("rewrite default system prompt + re-wire tools")}`,
			].join("\n"));
		}
	}
};

// ── Actor (programmatic API + hibernatable state cache) ──────────

const actorDef: ProgramActorDef = {
	createState: () => ({ agentId: "", agentName: "", principalPeerId: "" }),

	actions: {
		/**
		 * One-time setup (idempotent). Opts may be a JSON string or plain object.
		 *
		 * Aliased as both `bootstrap` and `setup`: the CLI command is
		 * `/holdfast setup`, and headless callers (HTTP dispatch) should be
		 * able to use the same verb.
		 */
		bootstrap: async (ctx: ProgramContext, opts?: string | SetupOpts) => {
			const parsed: SetupOpts = typeof opts === "string" ? (opts ? JSON.parse(opts) : {}) : (opts ?? {});
			const result = await doSetup(parsed, ctx);
			ctx.state.agentId = result.agentId;
			ctx.state.agentName = result.agentName;
			ctx.state.principalPeerId = result.principalPeerId;
			return result;
		},
		setup: async (ctx: ProgramContext, opts?: string | SetupOpts) => {
			const parsed: SetupOpts = typeof opts === "string" ? (opts ? JSON.parse(opts) : {}) : (opts ?? {});
			const result = await doSetup(parsed, ctx);
			ctx.state.agentId = result.agentId;
			ctx.state.agentName = result.agentName;
			ctx.state.principalPeerId = result.principalPeerId;
			return result;
		},

		/** Process an inbound message from a named peer on a named source. */
		ingest: async (ctx: ProgramContext, source: string, peerId: string, text: string) => {
			return await doIngest(source, peerId, text, ctx.state, ctx);
		},

		/** Shell-side convenience: the principal speaks to the agent directly. */
		say: async (ctx: ProgramContext, text: string) => {
			return await doSay(text, ctx.state, ctx);
		},

		/** Return current state for diagnostics. */
		status: async (ctx: ProgramContext) => {
			const info = await ensureBootstrapped(ctx.state, ctx);
			return info;
		},

		/** Re-render the default system prompt with current names and re-wire tools. */
		refreshPrompt: async (ctx: ProgramContext) => {
			const info = await ensureBootstrapped(ctx.state, ctx);
			return await doRefreshPrompt(info, ctx);
		},
	},
};

const program: ProgramDef = { handler, actor: actorDef };
export default program;

// ── Internal exports for testing ─────────────────────────────────

export const __test = {
	renderDefaultSystemPrompt,
	formatIngestPrompt,
	parseSetupArgs,
	buildHarnessTools,
	doSetup,
	doIngest,
	doSay,
	doRefreshPrompt,
	ensureBootstrapped,
	findAgentByName,
	findSelfPeer,
	findHarnessAgent,
};
