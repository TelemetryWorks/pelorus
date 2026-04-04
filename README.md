# Pelorus

GPU-accelerated geospatial object tracker with Arrow IPC streaming and shader-side time filtering.

**Current: Phase 4** — Natural Earth base map.

## Prerequisites

- Rust 2024 edition (1.85+)
- Node.js (for esbuild + npm deps — no runtime dependency)
- `curl` (for geodata download)

## Quick Start

```bash
# one-time: install deps
cd client && npm install && cd ..

# one-time: download Natural Earth geodata (public domain)
chmod +x scripts/*.sh
./scripts/download-geodata.sh

# build + run (defaults: 2000 objects @ 10 Hz)
./scripts/dev.sh
```

Open `http://127.0.0.1:3000` — colored dots moving over a vector world map.

## Configuration

Environment variables control the data generator:

| Variable | Default | Description |
|---|---|---|
| `PELORUS_OBJECTS` | `2000` | Number of tracked objects |
| `PELORUS_HZ` | `10` | Tick rate in Hz |

```bash
# conservative — 200 objects at 1 Hz
PELORUS_OBJECTS=200 PELORUS_HZ=1 ./scripts/dev.sh

# stress test — 5000 objects at 10 Hz (50K records/sec)
PELORUS_OBJECTS=5000 PELORUS_HZ=10 ./scripts/dev.sh
```

## Development

```bash
# watch mode: auto-rebuilds TS on save, runs server
./scripts/watch.sh
```

## Project Structure

```
├── Cargo.toml              # workspace root
├── server/
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs         # Axum + WebSocket streaming server
│       ├── schema.rs       # Arrow schema definition
│       ├── generator.rs    # Mock data generator (synthetic objects)
│       └── ipc.rs          # Arrow IPC serialization
├── client/
│   ├── package.json        # esbuild + apache-arrow + deck.gl
│   ├── src/
│   │   ├── main.ts         # Entry point, pipeline wiring
│   │   ├── decode.ts       # Arrow IPC decoder
│   │   ├── buffer.ts       # Rolling position buffer (typed arrays)
│   │   ├── map.ts          # deck.gl renderer (ScatterplotLayer)
│   │   ├── basemap.ts      # Natural Earth GeoJSON loader + layers
│   │   ├── perf.ts         # Real-time performance monitor
│   │   └── theme.ts        # Dark/light theme manager
│   └── dist/
│       ├── index.html      # served by Axum as static fallback
│       └── data/           # Natural Earth GeoJSON (downloaded)
└── scripts/
    ├── dev.sh              # build + run
    ├── watch.sh            # watch + run
    └── download-geodata.sh # fetch Natural Earth data
```

## Architecture

```
Rust server                          Browser client
┌─────────────────┐                  ┌─────────────────────────┐
│ Mock Generator   │                  │ WebSocket Client        │
│ (N objects @ Hz) │                  │         │               │
│       │          │   Arrow IPC      │   Arrow IPC Decoder     │
│  Arrow RecordBatch ──── WS ──────► │   (apache-arrow JS)     │
│       │          │   binary frames  │         │               │
│  IPC Serializer  │                  │  Position Buffer        │
└─────────────────┘                  │  (flat typed arrays)    │
                                     │         │               │
                                     │  deck.gl Layers         │
                                     │  ├─ GeoJsonLayer (base) │
                                     │  └─ ScatterplotLayer    │
                                     └─────────────────────────┘
```

## Phase Roadmap

1. ~~Skeleton — WebSocket echo~~
2. ~~Arrow IPC schema + mock data + browser decode~~
3. ~~deck.gl ScatterplotLayer — moving dots~~
4. **Natural Earth base map** ← current
5. Time slider with GPU-side filtering
6. Temporal chunk manager + ring buffer
7. Viewport culling with H3
8. Trail lines
9. Attribute coloring + filter UI
10. Multi-client session management
