# glon

A distributed object environment where every mutation is a content-addressed protobuf message in a DAG, every object is a durable actor, and every program — including the ones running the shell — is itself an object you can replay, sync, and inspect.

There is no folder hierarchy and no central database. Objects are typed, link to each other, and live in a flat graph. State is never written; it is *computed* by replaying changes from genesis to heads.

## The big idea, in one breath

Take Git's content-addressed history, give each object its own durable actor (Rivet) with a sync inbox, replace files-and-folders with typed objects-and-links, and let programs be just another kind of object that happens to define a handler, an actor, and a validator. You end up with a substrate where a tic-tac-toe game, an LLM agent's conversation, a Discord bridge, a UTXO ledger, and the runtime that loads them are all the same kind of thing.

## The kernel — five primitives

**1. Objects, not files.** Each entity is a typed object identified by a UUID with a `type_key` (`agent`, `peer`, `chain.coin.bucket`, `program`, …). Structure emerges from `ObjectLink` field values, not from where something is "placed."

**2. Changes, not state.** Every mutation is a `Change` protobuf — a list of `Operation`s (`ObjectCreate`, `FieldSet`, `FieldDelete`, `ContentSet`, `BlockAdd/Remove/Update/Move`, `ObjectDelete`) — whose id is `SHA-256` of its canonical bytes with id zeroed. Parents form the DAG; multiple parents are merges of concurrent edits. The `.pb` file on disk *is* the change; nothing supersedes it.

