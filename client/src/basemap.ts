// ---------------------------------------------------------------------------
// Pelorus — Base map (Natural Earth)
// ---------------------------------------------------------------------------
//
// Loads Natural Earth GeoJSON from static assets and returns deck.gl
// GeoJsonLayers for rendering under the data layers.
//
// Supports dark and light themes with distinct fill/stroke palettes.
// ---------------------------------------------------------------------------

import { GeoJsonLayer } from "@deck.gl/layers";
import { getTheme } from "./theme";

interface GeoData {
  countries: any | null;
  coastline: any | null;
  lakes: any | null;
  graticules: any | null;
}

const DARK_STYLE = {
  landFill:       [18, 18, 26, 255] as [number, number, number, number],
  landStroke:     [40, 40, 60, 180] as [number, number, number, number],
  coastStroke:    [50, 50, 75, 200] as [number, number, number, number],
  lakeFill:       [12, 12, 20, 255] as [number, number, number, number],
  gratStroke:     [25, 25, 40, 80]  as [number, number, number, number],
};

const LIGHT_STYLE = {
  landFill:       [232, 232, 240, 255] as [number, number, number, number],
  landStroke:     [180, 180, 200, 200] as [number, number, number, number],
  coastStroke:    [140, 140, 165, 220] as [number, number, number, number],
  lakeFill:       [200, 210, 230, 255] as [number, number, number, number],
  gratStroke:     [210, 210, 225, 100] as [number, number, number, number],
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
        const json = await res.json();
        return [key, json] as const;
      })
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        const [key, json] = result.value;
        this.data[key] = json;
      }
    }

    this._loaded = true;
    this._loading = false;
  }

  /** Build deck.gl layers for the base map. Returns empty array if not loaded. */
  getLayers(): any[] {
    if (!this._loaded) return [];

    const isDark = getTheme() === "dark";
    const style = isDark ? DARK_STYLE : LIGHT_STYLE;
    const layers: any[] = [];

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
