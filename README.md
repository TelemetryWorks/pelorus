# Pelorus
GPU-accelerated geospatial object tracker with Arrow IPC streaming and shader-side time filtering

# Phase 1 — WebSocket Scaffold

Axum WebSocket echo server + vanilla TypeScript browser client.

## Prerequisites

* Rust 2024 edition (1.85+)
* Node.js (for esbuild only — no runtime dependency)

## Quick Start

```bash
# one-time: install esbuild
cd client \&\& npm install \&\& cd ..

# make scripts executable
chmod +x scripts/\*.sh

# build + run
./scripts/dev.sh
```

Open `http://127.0.0.1:3000` — type a message, hit enter, see it echoed.

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
│       └── main.rs         # Axum + WebSocket server
├── client/
│   ├── package.json        # esbuild only
│   ├── src/
│   │   └── main.ts         # WebSocket client
│   └── dist/
│       └── index.html      # served by Axum as static fallback
└── scripts/
    ├── dev.sh              # build + run
    └── watch.sh            # watch + run
```

## Phase Roadmap

1. **Skeleton** ← you are here
2. Arrow IPC schema + mock data generator + decode in browser
3. deck.gl ScatterplotLayer — first moving dots
4. Natural Earth base map
5. Time slider with GPU-side filtering
6. Temporal chunk manager + ring buffer
7. Viewport culling with H3
8. Trail lines
9. Attribute coloring + filter UI
10. Multi-client session management
