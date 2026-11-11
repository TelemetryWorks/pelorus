// ---------------------------------------------------------------------------
// Pelorus — Base map (Natural Earth)
// ---------------------------------------------------------------------------
//
// Loads Natural Earth GeoJSON from static assets and returns deck.gl
// GeoJsonLayers for rendering under the data layers.
//
// Supports dark and light themes with distinct fill/stroke palettes.
// ---------------------------------------------------------------------------

import { GeoJsonLayer, type GeoJsonLayerProps } from "@deck.gl/layers";
import { getTheme } from "./theme";

type GeoDocument = Extract<GeoJsonLayerProps["data"], { type: string }>;

interface GeoData {
  countries: GeoDocument | null;
  coastline: GeoDocument | null;
  lakes: GeoDocument | null;
  graticules: GeoDocument | null;
}

type Color = [number, number, number, number];
type MapStyle = Record<"landFill" | "landStroke" | "coastStroke" | "lakeFill" | "gratStroke", Color>;

const DARK_STYLE: MapStyle = {
  landFill:       [18, 18, 26, 255],
  landStroke:     [40, 40, 60, 180],
  coastStroke:    [50, 50, 75, 200],
  lakeFill:       [12, 12, 20, 255],
  gratStroke:     [25, 25, 40, 80],
};

const LIGHT_STYLE: MapStyle = {
  landFill:       [232, 232, 240, 255],
  landStroke:     [180, 180, 200, 200],
  coastStroke:    [140, 140, 165, 220],
  lakeFill:       [200, 210, 230, 255],
  gratStroke:     [210, 210, 225, 100],
};

export class BaseMap {
  private data: GeoData = {
    countries: null,
    coastline: null,
    lakes: null,
    graticules: null,
  };
  private _loaded = false;
  private _loading = false;

  get loaded(): boolean { return this._loaded; }

  /** Fetch all GeoJSON assets from the server */
  async load(): Promise<void> {
    if (this._loaded || this._loading) return;
    this._loading = true;

    const files: [keyof GeoData, string][] = [
      ["countries",  "/data/ne_110m_admin_0_countries.geojson"],
      ["coastline",  "/data/ne_110m_coastline.geojson"],
      ["lakes",      "/data/ne_110m_lakes.geojson"],
      ["graticules", "/data/ne_110m_graticules_30.geojson"],
    ];

    const results = await Promise.allSettled(
      files.map(async ([key, path]) => {
        const res = await fetch(path);
        if (!res.ok) return [key, null] as const;
        // Static Natural Earth GeoJSON assets are the loader contract.
        const json: GeoDocument = await res.json();
        return [key, json] as const;
      })
    );

    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled" && result.value) {
        const [key, json] = result.value;
        this.data[key] = json;
      } else if (result.status === "rejected") {
        console.warn(`Failed to load basemap asset ${files[index][1]}`, result.reason);
      }
    }

    this._loaded = true;
    this._loading = false;
  }

  /** Build deck.gl layers for the base map. Returns empty array if not loaded. */
  getLayers(): GeoJsonLayer[] {
    if (!this._loaded) return [];

    const isDark = getTheme() === "dark";
    const style = isDark ? DARK_STYLE : LIGHT_STYLE;
    const layers: GeoJsonLayer[] = [];

    // Graticule grid (lowest z)
    if (this.data.graticules) {
      layers.push(
        new GeoJsonLayer({
          id: "basemap-graticules",
          data: this.data.graticules,
          stroked: true,
          filled: false,
          getLineColor: style.gratStroke,
          getLineWidth: 0.5,
          lineWidthMinPixels: 0.5,
        })
      );
    }

    // Country polygons (land fill + borders)
    if (this.data.countries) {
      layers.push(
        new GeoJsonLayer({
          id: "basemap-countries",
          data: this.data.countries,
          stroked: true,
          filled: true,
          getFillColor: style.landFill,
          getLineColor: style.landStroke,
          getLineWidth: 1,
          lineWidthMinPixels: 0.5,
        })
      );
    }

    // Coastline overlay (sharper edge)
    if (this.data.coastline) {
      layers.push(
        new GeoJsonLayer({
          id: "basemap-coastline",
          data: this.data.coastline,
          stroked: true,
          filled: false,
          getLineColor: style.coastStroke,
          getLineWidth: 1,
          lineWidthMinPixels: 1,
        })
      );
    }

    // Lakes
    if (this.data.lakes) {
      layers.push(
        new GeoJsonLayer({
          id: "basemap-lakes",
          data: this.data.lakes,
          stroked: false,
          filled: true,
          getFillColor: style.lakeFill,
        })
      );
    }

    return layers;
  }
}
