#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR/.."
ESBUILD="$ROOT/client/node_modules/.bin/esbuild"
if [[ ! -x "$ESBUILD" ]]; then
  echo "Missing local esbuild. Run npm ci --ignore-scripts in $ROOT/client." >&2
  exit 1
fi
DATA_DIR="$ROOT/client/dist/data"

# Check for geodata
if [ ! -f "$DATA_DIR/ne_110m_admin_0_countries.geojson" ]; then
  echo "⚠  No geodata found. Run: ./scripts/download-geodata.sh"
  echo "   (base map will be blank until downloaded)"
  echo ""
fi

echo "=== building client ==="
cd "$ROOT/client"
"$ESBUILD" src/main.ts \
  --bundle \
  --outfile=dist/app.js \
  --sourcemap \
  --target=es2022 \
  --format=esm

echo "=== building server ==="
cd "$ROOT"
cargo build --release -p server

echo "=== starting server on http://127.0.0.1:3000 ==="
RUST_LOG=server=debug,tower_http=debug cargo run --release -p server
