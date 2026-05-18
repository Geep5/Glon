#!/usr/bin/env bash
# Hard-reset this glon's local state. Wipes:
#   - daemon and dev-server processes
#   - ~/.glon (DAG store, wallet, hyperswarm key)
#   - the rivetkit actor-state dir under ~/Library/Application Support
#
# Run this before walking through a clean setup on a new machine, or
# whenever you want to start over from scratch. Does NOT touch the
# Astrolabe repo. Does NOT touch your .env (KIMI_API_KEY etc).
set -euo pipefail

echo "[reset] stopping daemon + dev server..."
pkill -f "tsx scripts/daemon.ts" 2>/dev/null || true
pkill -f "tsx src/index.ts" 2>/dev/null || true
sleep 1

echo "[reset] wiping ~/.glon ..."
rm -rf "$HOME/.glon"

echo "[reset] wiping rivetkit state ..."
RIVETKIT_DIR="$HOME/Library/Application Support/rivetkit"
if [ -d "$RIVETKIT_DIR" ]; then
	find "$RIVETKIT_DIR" -maxdepth 1 -type d -name 'glonFiggies-*' -exec rm -rf {} +
fi

echo "[reset] done."
echo
echo "Next steps:"
echo "  1. npm run dev              # rivetkit on :6420"
echo "  2. npm run bootstrap        # writes program source into the DAG"
echo "  3. npm run daemon           # brings up swarm + auto-creates wallet default key"
echo "  4. curl -X POST http://127.0.0.1:6430/dispatch \\"
echo "       -H 'Content-Type: application/json' \\"
echo "       -d '{\"prefix\":\"/holdfast\",\"action\":\"setup\","
echo "             \"args\":[{\"name\":\"Mikey\",\"principalName\":\"Grant\"}]}'"
echo "     # creates the agent + self peer (identity_pubkey wired from the wallet)"
