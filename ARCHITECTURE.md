# Glon OS — Architecture

## What It Is

An operating system where every entity is a protobuf message
living as a durable Rivet actor. No filesystem. No traditional
processes. Just protobuf objects and the actors that embody them.

## Two Primitives

### 1. Protobuf `Object` (the data)

Defined in `proto/glon.proto`. One message type. Everything is one.

```protobuf
message Object {
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

### 2. Rivet Actor (the runtime)

Each Object lives as a durable actor. The actor IS the object.
State persists through crashes, restarts, and hibernation.
Actors communicate through typed actions and events.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   Clients                       │
│  CLI (client.ts)  ·  Browser  ·  Other actors   │
└─────────────┬───────────────────┬───────────────┘
              │ actions/events    │
┌─────────────▼───────────────────▼───────────────┐
│              Store Actor (coordinator)           │
│  key: ["root"]                                   │
│  SQLite index: objects(id, kind, name, size)      │
│  actions: create, list, get, search, delete      │
└─────────────┬───────────────────────────────────┘
              │ creates/destroys
┌─────────────▼───────────────────────────────────┐
│           Object Actors (one per entity)         │
│  key: [object-id]                                │
│  state: protobuf Object fields                   │
│  actions: read, write, setMeta, readContent      │
│  events: changed                                 │
└─────────────────────────────────────────────────┘
              │
┌─────────────▼───────────────────────────────────┐
│              Protobuf Layer (src/proto.ts)        │
│  encode/decode glon.Object ↔ Uint8Array           │
│  state conversion (GlonObject ↔ ObjectState)      │
│  ID derivation, ref creation                      │
└─────────────────────────────────────────────────┘
```

## Self-Describing

On bootstrap, the OS loads its own source files as objects
into the store. Every `.ts`, `.proto`, `.json` file that
constitutes Glon becomes a protobuf Object in the graph.

You can query the OS for its own source code.

## Project Structure

```
glon/
  proto/
    glon.proto            # The primitive. One message type.
  src/
    proto.ts              # Load .proto, typed encode/decode
    actors/
      object.ts           # Object actor — one per entity
      store.ts            # Store coordinator — SQLite index
    index.ts              # Registry. Start the OS.
    bootstrap.ts          # Seed source files as objects
    client.ts             # CLI client
  package.json
  tsconfig.json
```

## Running

```bash
# Terminal 1: Start the OS
npm run dev

# Terminal 2: Bootstrap source files
npx tsx src/bootstrap.ts

# Terminal 3: Connect CLI
npx tsx src/client.ts
```

## Commands

```
/list [kind]           List all objects (or filter by kind)
/info                  System stats
/search <query>        Search by name
/create <kind> <name>  Create an object
/delete <id>           Delete an object
/get <id>              Get object details
/help                  Command list
/quit                  Exit
```

## Design Decisions

**Why protobuf, not JSON?**
Protobuf is the primitive, not a transport optimization. The `.proto`
file IS the type system. Schema evolution is built in (field numbers).
Binary encoding is compact. The same schema works across languages.

**Why Rivet actors, not a database?**
Each object is alive. It can react to events, enforce invariants,
communicate with other objects. A database row is dead data. An actor
is a running entity. The actor model maps directly to OS concepts:
actors are processes, state is memory, actions are syscalls.

**Why SQLite in the store?**
Actors are great for individual entities but bad for cross-entity
queries. The store actor maintains a SQLite index for "find all
objects of kind X" queries. The index is derived — the actors are
the source of truth.

**Why one Object message?**
Maximum primitiveness. A file and a process and a type definition
are all the same shape. The `kind` field distinguishes them. This
mirrors how Unix treats everything as a file descriptor — Glon
treats everything as a protobuf Object.
