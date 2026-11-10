# Data Pipeline

## Arrow Schema

All position data flows through the system as Arrow `RecordBatch` instances conforming to this schema:

| Field | Type | Nullable | Description |
|---|---|---|---|
| `timestamp_us` | `Int64` | No | Microseconds since Unix epoch (UTC) |
| `object_id` | `Utf8` | No | Unique identifier for the tracked object |
| `longitude` | `Float64` | No | WGS-84 longitude in degrees |
| `latitude` | `Float64` | No | WGS-84 latitude in degrees |
| `altitude_m` | `Float64` | Yes | Altitude in meters above reference |
| `speed_mps` | `Float64` | Yes | Speed in meters per second |
| `heading_deg` | `Float64` | Yes | Heading in degrees true north [0, 360) |
| `category` | `Utf8` | Yes | Arbitrary grouping label |

The schema is defined in `server/src/schema.rs` and is embedded in every Arrow IPC message. The client-side decoder validates the schema on first decode.

Required fields (`timestamp_us`, `object_id`, `longitude`, `latitude`) are guaranteed non-null. Optional fields are nullable and may be absent from data sources that don't produce them. The schema is designed to be extended — new nullable columns can be added without breaking existing consumers.

## Pipeline Stages

### Stage 1: Data Generation (Server)

The data source produces position records for N tracked objects. Currently this is a mock generator (`generator.rs`) that runs a random-walk simulation:

1. Each tracked object maintains state: `(lon, lat, alt, speed, heading, category)`.
2. On each tick (at `PELORUS_HZ` frequency), each object's heading and speed are perturbed by small random deltas.
3. Position is advanced along the heading at the current speed using approximate great-circle displacement: `dlat = cos(heading) * distance / 111320`, `dlon = sin(heading) * distance / (111320 * cos(lat))`.
4. Coordinates are clamped to valid ranges; longitude wraps at ±180°.

All N objects share the same timestamp per tick (the current wall-clock time in microseconds).

### Stage 2: Arrow Serialization (Server)

The generator builds a `RecordBatch` using Arrow's builder API:

```rust
let mut ts_builder = Int64Builder::with_capacity(n);
let mut lon_builder = Float64Builder::with_capacity(n);
// ... for each field

for obj in &mut self.objects {
    obj.tick(dt, &mut self.rng);
    ts_builder.append_value(now_us);
    lon_builder.append_value(obj.lon);
    // ...
}

RecordBatch::try_new(schema, vec![
    Arc::new(ts_builder.finish()),
    Arc::new(lon_builder.finish()),
    // ...
])
```

Builder capacities are pre-set to the object count, so no reallocation occurs during the build loop.

### Stage 3: IPC Serialization (Server)

The `RecordBatch` is serialized to Arrow IPC **stream** format (not file format):

```rust
let mut buf = Vec::with_capacity(batch.get_array_memory_size() + 1024);
let mut writer = StreamWriter::try_new(&mut buf, &batch.schema())?;
writer.write(&batch)?;
writer.finish()?;
```

The stream format embeds the schema in each message, making every WebSocket frame independently decodable. Typical frame size for 2,000 objects is ~100–200 KB depending on string lengths.

### Stage 4: WebSocket Transport

The IPC bytes are sent as a single binary WebSocket message:

```rust
sender.send(Message::Binary(bytes.into())).await
```

The server runs a `tokio::select!` loop per client that interleaves tick-driven sends with client message handling. The tick interval is `1.0 / PELORUS_HZ` seconds. At 10 Hz with 2,000 objects, sustained throughput is approximately 1.5–2.5 MB/s per client.

### Stage 5: IPC Decode (Client)

The browser receives the binary frame and decodes it using the `apache-arrow` JS library:

```typescript
const table = tableFromIPC(new Uint8Array(buffer));
const longitudes = table.getChild("longitude")!.toArray() as Float64Array;
const latitudes = table.getChild("latitude")!.toArray() as Float64Array;
const timestamps = table.getChild("timestamp_us")!.toArray() as BigInt64Array;
```

For numeric columns, `toArray()` returns a **view** into the decoded Arrow buffer — no data copying. String columns (`object_id`, `category`) must be iterated because they use variable-length encoding.

