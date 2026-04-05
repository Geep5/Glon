# Glon OS -- Whiteroom

This document is the clean-room specification for Glon: an operating
system built on two primitives and nothing else.

## The Two Primitives

### 1. The Change DAG

Every mutation in the system is a **Change** — a content-addressed
protobuf message appended to a directed acyclic graph. Current state
is computed by replaying changes from genesis to heads.

```
Change₀ (genesis)  →  Change₁ (set fields)  →  Change₂ (set content)
   |                                                ↑ HEAD
   └── id = SHA-256(protobuf bytes with id zeroed)
```

Changes are immutable once created. The protobuf bytes on disk ARE
the change. There is no wrapper, no metadata, no index that
supersedes the raw bytes.

Operations within a Change:
- `ObjectCreate` — initialize with a type key (genesis change)
- `ObjectDelete` — tombstone (soft delete flag)
- `FieldSet` / `FieldDelete` — typed field mutations
- `ContentSet` — raw byte content (source files, images)
- `BlockAdd` / `BlockRemove` / `BlockUpdate` / `BlockMove` — block tree

### 2. Rivet Actors

Every object is embodied by a durable Rivet actor — globally
addressable over HTTP, hibernatable, wakes on demand. The actor
caches the computed state derived from replaying the DAG. The DAG
on disk is the source of truth; the actor state is a cache.

The store actor is a coordinator: it maintains a SQLite index for
cross-object queries, creates and destroys object actors, and
validates IPC routing.

## The Sync Protocol

Actor-to-actor communication uses typed protobuf Envelope messages.
The protocol is pull-based: a peer advertises its heads, the other
responds with what's missing.

```protobuf
message Envelope {
  string from_id = 1;
  string to_id = 2;
  int64 timestamp = 3;

  oneof message {
    HeadAdvertise   head_advertise   = 10;
    HeadRequest     head_request     = 11;
    ChangePush      change_push      = 12;
    ChangeRequest   change_request   = 13;
    ObjectSubscribe object_subscribe = 20;
    ObjectEvent     object_event     = 21;
    AppMessage      app_message      = 30;
  }
}
```

Each object actor is a sync peer. Because Rivet actors are
globally addressable, the OS is a mesh of sync peers that could
be running anywhere — your laptop, an edge node in Tokyo, a
Raspberry Pi. The "local" experience is just the network being fast.

## Storage Model

```
Disk (~/.glon/)           Actors (Rivet)            Client (shell)
  changes/*.pb        --> object actor instances --> glon> /list
  content-addressed       cached computed state     CLI commands
  protobuf binary         durable, hibernatable

  index.db (SQLite)   --> store actor
  derived, rebuildable    coordinator + index
```

### On Disk

Each change is a file at `~/.glon/changes/<sha256-hex>.pb` containing
raw protobuf wire-format bytes. The hash IS the filename. The bytes
ARE the change. Delete the SQLite index and it rebuilds from the `.pb`
files on next boot.

### In Actors

Each object actor caches:
- Computed state (type, fields, content, blocks, deleted flag)
- Current head change IDs
- Change count
- IPC inbox/outbox

State is recomputed from disk on mutation — the actor reads all
changes for its object, replays them via topological sort, and
updates its cache.

### In the Index

The store actor's SQLite database:
```sql
objects (id, type_key, deleted, created_at, updated_at)
changes (id, object_id, timestamp, is_head)
change_parents (change_id, parent_id)
```

This is derived. The changes on disk are the source of truth.

## Object Identity

- **Object ID**: Stable UUID, generated once at creation.
- **Change ID**: SHA-256 hash of protobuf bytes (content-addressed).
- Objects are referenced by UUID (or prefix). Changes by hash.

## Self-Description

On bootstrap, the OS reads its own source files, creates a Change
DAG for each (genesis → fields → content), and registers them in
the store. The OS contains its own source as objects.

## The Shell

```
glon> /list              list all objects
glon> /list typescript   filter by type
glon> /get <id>          full object state from live actor
glon> /set <id> <k> <v>  set a field (creates a Change)
glon> /create <type> [n] create an object
glon> /delete <id>       soft-delete
glon> /search <query>    search by field values
glon> /history <id>      show the change DAG
glon> /change <hex-id>   inspect a single change
glon> /send <f> <t> <a>  IPC between objects
glon> /inbox <id>        show inbox
glon> /outbox <id>       show outbox
glon> /info              system stats
glon> /disk              disk stats
glon> /help              command reference
```

## Project Layout

```
glon/
  proto/glon.proto         the protocol (DAG + Sync + State + Blocks + Values)
  src/
    crypto.ts              SHA-256 content-addressing
    proto.ts               typed encode/decode for all messages
    dag/
      change.ts            change creation, content-address computation
      dag.ts               topological sort, state computation
    storage/ (actors/)
      object.ts            (stub — actors defined in index.ts)
      store.ts             (stub — actors defined in index.ts)
    disk.ts                raw .pb file storage
    index.ts               actor definitions + registry
    bootstrap.ts           seed source files as objects
    client.ts              CLI shell
  package.json
  tsconfig.json
  ARCHITECTURE.md
  WHITEROOM.md             this file
```

## What Exists

- Content-addressed Change DAG with topological sort and state replay
- Typed protobuf protocol: Changes, Operations, Sync messages, Blocks, Values
- Rivet actors: per-object sync peers, globally addressable over HTTP
- Store actor with SQLite index (objects, changes, DAG edges)
- Typed operations: ObjectCreate, FieldSet, FieldDelete, ContentSet, ObjectDelete, Block ops
- Raw .pb change files on disk, content-addressed by SHA-256
- Boot-from-disk: all state reconstructed from change files
- CLI with CRUD, field mutation, history inspection, IPC, search
- ID prefix resolution
- Self-describing: OS source files are objects in the OS

## What Does Not Exist Yet

- Sync protocol execution (HeadAdvertise/ChangePush/ChangeRequest actions
  are defined in the proto but not yet wired into actor actions)
- Peer-to-peer sync between Rivet actors (exchange heads, push missing changes)
- Block tree positioning (blocks append-only, no tree ordering)
- End-to-end encryption (encrypt changes before writing)
- Snapshot compaction (periodic snapshots to speed up replay)
- Multiple namespaces / spaces
- Process actors (actors that execute logic)
- Browser / Canvas UI
- Schema validation (enforcing type constraints on fields)
- Replication / multi-node Rivet deployment

## Design Constraints

1. **Changes are truth.** The `.pb` files on disk are the source of
   truth. Actor state is a cache. SQLite is an index. Both are derived
   from the change DAG and rebuildable.

2. **One protocol.** Storage, sync, IPC — all protobuf. The `.proto`
   file IS the protocol specification. There is no second format.

3. **Actors are sync peers.** Each object actor is a globally-addressable
   endpoint. Sync is peer-to-peer between actors. No central server,
   no relay infrastructure (Rivet provides the addressing).

4. **Content-addressed.** Changes are identified by their hash. Same
   mutation → same hash. Tamper-evident. Deduplication is free.

5. **The OS is its own content.** Every source file that builds Glon is
   an object inside Glon with full change history.
