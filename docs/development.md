# Development Guide

## Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Rust | 2024 edition (1.85+) | Server binary |
| Node.js | 18+ | esbuild transpiler, npm dependency management |
| curl | any | Geodata download script |

No runtime Node.js dependency exists. Node is used only at build time for esbuild (TypeScript → JavaScript bundling) and npm (dependency resolution for `apache-arrow` and `deck.gl`).

## First-Time Setup

```bash
# Clone and enter the repo
git clone <repo-url> pelorus && cd pelorus

# Install client dependencies (one-time)
cd client && npm install && cd ..

# Download Natural Earth geodata (one-time, ~3 MB, public domain)
chmod +x scripts/*.sh
./scripts/download-geodata.sh
```

The geodata files are gitignored. Each developer runs the download script once. The base map will render as a blank dark canvas if the geodata is missing — the data layer still works.

## Building and Running

### Development Build

```bash
./scripts/dev.sh
```

This runs three steps sequentially:
1. esbuild transpiles `client/src/main.ts` → `client/dist/app.js` (single-pass, ~2–4 seconds)
2. `cargo build --release -p server` compiles the Rust server
3. Starts the server on `http://127.0.0.1:3000`

### Watch Mode

```bash
./scripts/watch.sh
```

Runs esbuild in watch mode and the server in parallel. TypeScript changes are picked up automatically (~50 ms rebuild). Rust changes require restarting the script.

### Client Only

```bash
cd client
npm run build    # single build
npm run watch    # watch mode
```

### Server Only

```bash
cargo build --release -p server
RUST_LOG=server=debug cargo run --release -p server
```

### Running Tests

```bash
cargo test -p server
```

Tests cover Arrow schema validation, mock generator output correctness, IPC serialization roundtrip, chunk creation/sealing, time-range queries, and chunk eviction.

## Configuration

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PELORUS_OBJECTS` | `2000` | Number of tracked objects generated per tick |
| `PELORUS_HZ` | `10` | Tick rate in Hz (ticks per second) |
| `PELORUS_CHUNK_INTERVAL_US` | `5000000` | Chunk duration in microseconds (5s) |
| `PELORUS_MAX_CHUNKS` | `720` | Maximum sealed chunks retained (720 × 5s = 1hr) |
| `RUST_LOG` | `server=debug,tower_http=info` | tracing log filter |

Examples:

```bash
# Minimal load — good for UI development
PELORUS_OBJECTS=50 PELORUS_HZ=1 cargo run --release -p server

# Design envelope — full throughput testing
PELORUS_OBJECTS=2000 PELORUS_HZ=10 cargo run --release -p server

# Stress test — beyond design envelope
PELORUS_OBJECTS=5000 PELORUS_HZ=10 cargo run --release -p server
```

### Client Constants

In `client/src/main.ts`:

| Constant | Default | Description |
|---|---|---|
| `BUFFER_MAX_ROWS` | `1,200,000` | Maximum rows in the position buffer ring |
| `RECONNECT_INTERVAL_MS` | `2,000` | WebSocket reconnect delay |
| `MAX_RECONNECT_ATTEMPTS` | `10` | Reconnect attempts before giving up |

In `client/src/timeslider.ts`:

| Parameter | Default | Description |
|---|---|---|
| `windowWidthSec` | `1.0` | Initial time window width in seconds |

## Project Structure

```
pelorus/
├── Cargo.toml                  # Workspace root
├── docs/
│   ├── architecture.md         # System architecture overview
│   ├── data-pipeline.md        # End-to-end data flow
│   ├── chunk-manager.md        # Temporal chunking and query protocol
│   ├── gpu-precision.md        # Float32 precision constraints
│   └── development.md          # This file
├── server/
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs             # Axum server, WebSocket + query handler
│       ├── schema.rs           # Arrow schema definition
│       ├── generator.rs        # Mock data generator
│       ├── ipc.rs              # Arrow IPC serialization
│       ├── chunks.rs           # Temporal chunk manager
│       └── protocol.rs         # JSON command/response types
├── client/
│   ├── package.json            # npm dependencies + build scripts
│   ├── src/
│   │   ├── main.ts             # Entry point, pipeline + query state machine
│   │   ├── decode.ts           # Arrow IPC → typed arrays
│   │   ├── buffer.ts           # Rolling position buffer
│   │   ├── map.ts              # deck.gl renderer + DataFilterExtension
│   │   ├── basemap.ts          # Natural Earth GeoJSON layers
│   │   ├── timeslider.ts       # Time slider (live/scrub + server range)
│   │   ├── protocol.ts         # JSON message types
│   │   ├── perf.ts             # Performance monitor
│   │   └── theme.ts            # Dark/light theme
│   └── dist/
│       ├── index.html          # HTML shell (served by Axum)
│       └── data/               # Natural Earth GeoJSON (gitignored)
└── scripts/
    ├── dev.sh                  # Build all + run
    ├── watch.sh                # Watch + run (parallel)
    └── download-geodata.sh     # Fetch Natural Earth data