Typical decode time for a 2,000-row batch: **0.5–2 ms** depending on hardware.

### Stage 6: Position Buffer (Client)

Decoded arrays are appended to the rolling position buffer:

```typescript
buffer.append(timestamps, longitudes, latitudes, altitudes,
              speeds, headings, categories, objectIds);
```

The buffer is a set of pre-allocated flat typed arrays with a configurable maximum row count (default: 1,200,000 rows = ~60 seconds at 2,000 objects × 10 Hz).

**Append path**: If the buffer has room, data is written at the current tail index via direct indexed assignment. The `BigInt64` timestamps are converted to `Float64` during this copy (necessary for GPU upload in the next stage).

**Eviction path**: If the buffer is full, the oldest rows are shifted left using `TypedArray.copyWithin()`:

```typescript
this._timestamps.copyWithin(0, evictCount, this._length);
this._longitudes.copyWithin(0, evictCount, this._length);
// ... for each array
this._length -= evictCount;
```

`copyWithin` is implemented as a native `memmove` in the JS engine, so eviction of even hundreds of thousands of rows completes in sub-millisecond time.

**Category interning**: String category values are mapped to integer indices on first encounter via a `Map<string, number>`. The buffer stores only the integer index in a `Uint8Array`, eliminating per-row string storage.

### Stage 7: GPU Attribute Build (Client)

When the map renderer detects new data (`markDataDirty()`), it rebuilds the GPU attribute arrays from the buffer:

**Positions**: Interleaved `[lon, lat, alt]` as `Float64Array` — deck.gl converts to Float32 pairs internally for the vertex shader.

**Colors**: `Uint8Array` of `[R, G, B, A]` per vertex, looked up from the category index.

**Timestamps**: Converted from absolute microseconds to **relative milliseconds** as `Float32Array`. The buffer's minimum timestamp is subtracted as an epoch offset, then the result is divided by 1,000. This conversion is critical — see [GPU Precision](gpu-precision.md).

### Stage 8: GPU Rendering (Client)

The attribute arrays are passed to a deck.gl `ScatterplotLayer` via the binary attribute API:

```typescript
new ScatterplotLayer({
  data: {
    length: n,
    attributes: {
      getPosition: { value: positions, size: 3 },
      getFillColor: { value: colors, size: 4 },
      getFilterValue: { value: relTimestamps, size: 1 },
    },
  },
  extensions: [new DataFilterExtension({ filterSize: 1 })],
  filterRange: [filterMinRel, filterMaxRel],
})
```

The `DataFilterExtension` injects a GLSL comparison into the fragment shader. For each fragment, if the interpolated `filterValue` (relative timestamp) falls outside `filterRange`, the fragment is discarded. This runs entirely on the GPU with no CPU involvement.

### Stage 9: Time Slider Interaction (Client)

When the user moves the time slider:

1. The slider emits a new `[filterMin, filterMax]` range in **absolute microseconds**.
2. The map renderer converts this to relative milliseconds: `(absValue - epochOffset) / 1000`.
3. The converted range is passed to deck.gl as the `filterRange` prop.
4. deck.gl updates the corresponding WebGL uniform.
5. The GPU re-evaluates the filter on the next draw call — no data transfer.

This is the zero-cost scrubbing path. Moving the slider generates no CPU work beyond the uniform write. The GPU re-evaluates the discard condition per fragment using the existing vertex attribute data already resident in VRAM.

## Data Volume Reference

| Scenario | Objects | Hz | Records/sec | IPC bytes/sec | Buffer (60s) |
|---|---|---|---|---|---|
| Light | 200 | 1 | 200 | ~25 KB/s | 12,000 rows, ~1 MB |
| Default | 2,000 | 10 | 20,000 | ~2 MB/s | 1,200,000 rows, ~90 MB |
| Stress | 5,000 | 10 | 50,000 | ~5 MB/s | 3,000,000 rows, ~230 MB |

Buffer memory is dominated by the `Float64Array` fields (8 bytes each × 6 numeric fields = 48 bytes/row). The 1.2M default buffer consumes approximately 57 MB of heap for the typed arrays alone.
