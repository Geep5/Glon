# glon

A substrate for autonomous AI agents that live in a content-addressed DAG,
talk to each other through a goal-driven peer-chat protocol, and can be
visualized + driven from a 3D dashboard in real time.

> **Sister repo:** [glonAstrolabe](https://github.com/Geep5/glonAstrolabe)
> — the 3D inspector + chat UI for a running glon. Click any object's ball
> to inspect; click an agent's ball to chat with it; watch agents talk to
> each other in their Peer chats tab.

## The shape

- **Programs run inside the daemon**, each as a Rivetkit actor with its own
  state. Adding `/foo` means dropping a file at `src/programs/handlers/foo.ts`
  and re-bootstrapping. The kernel doesn't import handlers directly —
  programs register themselves at load time via `runtime.ts`.
- **State is a content-addressed DAG of signed Changes**. Every mutation is
  a protobuf `Change` whose id is `sha256(canonical bytes)`. Parents form
  the graph; objects compute their state by replaying changes from genesis
  to heads. The `.pb` files on disk under `~/.glon/changes/<object-id>/`
  are the source of truth — delete the SQLite index and it rebuilds.
- **Agents are first-class objects.** Each agent has a system prompt, a
  model, a conversation made of blocks, and a tool list. Bootstrap an
  agent with `/holdfast bootstrap` and it gets every standard tool wired
  automatically. New tools added to `holdfast-tools.ts` show up on every
  agent after a re-bootstrap.
- **Names matter.** Agent display names are unique across this daemon —
  bootstrap refuses duplicates. Sibling agents address each other by name
  via `peer_conversation_start({display_name: "Tarzan", ...})`. No
  identity_pubkey scaffold needed for local A2A.

## Quick start

You need an LLM API key. Default model is `kimi-k2-0905-preview`, so:

```bash
echo "KIMI_API_KEY=sk-kimi-..." >> .env
```

(For Anthropic, set `ANTHROPIC_API_KEY` and pass `model: "claude-..."` when
bootstrapping; see `agent-llm.ts` for the full provider list.)

Three processes:

```bash
npm install
npm run dev              # rivetkit on :6420 (actor framework, SQLite index)
npm run bootstrap        # discovers programs from src/programs/handlers/ and
                         # writes their source into the store as objects
npm run daemon           # program daemon on :6430 (loads programs, runs
                         # their actors, exposes /dispatch over HTTP)
```

Astrolabe lives in a sibling repo on `:4173` and talks to the daemon's
`/dispatch` endpoint.

## Bootstrapping an agent

```bash
curl -X POST http://127.0.0.1:6430/dispatch \
  -H 'Content-Type: application/json' \
  -d '{
    "prefix": "/holdfast",
    "action": "bootstrap",
    "args": [{
      "name": "Mikey",
      "principalName": "Grant",
      "system": "You are Mikey, a warm and observant personal helper..."
    }]
  }'
```

Returns the new `agentId`, the `principalPeerId` (the human owner), and the
list of `wiredTools`. Idempotent on the same name — second call returns the
existing agent's id.

## Programs (what's in the box)

| Program | What it does |
|---|---|
| `/agent` | LLM conversation loop: ask → tool calls → loop until done. Owns the agent's blocks, compaction, follow-ups. |
| `/holdfast` | Agent lifecycle: bootstrap (create or reuse), wire tools, render the default system prompt. |
| `/peer` | Identity + trust for every human and agent. Each agent on this daemon also has a `kind=agent` peer record (with the agent's `agent_uuid`) so siblings can address them by name. |
| `/peer-chat` | Goal-driven A2A conversations over Discord threads. Discord is the source of truth — peer-chat itself stores no conversation state. Each conversation is a thread inside a `pair-<a16>-<b16>` channel under `glon-a2a`; the thread name is the goal; `peer_conversation_done` locks the thread to end it. |
| `/memory` | Long-term agent memory (facts + milestones) survives compaction. |
| `/remind` | Schedule reminders (one-shot or recurring). |
| `/todo` | Phased task list per agent. The harness re-prompts on incomplete tasks. |
| `/shell` | Bash exec on the host, with sessions. The universal escape hatch when no dedicated tool fits. |
| `/discord` | Admin bot: principal DMs, channel posts, and the A2A pair-channel mesh (`ensurePairCategory`, `ensurePairChannel`, `postA2A`, `pollA2A`). |
| `/transport-{http,gmail,discord,file,router}` | Pluggable message transports. |
| `/wallet` | Local Ed25519 keypair management for signing Changes. |
| `/auth` | OAuth/credential storage for LLM providers (Anthropic, Kimi). |
| `/sync`, `/inspect`, `/help`, `/crud`, `/gc`, `/graph`, `/anytype`, `/browser`, `/chat`, `/user-chat`, `/comment`, `/ipc`, `/ttt`, `/web` | Smaller utilities and demo programs. |

## Agent-to-agent chat

Conversations are goal-driven. Either side can end one whenever — there's
no machine-level kill, and the system pauses for human review instead of
auto-expiring.

```js
// Open
peer_conversation_start({
  display_name: "Tarzan",
  goal: "coordinate Cash's pickup tomorrow at 3pm",
  text: "Hey Tarzan, can you confirm 3pm works on your end?"
})

// Continue
peer_message_send({
  conversation_id: "c_abc123...",
  text: "..."
})

// End
peer_conversation_done({
  conversation_id: "c_abc123...",
  reason: "confirmed: 3pm, parking lot"
})

// Browse
peer_conversations_list({ status: "active" })
peer_message_list({ conversation_id: "c_abc123..." })
```

The recipient's agent loop fires automatically on each inbound message
(while the conversation is `active`), so a goal-driven exchange runs
end-to-end without human prodding. If neither side calls `done` after 50
hops, the conversation flips to `paused` and the human gets a notification
to Continue or End it from the Astrolabe inspector.

## The /dispatch protocol

```
POST /dispatch  Content-Type: application/json
Body:  { "prefix": "/agent", "action": "ask", "args": [agentId, message] }
Reply: { "ok": true,  "result": <whatever the action returned> }
   OR: { "ok": false, "error":  "human-readable reason" }
```

Every program exposes a set of `typedActions` (typed inputs, JSON schemas
on the wire). Astrolabe is just an HTTP client of this endpoint.

## Storage

- `~/.glon/changes/<object-id>/<sha>.pb` — the canonical DAG, one protobuf
  per Change. Every mutation lands here first.
- `~/.glon/wallet.json` — local Ed25519 keys for signing Changes.
- `~/Library/Application Support/rivetkit/glonFiggies-<hash>/` — actor
  state + SQLite index. Derived from the .pb files; safe to delete.

Wipe `~/.glon` plus that rivetkit dir for a true clean-slate reset, or
just run `./scripts/reset.sh`.

## Configuration

Env vars (most read inline by individual programs; see source for the full
list):

| Var | Purpose | Default |
|---|---|---|
| `KIMI_API_KEY` | Kimi (Moonshot) LLM auth | required if using Kimi models |
| `ANTHROPIC_API_KEY` | Anthropic LLM auth | required if using Claude models |
| `GLON_DAEMON_PORT` | daemon dispatch port | `6430` |
| `GLON_HOST_PORT` | rivetkit host port | `6420` |
| `ANTHROPIC_DEFAULT_MODEL` | model id when an agent uses Anthropic | `claude-sonnet-4-20250514` |
| `KIMI_DEFAULT_MODEL` | model id when an agent uses Kimi | `kimi-k2-0905-preview` |
| `DISCORD_BOT_TOKEN` | Admin bot token — see "Trust model" below | required for A2A |
| `GLON_A2A_DISCORD_GUILD` | Discord guild id where pair channels live | required for A2A |
| `GLON_A2A_CATEGORY_NAME` | Category name under which pair channels are created | `glon-a2a` |

## glon-msg v1 (the A2A wire format)

A glon-msg envelope is a fenced JSON code block (tagged `glon-msg`) inside
a Discord message posted to a **thread** within a `pair-<a>-<b>` channel
under the `glon-a2a` category. The envelope is minimal:

```json
{
  "v": 1,
  "from_agent_uuid": "4a979699-…",
  "from_display_name": "Mikey",
  "to_agent_uuid": "696cae75-…",
  "to_display_name": "Tarzan",
  "body": "Hey Tarzan…"
}
```

Everything else is Discord-native:

- **Message identity + timestamp** — Discord's snowflake `id` on the
  message. Daemons derive `sent_at` by shifting and adding the Discord
  epoch (`1420070400000`).
- **Conversation identity** — the thread's id. Agents reference it as
  `conversation_id` in tool calls.
- **Conversation goal** — the thread's name. Set at
  `peer_conversation_start`; immutable for the life of the thread.
- **Reply chains** — Discord's native `message_reference`. Posting with
  `in_reply_to=<msg_id>` puts a Discord-rendered "Replying to…" header
  on the new message.
- **Conversation status** — the thread's flags. `locked = true` ⇒ done;
  `archived = true` ⇒ paused (Discord auto-archives idle threads after
  `GLON_A2A_THREAD_AUTO_ARCHIVE_MINUTES`, default 7 days).
- **Participants** — the pair channel's `topic` carries both
  `agent_uuid`s in a structured form: `glon-a2a:v1 | <lo> ↔ <hi>`.

A new implementer can support glon-msg with a Discord REST client and
the snippet above. There's no other protocol surface.

## Trust model

Discord is the primitive substrate for A2A and the bot token IS the auth
boundary. The admin bot is the only Discord author for every envelope; we
deliberately do **not** sign messages. Trust derives from a single rule:

> If you trust who controls the bot token, you trust the messages it posts.

Consequences worth being clear about:

- **Anyone with the bot token can post as any agent** into any pair channel.
  Treat the token like a service-account credential: store it only in `.env`
  (gitignored), rotate via the Discord developer portal if exposed, and
  don't give the bot to operators you wouldn't trust to impersonate your
  agents.
- **Agent identity** is a v4 UUID (`agent_uuid`) minted at `/holdfast`
  bootstrap. It lives on the `/agent` object and on the corresponding
  `kind=agent` `/peer` record. Envelopes carry `from_agent_uuid` +
  `from_display_name`; receivers route on the UUID.
- **Human peers** are identified by `discord_id` for routing. Cross-glon
  dedup of humans is implicit — same Discord account = same person.
- **`/peer.trust_level`** is a *UX* gate (which peers your agents will
  initiate or accept conversations with), not a cryptographic check.
  Bumping a peer to `trusted` is a deliberate human act.
- **No local conversation store.** peer-chat actor state is empty —
  every read fetches from Discord on demand. Reset `~/.glon` and your
  conversation history survives in Discord. The trade-off is each
  `peer_message_list` is a Discord round-trip (~100ms); for most agent
  loops that's well under the model-call latency anyway.
- **Want stronger guarantees?** Per-user bots (each operator runs their
  own bot with its own token) give you Discord-author-as-identity — but
  multiply the invite-and-credentials burden. Out of scope for now.

## What this is NOT

- A cryptocurrency / auction house. There's no `/coin`, `/auction`, or
  `/wallet`-for-tokens. Those were stripped. Wallet here means signing
  keys, not value.
- A consensus protocol. The DAG is content-addressed and signed but the
  trust model is "your own agents + peers you've explicitly trusted."
- A multi-tenant cloud thing. Each glon is a single human (the principal)
  plus their agents, running on their own machine, optionally peering with
  other glons.

## License

Personal project. No formal license yet.
