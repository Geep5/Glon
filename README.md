# 🌿 glon

A distributed operating environment for content-addressed objects, durable actors, and programs that act on them.

LLM agents are **applications** that run on this substrate — they reuse the kernel's objects, DAG, actors, and sync rather than reinventing them. Conversation history is just blocks in a DAG. Memory is just typed objects. Tools are just calls to other programs. Subagents are just more agent objects.

glon is inspired by [Anytype](https://anytype.io)'s philosophy — no hierarchy, just objects and the links between them — and built on two primitives that hold up at scale: [Rivet](https://rivet.gg) actors (how games, telecom, and Discord avoid shared-state problems) and content-addressed protobuf (how Git and IPFS make data self-verifying and conflict-free). Every object is a durable actor, every mutation is an immutable change in a DAG, and the graph of relations between objects is the only structure.

## Layered architecture

```
                ┌───────────────────────────────────────────────────┐
   apps         │  Holdfast · custom assistants · automations · …   │   ← configurations of programs
                ├───────────────────────────────────────────────────┤
   programs     │  /agent /task /memory /chat /crud /graph /peer …  │   ← user-space, all hot-loadable
                ├───────────────────────────────────────────────────┤
   kernel       │  objects · actors · DAG · sync · programs runtime │   ← every primitive is content-addressed
                ├───────────────────────────────────────────────────┤
   transport    │  protobuf wire format · HTTP · mDNS · sqlite cache│
                └───────────────────────────────────────────────────┘
```

The kernel knows nothing about LLMs. The fact that `/agent` exists at the program layer is convention; remove it and glon is still a working distributed object store with `/chat`, `/ttt`, and any other program you write.

## The kernel — five primitives

**Objects, not files.** There are no folders, no directories, no tree. Every entity is a typed object in a flat graph. Objects relate to each other through typed `ObjectLink` fields — the structure emerges from the connections, not from where something is placed.

**Changes, not state.** Every mutation is a `Change` — an immutable protobuf message appended to a DAG, identified by the SHA-256 of its wire bytes. Current state is computed by replaying the DAG from genesis to heads. Nothing is overwritten; full history is preserved.

**Actors, not databases.** Each object is a [Rivet actor](https://rivet.gg/docs/actors) — durable, globally addressable, hibernatable. Actor types: `objectActor` (one per object, sync peer), `storeActor` (singleton index), `programActor` (program state and RPC dispatch).

**Everything is a program.** The shell has zero built-in commands. It loads every command — including `/help` — from the store at startup. Programs are glon objects: they have change history, sync between instances, and are discoverable at runtime.

**Self-describing.** On bootstrap, the environment loads its own source files as objects. You can query glon for the code that built it.

## Getting started

**Prerequisites**
- Node 20+ (the dev server uses the built-in `node:sqlite`).
- For LLM agents: either an Anthropic API key (`ANTHROPIC_API_KEY`) or a Claude Pro/Max plan (set up via `/auth login anthropic`). Discord bot token if you want the bridge.

**Install**
```bash
git clone https://github.com/Geep5/glon.git
cd glon && npm install
cp .env.example .env        # fill in secrets (see sections below)
```

**Run**
```bash
# Terminal 1 — RivetKit actor host. Stays running.
npm run dev

# Terminal 2 — seed source files + programs. Only on first run.
npm run bootstrap

# Terminal 3 — interactive shell.
npm run client
```

Every script auto-loads `.env` from the project root, so `ANTHROPIC_API_KEY` and `DISCORD_BOT_TOKEN` are picked up without inline prefixes. Inline still works (`ANTHROPIC_API_KEY=sk-... npm run client`).

**Port collisions.** The dev server fails fast if `6420` is already bound instead of silently sliding to the next port. Either free it or set `GLON_PORT=6520` in `.env`. Clients auto-discover the chosen port via a lockfile at `~/.glon/.endpoint`, so you never have to tell them.

## The application layer — built-in programs

| Command | Purpose |
|---|---|
| `/help` | List available programs |
| `/crud` | Create, list, get, set, delete objects |
| `/inspect` | DAG history, change details, sync state |
| `/ipc` | Inter-object messaging (inbox/outbox) |
| `/graph` | Object link traversal, neighbours, BFS |
| `/ttt` | Tic-tac-toe — every move is a content-addressed change |
| `/chat` | Chat rooms — messages are blocks in the DAG |
| `/agent` | LLM agents with DAG-backed conversation, tool dispatch, auto-compaction, subagent spawning, and block recall |
| `/task` | Thin CLI front-end for spawning subagent batches |
| `/memory` | Durable agent memory: pinned facts and milestone arcs that survive compaction |
| `/peer` | People and agents the harness talks to: identity, trust level, contact handles |
| `/remind` | Scheduled actions: DM at a time, prompt the agent to compose then send |
| `/discord` | I/O bridge: Gateway WebSocket for online presence + 3s REST poll for DMs, routes to `/holdfast.ingest`, posts replies back |
| `/holdfast` | Generic agent harness: wraps an `/agent` with identity-aware ingest, memory, scheduled reminders, Google Workspace bridges, shell access, and subagent spawning. Configure once with `/holdfast setup --name <NAME>` |
| `/web` | HTTP client (fetch, get-text, get-json) with SSRF guard |
| `/shell` | Persistent bash sessions an agent can drive |
| `/google` | Bridge to Google Workspace CLI (calendar, gmail, drive, sheets, docs) |
| `/gc` | Garbage collection with retention policies |
| `/accounts` | Multi-user auth and per-object permissions |
| `/auth` | Anthropic credential management: OAuth login for Claude Pro/Max, or fall back to API key |
| `/sync` | P2P sync via mDNS discovery and HTTP |

Every program `export default`s a `ProgramDef`:

```typescript
export default {
  handler: async (cmd, args, ctx) => { ... },  // CLI handler (required)
  actor: { ... },                                // persistent state + RPC (optional)
  validator: (changes) => { ... },               // DAG gating (optional)
  validatedTypes: ["character", "item"],         // types to validate (optional)
};
```

A handler-only program is a stateless command. Add an `actor` for persistent state and a tick loop. Add a `validator` to gate synced changes before they reach disk.

## Agents on glon

An LLM agent is one configuration of the kernel's primitives — nothing about it requires a new subsystem.

| Agent feature | Built on which kernel primitive |
|---|---|
| Conversation history | content-addressed `Change`s in a DAG (one `objectActor` per agent) |
| User / assistant turn | `Block` with `text` content and a style tag |
| Tool call / result | `Block` with `custom` content and a `tool_use_id` for pairing |
| Compaction | A `compaction_summary` block that points at `firstKeptBlockId`. Older blocks remain in the DAG; the next ask just skips them |
| Tool registration | A scalar field on the agent listing `{name, description, target_prefix, target_action, bound_args}` — at call time the agent dispatches via `ctx.dispatchProgram(prefix, action, args)`. Any program is a potential tool |
| Memory | Separate `pinned_fact` / `milestone` objects with `owner` link back to the agent, `sourced_from_blocks` reference list. Survive compaction because they're independent objects with their own DAG |
| Identity-aware ingest | `/peer` objects carry `display_name`, `kind`, `trust_level`, `email`, `discord_id`. `/holdfast` tags inbound text with `[from {name} on {source}, trust={level}]` before reaching the model |
| Subagents | More `objectActor`s of `typeKey="agent"`, with a `spawn_parent` link back to the caller. Conversation, tools, memory, and compaction all "just work" because they're real agents |
| Block recall | A new `user_text` block that quotes a previous block (compacted or otherwise). Lands after the latest compaction's cut, so the model sees it on the next ask |

That's the entire picture. The agent doesn't have a database; the DAG is the database. The agent doesn't have a context manager; compaction blocks are the context manager. The agent doesn't have a job runner for subagents; rivet actors are the job runner. The agent doesn't have an artifact store; child agents *are* the artifacts.

### Example: solo agent

Agents store every prompt and response as changes in the DAG — content-addressed, replayable, syncable. Any peer can replay the conversation without an API key.

With Anthropic credentials configured (see [Anthropic plan setup](#anthropic-plan-setup-claude-promax) for the OAuth path, or set `ANTHROPIC_API_KEY` in your `.env`):

```
glon> /agent new analyst --system "You are a concise data analyst."
glon> /agent ask 9b2e What are the tradeoffs of event sourcing vs CRUD?
  assistant (847+312 tokens)
  Event sourcing trades write simplicity for read complexity. ...

glon> /agent inject c41a 9b2e       # inject analyst's full conversation into another agent
glon> /agent ask c41a What did the analyst get wrong?
```

### Example: subagent batch

`/agent.spawn` runs a parallel batch of child agents. Each child is a real agent object with its own conversation, its own tool dispatches, and its own DAG; the parent gets back a compressed `SpawnBatchResult` with one `SingleResult` per task, plus a list of `childAgentId`s for inspection.

```
glon> /task spawn c07aa4d3 '{
  "context": "looking at the codebase shape",
  "schema": {"type":"object","required":["findings"],"properties":{"findings":{"type":"array"}}},
  "tasks": [
    {"id":"a","agentTemplate":"explore","assignment":"map src/programs/handlers"},
    {"id":"b","agentTemplate":"explore","assignment":"map src/dag"}
  ]
}'

glon> /agent tree c07aa4d3
spawn tree rooted at c07aa4d3
· Graice [agent]  c07aa4d3
├─ ✓ explore-a [explore] task=a  child-12
└─ ✓ explore-b [explore] task=b  child-13
  2 subagent(s) total
```

Built-in templates: `task` (general worker, can spawn further), `explore` (read-only DAG bundle), `quick_task` (minimal, fast small model). Override or add your own:

```
glon> /agent create-template reviewer \
        --model claude-sonnet-4-20250514 \
        --system "Review the diff. Submit a list of findings via submit_result." \
        --spawns "" \
        --description "Code reviewer"

glon> /agent list-templates
agent templates:
  reviewer    [DAG abcd1234]
    model=claude-sonnet-4-20250514  spawns=(none)  Code reviewer
  task        [builtin]
    model=claude-sonnet-4-20250514  spawns=*       General-purpose worker agent. ...
  explore     [builtin]
    model=claude-sonnet-4-20250514  spawns=(none)  Read-only investigator. ...
  quick_task  [builtin]
    model=claude-haiku-4-20250414   spawns=(none)  Fast small-model worker for mechanical tasks.
```

Each child agent gets a `submit_result` tool bound to its own id. Per-task knobs: `timeoutMs` (cancel and mark `status=timeout`), `maxAttempts` (retry on timeout/error), `schema` (JSON Schema subset; violations surface as `is_error` tool_results so the model can self-correct, and the parent sees `status=schema_invalid`). Depth-capped via `GLON_AGENT_MAX_DEPTH` (default 4).

Progress is broadcast on `ctx.emit`: `spawn:start`, `spawn:child_created`, `spawn:child_done`, `spawn:complete` — useful for live UIs like [glonWorld](https://github.com/Geep5/glonWorld).

### Example: user-curated memory

Compaction skips old turns when context fills, but they remain in the DAG. `/agent recall` re-injects a specific block as a new user turn so the agent sees it on the next ask. Find the block id from `/agent history` (the timestamps line up with the visible turns) or from the search panel in [glonWorld](https://github.com/Geep5/glonWorld):

```
glon> /agent recall a3f8 7f141408
  Recalled user_text → new block 9c22d3a1
```

The new block content is `[Recalled user turn from 2024-…]:\nMy wife's name is Sarah. Save that.` — short framing so the model knows it's a deliberate recall. Truncates at 8 KB. Works on any block kind (text, tool_use, tool_result, compaction_summary).

The 3D viewer [glonWorld](https://github.com/Geep5/glonWorld) wraps this with a click-to-recall affordance and a search panel that scans every block's raw text — find a forgotten turn by phrase, click to bring it back into context.

### Example: Holdfast in action

Holdfast is the generic harness program. You configure it once with a name and a principal, and it wires an `/agent` with identity-aware ingest, a peer directory, durable memory, scheduled reminders, Google Workspace bridges, shell access, and subagent spawning. Inbound messages from any source (shell, Discord, future bridges) get tagged with `[from {name} on {source}, trust={level}]` before reaching the model.

```
glon> /holdfast setup --name Graice --principal-name Grant --principal-discord 123456789012345678
  Holdfast ready — Graice
  agent:     7f141408-… (created)
  principal: 9a3c5d20-… (created)
  tools:     peer_list, peer_get, peer_add, … (50 wired)

  Next: `/holdfast say hello`

glon> /holdfast say My wife's name is Sarah. Save that.
  Graice (to Grant)
  Saved. wife_name=Sarah.
  (one tool call: memory_upsert_fact)

# Restart the daemon, start a fresh session — the fact survives.
glon> /holdfast say What's my wife's name?
  Graice (to Grant)
  Sarah.
  (no tool calls — served from her memory digest)
```

**Per-user configuration in a separate repo.** The harness ships with a generic default system prompt that substitutes the configured names into a sensible "executive assistant" template. For your own personality, system prompt, and bootstrap script, keep that in a separate repo that drives `/holdfast setup` over the daemon's HTTP dispatch endpoint with your specific `--name`, `--principal-*`, and `--system` overrides.

**How it survives compaction.** When the conversation crosses the auto-compact threshold, the harness's compactor runs a tool-using extraction pass first: facts go to `pinned_fact` objects, multi-turn arcs go to `milestone` objects (with `supersedes` chains for amendments). A short narrative summary covers the kept region. Both are objects in the DAG — every prior value is recoverable via `object_history`.

### Example: multi-instance chat

Two glon instances sync over HTTP — both end up with identical `.pb` files on disk.

```
# Server A                              # Server B
GLON_DATA=~/.glon-a npm run dev          GLON_DATA=~/.glon-b npm run dev

glon> /chat new general
glon> /chat send 4dfaa Hello from A!
glon> /remote push localhost:6421 4dfaa
                                         glon> /chat read 4dfaa
                                           # general
                                           00:13  local  Hello from A!
```

### Example: tic-tac-toe

The board is an object. Every move is a content-addressed change — tamper-evident and replayable.

```
glon> /ttt new
New game: a3f8b2c1-...

glon> /ttt move a3f8 4
   0 | 1 | 2
  ---+---+---
   3 | X | 5
  ---+---+---
   6 | 7 | 8
  O's turn  (move 2)

glon> /ttt history a3f8
  7f141408f07a  06:27:17  new game
  1eed89826411  06:27:37  #1 X -> position 4
  ...
  d71da0218bb3  06:27:49  X wins
```

## Anthropic plan setup (Claude Pro/Max)

`/agent` and `/holdfast` work with two kinds of Anthropic credentials:

- **API key** from [console.anthropic.com](https://console.anthropic.com) — set `ANTHROPIC_API_KEY` in your `.env`. Pay per token.
- **Claude Pro/Max subscription** — run `/auth login anthropic` once. Requests authenticate as the official `claude` CLI and are billed against your plan instead of API credits.

If both are configured, the OAuth credential wins.

### First-time login

1. **Start Glon and a shell.**
   ```bash
   npm run dev          # terminal 1 — RivetKit actor host
   npm run bootstrap    # first time only — seeds programs as objects
   npm run client       # terminal 2 — the shell you'll type into
   ```
2. **Start the OAuth flow.**
   ```
   glon> /auth login anthropic

     Open this URL in your browser:
     https://claude.ai/oauth/authorize?code=true&client_id=…

     Sign in with the Claude account that owns your Pro/Max plan.
     When approved, claude.ai will display a code (often as CODE#STATE).

     Paste it back here with:
       /auth login anthropic <code>
   ```
3. **Open the URL in your browser.** Sign in with the Claude.ai account that has the Pro/Max subscription, approve the requested scopes. claude.ai then shows a success page with a code — typically `CODE#STATE`. Copy that whole string.
4. **Paste it back into the shell.**
   ```
   glon> /auth login anthropic CODE#STATE
     Logged in. Token expires in 23h 58m.
     Stored in /home/you/.glon/auth.json
   ```

Every `/agent ask`, `/holdfast say`, compaction summary, and subagent call from now on routes through your plan.

### Inspecting and managing credentials

```
glon> /auth status
  Glon auth
  /Users/you/.glon/auth.json

  anthropic  oauth (Claude Pro/Max)
    access expires in 23h 58m
    sk-ant-o…7q3a

glon> /auth refresh         # force a token refresh now (rarely needed)
glon> /auth logout          # delete the anthropic credential
glon> /auth logout all      # delete every credential, remove auth.json entirely
```

Tokens auto-refresh in the background when within 5 minutes of expiry, and again on a 401 from the API. You only need `/auth refresh` if something looks wrong.

### Where credentials live

`${GLON_DATA}/auth.json` (default `~/.glon/auth.json`), mode `0600`, written atomically via `.tmp` + rename. Plain JSON; safe to inspect or delete by hand. **Never** synced to peers — unlike DAG objects, credentials are local-only.

Schema:
```json
{
  "version": 1,
  "credentials": {
    "anthropic": {
      "type": "oauth",
      "access": "sk-ant-oat…",
      "refresh": "sk-ant-ort…",
      "expires": 1735689600000
    }
  }
}
```

### Caveats

- **The OAuth path mimics the official `claude` CLI.** Anthropic could tighten its server-side checks at any time. If `/auth login` succeeds but agent calls start returning 4xx, the impersonation fingerprint (User-Agent, beta strings, X-Stainless headers) probably needs a refresh — see `CLAUDE_CODE_VERSION` and the surrounding constants in `src/programs/handlers/agent.ts`. If the authorize page itself rejects with HTTP 400 "invalid request format", the OAuth client config (redirect URI, scopes) has drifted — fix the constants in `src/programs/handlers/auth.ts`.
- **It's your account on the line.** Use the OAuth path within the bounds of what your Pro/Max subscription allows. If in doubt, use an API key instead.
- **The pasted code is single-use.** If the token exchange fails, run `/auth login anthropic` again to get a fresh URL; the previous code is burned even on error.
- **The daemon picks the token up automatically.** If you're running `scripts/daemon.ts` (Discord poller, reminder ticks, headless dispatch), it reads from the same `auth.json` and refreshes through the same actor. No restart needed after `/auth login`.

## Discord bridge setup

1. **Create the application.** Visit [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. The application name is what users see as the bot's handle in Discord — name it what you want your assistant to be called (e.g. "Graice").
2. **Grab the bot token.** Bot tab → **Reset Token** → copy into `.env` as `DISCORD_BOT_TOKEN=...`. The token is the ONLY credential the bridge uses; nothing is persisted to the DAG.
3. **Invite the bot.** OAuth2 → URL Generator → scope `bot`, permissions `Send Messages` + `Read Message History`. Open the URL and add it to a guild you share with your user, or DM it directly.
4. **Find your Discord user id.** Settings → Advanced → enable **Developer Mode**. Then right-click your name anywhere → **Copy User ID**. That 18-digit snowflake goes into `/holdfast setup --principal-discord <id>`.
5. **DM the bot.** Any future messages to the bot flow through `/discord`'s 3-second poll into `/holdfast.ingest`, then the agent's reply is posted back. The first poll processes messages from the last 15 minutes so your onboarding "hi" isn't dropped. The bridge also holds a Gateway WebSocket to Discord so the bot shows online — presence-only; messages still flow via the REST poll.

**Note:** Discord's REST API doesn't let bots list their own DM inbox, so every peer must be registered with their `discord_id` up front. You can add more people later:

```
glon> /peer add display_name=Sarah kind=human trust_level=family discord_id=987654321098765432
```

## Headless operation

For background use (Discord polling, scheduled reminders, agent memory writes, subagent runs) without a shell:

```bash
npx tsx scripts/daemon.ts
```

This loads every program, starts their actor instances, and exposes a local HTTP dispatch endpoint on `127.0.0.1:6430` for `POST /dispatch {prefix, action, args}`. Every program's `actor.actions.*` is callable over this endpoint. Example:

```bash
curl -sS -X POST http://127.0.0.1:6430/dispatch \
  -H 'Content-Type: application/json' \
  -d '{"prefix":"/holdfast","action":"say","args":["What is on my calendar today?"]}'
```

The dispatch endpoint is also what [glonWorld](https://github.com/Geep5/glonWorld) uses to recall compacted blocks back into an agent's context, and what external orchestrators can drive without holding API keys themselves.

## The protocol

**Change DAG** — every mutation is a `Change` protobuf, content-addressed by SHA-256, linked to parents via DAG edges. Operations: `ObjectCreate`, `FieldSet`, `FieldDelete`, `ContentSet`, `ObjectDelete`, plus block tree ops (`BlockAdd`, `BlockRemove`, `BlockUpdate`, `BlockMove`).

**Sync** — typed protobuf `Envelope` messages between actors. Pull-based: advertise heads, push what's missing.

**Computed State** — derived by replaying the DAG. Never the source of truth. The SQLite index is a cache; delete it and it rebuilds from disk.

**Snapshots** — checkpoint full state into the DAG. Replay skips everything before the snapshot. History is never lost.

## Project structure

```
proto/glon.proto              the protocol
src/
  crypto.ts                   SHA-256 content-addressing
  proto.ts                    typed encode/decode
  dag/                        change creation, topological sort, state computation
  disk.ts                     per-object .pb file storage
  env.ts                      .env loader (zero-dep, side-effect import)
  endpoint.ts                 port lockfile + resolver shared by all entry points
  index.ts                    actor definitions (object, store, program)
  bootstrap.ts                seed source files + programs as objects
  client.ts                   CLI shell (pure program loader)
  programs/
    runtime.ts                module bundler, actor lifecycle, validators
    handlers/                 one file per program (21 today)
scripts/
  daemon.ts                   headless host: load programs, run actors, HTTP dispatch
  dispatch.ts                 thin HTTP client for the daemon
  read-agent-blocks.ts        diagnostic: dump an agent's conversation blocks
test/
  dag.test.ts                 DAG replay, snapshots
  runtime.test.ts             program actor lifecycle
  agent-compaction.test.ts    compaction view, cut-point, summary block
  agent-tooluse.test.ts       tool registration + tool-use loop
  agent-spawn.test.ts         core subagent spawning
  agent-spawn-advanced.test.ts schema validation, timeout, retry, progress events, tree
  agent-recall.test.ts        block recall framing + truncation
  task-program.test.ts        /task CLI dispatch + Holdfast wiring
  peer.test.ts                peer CRUD + find-or-create
  remind.test.ts              scheduling and tick
  discord.test.ts             bridge polling + send
  holdfast.test.ts            ingest wrapping + setup idempotency
  web.test.ts                 HTTP client + SSRF guard
  introspection.test.ts       agent reads its own source via /crud
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for internals: DAG replay, actor state model, sync handshake, program context, and the security model.

## Companion projects

- **[glonWorld](https://github.com/Geep5/glonWorld)** — interactive 3D viewer for any glon environment. Visualizes objects, programs, the agent's full conversation, memory-surfaced blocks (glow), subagent lineage (amber arcs), and adds a click-to-recall affordance for user-curated memory management.

## License

MIT
