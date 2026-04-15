# Glon — Architecture

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
|  ZERO built-in commands      |  as Glon objects               |
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
| `PeerAnnounce` | "I'm a Glon peer at this endpoint" (mDNS) |

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

Programs are Glon objects with type `program`. They sync between
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
| `programId` | This program's Glon object ID |
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
    crud.ts                  CRUD operations (create, list, get, set, delete)
    inspect.ts               DAG inspection (history, changes, heads, sync)
    ipc.ts                   inter-process communication (send, inbox, outbox)
    ttt.ts                   tic-tac-toe
    chat.ts                  chat / messaging
    agent.ts                 LLM agent with DAG-backed conversation
    gc.ts                    garbage collection with retention policies
    accounts.ts              multi-user authentication & permissions
    sync.ts                  P2P synchronization & discovery
    graph.ts                  object graph traversal and link queries
```

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

### Retention Policies

Programs declare how long their objects should be kept:

```typescript
interface RetentionPolicy {
  maxAge?: string;         // "30d", "1y", "forever"
  maxCount?: number;       // Keep N most recent
  maxSize?: number;        // Total size in bytes
  keepIfReferenced?: boolean;  // Preserve if other objects link
}
```

The GC program (`/gc`) enforces these policies, cleaning up old
changes while preserving object integrity.

### GC Algorithm

1. **Scan:** Enumerate all objects and their retention policies
2. **Mark:** Identify changes eligible for deletion based on:
   - Age exceeds `maxAge`
   - Count exceeds `maxCount` (keep newest)
   - Total size exceeds `maxSize`
3. **Sweep:** Delete eligible changes unless:
   - Object is protected (`/gc protect`)
   - Object is referenced by active objects
   - Change is part of current heads

### Protected Objects

Users can protect important objects from GC:

```
/gc protect <id>    # Never delete this object
/gc unprotect <id>  # Allow normal GC rules
```

Bootstrap source files and core programs are auto-protected.

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

Glon never interprets these structures. The DAG replay code does
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

Glon stores, content-addresses, syncs, and replays custom blocks
through the standard Change DAG. Peers that don't understand a
`CustomContent` block fall back to displaying the `meta` map.

### Why Not Program-Defined Protobufs?

**Custom Operations (programs bring their own reducers):** Glon
would need each program's code to replay the DAG. A peer without
the program couldn't compute state. Breaks "any peer can recompute
from changes alone."

**Custom Value schemas (opaque bytes with type URLs):** Glon
could carry but not inspect the data. Loses field indexing, value
queries, and state diffing.

Recursive Value avoids both traps: Glon always replays the DAG
(Operations are unchanged), always inspects values (typed all the
way down), and programs compose arbitrary structures from a fixed
set of primitives. `glon.proto` is stable.
