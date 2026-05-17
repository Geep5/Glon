# Figgies

A tiny chore-points system for a family, with a built-in auction house.

Parents mint "figgies" as rewards. Kids spend them in auctions on things like
extra screen time, picking dinner, getting out of a chore, etc. Anyone in the
family can also send figgies directly to anyone else.

One daemon per device. Devices sync over your home Wi-Fi by polling each
other every few seconds.

## Quick start

Each device needs a user name:

```bash
# Mom's laptop (parent — can mint figgies)
FIGGIES_USER=mom FIGGIES_AUTO_PARENT=1 npm run daemon

# Another device, after a parent has registered the user via the UI
FIGGIES_USER=kid1 npm run daemon
```

If you want devices to sync, set `FIGGIES_PEERS` to a comma-separated list
of peer URLs:

```bash
FIGGIES_USER=mom FIGGIES_PEERS=http://192.168.1.20:6430,http://192.168.1.30:6430 npm run daemon
```

LAN-only by default. If you want a kid's tablet to reach the family when
they're not on home Wi-Fi, run one device (e.g. an always-on home server)
that everyone points at as their `FIGGIES_PEERS`.

## State

Everything lives in `~/.figgies/state.json` as one JSON document. Operations
are appended to a `log` array; applying an op is idempotent on `op.id`. Sync
is just "send me ops you have that I don't" — last write wins on the rare
conflict.

## API

The daemon listens on `127.0.0.1:6430`.

- `POST /dispatch` — `{prefix, action, args}` → `{ok, result|error}`. Used by
  the [Astrolabe](https://github.com/Geep5/glonAstrolabe) UI for the auction
  house, coins, and family management.
- `GET /ops?since=<op_id>` — used by other Figgies daemons during sync.
- `GET /state` — full state dump (debug).
- `GET /health` — liveness + counts.

### Dispatch reference

| Prefix | Action | Args |
|---|---|---|
| `/family` | `list` | — |
| `/family` | `me` | — |
| `/family` | `register` | `{name, role}` where role is `parent` or `kid` |
| `/family` | `mint` | `{to, amount, memo?}` (parent only) |
| `/family` | `transfer` | `{to, amount, memo?}` (sender = local user) |
| `/family` | `log` | — full op history |
| `/family` | `peers` | — sync peer status |
| `/coin` | `list` | — |
| `/coin` | `holders` | `{tokenId}` |
| `/auction` | `status` | — |
| `/auction` | `list` | — |
| `/auction` | `getBids` | `[auction_id]` |
| `/auction` | `post` | `{give, want, expiryMs}` |
| `/auction` | `bid` | `{auctionId, offer}` |
| `/auction` | `settle` | `{auctionId, winner}` |
| `/auction` | `cancel` | `{auctionId}` |

## Trust model

There is none. Figgies assumes everyone on the network is your family. No
signatures, no consensus, no double-spend defense. If a kid figures out how
to mint herself a million figgies, talk to her about it.
