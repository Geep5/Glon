# Glon

A protobuf-native operating system. Every mutation is a content-addressed
change in a DAG. Every object is a durable [Rivet](https://rivet.gg) actor.
Raw protobuf on disk, sync protocol over HTTP. Two primitives, nothing else.

## How It Works

```
Disk                           Actors                        Shell
~/.glon/changes/<oid>/*.pb     durable Rivet actors   ───>   glon> /agent ask 9b2e ...
content-addressed              globally addressable           CLI commands
per-object subdirectories      sync peers over HTTP
```

**Changes, not state.** Every mutation is a `Change` — an immutable protobuf
message appended to a DAG. The id is the SHA-256 of the wire bytes. Current
state is computed by replaying the DAG from genesis to heads. Nothing is
overwritten. The full history of every object is preserved.

**Actors, not databases.** Each object is a [Rivet actor](https://rivet.gg/docs/actors) —
durable, globally addressable over HTTP, hibernatable. Three actor types:
objectActor (one per object, sync peer), storeActor (singleton index),
and programActor (manages program state, tick loops, and RPC dispatch).

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

## Examples

### Tic-Tac-Toe

The board is a regular object. Every move is a content-addressed Change
in the DAG — tamper-evident and replayable.

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

### Chat Between Two Instances

Chat rooms are regular objects. Messages are blocks. Two Glon instances
sync over HTTP — both end up with identical `.pb` files on disk.

```
# Server A                              # Server B
GLON_DATA=~/.glon-a npm run dev          GLON_DATA=~/.glon-b npm run dev

glon> /chat new general
glon> /chat send 4dfaa Hello from A!
glon> /remote push localhost:6421 4dfaa

                                         glon> /chat read 4dfaa
                                           # general
                                           00:13  local  Hello from A!
                                         glon> /chat send 4dfaa Hello from B!

glon> /remote pull localhost:6421 4dfaa
glon> /chat read 4dfaa
  # general
  00:13  local  Hello from A!
  00:13  local  Hello from B!
```

### LLM Agent

Agents store every prompt and response as blocks in the DAG —
content-addressed, replayable, syncable. The LLM call is I/O; the
result is a Change. Any peer can replay the conversation without an API key.

```bash
ANTHROPIC_API_KEY=sk-... npm run client
```

```
glon> /agent new analyst --system "You are a concise data analyst."
Agent created: 9b2e4f17-...

glon> /agent ask 9b2e What are the tradeoffs of event sourcing vs CRUD?
  assistant (847+312 tokens)
  Event sourcing trades write simplicity for read complexity. ...

glon> /agent history 9b2e
  analyst (claude-sonnet-4-20250514)
  system: You are a concise data analyst.

  user 14:32
    What are the tradeoffs of event sourcing vs CRUD?
  assistant 14:32
    Event sourcing trades write simplicity for read complexity. ...
```

Agents can read each other's conversations and inject context cross-agent:

```
glon> /agent new reviewer --system "You critique technical analysis."
glon> /agent inject c41a 9b2e
  Injected 4 turns from "analyst" into target
glon> /agent ask c41a What did the analyst get wrong?
```

### Garbage Collection

Programs declare retention policies for their objects. The GC system
respects these while cleaning up old changes to manage disk space.

```
glon> /gc policies
  chat:     30d (keep if referenced)
  agent:    forever
  game:     7d or 100 objects max

glon> /gc stats
  Total: 23,847 changes (142 MB)
  By age:
    < 1d:   1,234 changes
    < 7d:   5,678 changes
    < 30d:  12,456 changes
    > 30d:  4,479 changes (eligible for GC)

glon> /gc run --dry-run
  Would remove:
    chat:    234 objects (> 30 days)
    game:    45 objects (> 100 count)
    unknown: 89 objects (no policy)

glon> /gc protect a3f8b2c1
  Protected object from garbage collection
```

### Accounts & Permissions

Multi-user support with role-based access control. Programs can only
modify objects they own or have permission to access.

```
glon> /accounts whoami
  Not logged in (anonymous)

glon> /accounts create alice --role user
  Created account: alice

glon> /accounts login alice
  Logged in as: alice (user)

glon> /accounts grant bob read a3f8b2c1
  Granted read permission to bob for object a3f8b2c1

glon> /accounts check write 9b2e4f17
  ✗ No write permission for object 9b2e4f17
```

### P2P Sync

Peer-to-peer synchronization without central servers. Uses mDNS for
local discovery and HTTP for cross-network sync.

```
# Instance 1 (port 6420)
glon> /sync discover
  Starting mDNS discovery...
  Found peer: glon-b.local:6421

glon> /sync peers
  glon-b.local:6421  (reputation: 95, last: 2s ago)
  192.168.1.5:6422   (reputation: 82, last: 5m ago)

glon> /sync broadcast
  Broadcasting changes to 2 peers...
  Sent 45 changes to glon-b.local:6421
  Sent 12 changes to 192.168.1.5:6422

# Instance 2 (port 6421)
glon> /sync add http://localhost:6420
  Added peer: localhost:6420

glon> /sync sync a3f8b2c1
  Syncing object a3f8b2c1...
  Received 23 new changes from localhost:6420
  Object is now up to date
```

Peers maintain reputation scores and exchange Bloom filters for
efficient selective sync. Objects automatically sync when accessed.

## The Protocol

**1. Change DAG** — every mutation is a `Change` protobuf message,
content-addressed by SHA-256, linked to parents via DAG edges.
Operations: `ObjectCreate`, `FieldSet`, `FieldDelete`, `ContentSet`,
`ObjectDelete`, plus block tree ops.

**2. Sync Protocol** — typed protobuf `Envelope` messages for
exchanging DAG state between actors. Pull-based: advertise heads,
push what's missing.

**3. Computed State** — derived by replaying the DAG. Never the
source of truth. Any actor can recompute it from changes alone.
The SQLite index is a cache.

**Snapshots.** A snapshot checkpoints the full state into the DAG.
Replay skips everything before it. History is never lost — old changes
stay on disk — but you don't pay the replay cost.

## Programs

Programs are Glon objects. Their source code lives in the DAG, syncs
between peers, and is discoverable at runtime. The shell has zero
hardcoded commands — it loads every program from the store at startup.

Every program `export default`s a `ProgramDef`:

```typescript
export default {
  handler: async (cmd, args, ctx) => { ... },  // CLI handler (required)
  actor: { ... },                                // persistent state + RPC (optional)
  validator: (changes) => { ... },               // DAG gating (optional)
  validatedTypes: ["character", "item"],         // types to validate (optional)
};
```

A program with just a `handler` is a stateless command (tic-tac-toe, chat).
Add an `actor` and it gets persistent state, named RPC actions, and a tick
loop. Add a `validator` and it gates the DAG — synced changes for the
listed types are rejected before writing to disk if validation fails.

Programs don't change the OS. `Value` is recursive — `ValueMap` and
`ValueList` nest to any depth — so programs express arbitrarily complex
state using only `FieldSet` ops. `BlockContent` has a `CustomContent`
escape hatch for program-defined block types the OS carries without
interpreting. The protocol is stable; complexity lives in programs.

See [ARCHITECTURE.md](ARCHITECTURE.md) for internals: DAG replay,
actor state model, sync handshake, program context, and extensibility
primitives.

## Shell Commands

Core commands built into the shell:

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
| `/remote pull\|push <endpoint> <id>` | Cross-instance sync |
| `/snapshot <id>` | Checkpoint state (speeds up replay) |
| `/info` / `/disk` / `/help` | System info |

## Program Commands

Programs loaded dynamically from the store (use `/help` to see all):

| Program | Commands | Description |
|---|---|---|
| `/ttt` | `new`, `board`, `move`, `history` | Tic-Tac-Toe game |
| `/chat` | `new`, `send`, `read`, `reply`, `react` | Chat rooms and messaging |
| `/agent` | `new`, `ask`, `history`, `config`, `inject` | LLM agents with memory |
| `/gc` | `run`, `policies`, `set`, `protect`, `stats` | Garbage collection |
| `/accounts` | `whoami`, `login`, `create`, `grant`, `check` | User authentication |
| `/sync` | `discover`, `peers`, `add`, `sync`, `broadcast` | P2P synchronization |

Programs are Glon objects that sync between instances. Add new programs
by creating objects with type `program`.

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
    disk.ts                   per-object .pb file storage
    index.ts                  actor definitions (object, store, program)
    bootstrap.ts              seed source files + programs as objects
    client.ts                 CLI shell (discovers programs at startup)
    programs/
      runtime.ts              module bundler, actor lifecycle, validators
      handlers/
        ttt.ts                tic-tac-toe
        chat.ts               chat / messaging
        agent.ts              LLM agent with DAG-backed conversation
        gc.ts                 garbage collection with retention policies
        accounts.ts           multi-user authentication & permissions
        sync.ts               P2P synchronization & discovery
  test/
    dag.test.ts               DAG replay determinism, falsy values, snapshots
    runtime.test.ts           program actor lifecycle, tick, emit
  package.json
  tsconfig.json
```

## License

MIT
