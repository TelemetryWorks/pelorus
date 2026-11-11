# Development

## Requirements and setup

- Rust 2024 edition (1.85+) with Cargo, rustfmt and Clippy
- Node.js 24+ for the Node standard test harness (native TypeScript stripping)
- Pinned TypeScript 7.0.2 for source checking; esbuild remains the browser bundler
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
cargo test --workspace --locked -j 2
cargo clippy --workspace --all-targets --locked -j 2 -- -D warnings
cargo build -p server --locked -j 2
cd client
npm ci --ignore-scripts
npm run typeprep
npm run typecheck
PELORUS_SERVER_BIN=../target/debug/server npm run test:ci
npm run build
```

`npm run typecheck` checks every normal `src/**/*.ts` source with strict null and
implicit-any checking, unused checks, ES2022/DOM ESM, bundler module resolution
and no emit. Full dependency declaration checking stays enabled. The `.mjs` tests and tooling
scripts are executed by Node and are not included in the TypeScript source check. The locked
luma.gl 9.2.6 declarations need three precise type-only corrections; the separate
explicit `npm run typeprep` command validates both package versions and SHA-256
hashes before changing those two installed `.d.ts` files. Both targets must be
original or both already prepared; mixed/unknown states fail without writes. See [typecheck.md](typecheck.md)
for original diagnostics, exact corrections, rationale and maintenance guidance.
No runtime dependency file or package resolution is changed by this repair.

`npm test` remains the optional local test command: without `PELORUS_SERVER_BIN`,
the two real-server tests are skipped. **CI uses `npm run test:ci`**, which rejects
an unset, missing or non-executable server before starting. It runs all Node test
files with two workers, preserves nonzero child exits, and verifies TAP totals:
every registered test must pass with zero failures, skips, cancellations or TODOs.
Both named integration cases must have explicit passing results. The tests start
the real Cargo-built server on `127.0.0.1:3000` and clean up owned server processes.
No test package or framework is added. There is no shell output pipe in this gate.

Pure client tests exercise the entry point with socket/DOM/timer boundaries
stubbed and real Arrow IPC encoding/decoding. Tests do not render WebGL or measure
browser/GPU performance. esbuild still bundles; TypeScript performs source checks.

CI installs with `npm ci --ignore-scripts` so dependency lifecycle hooks do not
run; explicit declaration preparation remains a separate step. TypeScript 7's
optional platform packages are transitive development tooling, not runtime deps.

The single Linux CI job uses Ubuntu 24.04, Rust 1.99.1 and Node 24.22.1. Official
checkout/setup-node actions are pinned by commit SHA, permissions are
`contents: read`, checkout credentials are not persisted, and stale runs cancel.
The job has a 20-minute timeout; Cargo, Rust test threads, Tokio, native compiler
workers and Node test-file concurrency are bounded to two. Rust Clippy/tests/build
use `--locked`. CI does not establish Windows support or browser/GPU capacity.

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
