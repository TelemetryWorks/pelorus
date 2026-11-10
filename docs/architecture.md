# Architecture

Pelorus is an in-memory geospatial tracking prototype. Its implemented Phase 6
path is:

```text
one startup mock source → Arrow batches → bounded temporal archive
                              ↓                    ↓ query snapshot
                       live broadcast         header + chunk IPC
                              ↓                    ↓
                         per-socket serialized WebSocket output
                                            ↓
                         browser Arrow decoder / request lifecycle
                                  ↓                  ↓
                           live buffer          history buffer
                                  └──── selected view ────┘
                                            ↓
                        deck.gl attributes + GPU time filtering
```

The Rust/Axum server serves `client/dist` and upgrades `/ws`. One Tokio ingest
task owns the generator. The shared archive uses a standard mutex for synchronous
ingest/query snapshots; no network await holds that guard. Queries and live
output are serialized per socket. Bounded broadcast queues and send deadlines
isolate ingest from slow sockets. Immediately after a completed query, one live
receive attempt runs before another client message. If it reports lag, a typed
`live_reset` boundary reports the exact skipped count, then resumes at the oldest
retained frame (up to 16 queued older frames), with no extra discard or buffer.
Ordinary/repeated lag and failed/timed-out sends still disconnect. Query frames
remain contiguous and existing deadlines are unchanged. See
[chunk-manager.md](chunk-manager.md).

The TypeScript client uses existing esbuild, Apache Arrow JS and deck.gl packages.
It maintains a live buffer plus one lazy history buffer, each with a fixed row
cap, chronological merge and identity deduplication. It sends only one query at
a time and queues the latest subsequent scrub range. Disconnect clears state;
framing/decode failures close the socket before reconnecting. A valid post-query
live reset clears only live continuity, preserving completed history, loaded
coverage, the SCRUB view and a next request awaiting its header. The gap is logged;
the client does not infer coverage across it.

The time slider selects an absolute timestamp range. The renderer subtracts the
selected buffer's minimum timestamp and sends relative milliseconds to deck.gl's
`DataFilterExtension`. Filter-only updates reuse cached attributes; new data or
switching buffers requires rebuilding them. Natural Earth GeoJSON supplies the
basemap. Themes and counters are browser-local.

## Scope and readiness

Demonstrated checks cover archive/query correctness, client lifecycle and actual
Rust-to-JavaScript Arrow IPC/WebSocket framing. They do not prove browser/GPU
performance, a one-hour retention guarantee, or production capacity. Memory is
bounded by rows/chunks/queued frames per component, not by a global byte limit or
connection limit. Data is lost on restart. There is no authentication or durable
query store, and the server binds localhost.

`architecture.mermaid` is a **future concept diagram**, including real data ingest,
H3, Vortex and optional DataFusion. Those components and its alternate renderer
choices are not implemented. The current renderer is deck.gl. Later roadmap
items include viewport culling, trails, attribute filtering and managed sessions.
