#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR/.."

cleanup() {
  echo "shutting down..."
  kill $ESBUILD_PID $SERVER_PID 2>/dev/null || true
  exit 0
}
trap cleanup SIGINT SIGTERM

echo "=== starting esbuild watch ==="
cd "$ROOT/client"
npx esbuild src/main.ts \
  --bundle \
  --outfile=dist/app.js \
  --sourcemap \
  --target=es2022 \
  --format=esm \
  --watch &
ESBUILD_PID=$!

echo "=== building server ==="
cd "$ROOT"
cargo build --release -p server

echo "=== starting server on http://127.0.0.1:3000 ==="
RUST_LOG=server=debug,tower_http=debug cargo run --release -p server &
SERVER_PID=$!

wait
