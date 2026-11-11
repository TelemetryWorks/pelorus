// ---------------------------------------------------------------------------
// Pelorus — Map renderer (deck.gl)
// ---------------------------------------------------------------------------
//
// Renders tracked objects with GPU-side time filtering via
// DataFilterExtension. Uses RELATIVE timestamps (offset from buffer
// minimum) to avoid Float32 precision loss in WebGL shaders.
//
// The full position buffer is uploaded to the GPU; the time slider
// updates filter props while reusing cached attribute arrays.
// ---------------------------------------------------------------------------

import { Deck, MapView } from "@deck.gl/core";
import { ScatterplotLayer } from "@deck.gl/layers";
import { DataFilterExtension, type DataFilterExtensionProps } from "@deck.gl/extensions";
import { BaseMap } from "./basemap";
import { PositionBuffer } from "./buffer";
import { getTheme } from "./theme";

// Category colors — RGBA arrays for deck.gl
const CATEGORY_COLORS: [number, number, number, number][] = [
  [74, 158, 255, 220],   // alpha  — blue
  [233, 69, 96, 220],    // bravo  — red
  [46, 204, 113, 220],   // charlie — green
  [243, 156, 18, 220],   // delta  — orange
  [155, 89, 182, 220],
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

export interface MapConfig {
  container: HTMLDivElement;
  initialLongitude?: number;
  initialLatitude?: number;
  initialZoom?: number;
}

export class MapRenderer {
  private deck: Deck<MapView>;
  private basemap: BaseMap;
  private buffer: PositionBuffer | null = null;

  private _lastUpdateRows = 0;
  private _dataVersion = 0;
  private _filterVersion = 0;
  private _dirty = false;
  private _filterDirty = false;
  private _basemapLoaded = false;

  // Absolute filter range in microseconds (set by time slider)
  private _filterMinAbs = -Infinity;
  private _filterMaxAbs = Infinity;

  // Epoch offset — subtracted from all timestamps for GPU precision
  private _epochOffsetUs = 0;

  // Cached attribute arrays — rebuilt only when _dataVersion changes
  private _cachedPositions: Float64Array | null = null;
  private _cachedColors: Uint8Array | null = null;
  private _cachedRelTimestamps: Float32Array | null = null;  // relative, Float32-safe
  private _cachedLength = 0;
  private _cachedDataVersion = -1;

  constructor(config: MapConfig) {
    this.basemap = new BaseMap();

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
    });

    this.basemap.load().then(() => {
      this._basemapLoaded = true;
      this._dirty = true;
    });
  }

  setBuffer(buffer: PositionBuffer): void {
    if (this.buffer === buffer) return;
    this.buffer = buffer;
    this.markDataDirty();
  }

  /** Call when new data has been appended to the buffer */
  markDataDirty(): void {
    this._dataVersion++;
    this._dirty = true;
  }

  /**
   * Update the time filter range (absolute microseconds).
   * Internally converted to relative timestamps for the GPU.
   */
  setFilterRange(minUs: number, maxUs: number): void {
    this._filterMinAbs = minUs;
    this._filterMaxAbs = maxUs;
    this._filterVersion++;
    this._filterDirty = true;
  }

  /** Force full re-render (e.g. theme change) */
  invalidate(): void {
    this._dirty = true;
  }

  /**
   * Update deck.gl layers. Returns render time in ms.
   */
  update(): number {
    if (!this._dirty && !this._filterDirty) return 0;

    const t0 = performance.now();
    const isDark = getTheme() === "dark";

    // Rebuild cached attribute arrays if data changed
    if (this.buffer && this._cachedDataVersion !== this._dataVersion) {
      this._rebuildCache(isDark);
    }

    const baseLayers = this.basemap.getLayers();
    const dataLayers = this._buildFilteredLayer();

    this.deck.setProps({
      layers: [...baseLayers, ...dataLayers],
      style: {
        background: isDark ? "#0a0a0f" : "#f4f4f8",
      },
    });

    this._dirty = false;
    this._filterDirty = false;

    return performance.now() - t0;
  }

  /**
   * Rebuild cached attribute arrays from the buffer.
   * Expensive — only on new data.
   */
  private _rebuildCache(isDark: boolean): void {
    if (!this.buffer || this.buffer.length === 0) {
      this._cachedLength = 0;
      this._cachedPositions = null;
      this._cachedColors = null;
      this._cachedRelTimestamps = null;
      this._cachedDataVersion = this._dataVersion;
      return;
    }

    const buf = this.buffer;
    const n = buf.length;
    const palette = isDark ? CATEGORY_COLORS : LIGHT_CATEGORY_COLORS;

    // Positions [lon, lat, alt] interleaved
    const positions = new Float64Array(n * 3);
    const lons = buf.longitudes;
    const lats = buf.latitudes;
    const alts = buf.altitudes;
    for (let i = 0; i < n; i++) {
      positions[i * 3] = lons[i];
      positions[i * 3 + 1] = lats[i];
      positions[i * 3 + 2] = alts[i];
    }

    // Colors
    const colors = new Uint8Array(n * 4);
    const cats = buf.categories;
    for (let i = 0; i < n; i++) {
      const c = palette[cats[i] % palette.length];
      const offset = i * 4;
      colors[offset] = c[0];
      colors[offset + 1] = c[1];
      colors[offset + 2] = c[2];
      colors[offset + 3] = c[3];
    }

    // Relative timestamps — subtract epoch offset so values fit in Float32
    // A Float32 can represent integers up to 2^24 = 16,777,216 exactly.
    // In microseconds that's ~16.7 seconds. For larger windows we use
    // millisecond-relative values which gives ~16,777 seconds (~4.6 hours).
    const absTimestamps = buf.timestamps;
    const epochOffset = absTimestamps.length > 0 ? absTimestamps[0] : 0;
    this._epochOffsetUs = epochOffset;

    const relTimestamps = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // Convert to relative milliseconds for Float32 safety
      relTimestamps[i] = (absTimestamps[i] - epochOffset) / 1000.0;
    }

    this._cachedPositions = positions;
    this._cachedColors = colors;
    this._cachedRelTimestamps = relTimestamps;
    this._cachedLength = n;
    this._cachedDataVersion = this._dataVersion;
    this._lastUpdateRows = n;
  }

  /**
   * Build ScatterplotLayer with DataFilterExtension.
   * Filter range is converted from absolute to relative milliseconds.
   */
  private _buildFilteredLayer(): ScatterplotLayer<never, DataFilterExtensionProps>[] {
    if (!this._cachedPositions || this._cachedLength === 0) return [];

    const n = this._cachedLength;

    // Convert absolute filter range to relative milliseconds
    const filterMinRel = (this._filterMinAbs - this._epochOffsetUs) / 1000.0;
    const filterMaxRel = (this._filterMaxAbs - this._epochOffsetUs) / 1000.0;

    return [
      new ScatterplotLayer<never, DataFilterExtensionProps>({
        id: "objects",
        data: {
          length: n,
          attributes: {
            getPosition: { value: this._cachedPositions!, size: 3 },
            getFillColor: { value: this._cachedColors!, size: 4 },
            getFilterValue: { value: this._cachedRelTimestamps!, size: 1 },
          },
        },
        radiusMinPixels: 3,
        radiusMaxPixels: 8,
        radiusScale: 1,
        filled: true,
        antialiasing: true,

        // GPU-side time filter
        extensions: [new DataFilterExtension({ filterSize: 1 })],
        filterRange: [filterMinRel, filterMaxRel],

        updateTriggers: {
          getPosition: this._dataVersion,
          getFillColor: this._dataVersion,
          getFilterValue: this._dataVersion,
        },
      }),
    ];
  }

  get lastUpdateRows(): number { return this._lastUpdateRows; }
  get basemapLoaded(): boolean { return this._basemapLoaded; }

  destroy(): void {
    this.deck.finalize();
  }
}
