#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
PORT="${1:-8000}"

cd "$REPO_ROOT"
echo "Serving La Machine repo at http://localhost:$PORT/"
echo "Open http://localhost:$PORT/editorv2/"
exec python3 -m http.server "$PORT"
