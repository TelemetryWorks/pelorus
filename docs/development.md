# Development

## Requirements and setup

- Rust 2024 edition (1.85+) with Cargo, rustfmt and Clippy
- Node.js 24+ for the dependency-free Node test harness (native TypeScript
  stripping); Node/npm and esbuild for the browser build
- curl for optional Natural Earth geodata

```bash
cd client
npm ci
cd ..
bash scripts/download-geodata.sh
bash scripts/dev.sh
```

Scripts are tracked without executable bits; `bash scripts/...` works without
changing file permissions. The server binds `127.0.0.1:3000`. Missing geodata
leaves the basemap blank but does not prevent object/history rendering.

```bash
# Bounded development workload
PELORUS_OBJECTS=50 PELORUS_HZ=1 PELORUS_MAX_ROWS=10000 bash scripts/dev.sh
# Browser watcher; restart for Rust changes
bash scripts/watch.sh
```

The dev script bundles the client and builds/runs the server in release mode.
Set `CARGO_BUILD_JOBS=2` on constrained hosts. Browser-only build:

```bash
cd client && npm run build
```

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

`npm test` runs the Node standard test runner using existing esbuild/Arrow
packages; no test package is added. Pure client tests exercise the actual entry
point with socket/DOM/timer boundaries stubbed and real Arrow IPC encoding and
decoding. The optional `PELORUS_SERVER_BIN` tests start that server with a small
workload on port 3000 to check real WebSocket/IPC query framing, and verify
invalid-setting exits. Without the variable, those two tests are skipped. Tests do not render WebGL or
measure browser performance. esbuild bundles TypeScript; it is not a typechecker.

Rust regressions use explicit timestamps and Tokio virtual time instead of
sleeping. They cover startup ingestion without clients, shared fanout, lag,
empty data/settings, query bounds/counts, retention, and unlocked network sends.
Client tests cover chronological merge, deduplication, eviction, full-live-buffer
history viewing, latest-request queueing, reconnect, empty/error replies and
decode failures. See the PR for exact executed commands and results.

## Settings

| Variable | Default | Validation |
|---|---|---|
| `PELORUS_OBJECTS` | 2000 | Positive, no larger than `PELORUS_MAX_ROWS` |
| `PELORUS_HZ` | 10 | Finite, positive; interval must be representable and nonzero |
| `PELORUS_CHUNK_INTERVAL_US` | 5000000 | Positive integer microseconds |
| `PELORUS_MAX_CHUNKS` | 720 | Positive integer |
| `PELORUS_MAX_ROWS` | 1200000 | Positive integer; sealed plus open archive rows |
| `RUST_LOG` | server=info | tracing filter |

An explicitly empty or unparsable setting is an error, rather than silently
falling back. Invalid settings exit before starting ingest. Row caps are not byte
caps. Default archive retention can be much less than an hour; see the
[memory and retention contract](chunk-manager.md).

Client live/history buffers each have a 1.2M-row cap. The history buffer is
allocated on first request. Requests refresh archive metadata every 10 seconds,
so the slider can temporarily show stale server bounds. Evicted ranges may return
empty results. Connections retry at two-second intervals, up to ten consecutive
failures. A successful connection resets that counter.

## Extending ingest/schema

Replace the **single startup ingest source**, not the socket handler, when
connecting real telemetry. Produce canonical batches, archive once and publish
one shared live frame. The current path expects non-null canonical required
columns and homogeneous timestamps per batch. Optional numeric validity-bit
handling for arbitrary external data has not been validated.

Schema changes must be coordinated across `server/src/schema.rs`, the generator,
`client/src/decode.ts`, `buffer.ts`, renderer attributes and protocol tests.
Geodata downloads use `nvkelso/natural-earth-vector` at mutable `master` and are
not required for automated history tests.
