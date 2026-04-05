# Glon OS -- Whiteroom

This document is the clean-room specification for Glon: an operating
system built on two primitives and nothing else.

## The Two Primitives

### 1. Protobuf

Every entity in the system is a single protobuf message:

```protobuf
message GlonObject {
  string id = 1;
  string kind = 2;
  string name = 3;
  bytes content = 4;
  map<string, string> meta = 5;
  int64 created_at = 6;
  int64 updated_at = 7;
  int64 size = 8;
}
```

There is one type. A file is a GlonObject. A process is a GlonObject.
A configuration is a GlonObject. The proto schema itself is a GlonObject.
The `kind` field is the only distinction. The wire format is binary --
field tags, varint lengths, raw bytes. This is what lives on disk.

### 2. Actors

Every GlonObject is embodied by a durable actor (Rivet). The actor IS
the object. It holds the protobuf state in memory, persists it, survives
crashes, hibernates when idle, wakes on demand. Actors communicate
through typed actions and broadcast events.

The store actor is a coordinator. It maintains a SQLite index of all
objects for queries. It creates and destroys object actors. There is
one store per namespace (currently one: "root").

## Storage Model

```
Disk (local)              Actors (Rivet)           Client (shell)
~/.glon/objects/*.pb  --> objectActor instances --> glon> /list
raw protobuf binary       in-memory state          CLI commands
                          durable, hibernatable
```

### On Disk

Each object is a file at `~/.glon/objects/<id>.pb` containing the raw
protobuf wire-format encoding of a GlonObject. No headers, no wrappers,
no filesystem metadata. The protobuf bytes ARE the file.

You can decode any object with standard tooling:

```
protoc --decode=glon.GlonObject proto/glon.proto < ~/.glon/objects/proto_glon.proto.pb
```

### In Actors

Each object actor holds the GlonObject fields as in-memory state.
Content is base64-encoded for JSON serialization (Rivet's persistence
layer). The actor provides actions: read, write, setMeta, readContent,
readProto. It broadcasts a `changed` event on mutation.

### In the Index

The store actor runs a SQLite database with a single table:

```sql
CREATE TABLE objects (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  name       TEXT NOT NULL,
  size       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);
```

This is a derived index. The protobuf on disk is the source of truth.

## Object Identity

IDs are derived from kind and name: `<kind>:<name>`. Examples:

```
proto:glon.proto
typescript:store.ts
json:package.json
note:hello-world
```

This is deterministic. The same kind + name always produces the same ID.
There are no UUIDs, no auto-increment, no randomness.

## Self-Description

On bootstrap, the OS reads its own source files from disk, encodes each
as a GlonObject, writes the protobuf bytes to `~/.glon/objects/`, and
registers them in the store actor's index.

After bootstrap, the OS contains:

```
proto:glon.proto           -- the type system itself
typescript:proto.ts        -- the protobuf encode/decode layer
typescript:object.ts       -- the object actor definition
typescript:store.ts        -- the store coordinator
typescript:index.ts        -- the registry entry point
typescript:bootstrap.ts    -- the bootstrap script
typescript:client.ts       -- the CLI shell
json:package.json          -- dependencies
json:tsconfig.json         -- compiler config
```

The operating system describes itself. You can `/cat` any of these to
read the source code that built the OS you're running.

## The Shell

The CLI is the primary interface. It connects to the store actor over
HTTP (Rivet's actor protocol, default port 6420).

```
glon> /list              -- list all objects
glon> /list typescript   -- list objects of kind "typescript"
glon> /info              -- system stats
glon> /get <id>          -- inspect an object ref
glon> /search <query>    -- search by name
glon> /create <kind> <name>  -- create an empty object
glon> /delete <id>       -- delete an object
glon> /cat <id>          -- read content from disk (decoded protobuf)
glon> /dump <id>         -- hex dump of raw protobuf bytes on disk
glon> /disk              -- disk storage stats
glon> /proto             -- display the proto schema
glon> /kinds             -- list object kinds with counts
glon> /help              -- command reference
```

## IPC

The Envelope message defines actor-to-actor communication:

```protobuf
message Envelope {
  string from_id = 1;
  string to_id = 2;
  string action = 3;
  bytes payload = 4;
  int64 timestamp = 5;
}
```

The payload is itself a protobuf-encoded message. Protobuf all the way
down. This is defined but not yet wired into the runtime.

## Project Layout

```
glon/
  proto/glon.proto         -- the primitive
  src/
    proto.ts               -- load .proto, encode/decode, type helpers
    disk.ts                -- read/write raw protobuf to ~/.glon/
    actors/
      object.ts            -- object actor (one per entity)
      store.ts             -- store coordinator (SQLite index)
    index.ts               -- actor registry, start server
    bootstrap.ts           -- seed source files into the OS
    client.ts              -- CLI shell
  package.json
  tsconfig.json
  ARCHITECTURE.md
  WHITEROOM.md             -- this file
```

## Running

```bash
# Install
cd glon && npm install

# Start the OS
npm run dev

# Bootstrap (first time -- seeds source files)
npm run bootstrap

# Open the shell
npm run client
```

## What Exists

- Protobuf schema with three messages (GlonObject, ObjectRef, Envelope)
- Object actor: durable, stateful, per-entity
- Store actor: coordinator with SQLite, CRUD + search
- Disk layer: raw .pb files at ~/.glon/objects/
- CLI shell: /list, /cat, /dump, /disk, /info, /create, /delete, /search
- Self-describing: the OS contains its own source as objects
- TypeScript compiles clean, runtime tested

## What Does Not Exist Yet

- Actor-to-actor IPC via Envelope messages
- Object actor instances (store tracks refs, but individual object
  actors are not yet created per-object -- the store handles CRUD
  directly against its SQLite index)
- Disk-to-actor sync on boot (loading .pb files back into actor state)
- Permissions / capability tokens
- Namespaces beyond "root"
- Process actors (actors that execute logic, not just hold data)
- Browser/Canvas UI
- Persistence of user-created objects to disk (only bootstrap writes .pb)
- Schema validation (enforcing that objects match their kind's expected fields)
- Replication / multi-node

## Design Constraints

1. One message type. No inheritance, no subtypes, no schemas-per-kind.
   The `kind` field and `meta` map handle all variation.

2. Binary on disk. No JSON, no SQL, no filesystem metadata wrapping
   the protobuf. The .pb file IS the object.

3. Actors are the runtime. Not threads, not processes, not lambdas.
   Each object is an actor. The actor model provides isolation,
   durability, communication, and lifecycle management.

4. The OS is its own content. Every source file that builds Glon is
   an object inside Glon. If you delete the source from the filesystem
   but the .pb files survive, the OS still knows what it is.

5. Protobuf is the lingua franca. Storage is protobuf. IPC will be
   protobuf. The schema is protobuf. There is no second serialization
   format.
