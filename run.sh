#!/usr/bin/env bash
# Run the rpg-tabletop server.
#
# Usage:
#   ./run.sh [--host HOST] [--port PORT] [--reload]   Start the server (default)
#   ./run.sh create-user USERNAME [--admin]            Create a login account
#
# Host/port honor the PORT / HOST env vars (as set by server-watcher), falling back to
# 127.0.0.1:8000 for local dev.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [[ ! -d ".venv" ]]; then
  echo "No virtual environment found, creating .venv ..." >&2
  python3 -m venv .venv
  source .venv/bin/activate
  pip install -q --upgrade pip
else
  source .venv/bin/activate
fi

# Always sync deps (pip no-ops quickly when requirements.txt hasn't changed), so an
# existing .venv on a deployed server picks up newly added dependencies on redeploy.
pip install -q -r requirements.txt

COMMAND="serve"
if [[ $# -gt 0 && "$1" != -* ]]; then
  COMMAND="$1"
  shift
fi

case "$COMMAND" in
  create-user)
    exec python scripts/create_user.py "$@"
    ;;
  serve)
    HOST="${HOST:-127.0.0.1}"
    PORT="${PORT:-8000}"
    RELOAD=""

    while [[ $# -gt 0 ]]; do
      case "$1" in
        --host) HOST="$2"; shift 2 ;;
        --port) PORT="$2"; shift 2 ;;
        --reload) RELOAD="--reload"; shift ;;
        -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown argument: $1" >&2; exit 1 ;;
      esac
    done

    exec python -m uvicorn app.main:app --host "$HOST" --port "$PORT" $RELOAD
    ;;
  -h|--help)
    grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0
    ;;
  *)
    echo "Unknown command: $COMMAND" >&2
    echo "Usage: ./run.sh [--host HOST] [--port PORT] [--reload] | create-user USERNAME [--admin]" >&2
    exit 1
    ;;
esac
