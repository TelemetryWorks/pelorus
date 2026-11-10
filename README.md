# Pelorus

GPU-accelerated geospatial object tracker with Arrow IPC streaming and shader-side time filtering.

**Current: Phase 6 prototype** — Bounded in-memory archive and historical queries.
Correctness is covered by automated tests; browser performance and production capacity are not established.

## Prerequisites

- Rust 2024 edition (1.85+)
- Node.js (for esbuild + npm deps — no runtime dependency)
- `curl` (for geodata download)

## Quick Start

```bash
# one-time: install deps
cd client && npm install && cd ..

# one-time: download Natural Earth geodata (public domain)
bash scripts/download-geodata.sh

# build + run (defaults: 2000 objects @ 10 Hz)
bash scripts/dev.sh
```

Open `http://127.0.0.1:3000` — colored dots streaming over a vector world map with time scrubbing and server-side history.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PELORUS_OBJECTS` | `2000` | Number of tracked objects |
| `PELORUS_HZ` | `10` | Tick rate in Hz |
| `PELORUS_CHUNK_INTERVAL_US` | `5000000` | Chunk duration (μs) |
| `PELORUS_MAX_CHUNKS` | `720` | Maximum sealed chunks |
| `PELORUS_MAX_ROWS` | `1200000` | Maximum archive rows, including open chunk |

```bash
# conservative — 200 objects at 1 Hz
PELORUS_OBJECTS=200 PELORUS_HZ=1 bash scripts/dev.sh

# stress test — 5000 objects at 10 Hz (50K records/sec)
PELORUS_OBJECTS=5000 PELORUS_HZ=10 bash scripts/dev.sh
```

## Time Slider

The time slider filters the position buffer entirely on the GPU.

- **LIVE mode** (green) — cursor auto-advances to the latest timestamp
- **SCRUB mode** (amber) — drag the slider to scrub through history
- **Window width** — controls how much time around the cursor is visible

The slider range includes sealed server history. Scrubbing beyond local live retention queries overlapping whole chunks into a separate bounded history view. LIVE returns to the advancing live buffer. The archive's row cap can evict history well before one hour: at the default 20K rows/sec, the row budget holds about 60 seconds including the open chunk. See the [retention and memory limits](docs/chunk-manager.md).

## Documentation

| Document | Description |
|---|---|
| [Architecture](docs/architecture.md) | System design, component descriptions, key decisions |
| [Data Pipeline](docs/data-pipeline.md) | End-to-end data flow from server to GPU |
| [Chunk Manager](docs/chunk-manager.md) | Temporal chunking, retention, query protocol |
| [GPU Precision](docs/gpu-precision.md) | Float32 constraints and the relative timestamp solution |
| [Development](docs/development.md) | Setup, build, configuration, debugging, extending |

## Project Structure

```
├── Cargo.toml              # workspace root
├── server/
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs         # Axum server, WebSocket + query handler
│       ├── schema.rs       # Arrow schema definition
│       ├── generator.rs    # Mock data generator
│       ├── ipc.rs          # Arrow IPC serialization
│       ├── chunks.rs       # Temporal chunk manager
│       └── protocol.rs     # JSON command/response types
├── client/
│   ├── package.json        # esbuild + apache-arrow + deck.gl
│   ├── src/
│   │   ├── main.ts         # Entry point, pipeline + query state machine
│   │   ├── decode.ts       # Arrow IPC decoder
│   │   ├── buffer.ts       # Rolling position buffer
│   │   ├── map.ts          # deck.gl renderer + DataFilterExtension
│   │   ├── basemap.ts      # Natural Earth GeoJSON layers
│   │   ├── timeslider.ts   # Time slider (live/scrub + server range)
│   │   ├── protocol.ts     # JSON message types
│   │   ├── perf.ts         # Performance monitor
│   │   └── theme.ts        # Dark/light theme
│   └── dist/
│       ├── index.html
│       └── data/           # Natural Earth GeoJSON (downloaded)
├── docs/                   # Engineering documentation
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
5. ~~Time slider with GPU-side filtering~~
6. **Bounded temporal archive + history queries** ← current prototype (client uses flat buffers, not a GPU ring)
7. Viewport culling with H3
8. Trail lines
9. Attribute coloring + filter UI
10. Multi-client session management

## Checks

```bash
cargo fmt --all -- --check
cargo test --workspace -j 2
cargo clippy --workspace --all-targets -j 2 -- -D warnings
cargo build -p server -j 2
cd client
PELORUS_SERVER_BIN=../target/debug/server npm test
npm run build
```

Node 24+ is required for the standard test harness. The frontend build is not a
TypeScript typecheck. See [Development](docs/development.md) for test boundaries.
