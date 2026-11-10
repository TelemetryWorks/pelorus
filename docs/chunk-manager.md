# Temporal Chunk Manager

## Overview

The chunk manager partitions incoming position data into fixed-duration time chunks and maintains them in a ring buffer with configurable retention. This enables clients to request historical data on demand when scrubbing beyond their local buffer.

## Architecture

```
                     live tick
                        │
                        ▼
              ┌─────────────────┐
              │  ChunkManager   │
              │                 │
              │  ┌───────────┐  │     ┌────────────────────────┐
  ingest() ──►│  │ open chunk│  │     │   Sealed Chunk Ring    │
              │  │ (batches  │──┼────►│                        │
              │  │  accum.)  │  │     │  [c0] [c1] [c2] ... [cN]
              │  └───────────┘  │     │   5s   5s   5s      5s │
              │                 │     │                        │
              │  seal when      │     │  max_chunks = 720      │
              │  interval       │     │  retention = 1 hour    │
              │  exceeded       │     │                        │
              └─────────────────┘     │  Oldest evicted when   │
                                      │  ring is full          │
                query_range() ◄───────│                        │
                                      └────────────────────────┘
```

## Chunk Lifecycle

1. **Open**: Incoming `RecordBatch` instances are appended to the open chunk's batch list. The open chunk tracks its time bounds (min/max timestamp).

2. **Seal trigger**: When a new batch's timestamp exceeds `chunk_start + chunk_interval_us`, the open chunk is sealed. All accumulated batches are concatenated into a single `RecordBatch` using `arrow::compute::concat_batches`. The concatenated batch is serialized to Arrow IPC bytes and cached.

3. **Sealed**: The chunk is immutable. It stores the concatenated `RecordBatch`, pre-serialized IPC bytes (as `Arc<Vec<u8>>`), time bounds, and row count. The IPC bytes are cached to avoid re-serialization on every client query.

4. **Eviction**: When the sealed ring exceeds `max_chunks`, the oldest chunk is popped from the front of the `VecDeque`.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PELORUS_CHUNK_INTERVAL_US` | `5,000,000` (5s) | Duration of each chunk in microseconds |
| `PELORUS_MAX_CHUNKS` | `720` | Maximum sealed chunks retained |

At default settings: 720 chunks × 5 seconds = **1 hour** of history.

The chunk interval should be tuned to balance query granularity against memory overhead. Shorter intervals (1–2s) give finer scrubbing resolution but more chunks to manage. Longer intervals (10–30s) reduce overhead but make the smallest queryable unit larger.

## Query Protocol

Clients request historical data via a JSON text message / binary response protocol over the same WebSocket used for live streaming.

### Request: Meta

```json
{"type": "meta"}
```

Response:

```json
{
  "type": "meta",
  "chunk_count": 42,
  "total_rows": 840000,
  "min_us": 1700000000000000,
  "max_us": 1700000210000000,
  "chunk_interval_us": 5000000
}
```

The client uses this to know the server's full archive range, which may extend further back than the client's local buffer.

### Request: Query

```json
{"type": "query", "min_us": 1700000050000000, "max_us": 1700000100000000}
```

Response (header, then binary frames):

```json
{
  "type": "query_response",
  "chunk_count": 10,
  "min_us": 1700000050000000,
  "max_us": 1700000100000000,
  "total_rows": 200000
}
```

Followed by `chunk_count` binary WebSocket messages, each containing a complete Arrow IPC stream for one chunk.

### Client State Machine

The client maintains a simple state machine to distinguish live frames from query response frames:

```
                        ┌──────────┐
             binary     │          │  binary
    ┌──────────────────►│  LIVE    │◄──────────┐
    │    (live frame)   │          │            │
    │                   └────┬─────┘            │
    │                        │                  │
    │              query_response               │
    │              (chunk_count=N)               │
    │                        │                  │
    │                   ┌────▼─────┐            │
    │                   │          │  binary    │
    │                   │ LOADING  ├────────────┘
    │                   │          │  (N frames
    │                   └──────────┘   received)
    │                                           │
    └───────────────────────────────────────────┘
```

In both states, binary frames are decoded and appended to the same position buffer. The distinction only matters for logging and preventing duplicate query requests.

## Memory Budget

Each sealed chunk stores:
- The concatenated `RecordBatch` (~48 bytes/row for numeric columns + variable-length strings)
- The pre-serialized IPC bytes (~similar size, as Arrow IPC is not compressed)

At default settings (2,000 objects × 10 Hz × 5-second chunks):

| Item | Size |
|---|---|
| Rows per chunk | 100,000 |
| RecordBatch memory | ~5 MB |
| IPC bytes (cached) | ~5 MB |
| Per-chunk total | ~10 MB |
| Full ring (720 chunks) | ~7.2 GB |

For production deployments with 1-hour retention, the server needs sufficient memory for the full ring. The IPC byte cache can be disabled (serialize on demand) to halve memory usage at the cost of CPU on query.

For the default 200 objects at 1 Hz (light load):

| Item | Size |
|---|---|
| Rows per chunk | 1,000 |
| Per-chunk total | ~100 KB |
| Full ring (720 chunks) | ~72 MB |

## Thread Safety

The `ChunkManager` is wrapped in `Arc<Mutex<ChunkManager>>` and shared across all client connections via `AppState`. The mutex is held briefly during:

1. `ingest()` — each tick (append a batch, possibly seal and evict)
2. `query_range()` — on client request (iterate sealed chunks, clone `Arc<Vec<u8>>` pointers)
3. `meta()` — on client request (read counts and bounds)

The `Arc<Vec<u8>>` for IPC bytes ensures that query responses can be sent after releasing the lock, avoiding holding the mutex during WebSocket I/O.
