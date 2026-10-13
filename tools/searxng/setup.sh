#!/usr/bin/env bash
# One-time install of SearXNG (open-source metasearch) for ITEMDEX price checks.
# No Docker: clones the source and installs it into a local Python venv.
# Needs git and Python >= 3.10. Re-run to update.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
REF="${SEARXNG_REF:-master}"
PY="${PYTHON:-python3}"

"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' \
  || { echo "Python >= 3.10 required (set PYTHON=/path/to/python3.x)" >&2; exit 1; }

if [ -d "$DIR/src/.git" ]; then
  git -C "$DIR/src" fetch --depth 1 origin "$REF" && git -C "$DIR/src" checkout -q FETCH_HEAD
else
  git clone --depth 1 --branch "$REF" https://github.com/searxng/searxng.git "$DIR/src"
fi

[ -x "$DIR/.venv/bin/python" ] || "$PY" -m venv "$DIR/.venv"
"$DIR/.venv/bin/pip" install -q -U pip setuptools wheel
"$DIR/.venv/bin/pip" install -q -r "$DIR/src/requirements.txt"
(cd "$DIR/src" && "$DIR/.venv/bin/pip" install -q --no-build-isolation -e .)
echo "SearXNG installed ($(git -C "$DIR/src" rev-parse --short HEAD)). Start it with: npm run search"
