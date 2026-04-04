# Pelorus

GPU-accelerated geospatial object tracker with Arrow IPC streaming and shader-side time filtering.

**Current: Phase 5** — GPU-side time filtering with zero-cost scrubbing.

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

Open `http://127.0.0.1:3000` — colored dots streaming over a vector world map with time scrubbing.

## Configuration

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

## Time Slider

The time slider filters the position buffer entirely on the GPU.

- **LIVE mode** (green) — cursor auto-advances to the latest timestamp
- **SCRUB mode** (amber) — drag the slider to scrub through buffered history
- **Window width** — controls how much time around the cursor is visible
  - Narrow (0.1s): shows one position per object — clean current view
  - Wide (10s+): shows historical positions — trail-like visualization

Scrubbing updates only a shader uniform. No data re-upload, no CPU work.
Click LIVE/SCRUB button to toggle modes.

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
│   │   ├── map.ts          # deck.gl renderer + DataFilterExtension
│   │   ├── basemap.ts      # Natural Earth GeoJSON loader
│   │   ├── timeslider.ts   # Time slider (live/scrub modes)
│   │   ├── perf.ts         # Real-time performance monitor
│   │   └── theme.ts        # Dark/light theme manager
│   └── dist/
│       ├── index.html
│       └── data/           # Natural Earth GeoJSON (downloaded)
└── scripts/
    ├── dev.sh
    ├── watch.sh
    └── download-geodata.sh
```

## Phase Roadmap

1. ~~Skeleton — WebSocket echo~~
2. ~~Arrow IPC schema + mock data + browser decode~~
3. ~~deck.gl ScatterplotLayer — moving dots~~
4. ~~Natural Earth base map~~
5. **Time slider with GPU-side filtering** ← current
6. Temporal chunk manager + ring buffer
7. Viewport culling with H3
8. Trail lines
9. Attribute coloring + filter UI
10. Multi-client session management
