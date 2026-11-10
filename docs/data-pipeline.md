# Data pipeline

1. One startup-owned `MockGenerator` advances all synthetic objects per tick,
   whether or not sockets are connected. One strictly increasing microsecond
   timestamp is assigned to the whole batch.
2. `ChunkManager` archives the batch once. Interval or row pressure seals an open
   chunk; sealed chunks cache Arrow IPC and are evicted by chunk/row caps.
3. A shared live IPC frame is published through Tokio broadcast. Each socket
   forwards it independently; lag or send deadlines disconnect slow consumers.
4. A history request snapshots whole overlapping sealed chunks and their actual
   row count. The header and all frames are sent consecutively outside the lock.
5. The client decodes each IPC stream with `apache-arrow`. Required numeric
   columns become typed arrays; IDs/categories are iterated as strings. The
   current decoder expects the canonical schema; it does not validate arbitrary
   external schemas or all nullable numeric validity cases.
6. Live rows enter the bounded live buffer. History frames enter a separate,
   bounded query-view buffer. Each buffer orders timestamps, deduplicates by
   timestamp/object ID and retains the newest rows on overflow. A general merge
   uses temporary storage; chronological nonoverlapping live appends reuse arrays.
7. The selected view supplies deck.gl's position, color and relative-timestamp
   arrays. A new-data update rebuilds attributes. A filter change reuses cached
   arrays, but still performs JavaScript/deck.gl work.
8. LIVE follows the latest live timestamp. SCRUB can request a historical visible
   window outside local live retention. Loading a new query replaces the previous
   history view; returning to LIVE selects the independently advancing live data.

## Canonical Arrow schema

| Field | Arrow type | Nullable |
|---|---|---|
| timestamp_us | Int64 (Unix UTC microseconds) | No |
| object_id | Utf8 | No |
| longitude | Float64 (WGS-84 degrees) | No |
| latitude | Float64 (WGS-84 degrees) | No |
| altitude_m | Float64 | Yes |
| speed_mps | Float64 | Yes |
| heading_deg | Float64 | Yes |
| category | Utf8 | Yes |

The current mock source fills every field. Rust Arrow 54 serializes complete IPC
streams; JavaScript Arrow 18 decodes them. Cross-language WebSocket integration
checks this boundary. Binary messages have no independent request ID, so a
connection must preserve the header/contiguous-frame contract.

GPU filtering uses `(timestamp_us - buffer_min_us) / 1000` as Float32 relative
milliseconds, with the same offset for filter bounds. See
[gpu-precision.md](gpu-precision.md). Performance depends on data volume, runtime,
GPU and allocations; this repository does not establish timing or FPS guarantees.

See [chunk-manager.md](chunk-manager.md) for exact retention, request lifecycle,
lag policy and memory limits.
