# 🌿 Glon

A distributed operating environment inspired by
[Anytype](https://anytype.io)'s philosophy — no hierarchy, just objects and
the links between them — built on two primitives that hold up at scale:
[Rivet](https://rivet.gg) actors (how games and large distributed systems
manage state) and content-addressed protobuf (how large systems store and
sync data). Every object is a durable actor, every mutation is an immutable change
in a DAG, and the graph of relations between objects is the only structure.

## How It Works

**Objects, not files.** There are no folders, no directories, no tree. Every
entity is a typed object in a flat graph. Objects relate to each other through
typed fields — the structure emerges from the connections, not from where
something is placed.

**Changes, not state.** Every mutation is a `Change` — an immutable protobuf
message appended to a DAG, identified by the SHA-256 of its wire bytes. Current
state is computed by replaying the DAG from genesis to heads. Nothing is
overwritten; full history is preserved.

**Actors, not databases.** Each object is a
[Rivet actor](https://rivet.gg/docs/actors) — durable, globally addressable,
hibernatable. Actor types: `objectActor` (one per object, sync peer),
`storeActor` (singleton index), `programActor` (program state and RPC dispatch).

**Everything is a program.** The shell has zero built-in commands. It loads every
command — including `/help` — from the store at startup. Programs are Glon
objects: they have change history, sync between instances, and are discoverable
at runtime.

**Self-describing.** On bootstrap, the environment loads its own source files as
objects. You can query Glon for the code that built it.

## Quick Start

```bash
git clone https://github.com/Geep5/Glon.git
cd Glon && npm install

# Terminal 1: start the environment
npm run dev

# Terminal 2: seed source files (first time)
npm run bootstrap

# Terminal 3: open the shell
npm run client
```

## Programs

Every program `export default`s a `ProgramDef`:

```typescript
export default {
  handler: async (cmd, args, ctx) => { ... },  // CLI handler (required)
  actor: { ... },                                // persistent state + RPC (optional)
  validator: (changes) => { ... },               // DAG gating (optional)
  validatedTypes: ["character", "item"],         // types to validate (optional)
};
```

A handler-only program is a stateless command. Add an `actor` for persistent
state and a tick loop. Add a `validator` to gate synced changes before they
reach disk.

### Built-in Programs

| Command | Purpose |
|---|---|
| `/help` | List available programs |
| `/crud` | Create, list, get, set, delete objects |
| `/inspect` | DAG history, change details, sync state |
| `/ipc` | Inter-object messaging (inbox/outbox) |
| `/ttt` | Tic-tac-toe — every move is a content-addressed change |
| `/chat` | Chat rooms — messages are blocks in the DAG |
| `/agent` | LLM agents with DAG-backed conversation history |
| `/gc` | Garbage collection with retention policies |
| `/accounts` | Multi-user auth and per-object permissions |
| `/sync` | P2P sync via mDNS discovery and HTTP |

### Example: LLM Agent

Agents store every prompt and response as changes in the DAG — content-addressed,
replayable, syncable. Any peer can replay the conversation without an API key.

```bash
ANTHROPIC_API_KEY=sk-... npm run client
```
```
glon> /agent new analyst --system "You are a concise data analyst."
glon> /agent ask 9b2e What are the tradeoffs of event sourcing vs CRUD?
  assistant (847+312 tokens)
  Event sourcing trades write simplicity for read complexity. ...

glon> /agent inject c41a 9b2e       # inject analyst's context into another agent
glon> /agent ask c41a What did the analyst get wrong?
```

### Example: Multi-Instance Chat

Two Glon instances sync over HTTP — both end up with identical `.pb` files
on disk.

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

### Example: Tic-Tac-Toe

The board is an object. Every move is a content-addressed change — tamper-evident
and replayable.

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

## The Protocol

**Change DAG** — every mutation is a `Change` protobuf, content-addressed by
SHA-256, linked to parents via DAG edges. Operations: `ObjectCreate`, `FieldSet`,
`FieldDelete`, `ContentSet`, `ObjectDelete`, plus block tree ops.

**Sync** — typed protobuf `Envelope` messages between actors. Pull-based:
advertise heads, push what's missing.

**Computed State** — derived by replaying the DAG. Never the source of truth.
The SQLite index is a cache; delete it and it rebuilds from disk.

**Snapshots** — checkpoint full state into the DAG. Replay skips everything
before the snapshot. History is never lost.

## Project Structure

```
proto/glon.proto              the protocol
src/
  crypto.ts                   SHA-256 content-addressing
  proto.ts                    typed encode/decode
  dag/                        change creation, topological sort, state computation
  disk.ts                     per-object .pb file storage
  index.ts                    actor definitions (object, store, program)
  bootstrap.ts                seed source files + programs as objects
  client.ts                   CLI shell (pure program loader)
  programs/
    runtime.ts                module bundler, actor lifecycle, validators
    handlers/                 one file per program
test/
  dag.test.ts                 DAG replay, snapshots
  runtime.test.ts             program actor lifecycle
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for internals: DAG replay, actor state
model, sync handshake, program context, and the security model.

## License

MIT
