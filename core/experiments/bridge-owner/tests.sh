#!/usr/bin/env bash
# Bridge-owner experiment runner.
#
# Run from genericagent-webui/core (so cargo finds Cargo.toml) OR from
# genericagent-webui (so the binary's default cwd is right).
#
# Each scenario sets cwd to the workbench repo root and points GA_PATH at
# JC's GA checkout. Override via env vars if those defaults are wrong.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CORE_DIR="$REPO_ROOT/core"

GA_PATH="${GA_PATH:-$HOME/Documents/GenericAgent}"
PYTHON="${PYTHON:-python3}"

scenario="${1:-l1}"

echo "[runner] repo root = $REPO_ROOT"
echo "[runner] ga_path   = $GA_PATH"
echo "[runner] python    = $PYTHON"
echo "[runner] scenario  = $scenario"
echo

# Build once (cached if unchanged)
( cd "$CORE_DIR" && cargo build --features experiments --bin bridge-owner-experiment ) || {
    echo "[runner] build failed"
    exit 1
}

BIN="$CORE_DIR/target/debug/bridge-owner-experiment"

# Run from repo root so Python's `-m runner.workbench_bridge` resolves.
cd "$REPO_ROOT"
GA_PATH="$GA_PATH" PYTHON="$PYTHON" "$BIN" "$scenario"
exit_code=$?

echo
echo "[runner] scenario $scenario exited with code $exit_code"

# Belt-and-suspenders orphan check (covers L4 even if the binary said PASS).
# We filter to `--session-id exp_*` so the check ignores any unrelated bridge
# children (e.g. JC's running /Applications/Galley.app, which we keep alive
# during refactor per invariant I8).
echo "[runner] orphan check (exp_* session-ids only)..."
remaining=$(pgrep -f -- "--session-id exp_" 2>/dev/null || true)
if [ -n "$remaining" ]; then
    echo "[runner] ORPHAN EXPERIMENT BRIDGES DETECTED:"
    echo "$remaining" | xargs ps -p 2>/dev/null
    exit 1
else
    echo "[runner] no orphan exp_* bridges"
fi

exit $exit_code
