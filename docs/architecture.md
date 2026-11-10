# Pelorus Architecture

## Overview

Pelorus is a GPU-accelerated geospatial object tracker designed for high-throughput streaming visualization. The system streams position data from a Rust server to a browser client over WebSocket using Apache Arrow IPC as the wire format, and renders tracked objects on a vector base map using deck.gl with GPU-side time filtering.

The design envelope is **2,000 tracked objects at 10 Hz** (20,000 records/second, ~2 MB/s sustained throughput). The architecture is intentionally over-provisioned so that typical workloads (hundreds of objects at 1 Hz) operate at single-digit percent capacity.

## System Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                       RUST SERVER                            │
│                                                              │
│  ┌────────────┐    ┌───────────────┐    ┌────────────────┐   │
│  │ Data Source │───►│ Arrow Schema  │───►│ IPC Serializer │   │
│  │ (ingest)   │    │ RecordBatch   │    │ (stream fmt)   │   │
│  └────────────┘    └───────────────┘    └───────┬────────┘   │
│                                                  │            │
│  ┌──────────────────────────────────────────────┐│            │
│  │            Axum WebSocket Server             ││            │
│  │         (per-client session, tokio)          ││            │
│  └──────────────────────────────────────────────┘│            │
└──────────────────────────────────────────────────┼────────────┘
                                                   │
                                          Arrow IPC binary
                                          frames over WS
                                                   │
┌──────────────────────────────────────────────────┼────────────┐
│                    BROWSER CLIENT                │            │
│                                                  ▼            │
│  ┌──────────────────────────────────────────────────────┐     │
│  │                  WebSocket Client                     │     │
│  │            (auto-reconnect, binary mode)              │     │
│  └───────────────────────┬──────────────────────────────┘     │
│                          │                                    │
│                          ▼                                    │
│  ┌──────────────────────────────────────────────────────┐     │
│  │              Arrow IPC Decoder                        │     │
│  │         (apache-arrow JS, zero-copy)                  │     │
│  └───────────────────────┬──────────────────────────────┘     │
│                          │                                    │
│                          ▼                                    │
│  ┌──────────────────────────────────────────────────────┐     │
│  │            Position Buffer (ring)                     │     │
│  │     pre-allocated flat Float64/Uint8 typed arrays     │     │
│  │           rolling window, ~60s at full rate           │     │
│  └──────────┬───────────────────────────────┬───────────┘     │
│             │                               │                 │
│             ▼                               ▼                 │
│  ┌────────────────────┐        ┌─────────────────────────┐    │
│  │    Time Slider      │        │    Map Renderer          │    │
│  │  (live / scrub)     │───────►│  deck.gl Deck            │    │
│  │  window width ctrl  │ range  │  ├─ GeoJsonLayer (base)  │    │
│  └────────────────────┘ update  │  └─ ScatterplotLayer     │    │
│                         (uniform│     + DataFilterExtension │    │
│                          only)  └─────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

## Component Descriptions

### Server Components

**Data Source / Ingest** — Currently a mock generator (`generator.rs`) that produces synthetic tracked objects with smooth random-walk trajectories. In production, this is replaced by a real data ingest pipeline (UDP, file replay, message bus, etc.). The generator is parameterized via `PELORUS_OBJECTS` and `PELORUS_HZ` environment variables.

**Arrow Schema** (`schema.rs`) — Defines the canonical `RecordBatch` layout. All components on both sides of the WebSocket agree on this schema. See [Data Pipeline](data-pipeline.md) for the full schema definition.

**IPC Serializer** (`ipc.rs`) — Converts `RecordBatch` to Arrow IPC stream format. Uses the streaming format (not file format) so each WebSocket message is independently decodable without a file footer.

**Axum WebSocket Server** (`main.rs`) — HTTP server with WebSocket upgrade at `/ws`. Each client connection gets its own `tokio::select!` loop that ticks the generator and pushes IPC frames. Static files (the client build) are served via `tower-http::ServeDir` as the fallback route.

### Client Components

**WebSocket Client** (`main.ts`) — Connects to `/ws`, sets `binaryType = "arraybuffer"`, auto-reconnects with configurable backoff. Binary messages go to the decode pipeline; text messages are logged.

