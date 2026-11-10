# Temporal archive and history queries

Phase 6 is a functional in-memory prototype. There is no persistence, H3 index,
server-side viewport filtering, or production capacity claim.

## Ingest and retention

One task starts with the server and owns one synthetic generator. It ingests
once per tick, even with no sockets, then broadcasts the same IPC frame to all
subscribers. Adding clients does not multiply archived records or create
independent trajectories with the same object IDs. Timestamps are strictly
increasing within a process, including after a backwards wall-clock adjustment.

The open chunk accumulates homogeneous-timestamp batches. It seals before a new
batch would exceed the interval or row budget. Sealed chunks are stored in a
`VecDeque` with cached IPC bytes; the combined RecordBatch is discarded after
serialization. Empty batches are ignored. Incoming oversized batches are sliced
to their newest rows. Ingest currently receives only the canonical mock schema.

Limits, all positive:

| Setting | Default | Meaning |
|---|---|---|
| `PELORUS_CHUNK_INTERVAL_US` | 5000000 | Target chunk interval in microseconds |
| `PELORUS_MAX_CHUNKS` | 720 | Maximum sealed chunks |
| `PELORUS_MAX_ROWS` | 1200000 | Maximum sealed plus open rows |

Oldest sealed chunks are evicted until both caps hold. Open data is not queryable
until sealed. Metadata describes only sealed/queryable rows; an empty archive has
zero chunks, rows and bounds (`min_us = max_us = 0`). Bounds are actual retained
row timestamps, not nominal bucket edges.

**One hour is only the interval/count ceiling, not promised retention.** At
2000 objects × 10 Hz, the default row budget is about 60 seconds including the
open chunk; available sealed history is shorter. Sparse ticks, row-triggered
sealing and chunk eviction also affect duration.

## Wire contract

Client text messages:

```json
{"type":"meta"}
{"type":"query","min_us":100,"max_us":200}
```

Bounds are inclusive integer microseconds, ordered and within JavaScript's safe
integer range. Invalid JSON, fractional/out-of-range or reversed bounds receive
`{"type":"error","message":"..."}` with no binary frames.

Metadata:

```json
{"type":"meta","chunk_count":2,"total_rows":6,"min_us":100,"max_us":200,"chunk_interval_us":10}
```

Query header:

```json
{"type":"query_response","chunk_count":2,"min_us":100,"max_us":200,"total_rows":6}
```

Exactly `chunk_count` Arrow IPC stream messages follow, contiguously. No live
frames or metadata interleave between that header and its frames. Each frame is
one **whole sealed chunk overlapping** the requested range, so it may contain
rows outside the requested bounds. `total_rows` sums transmitted rows, not chunk
count. An empty response has both counts zero. The GPU filter selects the visible
window. There is no pagination or request ID: a client permits one active query
per connection and keeps only the latest queued scrub range.

The response is snapshotted synchronously under the archive mutex. All network
awaits, including the header send, happen after the guard is dropped. Snapshot
Arcs remain valid after archive eviction. Failed sends stop the response.

## Client behavior

The live buffer and lazily allocated history-view buffer each retain at most
1.2M rows. History replaces the preceding query result and merges each incoming
frame chronologically. Duplicate `(timestamp_us, object_id)` records collapse;
existing records win if payloads disagree. Retained live rows within the requested
window are merged into the completed history view so the retention boundary has
no artificial gap. Oversized results retain newest rows. The buffers' bounds
reflect retained rows. A historical view remains separate from the advancing live window; LIVE switches back immediately.

After a successful query, the server makes exactly one immediate live receive
attempt **before** processing any queued next client message. If that attempt
reports lag, it sends a typed boundary before further live binaries:

```json
{"type":"live_reset","skipped_frames":4}
```

`skipped_frames` is Tokio's exact lost-frame count (a positive safe integer).
The receiver resumes at its **oldest retained frame**, not the latest frame:
up to 16 older queued frames can still follow. No additional frames are discarded,
no catch-up buffer is added, and nothing interleaves within the counted history
response. A normal first live frame or an empty receive attempt consumes this
single opportunity without a marker. Metadata/errors do not arm recovery.
Repeated or ordinary non-query lag still disconnects.

The client accepts one marker only after a completed query and before its next
live frame. It also accepts that previous-query marker while a newer request is
in flight awaiting its header; it rejects markers during pending chunk frames,
duplicates, malformed counts and markers without prior completion. The marker
clears only live rows/bounds, logs a visible stream restart and keeps completed
history, loaded coverage, SCRUB selection and any next request. Completed history
is replaced only when a newer query header arrives. Subsequent live rows form a
new window; the client never claims live coverage across the skipped interval.
A real disconnect continues to clear all connection/history state.

The client normalizes fractional slider bounds outwards to integer microseconds.
It requests the visible window, rather than everything between the cursor and
live retention. Loaded-range suppression applies only to a complete nonempty
result that fits its row cap. Empty/error results can be retried. A newer scrub
range supersedes older queued requests. Disconnect resets request, pending-frame,
coverage and server metadata state and clears both buffers. Decode failure,
malformed framing or a 15-second response timeout closes the socket; continuing
would risk classifying remaining history frames as live.

## Bounded resources and limitations

Each socket subscribes to a 16-frame live broadcast queue. Missed ticks are
skipped instead of accumulating catch-up work. Ordinary or repeated lag
disconnects; the sole exception is the immediate post-query boundary above.
A live send has a 5-second deadline; an entire query response has a 10-second
deadline; the optional boundary send uses the same 5-second live deadline.
Failed or timed-out sends disconnect. Incoming WebSocket messages are capped at
16 KiB. Ingest does not await socket I/O.

The row budget is **not a process-wide byte cap**. For this synthetic schema,
numeric fields alone cost 48 bytes/row; 1.2M rows account for 57.6 MB before IDs,
categories, IPC overhead and allocations. Sealing temporarily retains both the
batches and concatenated/serialized output. A query may pin a previous archive
snapshot while ingest evicts it, with another outgoing frame copy per socket.
A default 2000-row live frame is roughly hundreds of KB; queues are frame-capped,
not byte-capped. Memory grows with connection count; no global session limit is
implemented. Set lower object/row/chunk budgets for constrained hosts.

Each client buffer has 58.8 MB of numeric typed arrays at capacity, plus ID
references/strings and category maps. Two buffers can therefore use 117.6 MB for
numeric arrays alone. Historical merges allocate temporary index arrays and a
replacement buffer; render caches, Arrow decode buffers and GPU allocations add
more. This implementation favors correctness over an optimized temporal/GPU
ring. No zero-allocation, constant-cost scrubbing or FPS guarantee is made.

The canonical mock category scope is exactly `alpha`, `bravo`, `charlie`, and
`delta`; arbitrary external category cardinalities are outside this feature.

The slow-query gap regression uses the actual generic session loop with a checked
sink, seeded data and paused Tokio time (3s transfer, 20 ticks, 16-frame queue,
exactly 4 lost frames). It checks marker-before-queued-message ordering and resumption
at the oldest retained timestamp, plus ordinary/repeated lag and failed marker
sends. Client tests cover strict marker parsing and history/request preservation.
The gap scenario is unit-tested, not induced over a real slow network. Existing
real WebSocket integration still checks shared trajectories and query IPC/counts.
Evidence here is Linux aarch64 only; Windows has not been executed.

See [development.md](development.md) for reproducible checks.
