# Glon

A protobuf-native operating system. Every mutation is a content-addressed
change in a DAG. Every object is a durable [Rivet](https://rivet.gg) actor.
Raw protobuf on disk, sync protocol over HTTP. Two primitives, nothing else.

## How It Works

```
Disk                         Actors                        Shell
~/.glon/changes/*.pb  ───>   durable Rivet actors   ───>   glon> /ttt move a3f 4
content-addressed            globally addressable           CLI commands
protobuf binary              sync peers over HTTP
```

**Changes, not state.** Every mutation is a `Change` — an immutable protobuf
message appended to a DAG. The id is the SHA-256 of the wire bytes. Current
state is computed by replaying the DAG from genesis to heads. Nothing is
overwritten. The full history of every object is preserved.

**Actors, not databases.** Each object is a [Rivet actor](https://rivet.gg/docs/actors) —
durable, globally addressable over HTTP, hibernatable. Two actors in
different regions sync by exchanging DAG heads and pushing missing changes.

**Self-describing.** On bootstrap, the OS loads its own source files as
objects. You can query the OS for the code that built it.

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

## Demo: Tic-Tac-Toe on the OS

The board is a regular object. Every move is a content-addressed Change
in the DAG. The game logic operates on objects through the standard
protocol — no special types, no framework hooks.

```
glon> /ttt new
New game: a3f8b2c1-...

glon> /ttt board a3f8
   0 | 1 | 2
  ---+---+---
   3 | 4 | 5
  ---+---+---
   6 | 7 | 8
  X's turn  (move 1)

glon> /ttt move a3f8 4
   0 | 1 | 2
  ---+---+---
   3 | X | 5
  ---+---+---
   6 | 7 | 8
  O's turn  (move 2)

glon> /ttt move a3f8 0
   O | 1 | 2
  ---+---+---
   3 | X | 5
  ---+---+---
   6 | 7 | 8
  X's turn  (move 3)
```

Every move is auditable:

```
glon> /ttt history a3f8
  7f141408f07a  06:27:17  new game
  1eed89826411  06:27:37  #1 X -> position 4
  92298d06e80a  06:27:37  #2 O -> position 0
  808887e3e5a7  06:27:38  #3 X -> position 8
  e0d88198bfd6  06:27:38  #4 O -> position 1
  8a30142209f4  06:27:39  #5 X -> position 2
  bc3ba285d528  06:27:49  #6 O -> position 3
  79d3eb579627  06:27:49  #7 X -> position 6
  d71da0218bb3  06:27:49  X wins
```

Each hash is the SHA-256 of the protobuf bytes. Tamper-evident.
Replayable. The `.pb` files on disk ARE the game.

## Demo: Chat Between Two Instances

Chat rooms are regular objects. Messages are blocks — pure content,
with authorship derived from the Change that created them (not stored
on the block). Two Glon instances sync the chat over HTTP.

```
# Terminal 1: start server A
GLON_DATA=~/.glon-a npm run dev

# Terminal 2: start server B (auto-assigns port 6421)
GLON_DATA=~/.glon-b npm run dev
```

On server A:

```
glon> /chat new general
Chat room: 4dfaa1ce-...

glon> /chat send 4dfaa Hey, anyone on server B?
sent ce0d1313

glon> /remote push localhost:6421 4dfaa
Pushed 4 change(s) to localhost:6421
```

On server B:

```
GLON_ENDPOINT=http://localhost:6421 npm run client

glon> /chat read 4dfaa
  # general

  00:13  local  Hey, anyone on server B?

glon> /chat send 4dfaa Hello from server B!
sent 0c1a7fcc
```

Back on server A:

```
glon> /remote pull localhost:6421 4dfaa
Pulled 1 change(s) from localhost:6421

glon> /chat read 4dfaa
  # general

  00:13  local  Hey, anyone on server B?
  00:13  local  Hello from server B!
```

Both instances end up with the same content-addressed `.pb` files on
disk — identical SHA-256 hashes. Same protobuf bytes. Same DAG.

## The Protocol

Three layers:

**1. Change DAG** — every mutation is a `Change` protobuf message,
content-addressed by SHA-256, linked to parents via DAG edges.
Operations: `ObjectCreate`, `FieldSet`, `FieldDelete`, `ContentSet`,
`ObjectDelete`, plus block tree ops.

**2. Sync Protocol** — typed protobuf `Envelope` messages for
exchanging DAG state between actors. `HeadAdvertise`, `ChangePush`,
`ChangeRequest`. Pull-based: advertise heads, push what's missing.

**3. Computed State** — derived by replaying the DAG. Never the
source of truth. Any actor can recompute it from changes alone.
The SQLite index is a cache.

**Snapshots.** A snapshot is a Change with no operations and an embedded
full state. Replay starts from the most recent snapshot, skipping
everything before it. Create one manually with `/snapshot <id>` — a
chat with 10,000 messages compacts to a single checkpoint.

## Shell Commands

| Command | Description |
|---|---|
| `/create <type> [name]` | Create an object |
| `/list [type]` | List objects |
| `/get <id>` | Full object state from live actor |
| `/set <id> <key> <value>` | Set a field (creates a Change) |
| `/delete <id>` | Soft-delete |
| `/search <query>` | Search objects |
| `/history <id>` | Change DAG for an object |
| `/change <hex>` | Inspect a single change |
| `/heads <id>` | Current DAG heads |
| `/sync <idA> <idB>` | Sync two objects |
| `/send <from> <to> <action>` | IPC between objects |
| `/inbox <id>` / `/outbox <id>` | Message queues |
| `/ttt new\|board\|move\|history` | Tic-Tac-Toe |
| `/chat new\|send\|read\|reply\|react` | Chat |
| `/remote pull\|push <endpoint> <id>` | Cross-instance sync |
| `/snapshot <id>` | Checkpoint state (speeds up replay) |
| `/info` / `/disk` / `/help` | System info |

## Project Structure

```
glon/
  proto/glon.proto            the protocol
  src/
    crypto.ts                 SHA-256 content-addressing
    proto.ts                  typed encode/decode for all messages
    dag/
      change.ts               change creation + content-address
      dag.ts                  topological sort + state computation
    disk.ts                   raw .pb file storage
    index.ts                  actor definitions + registry
    bootstrap.ts              seed source files as objects
    client.ts                 CLI shell
    programs/
      tictactoe.ts            tic-tac-toe game
      chat.ts                 chat / messaging
  package.json
  tsconfig.json
```

## Design

**Changes are truth.** The `.pb` files on disk are the source of truth.
Actor state is a cache. SQLite is an index. Delete either and it
rebuilds from the change DAG.

**One protocol.** Storage, sync, IPC — all protobuf. The `.proto` file
IS the type system. There is no second serialization format.

**Actors are sync peers.** Each object actor is a globally-addressable
HTTP endpoint via Rivet. Sync is peer-to-peer between actors.

**Content-addressed.** Same mutation produces the same SHA-256 hash.
Tamper-evident. Deduplication is free.

**Programs are protocol consumers.** Tic-tac-toe uses no special APIs.
It reads fields, validates a move, writes fields. Any program on this
OS works the same way.

**Programs don't change the OS.** `Value` is recursive — `ValueMap` and
`ValueList` contain `Value`s, so programs express arbitrarily complex state
(nested config, typed lists, object graphs) using only `FieldSet` ops.
`BlockContent` has a `CustomContent` escape hatch for program-defined block
types (images, tables, embeds) the OS carries without interpreting.
The protocol is stable; the complexity lives in programs, not the kernel.

**Snapshots for scale.** Every change is preserved, but replay doesn't
start from genesis. A snapshot checkpoints the full state into the DAG.
Future reads skip everything before it. History is never lost — the
old changes are still on disk — but you don't pay the replay cost.

## Extensibility

Programs define their own data conventions on top of two composable
primitives — without modifying `glon.proto`:

**Recursive Value** — nest maps and lists to any depth:

```
// A browser tab stores complex state as standard FieldSet ops
fields:
  url:       string("https://example.com")
  history:   values_value([string("url1"), string("url2"), ...])
  cookies:   map_value({
               "session": string("abc"),
               "prefs": map_value({ "theme": string("dark") })
             })
```

**Custom blocks** — program-defined visual content:

```
// A document editor adds image blocks; the OS syncs them unchanged
BlockContent {
  custom {
    content_type: "image"
    data: <png bytes>
    meta: { "alt": "diagram of system", "width": "800" }
  }
}
```

The OS stores, content-addresses, syncs, and replays all of it
through the standard Change DAG. No custom operations. No custom
reducers. No program needs to touch the kernel to be arbitrarily
complex.


## License

MIT
