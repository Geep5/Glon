# Glon OS -- Architecture

## Layers

```
+---------------------------------------------------------------+
|  Programs (src/programs/)                                     |
|  Tic-tac-toe, future apps. Pure logic on objects.             |
+------------------------------+--------------------------------+
|  Shell (src/client.ts)       |  Bootstrap (src/bootstrap.ts)  |
|  CLI over Rivet HTTP         |  Seed OS source as objects     |
+------------------------------+--------------------------------+
|  Store Actor (coordinator)                                    |
|  SQLite index: objects, changes, DAG edges                    |
|  Creates/destroys object actors                               |
+------------------------------+--------------------------------+
|  Object Actors (one per entity)                               |
  Ephemeral vars: recomputed from disk on every wake             |
|  Sync protocol: advertiseHeads, pushChanges, getChanges       |
|  IPC: sendMessage, receiveMessage                             |
+------------------------------+--------------------------------+
|  Change DAG (src/dag/)                                        |
|  Topological sort, state computation, content-addressing      |
+------------------------------+--------------------------------+
|  Disk (src/disk.ts)          |  Proto (src/proto.ts)          |
|  ~/.glon/changes/<hash>.pb   |  Typed encode/decode           |
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
| `FieldSet` | Set a typed field (values can nest via ValueMap/ValueList) |
| `FieldDelete` | Remove a field |
| `ContentSet` | Set raw byte content |
| `ObjectDelete` | Tombstone flag |
| `BlockAdd/Remove/Update` | Block tree mutations (TextContent or CustomContent) |

## Sync Protocol

Typed protobuf `Envelope` messages between actors:

| Message | Purpose |
|---|---|
| `HeadAdvertise` | "Here are my heads for this object" |
| `HeadRequest` | "Send me changes between these ancestors and these heads" |
| `ChangePush` | "Here are changes you're missing" (topologically sorted) |
| `ChangeRequest` | "Send me these specific changes by hash" |
| `ObjectSubscribe` | "Notify me when this object changes" |
| `ObjectEvent` | "This object changed, here are the new heads + changes" |
| `AppMessage` | Free-form IPC between objects |

The sync handshake:
1. Both sides exchange their full change ID sets
2. Compute set difference (what each is missing)
3. Fetch missing changes from the peer
4. Push missing changes to the peer
5. Both recompute state from the merged DAG

## Storage

```
~/.glon/
  changes/              one .pb file per change
    <sha256-hex>.pb     raw protobuf wire bytes
```

The `.pb` files are the source of truth. The SQLite index in the
store actor is derived — it tracks objects, changes, and DAG edges
for efficient queries. Delete the index and it rebuilds from disk.

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
- Creates/destroys object actors via `c.client()`
- Validates existence for IPC routing

## Programs

Programs are protocol consumers. They read object state, validate
logic, write changes through the standard DAG protocol. No special
actor types, no framework hooks.

Tic-tac-toe (`src/programs/tictactoe.ts`) demonstrates this:
the board is a regular object with fields (`cell_0`..`cell_8`,
`turn`, `status`). Game logic validates moves and writes field
changes. Every move is a content-addressed Change in the DAG.

## Data Flow

**Write:** Shell → Object Actor → create Change → write .pb to disk
→ reload vars from DAG → broadcast event → Store indexes in SQLite

**Read:** Shell → Store → Object Actor (vars, computed from disk)
or SQLite (list queries)

**Wake:** Actor wakes → `createVars` runs → reads all changes from
disk for this object → replays DAG → vars populated → ready

**Sync:** Actor A.getAllChangeIds() → Actor B.getAllChangeIds() →
set difference → exchange missing changes → both reload vars


## Program Extensibility

Programs on Glon don't need to modify `glon.proto` to express complex
state. Two primitives make this possible:

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

A browser program stores tab state as flat and nested fields:

```
fields:
  url:       string("https://example.com")
  title:     string("Example")
  history:   values_value([string("url1"), string("url2")])
  cookies:   map_value({
               "session": string("abc123"),
               "prefs":   map_value({ "theme": string("dark") })
             })
```

The OS never interprets these structures. The DAG replay code does
`state.fields.set(key, value)` -- it doesn't look inside the Value.
Programs define their own conventions on top of the typed primitives.

### Custom Block Content

`BlockContent` has an escape hatch for program-defined block types:

```
BlockContent {
  oneof content {
    TextContent   text   = 1;
    CustomContent custom = 2;
  }
}

CustomContent {
  string content_type          = 1;  // e.g. "image", "table", "embed"
  bytes  data                  = 2;  // program-encoded payload
  map<string, string> meta     = 3;  // fallback display metadata
}
```

A document editor adds image blocks. A spreadsheet adds cell blocks.
The OS stores them in the block tree, syncs them, content-addresses
them. If a peer doesn't know how to render a `CustomContent` block,
it falls back to displaying the `meta` map.

### Why not program-defined protobufs?

Two approaches were considered and rejected:

**Custom Operations (programs bring their own reducers).** The OS
would need each program's code to replay the DAG and compute state.
A peer without the program installed couldn't compute state. This
breaks "any peer can recompute from changes alone" -- Glon's core
property.

**Custom Value schemas (opaque bytes with type URLs).** The OS
could carry but not inspect the data. Loses the ability to index
fields, query values, or diff state.

Recursive Value avoids both traps: the OS always replays the DAG
(Operations are unchanged), always inspects values (typed all the
way down), and programs compose arbitrary structures from a fixed
set of primitives. `glon.proto` is modified once, then stable.