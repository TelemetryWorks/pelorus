# GPU Float32 Precision Constraints

## The Problem

WebGL vertex attributes and shader uniforms use IEEE 754 single-precision floating point (Float32). A Float32 has a 23-bit mantissa (plus 1 implicit bit), giving **24 bits of integer precision** — it can represent integers exactly up to 2²⁴ = 16,777,216.

Pelorus timestamps are **microseconds since Unix epoch**. A typical timestamp in 2025 is approximately:

```
1,700,000,000,000,000 μs  (1.7 × 10¹⁵)
```

When this value is cast to Float32, the representable precision at that magnitude is:

```
1.7 × 10¹⁵ / 2²⁴ ≈ 1.01 × 10⁸ μs ≈ 101 seconds
```

This means **all timestamps within a ~100-second window round to the same Float32 value**. The DataFilterExtension's GLSL comparison becomes meaningless — either all points pass the filter, or none do, depending on rounding.

This is not a deck.gl bug. It is a fundamental constraint of the Float32 pipeline that WebGL mandates for vertex attributes.

## The Solution: Relative Timestamps

Instead of passing absolute timestamps to the GPU, Pelorus converts to **relative milliseconds** offset from the buffer's minimum timestamp:

```typescript
// In map.ts → _rebuildCache()
const epochOffset = absTimestamps[0];  // buffer minimum

const relTimestamps = new Float32Array(n);
for (let i = 0; i < n; i++) {
    relTimestamps[i] = (absTimestamps[i] - epochOffset) / 1000.0;
}
```

The filter range is converted using the same offset:

```typescript
// In map.ts → _buildFilteredLayer()
const filterMinRel = (this._filterMinAbs - this._epochOffsetUs) / 1000.0;
const filterMaxRel = (this._filterMaxAbs - this._epochOffsetUs) / 1000.0;
```

### Why This Works

After the offset subtraction, relative values start at 0 and grow with buffer duration. Dividing by 1,000 converts from microseconds to milliseconds, which reduces the magnitude further.

For a 60-second buffer at full rate:

```
Maximum relative value: 60 seconds × 1,000 = 60,000 ms
```

60,000 is well within Float32's exact integer range (up to 16,777,216). Even sub-millisecond differences are representable at this magnitude.

### Precision Budget

| Buffer Duration | Max Relative Value (ms) | Float32 Precision | Status |
|---|---|---|---|
| 1 minute | 60,000 | Exact integers | Safe |
| 10 minutes | 600,000 | Exact integers | Safe |
| 1 hour | 3,600,000 | Exact integers | Safe |
| 4.6 hours | 16,777,216 | Exact integers | Limit |
| 4.6+ hours | > 16,777,216 | Loses LSBs | Degraded |

Pelorus's default buffer holds ~60 seconds, consuming less than 0.4% of the Float32 precision budget. Even a 1-hour buffer (if the buffer max rows were increased) would use only 21%.

## Where This Pattern Applies

This relative-offset pattern is required anywhere large absolute values flow through the Float32 pipeline:

**Timestamps** — The case documented here. Any epoch-based timestamp will overflow Float32 precision.

**Geographic coordinates** — Longitude and latitude in degrees are small enough (±180, ±90) that Float32 is adequate for global-scale visualization. However, for sub-meter precision at a fixed location, the same offset pattern may be needed (deck.gl handles this internally via its coordinate system, using a Float64 base position with Float32 deltas).

**Altitude** — Altitudes in meters (0–100,000) are safe in Float32 for the visualization precision required.

## Debugging Precision Issues

Symptoms of Float32 precision loss in deck.gl:

1. **All points visible or none visible** — The filter can't distinguish between timestamps. Check whether `getFilterValue` data exceeds 2²⁴ in magnitude.
2. **Points "snap" to grid positions** — Coordinates are being rounded. Check whether position deltas are smaller than the Float32 ULP at that magnitude.
3. **Flickering at high zoom** — The Float64 → Float32 conversion in the vertex shader introduces jitter. deck.gl mitigates this with its `coordinateSystem` and `coordinateOrigin` props, but custom attributes don't get this treatment automatically.

To verify the relative timestamp pipeline is working, check the browser console or add a log:

```typescript
console.log("Epoch offset:", this._epochOffsetUs);
console.log("Relative range:", relTimestamps[0], "to", relTimestamps[n - 1]);
console.log("Filter range:", filterMinRel, "to", filterMaxRel);
```

All relative values should be small numbers (0 to a few thousand for a typical buffer), and the filter range should bracket the values you expect to be visible.

## References

- IEEE 754 single-precision: 1 sign bit, 8 exponent bits, 23 mantissa bits (24 effective)
- deck.gl DataFilterExtension: uses `float` (32-bit) for `filterValues` attribute in GLSL
- deck.gl coordinate precision: [https://deck.gl/docs/developer-guide/coordinate-systems](https://deck.gl/docs/developer-guide/coordinate-systems)
