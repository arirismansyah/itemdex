#!/usr/bin/env bash
# Starts the local SearXNG instance used for price lookups (http://127.0.0.1:8888).
# One-time setup: tools/searxng/setup.sh
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
if [ ! -x "$DIR/.venv/bin/python" ]; then
  echo "SearXNG is not installed yet. Run: npm run search:setup" >&2
  exit 1
fi
SECRET_FILE="$DIR/.secret"
[ -s "$SECRET_FILE" ] || openssl rand -hex 32 > "$SECRET_FILE"
export SEARXNG_SETTINGS_PATH="$DIR/settings.yml"
export SEARXNG_SECRET="$(cat "$SECRET_FILE")"
export SEARXNG_PORT="${SEARXNG_PORT:-8888}"
export SEARXNG_BIND_ADDRESS="${SEARXNG_BIND_ADDRESS:-127.0.0.1}"
cd "$DIR/src"
echo "SearXNG on http://$SEARXNG_BIND_ADDRESS:$SEARXNG_PORT"
exec "$DIR/.venv/bin/python" -m searx.webapp
