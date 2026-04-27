# glon — Architecture

## Layers

```
+---------------------------------------------------------------+
|  Programs (src/programs/)                                     |
|  EVERYTHING is a program: help, CRUD, inspect, IPC, agent,    |
|  tic-tac-toe, chat, GC, accounts, P2P sync, graph.            |
|  Even /help is just a program loaded from the store!          |
+------------------------------+--------------------------------+
|  Shell (src/client.ts)       |  Bootstrap (src/bootstrap.ts)  |
|  Pure program loader         |  Seed source & programs        |
|  ZERO built-in commands      |  as glon objects               |
+------------------------------+--------------------------------+
|  Store Actor (coordinator)                                    |
|  SQLite index: objects, changes, DAG edges, links             |
|  Creates/destroys object actors                               |
+------------------------------+--------------------------------+
|  Object Actors (one per entity)                               |
|  Ephemeral vars: recomputed from disk on every wake           |
|  Sync protocol: advertiseHeads, pushChanges, getChanges       |
|  IPC: sendMessage, receiveMessage                             |
+------------------------------+--------------------------------+
|  Change DAG (src/dag/)                                        |
|  Topological sort, state computation, content-addressing      |
+------------------------------+--------------------------------+
|  Disk (src/disk.ts)          |  Proto (src/proto.ts)          |
|  ~/.glon/changes/<oid>/*.pb  |  Typed encode/decode           |
+------------------------------+--------------------------------+
```

## The Change DAG

Every mutation is a `Change` — an immutable protobuf message.

```
Change {
  id: bytes           SHA-256 of the wire bytes (id field zeroed)
  object_id: string   stable UUID of the object
  parent_ids: bytes[] DAG edges to parent changes
  ops: Operation[]    mutations in this change
  timestamp: int64    unix ms
  author: string      device/user identifier
}
```

**Content-addressed.** `id = SHA-256(encode(change with id zeroed))`.
Same mutation always produces the same hash.

**DAG structure.** Parent edges form the graph. No parents = genesis.
Multiple parents = merge of concurrent changes. Heads = changes with
no children.