**3. Actors, not databases.** Three actor kinds live in `src/index.ts`: `objectActor` (one per object, holds the inbox/outbox and serves sync), `storeActor` (singleton coordinator with a SQLite index that's a pure cache — delete it and it rebuilds from disk), and `programActor` (one per running program, owns its persistent state and tick loop).

**4. Programs are objects.** Programs live in the DAG as type=`program` objects with a `manifest` ValueMap of filenames → source. `src/programs/runtime.ts` esbuild-compiles them at load time and starts their actors. The shell has zero built-ins — even `/help` is loaded from the store. To deploy a code change you re-bootstrap (push new source into the DAG) and restart, because the running daemon is executing what's in the graph, not what's on disk.

**5. Self-hosted.** `src/bootstrap.ts` seeds the environment with its own source files as objects. The proto, the kernel, the runtime, every handler — all queryable as Glon objects. You can ask the system for the code that built it.

## The protocol (proto/glon.proto)

Three layers, deliberately separated:

| Layer | Messages | Role |
|-------|----------|------|
| Change DAG | `Change`, `Operation`, `ObjectCreate/Delete`, `FieldSet/Delete`, `ContentSet`, `Block*`, `Signature`, `X402Auth` | Source of truth. Immutable, content-addressed. |
| Sync | `Envelope` wrapping `HeadAdvertise`, `HeadRequest`, `ChangePush`, `ChangeRequest`, `ObjectSubscribe`, `ObjectEvent`, `AppMessage` | Pull-based DAG exchange between actors. Typed, no JSON-on-the-wire. |
| Computed State | `ObjectSnapshot`, `ObjectRef`, `Block`, `Value` (recursive `ValueMap`/`ValueList`/`ObjectLink`) | Derived from replay. `ObjectSnapshot` can be embedded in a Change as a replay-skip checkpoint, never as truth. |

Values are recursive and typed at the protobuf level — string/int/float/bool/bytes/list/map/`ObjectLink` — so a browser can store cookie jars as nested maps and a spreadsheet can store cell metadata as typed lists without anyone touching `glon.proto`.

Two kernel-level fields on `Change` matter for the chain layer below: `author_sig` (Ed25519 signature with per-pubkey monotonic nonce and fee), and `x402_auth` (pre-signed payment authorization with unique-nonce replay protection and time bounds).

## What lives on top — the application layer

Every directory under `src/programs/handlers/` is a hot-loadable program. They all use the same `ProgramDef` shape: an optional `handler` (CLI), optional `actor` (persistent state + actions + tick), and optional `validator` (gates synced changes for given `validatedTypes`).

There are roughly four families of programs in this repo:

**Object plumbing.** `crud` (create/list/get/set/delete), `inspect` (DAG history, change details, sync state), `graph` (link traversal, BFS), `ipc` (inter-object messaging), `gc` (retention policies), `sync` (mDNS + HTTP P2P sync — service name `_glon._tcp.local`), `help`.

**Generic apps.** `ttt` (tic-tac-toe where every move is a content-addressed change), `comment` (threaded discussions), `chat` (thin alias on top of `comment`, with legacy block fallback for the pre-migration history), `todo`, `remind` (scheduled actions), `peer` (people and agents — display name, kind, trust level, contact handles).

**Agent stack.** This is the bulk of the code:

- `agent` (3.8k lines) — an LLM agent as a regular object. Every user prompt, assistant reply, tool_use, tool_result, and `compaction_summary` is a content-addressed Block. Tool registration is a scalar field; tools dispatch into other programs via `ctx.dispatchProgram(prefix, action, args)`. ReAct loop with auto-compaction at `contextWindow - reserveTokens`, walking back to the first user boundary that fits the kept-region budget. Subagents are real `agent` objects with a `spawn_parent` link; the parent's DAG records a single tool_use/tool_result whose payload is the compressed batch result.
- `holdfast` (1.5k lines) — the generic harness. Configure once with `--name <agent>` and `--principal-<...>`, get back an agent wired with identity-aware ingest (every inbound message tagged `[from {name} on {source}, trust={level}]`), a peer directory, durable memory, scheduled reminders, shell access, and subagent spawning. Holds only a cache of `{agentId, agentName, principalPeerId}`; truth lives in the DAG.
- `memory` — durable `pinned_fact` and `milestone` objects with `owner` links back to the agent and `sourced_from_blocks` references. Survives compaction because they're independent objects with their own DAGs.
- `task` — thin CLI wrapper around `/agent.spawn` for batch subagent runs.
- `auth` — Anthropic OAuth (Claude Pro/Max impersonating the official `claude` CLI) and API-key fallback. Credentials live in `~/.glon/auth.json`, mode 0600, never synced to peers.

**I/O bridges.** `discord` (Gateway WS for presence + 3-second REST poll for DMs, routes inbound to `/holdfast.ingest`), `google` (cheatsheet for the `gws` CLI), `browser` (cheatsheet for a local Skyvern instance on :8000), `web` (curl/jq/pandoc recipes), `shell` (persistent bash sessions an agent can drive), `anytype` (local Anytype REST API).

**Chain layer.** A small Chia-style proof-of-spacetime blockchain runs on top of the same kernel:

- `wallet` — local Ed25519 keys, never on the DAG. Receives an unsigned `Change`, fills in `pubkey`/`nonce`/`fee`, signs the canonical bytes, returns it content-addressed.
- `consensus` — validator gate for chain-mode types. Per-pubkey monotonic nonce, asymmetric fee floors (deploy 100×, mint 10×, other 1×), dispatches type-specific semantic checks to the owning program.
- `coin` — UTXO-based fungible tokens. `chain.token` holds metadata; `chain.coin.bucket` objects hold up to 1000 coins each as `BlockAdd` ops. Atomic swaps via `chain.coin.offer` objects with two-pass replay so `settle` can land before its `escrow`/`pay`.
- `anchor` — global ordering and Merkle state commitment over chain-mode head ids. Longest-chain fork choice with timestamp tiebreak. Inflation rewards in FIG (5 FIG base, halving every 1000 anchors) paid to anchor creators.
- `plot` — real Proof of Space via shelling out to `chiapos` (Chia's plotter), default `k=25` (~600 MB) for testing, `k=32` (~101 GB) for mainnet-equivalent.
- `timelord` — real Proof of Time via `chiavdf` (Wesolowski VDFs, class groups of unknown order, 1024-bit discriminant), default 5M iterations.

The chain layer is genuinely separate from the object/agent kernel — it just rides the same `Change` DAG and uses `author_sig` / `x402_auth` to gate which changes survive `consensus.validate()` before the kernel writes them to disk.

## Stack

- **Language.** TypeScript, ESM. ~99.8% of the repo by line count.
- **Runtime.** Node 20+ via `tsx` (no build step in dev). Uses `node:sqlite` for the store index and `node:dgram` for mDNS.
- **Actors.** `rivetkit` 2.x. `objectActor` and `storeActor` are defined in `src/index.ts`; `programActor` is dynamically materialized per program by `runtime.ts`.
- **Wire format.** `protobufjs`. Schema in `proto/glon.proto`. Canonical encoding for signing lives in `src/det/canonical.ts`.
- **Crypto.** SHA-256 for content addressing (`src/crypto.ts`); Ed25519 for chain signatures (`src/det/ed25519.ts`); `randomBytes` for nonces.
- **Determinism.** `src/det/` carries the bits the chain layer needs to be reproducible across machines: canonical proto encoding, signing, big-int math (`U64_MAX`, `U128_MAX`, bounded add, checked sub).
- **Bundler.** `esbuild`, used at runtime to compile programs out of the DAG.
- **Optional native binaries.** `chiapos` and `chiavdf` under `~/.glon/bin/` if you want real PoSpace/PoT. Optional Skyvern at `127.0.0.1:8000` if agents need a real browser.
- **Other deps.** `nostr-tools` is in `package.json` (presumably for an identity/event-bridge experiment, no handler imports it directly in this snapshot).

## Quick start

```bash
git clone https://github.com/Geep5/glon.git
cd glon && npm install
cp .env.example .env

# terminal 1 — actor host
npm run dev

# terminal 2 — first run only: seed source files + programs into the DAG
npm run bootstrap

# terminal 3 — interactive shell
npm run client
```

The dev server fails fast if port 6420 is taken; override with `GLON_PORT`. Clients auto-discover the chosen port via `~/.glon/.endpoint`. For headless/automated use there's `scripts/daemon.ts`, which loads every program, runs their actors and tick loops, and exposes `POST /dispatch {prefix, action, args}` on `127.0.0.1:6430` so any external orchestrator can drive Glon without holding API keys.

## Notable design choices, in case you forget why later

- **Snapshots are never truth.** They live inside `Change` messages as a replay-skip optimization. The op DAG is canonical. This keeps full history recoverable even after aggressive checkpointing.
- **The SQLite index is a cache.** Delete `~/.glon/index.db` and the next wake rebuilds it from `.pb` files on disk. This is the property that makes "every wake reads disk" tolerable.
- **Programs run from the DAG, not from disk.** Editing a handler under `src/programs/handlers/` after bootstrap has *no effect* on the running daemon. To deploy a handler change: `npm run bootstrap` (push new source into typescript objects), then restart the daemon. Agent fields (system prompt, model, wired tools) are direct `object_set_field` writes — those take effect immediately.
- **The agent doesn't have a database; the DAG is the database.** Conversation history, tool calls, compaction summaries, memory facts, subagent transcripts — all the same kind of thing, all replayable, all syncable, all inspectable from another peer that was never given an API key.
- **Chain mode is opt-in per type.** Non-chain objects sync on a trust-the-peer basis. Chain-mode types route through `consensus.validate()` before the kernel writes anything to disk, with Ed25519 verified by the kernel itself before any program validator sees the change.
- **Local-only credentials.** Wallet keys (`~/.glon/wallet.json`) and Anthropic tokens (`~/.glon/auth.json`) are mode 0600, written atomically via `.tmp` + rename, and explicitly *never* part of the sync set. The chain knows you only by your raw pubkey.

## Repo layout

```
proto/glon.proto              the protocol — single source of schema truth
src/
  proto.ts                    typed encode/decode wrappers around protobufjs
  crypto.ts                   SHA-256, hex, object-id generation
  disk.ts                     per-object .pb file storage + listing
  endpoint.ts                 port lockfile shared by every entry point
  env.ts                      side-effect .env loader
  index.ts                    objectActor / storeActor / programActor + Rivet registry
  bootstrap.ts                seeds source files + programs as objects on first run
  client.ts                   the CLI shell (a pure program loader, no built-ins)
  dag/
    change.ts                 change construction + content-address hashing
    dag.ts                    topological sort, snapshot replay, head computation
  det/                        determinism layer for the chain
    canonical.ts              canonical encoding for signing
    ed25519.ts                signing + verification
    math.ts                   bounded big-int arithmetic
  sync/                       mDNS discovery + peer types (the wire layer)
  programs/
    runtime.ts                module bundler, actor lifecycle, validator dispatch
    handlers/                 one file per program (~30, see Application Layer above)
scripts/                      operational tools (daemon, dispatch, dumps, repairs)
test/                         unit tests for kernel, agents, chain, programs
docs/                         design notes for coin offers + the trading-agent system
```

## License

MIT.
