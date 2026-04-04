// ---------------------------------------------------------------------------
// Pelorus — Map renderer (deck.gl)
// ---------------------------------------------------------------------------
//
// Renders tracked objects as a ScatterplotLayer on a dark canvas.
// Uses deck.gl's binary attribute API for maximum throughput —
// typed arrays are passed directly, no per-row object allocation.
//
// Two render modes:
//   - "live" (default): renders only the latest batch (current positions)
//   - "buffer": renders the full position buffer (for time slider, Phase 5)
// ---------------------------------------------------------------------------

import { Deck, MapView } from "@deck.gl/core";
import { ScatterplotLayer } from "@deck.gl/layers";
import { getTheme } from "./theme";

// Category colors — RGBA arrays for deck.gl
const CATEGORY_COLORS: [number, number, number, number][] = [
  [74, 158, 255, 220],   // alpha  — blue
  [233, 69, 96, 220],    // bravo  — red
  [46, 204, 113, 220],   // charlie — green
  [243, 156, 18, 220],   // delta  — orange
  [155, 89, 182, 220],   // extra categories
  [52, 152, 219, 220],
  [231, 76, 60, 220],
  [241, 196, 15, 220],
];

const LIGHT_CATEGORY_COLORS: [number, number, number, number][] = [
  [37, 99, 235, 200],
  [220, 38, 38, 200],
  [22, 163, 74, 200],
  [217, 119, 6, 200],
  [147, 51, 234, 200],
  [59, 130, 246, 200],
  [239, 68, 68, 200],
  [245, 158, 11, 200],
];

/** Current frame of position data for live rendering */
export interface CurrentFrame {
  count: number;
  longitudes: Float64Array;
  latitudes: Float64Array;
  altitudes: Float64Array;
  speeds: Float64Array;
  headings: Float64Array;
  categories: Uint8Array;   // category indices
}

export interface MapConfig {
  container: HTMLElement;
  initialLongitude?: number;
  initialLatitude?: number;
  initialZoom?: number;
}

export class MapRenderer {
  private deck: Deck;
  private _currentFrame: CurrentFrame | null = null;
  private _lastUpdateRows = 0;
  private _renderVersion = 0;
  private _dirty = false;

  constructor(config: MapConfig) {
    this.deck = new Deck({
      parent: config.container,
      views: new MapView({ repeat: true }),
      initialViewState: {
        longitude: config.initialLongitude ?? 0,
        latitude: config.initialLatitude ?? 20,
        zoom: config.initialZoom ?? 1.5,
        pitch: 0,
        bearing: 0,
      },
      controller: true,
      parameters: {
        depthTest: false,
      },
    });
  }

  /**
   * Set the current frame of live data. Call this each time a new
   * batch arrives. The next update() call will render it.
   */
  setCurrentFrame(frame: CurrentFrame): void {
    this._currentFrame = frame;
    this._dirty = true;
  }

  /**
   * Update the deck.gl layer if new data is available.
   * Returns render time in ms (0 if nothing to do).
   */
  update(): number {
    if (!this._dirty || !this._currentFrame) return 0;
    this._dirty = false;

    const t0 = performance.now();
    const frame = this._currentFrame;
    const n = frame.count;
    const isDark = getTheme() === "dark";
    const palette = isDark ? CATEGORY_COLORS : LIGHT_CATEGORY_COLORS;

    this._renderVersion++;
    this._lastUpdateRows = n;

    // Build color array from category indices
    const colors = new Uint8Array(n * 4);
    const cats = frame.categories;
    for (let i = 0; i < n; i++) {
      const c = palette[cats[i] % palette.length];
      const offset = i * 4;
      colors[offset] = c[0];
      colors[offset + 1] = c[1];
      colors[offset + 2] = c[2];
      colors[offset + 3] = c[3];
    }

    // Build interleaved position array [lon, lat, alt]
    const positions = new Float64Array(n * 3);
    const lons = frame.longitudes;
    const lats = frame.latitudes;
    const alts = frame.altitudes;
    for (let i = 0; i < n; i++) {
      positions[i * 3] = lons[i];
      positions[i * 3 + 1] = lats[i];
      positions[i * 3 + 2] = alts[i];
    }

    const layer = new ScatterplotLayer({
      id: "objects",
      data: {
        length: n,
        attributes: {
          getPosition: { value: positions, size: 3 },
          getFillColor: { value: colors, size: 4 },
        },
      },
      radiusMinPixels: 3,
      radiusMaxPixels: 8,
      radiusScale: 1,
      filled: true,
      antialiasing: true,
      updateTriggers: {
        getPosition: this._renderVersion,
        getFillColor: this._renderVersion,
      },
    });

    this.deck.setProps({
      layers: [layer],
      style: {
        background: isDark ? "#0a0a0f" : "#f4f4f8",
      },
    });

    return performance.now() - t0;
  }

  get lastUpdateRows(): number { return this._lastUpdateRows; }

  destroy(): void {
    this.deck.finalize();
  }
}
