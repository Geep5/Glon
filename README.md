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

**Zero built-in commands.** The shell is a pure program loader. Everything —
even `/help` — is just a program stored as a Glon object that can be created,
modified, versioned, and synced like any other data.

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
between peers, and is discoverable at runtime. **The shell has ZERO
built-in commands** — it loads every program from the store at startup.
Everything is a program, even `/help`.

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

## Programs

**All commands are programs** loaded dynamically from the store. The shell has
**ZERO built-in commands** — even `/help` is just a program. Programs are Glon
objects that sync between instances. Add new programs by creating objects with
type `program`.

### `/help` — Program Discovery

Lists all available programs loaded from the store. Since the shell has no
built-in commands, this is how you discover what you can do.

```
glon> /help
  Available programs:
    /crud      Basic object operations (create, list, get, set, delete)
    /inspect   DAG inspection and debugging tools
    /ipc       Inter-process communication between objects
    /ttt       Tic-tac-toe game
    /chat      Chat rooms and messaging
    /agent     LLM agents with DAG-backed memory
    /gc        Garbage collection with retention policies
    /accounts  Multi-user authentication & permissions
    /sync      P2P synchronization & discovery
```

### `/crud` — Object Operations

Basic CRUD operations for Glon objects. Every object has a type, fields,
and optional content/blocks.

```
glon> /crud create note "Shopping List"
Created object: b7c3a921-... (type: note)

glon> /crud set b7c3 items "milk, eggs, bread"
Field set: items

glon> /crud get b7c3
  note b7c3a921-...
    name: Shopping List
    items: milk, eggs, bread
    created: 2024-01-20T10:30:00Z

glon> /crud list note
  b7c3a921-...  Shopping List
  f2e4d817-...  Meeting Notes
  91a6c453-...  Ideas

glon> /crud search "milk"
  b7c3a921-...  note  Shopping List
```

### `/inspect` — DAG Inspection

Debug and inspect the underlying Change DAG. See history, examine
specific changes, manage sync state.

```
glon> /inspect history b7c3
  4a8f92c1  10:30:00  ObjectCreate (type: note)
  7b2e3f45  10:30:05  FieldSet (name: Shopping List)
  c91d6a87  10:30:12  FieldSet (items: milk, eggs, bread)

glon> /inspect change c91d6a87
  Change c91d6a87...
    object_id: b7c3a921-...
    parent: 7b2e3f45...
    author: local
    timestamp: 2024-01-20T10:30:12Z
    operation: FieldSet { key: "items", value: "milk, eggs, bread" }

glon> /inspect heads b7c3
  Current heads: c91d6a87... (1 head, no conflicts)

glon> /inspect sync localhost:6421 b7c3
  Local heads:  c91d6a87...
  Remote heads: c91d6a87...
  Objects are in sync

glon> /inspect disk
  ~/.glon/changes/
    423 objects
    12,847 changes
    Total: 67.3 MB
```

### `/ipc` — Inter-Process Communication

Send messages between Glon objects. Objects have inbox/outbox queues
for async communication.

```
glon> /ipc send game-9f2a player-3b4c "Your turn!"
Message sent to player-3b4c

glon> /ipc inbox player-3b4c
  From: game-9f2a  (2 min ago)
    Your turn!
  From: chat-7d8e  (5 min ago)
    New message in #general

glon> /ipc outbox game-9f2a
  To: player-3b4c  (2 min ago)  ✓ delivered
    Your turn!
  To: player-8a1f  (2 min ago)  ✓ delivered
    Your turn!

glon> /ipc clear player-3b4c inbox
Cleared inbox for player-3b4c
```

### `/ttt` — Tic-Tac-Toe

Play tic-tac-toe with full DAG history. Every move is a content-addressed
Change.

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

glon> /ttt board a3f8
   O | X | O
  ---+---+---
   3 | X | 5
  ---+---+---
   X | 7 | O
  X's turn  (move 6)

glon> /ttt history a3f8
  7f141408f07a  06:27:17  new game
  1eed89826411  06:27:37  #1 X -> position 4
  8c3f29ab5612  06:27:45  #2 O -> position 0
  ...
