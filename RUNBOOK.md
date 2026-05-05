# Glon Operations Runbook

Quick reference for getting this project running and keeping it alive.

## Prerequisites

```bash
npm install
# .env must contain:
#   KIMI_API_KEY=sk-...
#   DISCORD_BOT_TOKEN=<bot token>
# ANTHROPIC_API_KEY is optional; the default model is Kimi (moonshot-v1-8k)
```

## Starting the stack

Two processes are required. The dev server alone is **not enough**.

**Terminal 1 — actor host (core store + object actors):**
```bash
npm run dev
```
Binds `:6420`. Inspector UI: http://127.0.0.1:6420/ui/

**Terminal 2 — daemon (programs + Discord bridge + reminders + ticks):**
```bash
npx tsx scripts/daemon.ts
```
Binds `:6430` (HTTP dispatch). The daemon is what runs:
- Discord gateway (presence/online status)
- Discord DM polling (every 3s)
- Reminder scheduler (every 30s)
- Anchor commits (every 60s)

If the daemon dies, the agent stops reading Discord DMs and reminders stop firing. Restart it.

## First-time / bootstrap

After source changes (including this runbook):
```bash
npm run bootstrap
```
This pushes `src/` into the DAG store so programs load from there.

## Agent setup

The default model is **Kimi** (`moonshot-v1-8k`). The hardcoded default lives in `src/programs/handlers/agent.ts` (`DEFAULT_MODEL`). If you change it, re-run `npm run bootstrap`.

Per-agent override:
```bash
npx tsx src/client.ts
/agent config <agent-id> model <model-name>
```

### Discover your IDs

```bash
# List agents
npx tsx src/client.ts <<'EOF'
/crud list agent
EOF

# List peers
npx tsx src/client.ts <<'EOF'
/peer list
EOF

# Get full agent state
npx tsx src/client.ts <<'EOF'
/crud get <agent-id>
EOF
```

## Discord

- The bot needs `Bot` scope + `Send Messages` + `Read Message History` permissions.
- The bot stays online via a Gateway WebSocket maintained by the daemon.
- DMs are polled via REST every 3s. Rate-limit `429` responses are normal after restarts; the daemon backs off and retries automatically.
- **Bridge channels**: Set `GLON_BRIDGE_CHANNELS` in `.env` (comma-separated channel IDs) to enable inter-agent communication over shared server channels. Bot-to-bot DMs are forbidden by Discord, so bridge channels are the only way for two bots to talk.

### Bridge channel setup

1. Add the other agent as a peer with its Discord user ID:
   ```bash
   npx tsx src/client.ts <<'EOF'
   /peer add {"display_name":"<name>","kind":"agent","trust_level":"family","discord_id":"<discord-user-id>","notes":"<description>"}
   EOF
   ```
2. Set the bridge channel in `.env`:
   ```
   GLON_BRIDGE_CHANNELS=<channel-id>
   ```
3. Restart the daemon to pick up the env var.
4. Only **one** bot should auto-ingest in the bridge channel. The other bot should post manually via `discord_bridge_send` or `sendChannel`.

### Discord troubleshooting

| Symptom | Check |
|---------|-------|
| Bot shows offline | Daemon is dead. Restart `npx tsx scripts/daemon.ts`. |
| Bot online but not replying | Check daemon log for `poll error` or `ingest failed`. |
| 429 rate limits | Transient after restarts. Wait 10–20s. If persistent, check if multiple daemon instances are running. |
| Bot-to-bot DMs fail with 50007 | Expected — Discord forbids bot-to-bot DMs. Use a bridge channel instead. |

## Common recovery

```bash
# 1. Is the dev server up?
curl -s http://localhost:6420/ui/ > /dev/null && echo "dev ok" || echo "dev DOWN"

# 2. Is the daemon up?
curl -s http://localhost:6430/ > /dev/null && echo "daemon ok" || echo "daemon DOWN"

# 3. Restart daemon (safe, no data loss)
npx tsx scripts/daemon.ts

# 4. Check agent model and state
npx tsx src/client.ts <<'EOF'
/crud list agent
/crud get <agent-id>
EOF
```

## State

All state lives in `~/.glon/` (DAG changes) and `~/.glon-data/` (wallet, endpoint lockfile). No external database. Back up those directories to preserve everything.

## Ports

| Port | Purpose |
|------|---------|
| 6420 | RivetKit actor host (dev server) |
| 6430 | Daemon HTTP dispatch endpoint |

Set `GLON_PORT` in `.env` to override the dev server port. The daemon port is controlled by `GLON_DAEMON_PORT` (default 6430).

## Files you might edit

| File | What it controls |
|------|-----------------|
| `src/programs/handlers/agent.ts` | Agent logic, model defaults, compaction |
| `src/programs/handlers/discord.ts` | Discord bridge, gateway, polling |
| `src/programs/handlers/holdfast.ts` | Harness wiring (tools, ingest, say) |
| `src/programs/handlers/coin.ts`  | Coin, token, bucket, and offer handlers |
| `scripts/daemon.ts` | Headless daemon entry point |
| `.env` | API keys, tokens, ports |

After editing any handler, run `npm run bootstrap` to push the new source into the store, then restart the daemon.

## Heads-up: Kimi-only

This environment is configured for **Kimi (Moonshot AI)** as the primary LLM. Anthropic support exists but requires an explicit `ANTHROPIC_API_KEY` and per-agent model override. If an agent seems to hang silently, check whether it's trying to call Claude with no key.

## Quick health check

```bash
npx tsx src/client.ts <<'EOF'
/discord status
/holdfast status
/holdfast say ping
EOF
```


Expected: gateway connected, agent ID + principal ID printed, and a "pong" response.

---

## Coin Offers (atomic swaps)

Glon supports peer-to-peer atomic token swaps via `chain.coin.offer`. Offers are never-expiring and support N-for-M multi-asset trades from day one. Settlement uses cross-object batch validation (`pushChangesBatch`) for atomicity.

### Deploy a token first

```bash
npx tsx src/client.ts <<'EOF'
/coin deploy MyToken MT 1000000 --decimals=2 --key=default
EOF
```

### Create an offer (maker)

```bash
npx tsx src/client.ts <<'EOF'
/coin offer create <token_id> <amount> <request_token_id> <request_amount> --key=default
EOF
```

Example: offer 1000 MT for 500 of another token.

### Accept an offer (taker)

```bash
npx tsx src/client.ts <<'EOF'
/coin offer accept <offer_id> --key=default
EOF
```

The taker must have sufficient balance of the requested tokens. The command auto-selects payment coins, spends them, pays into the offer, and settles atomically in a single batch.

### Claim settled outputs

After settlement, each party claims their outputs:

```bash
npx tsx src/client.ts <<'EOF'
/coin offer claim <offer_id> --key=default
EOF
```

### Other offer commands

```bash
# List all offers
/coin offer list

# Show offer details + replay state
/coin offer info <offer_id>

# Cancel (maker only)
/coin offer cancel <offer_id> --key=default

# Export offer JSON for sharing
/coin offer export <offer_id> --file=offer.json

# Inspect exported offer
/coin offer import offer.json
```

---

Last updated: 2026-05-05

## Appendix: keeping env-specific notes locally

If you want to track your own agent IDs, peer IDs, Discord IDs, and bridge channels without committing them, create a file outside the repo (e.g. `~/glon-notes.md`) or add them to your shell env. The commands in the "Discover your IDs" section above will always let you look them up from the running system.
