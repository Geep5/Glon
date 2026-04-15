# Glon

A protobuf-native operating system built on the two primitives that scale
to the extreme: [Rivet](https://rivet.gg) actors (how games and massive
distributed systems manage state) and content-addressed protobuf (how large
systems store and sync data). Glon blends them into one thing — every object
is a durable actor, every mutation is an immutable protobuf change in a DAG.

## How It Works

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

## Quick Start

```bash
git clone https://github.com/Geep5/Glon.git
cd Glon && npm install

# Terminal 1: start the OS
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

### Example: Tic-Tac-Toe

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

### Example: Multi-Instance Chat

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

### Example: LLM Agent

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