**State = replay.** Current state is computed by topological sort
(Kahn's BFS, ties broken by hex id) from genesis to heads, applying
operations in order:

| Operation | Effect |
|---|---|
| `ObjectCreate` | Set type key, created timestamp |
| `FieldSet` | Set a typed field (values can nest via ValueMap/ValueList/ObjectLink) |
| `FieldDelete` | Remove a field |
| `ContentSet` | Set raw byte content |
| `ObjectDelete` | Tombstone flag |
| `BlockAdd/Remove/Update` | Block tree mutations (TextContent or CustomContent) |

## Sync Protocol

### P2P Architecture

The sync system operates peer-to-peer without central servers:

**Discovery:** mDNS for local network, manual addition for cross-network
**Transport:** HTTP with protobuf `Envelope` messages
**Selection:** Bloom filters for efficient content advertising
**Trust:** Reputation scoring based on successful syncs

### Messages

| Message | Purpose |
|---|---|
| `HeadAdvertise` | "Here are my heads for this object" |
| `HeadRequest` | "Send me changes between these ancestors and these heads" |
| `ChangePush` | "Here are changes you're missing" (topologically sorted) |
| `ChangeRequest` | "Send me these specific changes by hash" |
| `ObjectSubscribe` | "Notify me when this object changes" |
| `ObjectEvent` | "This object changed, here are the new heads + changes" |
| `AppMessage` | Free-form IPC between objects |
| `BloomFilter` | "Here's what content I have" (space-efficient) |
| `PeerAnnounce` | "I'm a glon peer at this endpoint" (mDNS) |

### Sync Handshake

1. Peers exchange Bloom filters (probabilistic content sets)
2. Compute likely differences (what each might be missing)
3. Request specific missing changes by hash
4. Push confirmed missing changes to the peer
5. Both recompute state from the merged DAG
6. Update peer reputation based on sync success

### Peer Management

```typescript
interface Peer {
  id: string;           // SHA-256 of endpoint
  endpoint: string;     // HTTP URL
  lastSeen: number;     // Unix timestamp
  reputation: number;   // 0-100 score
  bloomFilter: Uint8Array;  // Compressed content set
}
```

Peers track reputation: successful syncs increase score, failures
decrease. High-reputation peers are preferred for sync operations.

## Storage

```
~/.glon/
  changes/
    <object-id>/            one subdirectory per object
      <sha256-hex>.pb       raw protobuf wire bytes
```

The `.pb` files are the source of truth. The SQLite index in the
store actor is derived — it tracks objects, changes, DAG edges,
and inter-object links for efficient queries. Delete the index
and it rebuilds from disk.

Per-object subdirectories keep actor wake O(own changes) — an actor
reads only its own directory, not the full change set.

## Actor State Model

Follows Rivet's `state` vs `vars` pattern:

```
state (persistent)           vars (ephemeral)
────────────────────────────  ────────────────────────────
id (object UUID)             typeKey
inbox (IPC messages)         fields, content, blocks
outbox (IPC messages)        blockProvenance
                             deleted, createdAt, updatedAt
                             headIds, changeCount
```

**`state`** is persistent — survives sleep, crash, restart. Holds only
the object's UUID and IPC message queues. Minimal by design.

**`vars`** is ephemeral — recomputed via `createVars` every time the
actor wakes. Reads all changes from disk for this object, replays
the DAG via topological sort, and produces fresh computed state.
No stale cache. The DAG on disk is always truth.

**`commitChange`** (the mutation path) writes the new change to disk,
then reloads `vars` by recomputing from the full DAG. The actor
never holds computed state that's out of sync with disk.

**Rivet actors over HTTP.** Each object actor is a globally-addressable
endpoint that wakes on demand, hibernates when idle, survives crashes.
The `createVars` hook runs on every wake, so computed state is always
fresh from disk.

**Store actor:**
- SQLite index for cross-object queries
- Link index: scans fields for `ObjectLink` values, maintains `links` table
  for forward/reverse link queries and graph traversal
- Creates/destroys object actors via `c.client()`
- Validates existence for IPC routing

## Programs

Programs are glon objects with type `program`. They sync between
instances, have full change history, and are individually addressable.

### Object Shape

| Field | Type | Purpose |
|---|---|---|
| `name` | string | Display name ("Agent") |
| `prefix` | string | Shell command prefix ("/agent") |
| `commands` | ValueMap | Subcommand names to descriptions |
| `manifest` | ValueMap | Module filenames → base64 source |

### Compilation

The `manifest` maps filenames to source strings. At load time,
the runtime feeds them into esbuild's virtual filesystem plugin and
produces a single CJS bundle. The entry module `export default`s
a `ProgramDef`:

```typescript
export default {
  handler: async (cmd, args, ctx) => { ... },  // CLI handler
  actor: { ... },                                // stateful actor (optional)
  validator: (changes) => { ... },               // DAG validator (optional)
  validatedTypes: ["character", "item"],         // types to validate (optional)
};
```

Simple programs (ttt, chat, agent) have one module. Complex programs
(godly) have many. Same compilation path — no special cases.

**Discovery.** The shell calls `store.list("program")` at startup,
extracts each program's manifest, bundles the modules, and compiles
handlers. **ZERO hardcoded commands** — even `/help` is just another
program loaded from the store. The shell is a pure program loader.

**Execution.** When you type `/agent ask 9b2e Hello`, the shell
matches the `/agent` prefix, calls the handler with
`("ask", ["9b2e", "Hello"], ctx)`. The handler validates, calls
actor actions, and prints output.

### Program Actors

Programs that export an `actor` definition get a managed lifecycle:

- `createState()` — initial persistent state
- `onCreate(ctx)` / `onDestroy(ctx)` — lifecycle hooks
- `actions: { name: (ctx, ...args) => result }` — RPC endpoints
- `tickMs` + `onTick(ctx)` — periodic tick loop

The runtime creates one actor instance per program. Programs manage
their own sub-instances (e.g. active fights) in state. The kernel's
`programActor` provides RPC dispatch and event broadcast.

### ProgramContext

The context object passed to all program code:

| Field | Purpose |
|---|---|
| `store` | Actor client for CRUD, list, search |
| `state` | Program's persistent state (read/write) |
| `emit(channel, data)` | Broadcast structured events |
| `programId` | This program's glon object ID |
| `objectActor(id)` | Typed access to any object actor |
| `proto` | Encode/decode helpers (`stringVal`, `mapVal`, etc.) |
| `print(msg)` | Output to the shell |

### Validators

Programs register validators for specific object types. When
`pushChanges` receives synced changes, the validator runs **before**
writing to disk. Rejected changes throw and are not persisted.

### Typed Output (Events)

The kernel's `programActor` has a `programEvent` Rivet event.
Programs call `ctx.emit(channel, data)` which broadcasts
`{ programId, channel, data }` to all subscribers.

### Source Layout

```
src/programs/
  runtime.ts                 module bundler, actor lifecycle, validators
  handlers/
    help.ts                  list available programs (even this is a program!)
    crud.ts                  CRUD operations on any object
    inspect.ts               DAG inspection (history, changes, heads, sync)
    ipc.ts                   inter-object messaging (inbox/outbox)
    graph.ts                 object graph traversal and link queries
    ttt.ts                   tic-tac-toe
    chat.ts                  chat rooms
    agent.ts                 LLM agent: conversation, tool use, auto-compaction, memory digest
    memory.ts                pinned_fact + milestone objects, recall/digest, validator
    peer.ts                  identity + trust for people and agents
    remind.ts                scheduled actions (DM, agent-compose, email)
    discord.ts               Discord bridge: Gateway WS for online presence + REST poll for DMs -> /holdfast.ingest
    holdfast.ts              generic agent harness: identity-aware ingest + tools, configured per setup
    web.ts                   HTTP client with SSRF guard
    gc.ts                    reachability-based garbage collection
    accounts.ts              multi-user auth & per-object permissions
    sync.ts                  P2P synchronization & discovery
scripts/
  daemon.ts                  headless host: no stdin, HTTP dispatch endpoint
  dispatch.ts                thin HTTP client for the daemon
  read-agent-blocks.ts       diagnostic: dump an agent's conversation blocks
```

### Daemon vs Shell

Two entry points share the same program loader:

- `src/client.ts` — interactive REPL. Reads stdin, prints to stdout. Good for
  exploring, debugging, ad-hoc chat with an agent.
- `scripts/daemon.ts` — headless. Same program set, no stdin, exposes
  `POST /dispatch {prefix, action, args}` on `127.0.0.1:6430`. Good for running
  the Discord bridge, the reminder tick loop, or anything that should keep running
  without a terminal attached.

Both connect to the same actor registry on `:6420`. Running them in parallel is
valid — the actors hold their own state, clients only dispatch.

## Agents: Conversation, Tools, Compaction, Memory

`/agent` is a program that treats an `agent`-typed glon object as the durable
home of a conversation. Every prompt, assistant text, `tool_use`, `tool_result`,
and `compaction_summary` is a block in that object's DAG.

### Conversation view

The model-facing view of the conversation is derived, not stored:

1. Classify blocks into typed items (user_text, assistant_text, tool_use,
   tool_result, compaction).
2. If a `compaction_summary` block exists, filter to items at or after
   `first_kept_block_id` and inject the latest summary into the system prompt
   as `<conversation-summary>`.
3. Group contiguous same-role items into Anthropic-shaped turns.

Pre-compaction blocks stay in the DAG. Any peer replaying the history can ignore
compaction blocks and see the full original conversation.

### Tool registration and `bound_args`

Agents register tools as ValueMap entries on their `tools` field. Each tool
carries a target (`target_prefix`, `target_action`) that dispatches to another
program's actor action, plus an optional `bound_args` map. At tool-use time the
dispatcher merges `bound_args` **over** the model's input before calling the
target — so callers can bind identity (e.g. `owner = agentId`) that the model
cannot spoof by passing its own value.

This turns registered tools into partially-applied program actions: the model
provides the task-specific arguments, the registrar provides the identity-
scoped ones.

### Compaction (two-stage)

Before each ask, `shouldAutoCompact` estimates the effective system prompt +
messages + memory digest against `contextWindow - reserveTokens`. Over threshold
triggers `doCompact`:

- **Stage A (opt-in, `memory_extraction_enabled`):** a private tool set exposes
  `/memory.upsert_fact`, `upsert_milestone`, `amend_milestone`, `list_*`, and
  `recall`, each with `bound_args = { owner: agentId }`. A tool-using summariser
  reads the pre-cut region, inspects existing memory first, then writes structured
  facts and milestones directly into the store. Failures degrade to Stage B.
- **Stage B (always):** single LLM call produces a narrative `compaction_summary`
  block covering the kept region. Knows Stage A ran, so it focuses on arc
  (goal / progress / next steps) rather than re-listing facts memory already holds.

An Anthropic context-overflow during an ask triggers a one-time mid-flight
compaction + retry.

## Memory: Facts and Milestones

`/memory` gives agents two object types for durable knowledge that survives
compaction and syncs between instances like any other glon object.

### Object types

```
pinned_fact
  owner: ObjectLink<agent>
  key: string                 unique per (owner, key)
  value: string
  confidence: low | med | high
  sourced_from_block_id?: string

milestone
  owner: ObjectLink<agent>
  title: string
  narrative: string
  topics: string[]
  peers: ObjectLink<peer>[]
  supersedes: ObjectLink<milestone>[]   # amendment/replacement chain
  status: active | completed | superseded
  confidence: low | med | high
  sourced_from_blocks: string[]
  started_at / ended_at: int (ms)
```

### Write paths

- `upsert_fact(owner, key, value, ...)` — one row per `(owner, key)`. Same key
  replaces value in place via `FieldSet`; prior value stays in `object_history`.
- `upsert_milestone(owner, {...}, supersedes?)` — creates a new milestone and
  flips each `supersedes` target's `status` to `superseded`.
- `amend_milestone(id, {...})` — `FieldSet` on specific fields of an existing
  milestone. Every amendment is a `Change` in that milestone's DAG.

Local writes go through these action helpers (input validation). Peer-synced
writes hit a registered validator that enforces required fields on create
batches and enum shape on amendments. The validator is registered on
`validatedTypes: ["pinned_fact", "milestone"]` and fires before disk write
in `pushChanges`.

### Read paths

- `list_facts(owner, key?)`, `list_milestones(owner, {status?, topic?, peer_id?, limit?})` — enumerate.
- `recall(owner, {query?, topics?, peer_ids?, time_range?})` — scoped search.
- `digest(owner)` — markdown digest ready for system-prompt injection,
  superseded milestones excluded, capped at `max_facts=40 / max_milestones=8`.

When an agent has `memory_digest_enabled: true`, `runAsk` prepends the digest
to the effective system prompt. Facts and milestones the model just wrote or
amended are visible on the next turn. `shouldAutoCompact` also counts digest
tokens in its threshold estimate.

### Why objects, not a flat summary

One `pinned_fact` object per `(owner, key)` means an update is one `FieldSet`
op, not a blob rewrite. The full edit chain is recoverable from `object_history`.
Milestones supersede via `ObjectLink`, which the store's link index tracks in
both directions — "what replaced milestone X?" is a cheap reverse-link query.

### Ownership model

Everything in `/memory` is agent-scoped through the `owner` `ObjectLink` field.
Two agents sharing a glon store have independent memory. An agent reading its
own store is a regular `object_list type_key=pinned_fact/milestone` query; no
special read path.


## Security Model

### Accounts & Authentication

Users authenticate with username/password, stored as bcrypt hashes.
Sessions use JWT tokens with configurable expiry.

```typescript
interface Account {
  id: string;              // UUID
  username: string;        // Unique identifier
  passwordHash: string;    // bcrypt hash
  role: "admin" | "user" | "guest";
  createdAt: number;       // Unix timestamp
  permissions: Permission[];
}
```

### Permissions

Object access is controlled by ownership and explicit permissions:

| Permission | Scope | Effect |
|---|---|---|
| `read` | Per-object | View object state and history |
| `write` | Per-object | Modify fields and content |
| `delete` | Per-object | Soft-delete the object |
| `admin` | Global | All operations on all objects |

Programs can only modify objects they created or have permission
to access. The store actor enforces permissions before mutations.

### Object Ownership

Every object tracks its owner (the account that created it):

```typescript
interface ObjectMetadata {
  ownerId: string;         // Account ID
  createdBy: string;       // Program that created it
  sharedWith: string[];    // Account IDs with access
}
```

## Garbage Collection

GC is a tool, not a policy. The `/gc` program provides protection,
link-based reachability, and collection. It has no opinions about
retention — programs decide what to protect by calling GC's actor
actions (`protect`, `unprotect`, `isRetained`, `getRetained`).

### Algorithm

1. **Roots:** explicitly protected object IDs (set by programs or users)
2. **Reachability:** BFS from roots following outbound links in the
   object graph — everything reachable from a root is retained
3. **Collect:** delete objects that are neither roots nor reachable

```
/gc protect <id>     # mark as root (transitive via links)
/gc unprotect <id>   # remove root
/gc run [--dry-run]  # collect unreachable objects
/gc status           # show roots and reachability
```

## Data Flow

**Write:** Shell → Object Actor → create Change → write .pb to disk
→ reload vars from DAG → broadcast event → Store indexes in SQLite

**Read:** Shell → Store → Object Actor (vars, computed from disk)
or SQLite (list queries)

**Wake:** Actor wakes → `createVars` runs → reads all changes from
disk for this object → replays DAG → vars populated → ready

**Sync:** Actor A.getAllChangeIds() → Actor B.getAllChangeIds() →
set difference → exchange missing changes → both reload vars

## Extensibility

Programs express complex state without modifying `glon.proto`:

### Recursive Values

`Value` is recursive. `ValueMap` and `ValueList` contain `Value`s,
so programs can express arbitrarily nested structures using only
`FieldSet` operations:

```
Value {
  oneof kind {
    string     string_value  = 1;
    int64      int_value     = 2;
    double     float_value   = 3;
    bool       bool_value    = 4;
    bytes      bytes_value   = 5;
    StringList list_value    = 6;
    ValueMap   map_value     = 7;   // nested key-value
    ValueList  values_value  = 8;   // heterogeneous typed list
  }
}
```

glon never interprets these structures. The DAG replay code does
`state.fields.set(key, value)` — it doesn't look inside the Value.
Programs define their own conventions on top of the typed primitives.

### Custom Block Content

`BlockContent` has an escape hatch for program-defined block types:

```
CustomContent {
  string content_type          = 1;  // e.g. "image", "table", "embed"
  bytes  data                  = 2;  // program-encoded payload
  map<string, string> meta     = 3;  // fallback display metadata
}
```

glon stores, content-addresses, syncs, and replays custom blocks
through the standard Change DAG. Peers that don't understand a
`CustomContent` block fall back to displaying the `meta` map.

### Why Not Program-Defined Protobufs?

**Custom Operations (programs bring their own reducers):** glon
would need each program's code to replay the DAG. A peer without
the program couldn't compute state. Breaks "any peer can recompute
from changes alone."

**Custom Value schemas (opaque bytes with type URLs):** glon
could carry but not inspect the data. Loses field indexing, value
queries, and state diffing.

Recursive Value avoids both traps: glon always replays the DAG
(Operations are unchanged), always inspects values (typed all the
way down), and programs compose arbitrary structures from a fixed
set of primitives. `glon.proto` is stable.
