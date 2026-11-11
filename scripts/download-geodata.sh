#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Download Natural Earth vector data for Pelorus base map
# Run once during project setup. Data is public domain.
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$SCRIPT_DIR/../client/dist/data"
mkdir -p "$DATA_DIR"

BASE_URL="https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson"

CURL_OPTIONS=(--fail --silent --show-error --location --proto '=https' --proto-redir '=https')

echo "=== downloading Natural Earth 110m data ==="

# Country polygons (land + borders)
echo "  countries..."
curl "${CURL_OPTIONS[@]}" -o "$DATA_DIR/ne_110m_admin_0_countries.geojson" \
  "$BASE_URL/ne_110m_admin_0_countries.geojson"

# Coastline (backup/overlay)
echo "  coastline..."
curl "${CURL_OPTIONS[@]}" -o "$DATA_DIR/ne_110m_coastline.geojson" \
  "$BASE_URL/ne_110m_coastline.geojson"

# Lakes
echo "  lakes..."
curl "${CURL_OPTIONS[@]}" -o "$DATA_DIR/ne_110m_lakes.geojson" \
  "$BASE_URL/ne_110m_lakes.geojson"

# Graticule (lat/lon grid lines)
echo "  graticules..."
curl "${CURL_OPTIONS[@]}" -o "$DATA_DIR/ne_110m_graticules_30.geojson" \
  "$BASE_URL/ne_110m_graticules_30.geojson"

echo ""
echo "=== optional: higher detail 50m data ==="
echo "  countries (50m)..."
curl "${CURL_OPTIONS[@]}" -o "$DATA_DIR/ne_50m_admin_0_countries.geojson" \
  "$BASE_URL/ne_50m_admin_0_countries.geojson"

echo ""
echo "=== done ==="
ls -lh "$DATA_DIR"/*.geojson
echo ""
echo "Total:"
du -sh "$DATA_DIR"
