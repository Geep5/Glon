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
|  Cached computed state from DAG replay                        |
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
| `FieldSet` | Set a typed field |
| `FieldDelete` | Remove a field |
| `ContentSet` | Set raw byte content |
| `ObjectDelete` | Tombstone flag |
| `BlockAdd/Remove/Update` | Block tree mutations |

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

## Actor System

**Rivet actors over HTTP.** No custom actor framework. Each object
actor is a globally-addressable endpoint that wakes on demand,
hibernates when idle, survives crashes.

**Object actor state** (cached, not truth):
- Computed fields, content, blocks, deleted flag
- Current DAG head IDs
- Change count
- IPC inbox/outbox

**Store actor:**
- SQLite index for cross-object queries
- Creates/destroys object actors
- Validates IPC routing

**Constraint:** `c.client()` from within a Rivet actor can read
other actors but state mutations don't persist on the target.
Sync and IPC delivery happen from the external client.

## Programs

Programs are protocol consumers. They read object state, validate
logic, write changes through the standard DAG protocol. No special
actor types, no framework hooks.

Tic-tac-toe (`src/programs/tictactoe.ts`) demonstrates this:
the board is a regular object with fields (`cell_0`..`cell_8`,
`turn`, `status`). Game logic validates moves and writes field
changes. Every move is a content-addressed Change in the DAG.

## Data Flow

**Write:** Shell -> Store -> Object Actor -> create Change ->
write .pb to disk -> recompute state from DAG -> update cache ->
Store indexes in SQLite

**Read:** Shell -> Store -> Object Actor (cached state) or
SQLite (queries)

**Boot:** Store reads all .pb files -> groups by object ->
creates Object Actor per object -> replays DAG -> indexes state

**Sync:** Actor A.getAllChangeIds() -> Actor B.getAllChangeIds() ->
set difference -> exchange missing changes -> both recompute