```

## Debugging

### Server Diagnostics

The server logs throughput stats every 5 seconds (at the configured tick rate):

```
tick 50: 2000 rows, 147832 B/frame, 7.2 MB total in 5s (1.4 MB/s)
```

To increase log verbosity:

```bash
RUST_LOG=server=trace cargo run --release -p server
```

### Client Diagnostics

The performance bar in the browser shows real-time metrics:

| Metric | Healthy Range (at 2000 × 10 Hz) | Concern Threshold |
|---|---|---|
| FPS | 30–60 | Below 20 |
| batches/s | 9–11 | Below 8 (WebSocket backpressure) |
| decode | 0.5–3 ms | Above 10 ms |
| render | 1–10 ms | Above 16 ms (frame budget) |
| buffer | Growing to 1.2M then stable | Not growing (decode failures) |

If **FPS drops below 30**, the bottleneck is likely the GPU render pass. Reduce `PELORUS_OBJECTS` or check for GPU thermal throttling.

If **decode time spikes**, the bottleneck is Arrow IPC deserialization. This usually indicates the browser tab is under memory pressure.

If **batches/s is below the configured Hz**, the WebSocket is backpressured. The server will log "send failed" messages. Reduce `PELORUS_HZ` or `PELORUS_OBJECTS`.

### Browser DevTools

Open the Performance tab in Chrome DevTools and record a few seconds. Look for:

- **Long tasks** in the main thread — should see clean ~16ms rAF frames with no spikes above 20ms.
- **WebSocket frame timing** in the Network tab — frames should arrive at regular intervals matching `PELORUS_HZ`.
- **GPU memory** — in Chrome, `chrome://gpu` shows WebGL resource usage.

## Extending the Schema

To add a new field to the position data:

1. **`server/src/schema.rs`** — Add the field to `pelorus_schema()`:
   ```rust
   Field::new("new_field", DataType::Float64, true),
   ```

2. **`server/src/generator.rs`** — Add a builder and populate it in the tick loop:
   ```rust
   let mut new_builder = Float64Builder::with_capacity(n);
   // ... in the loop:
   new_builder.append_value(obj.new_field);
   ```

3. **`client/src/decode.ts`** — Extract the new column:
   ```typescript
   const newCol = table.getChild("new_field");
   const newValues = newCol ? newCol.toArray() as Float64Array : new Float64Array(rowCount);
   ```

4. **`client/src/buffer.ts`** — Add a typed array and update `append()` / `_copyIn()` / `_shiftLeft()`.

5. **`client/src/map.ts`** — If the field should affect rendering (color, size, etc.), update the attribute build in `_rebuildCache()`.

The Arrow IPC format is schema-aware, so the client will ignore unrecognized columns and handle missing nullable columns gracefully.

## Replacing the Mock Generator

To connect a real data source, replace the body of `handle_socket()` in `server/src/main.rs`. The contract is:

1. Produce `RecordBatch` instances conforming to the schema in `schema.rs`.
2. Serialize each batch with `batch_to_ipc_bytes()`.
3. Send the bytes as a binary WebSocket message.

The tick loop pattern can be replaced with any async stream — a UDP receiver, a Kafka consumer, a file reader with replay timing, etc. The client doesn't care about the source; it only sees Arrow IPC frames.