**Arrow IPC Decoder** (`decode.ts`) — Calls `tableFromIPC()` from the `apache-arrow` JS library. Extracts typed arrays (`Float64Array`, `BigInt64Array`) from the decoded `Table`. String columns (`object_id`, `category`) are iterated into JS arrays. Returns decode timing for the performance monitor.

**Position Buffer** (`buffer.ts`) — Pre-allocated ring buffer of flat typed arrays. Holds a configurable maximum number of rows (default: 1.2M, ~60 seconds at full rate). Incoming batches are appended at the tail; when the buffer is full, the oldest rows are evicted via `TypedArray.copyWithin()` — no allocation, no GC pressure. Category strings are interned to integer indices on first encounter. See [Data Pipeline](data-pipeline.md) for buffer internals.

**Time Slider** (`timeslider.ts`) — UI control with two modes. In LIVE mode, the cursor auto-advances to the latest timestamp and the slider pins to the right edge. In SCRUB mode, the user drags the slider to a historical position. A secondary slider controls the time window width (how much data around the cursor is visible). The output is a `[filterMin, filterMax]` range in absolute microseconds, passed to the map renderer. See [GPU Precision](gpu-precision.md) for how this range is translated for the shader.

**Map Renderer** (`map.ts`) — Manages a deck.gl `Deck` instance with two layer groups: base map layers (Natural Earth GeoJSON via `GeoJsonLayer`) and the data layer (`ScatterplotLayer` with `DataFilterExtension`). The renderer has two update paths:

  1. **Full rebuild** — When new data arrives (`markDataDirty()`), the position, color, and timestamp attribute arrays are rebuilt from the buffer and re-uploaded to the GPU. This is the expensive path.
  2. **Filter-only** — When the time slider moves (`setFilterRange()`), only the `filterRange` uniform is updated. This is a single GL uniform write — zero CPU work, zero data transfer.

**Base Map** (`basemap.ts`) — Loads Natural Earth 110m GeoJSON files (countries, coastline, lakes, graticules) from static assets. Returns deck.gl `GeoJsonLayer` instances with dark/light theme palettes. Loaded asynchronously on startup; the data layer renders immediately while the base map loads.

**Theme Manager** (`theme.ts`) — Manages dark/light mode via CSS custom properties on `:root`. Persists preference to `localStorage`. Provides category color tokens used by both CSS and the deck.gl color palette.

**Performance Monitor** (`perf.ts`) — Tracks FPS (via `requestAnimationFrame` timestamps), batches/sec, rows/sec, byte throughput, average decode time, and average render time. Snapshots and resets at 1 Hz for the stats display.

## Key Design Decisions

**Arrow IPC as wire format** — Chosen over JSON or Protobuf because Arrow IPC gives zero-copy access to typed arrays on the client side. The `apache-arrow` JS library returns `Float64Array` views directly into the decoded buffer — no per-row deserialization, no intermediate objects. This is critical at 20K records/sec.

**Pre-allocated ring buffer** — The position buffer allocates all typed arrays at startup and never resizes. Appends write into the pre-allocated space; eviction uses `copyWithin()` which is a `memmove` under the hood. This eliminates GC pauses that would cause frame drops.

**GPU-side time filtering** — The `DataFilterExtension` injects a GLSL `discard` into the fragment shader that compares each vertex's timestamp against the filter range. Scrubbing the time slider updates one uniform — the GPU does all the filtering work. This is the core architectural insight that enables smooth time scrubbing at any data volume. See [GPU Precision](gpu-precision.md) for the Float32 precision constraint this introduces.

**Binary attribute API** — deck.gl's binary attribute API (`data.attributes`) bypasses the normal accessor function path. Instead of calling `getPosition(d, {index})` per row, typed arrays are uploaded directly as vertex attributes. This eliminates the per-row function call overhead that would otherwise dominate at high row counts.

**Flat columnar layout** — The position buffer stores each field as a separate typed array (longitudes, latitudes, altitudes, etc.) rather than an array of objects. This matches both the Arrow columnar format coming off the wire and the interleaved attribute format deck.gl expects, minimizing transformation overhead.