```

### `/chat` — Messaging

Create chat rooms, send messages, react with emojis. Messages are blocks
in the DAG and sync between instances.

```
glon> /chat new general "General discussion"
Created chat room: 4dfaa817-...

glon> /chat send 4dfaa "Hello everyone!"
Message sent

glon> /chat read 4dfaa
  # general
  10:15  local  Hello everyone!
  10:16  peer1  Hey there!
  10:16  peer2  Welcome!

glon> /chat reply 4dfaa msg-8f2c "Thanks for the warm welcome"
Reply sent

glon> /chat react 4dfaa msg-8f2c 👍
Added reaction
```

### `/agent` — LLM Agents

Create AI agents powered by Claude/GPT with full conversation history
stored in the DAG. Supports streaming responses, temperature control,
and context injection between agents.

```
glon> /agent new analyst --model claude-sonnet-4 --system "You are a data analyst"
Agent created: 9b2e4f17-...

glon> /agent ask 9b2e "What are the key metrics for a SaaS business?"
  thinking (claude-sonnet-4-20250514)...

  assistant streaming...

  Key SaaS metrics include:
  1. MRR (Monthly Recurring Revenue)
  2. Churn rate
  3. CAC (Customer Acquisition Cost)
  ...

  (423 input + 187 output = 610 total tokens)

glon> /agent config 9b2e temperature 0.8
  temperature = 0.8

glon> /agent history 9b2e
  analyst (claude-sonnet-4-20250514)
  system: You are a data analyst

  user 10:32
    What are the key metrics for a SaaS business?
  assistant 10:32
    Key SaaS metrics include...
```

### `/gc` — Garbage Collection

Manage disk space with retention policies. Clean up old changes while
preserving object integrity.

```
glon> /gc policies
  chat:     30d (keep if referenced)
  agent:    forever
  game:     7d or 100 objects max
  note:     90d

glon> /gc set note --max-age 180d
Updated retention policy for type: note

glon> /gc stats
  Total: 23,847 changes (142 MB)
  By age:
    < 1d:   1,234 changes
    < 7d:   5,678 changes
    < 30d:  12,456 changes
    > 30d:  4,479 changes (eligible for GC)

glon> /gc protect b7c3a921
Protected object from garbage collection

glon> /gc run
  Removed:
    234 chat objects (> 30 days)
    45 game objects (> 100 count)
  Freed: 18.3 MB
```

### `/accounts` — Authentication

Multi-user support with role-based access control. Manage users,
sessions, and permissions.

```
glon> /accounts create alice --role user
Created account: alice

glon> /accounts login alice
Enter password: ****
Logged in as: alice (user)

glon> /accounts whoami
  User: alice
  Role: user
  Session expires: 2024-01-21T10:30:00Z

glon> /accounts grant bob read b7c3a921
Granted read permission to bob for object b7c3a921

glon> /accounts check write b7c3a921
✓ You have write permission for object b7c3a921

glon> /accounts logout
Logged out
```

### `/sync` — P2P Synchronization

Peer-to-peer sync without central servers. Discover peers via mDNS,
maintain reputation scores, exchange Bloom filters for efficient sync.

```
glon> /sync discover
Starting mDNS discovery...
Found peer: glon-b.local:6421

glon> /sync add http://remote.example.com:6420
Added peer: remote.example.com:6420

glon> /sync peers
  glon-b.local:6421       (reputation: 95, last: 2s ago)
  remote.example.com:6420 (reputation: 82, last: 5m ago)

glon> /sync sync b7c3a921
Syncing object b7c3a921...
Exchanged Bloom filters (12 KB)
Received 23 new changes from glon-b.local:6421
Object is now up to date

glon> /sync broadcast
Broadcasting changes to 2 peers...
Sent 45 changes to glon-b.local:6421
Sent 12 changes to remote.example.com:6420
```

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
    client.ts                 CLI shell (pure program loader, ZERO built-in commands)
    programs/
      runtime.ts              module bundler, actor lifecycle, validators
      handlers/
        help.ts               show available programs (even this is just a program!)
        crud.ts               basic CRUD operations
        inspect.ts            DAG inspection and debugging
        ipc.ts                inter-process communication
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
