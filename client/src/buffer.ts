// ---------------------------------------------------------------------------
// Pelorus — Position buffer
// ---------------------------------------------------------------------------
//
// Rolling buffer that accumulates decoded Arrow batches into flat typed
// arrays suitable for direct deck.gl consumption. Merges by timestamp/object
// identity and evicts the oldest rows.
// ---------------------------------------------------------------------------

export interface BufferConfig {
  /** Maximum rows to hold in the buffer */
  maxRows: number;
}

/**
 * Flat columnar buffer of position data. Each array is parallel-indexed.
 * This layout is directly consumable by deck.gl as attribute arrays.
 */
export class PositionBuffer {
  readonly maxRows: number;

  // Parallel arrays — current valid range is [0, length)
  private _length = 0;
  private _timestamps: Float64Array;   // microseconds as float64 for GPU compatibility
  private _longitudes: Float64Array;
  private _latitudes: Float64Array;
  private _altitudes: Float64Array;
  private _speeds: Float64Array;
  private _headings: Float64Array;
  private _categories: Uint8Array;     // category index (0-3)
  private _objectIds: string[] = [];

  // Category lookup
  private categoryMap = new Map<string, number>();
  private nextCategoryIndex = 0;

  constructor(config: BufferConfig) {
    if (!Number.isSafeInteger(config.maxRows) || config.maxRows <= 0) {
      throw new RangeError("maxRows must be a positive safe integer");
    }
    this.maxRows = config.maxRows;
    this._timestamps = new Float64Array(config.maxRows);
    this._longitudes = new Float64Array(config.maxRows);
    this._latitudes = new Float64Array(config.maxRows);
    this._altitudes = new Float64Array(config.maxRows);
    this._speeds = new Float64Array(config.maxRows);
    this._headings = new Float64Array(config.maxRows);
    this._categories = new Uint8Array(config.maxRows);
    this._objectIds = new Array(config.maxRows);
  }

  get length(): number { return this._length; }

  /** Views into the valid portion of each array */
  get timestamps(): Float64Array { return this._timestamps.subarray(0, this._length); }
  get longitudes(): Float64Array { return this._longitudes.subarray(0, this._length); }
  get latitudes(): Float64Array { return this._latitudes.subarray(0, this._length); }
  get altitudes(): Float64Array { return this._altitudes.subarray(0, this._length); }
  get speeds(): Float64Array { return this._speeds.subarray(0, this._length); }
  get headings(): Float64Array { return this._headings.subarray(0, this._length); }
  get categories(): Uint8Array { return this._categories.subarray(0, this._length); }

  getCategoryIndex(name: string): number {
    let idx = this.categoryMap.get(name);
    if (idx === undefined) {
      idx = this.nextCategoryIndex++;
      this.categoryMap.set(name, idx);
    }
    return idx;
  }

  getCategoryName(idx: number): string | undefined {
    for (const [name, i] of this.categoryMap) {
      if (i === idx) return name;
    }
    return undefined;
  }

  get categoryCount(): number { return this.categoryMap.size; }

  /**
   * Append a decoded batch. If buffer would overflow, evict oldest rows.
   *
   * Expects parallel arrays from the Arrow decoder.
   */
  append(
    timestamps: BigInt64Array,
    longitudes: Float64Array,
    latitudes: Float64Array,
    altitudes: Float64Array | null,
    speeds: Float64Array | null,
    headings: Float64Array | null,
    categories: (string | null)[],
    objectIds: string[],
  ): void {
    const incoming = timestamps.length;
    if (incoming === 0) return;
    if ([longitudes, latitudes, categories, objectIds, altitudes, speeds, headings]
      .some(column => column !== null && column.length !== incoming)) {
      throw new RangeError("batch columns must have equal lengths");
    }
    for (const timestamp of timestamps) {
      if (!Number.isSafeInteger(Number(timestamp))) throw new RangeError("unsafe timestamp");
    }

    // Sort incoming indices and deduplicate even when a query overlaps live data.
    const order = Array.from({ length: incoming }, (_, i) => i)
      .sort((a, b) => Number(timestamps[a] - timestamps[b]));
    const monotonicAppend = Number(timestamps[order[0]]) > (this._length ? this._timestamps[this._length - 1] : -Infinity)
      && order.every((value, index) => value === index)
      && new Set(order.map(i => `${timestamps[i]}:${objectIds[i]}`)).size === incoming;
    if (monotonicAppend) {
      if (incoming >= this.maxRows) {
        this._copyIn(0, timestamps, longitudes, latitudes, altitudes, speeds, headings, categories, objectIds, incoming - this.maxRows, this.maxRows);
        this._length = this.maxRows;
      } else {
        if (this._length + incoming > this.maxRows) this._shiftLeft(this._length + incoming - this.maxRows);
        this._copyIn(this._length, timestamps, longitudes, latitudes, altitudes, speeds, headings, categories, objectIds, 0, incoming);
        this._length += incoming;
      }
      return;
    }
    const selected: number[] = [];
    let old = this._length - 1;
    let next = order.length - 1;
    let time = NaN;
    const ids = new Set<string>();
    while ((old >= 0 || next >= 0) && selected.length < this.maxRows) {
      const fromOld = old >= 0 && (next < 0 || this._timestamps[old] >= Number(timestamps[order[next]]));
      const index = fromOld ? old-- : order[next--];
      const timestamp = fromOld ? this._timestamps[index] : Number(timestamps[index]);
      const id = fromOld ? this._objectIds[index] : objectIds[index];
      if (timestamp !== time) { time = timestamp; ids.clear(); }
      if (ids.has(id)) continue;
      ids.add(id);
      selected.push(fromOld ? index : -index - 1);
    }

    // A normal live append can keep the preallocated arrays. The general merge
    // snapshots the old rows before writing, so inserting history cannot corrupt
    // other columns. Retention always keeps the newest maxRows distinct records.
    const oldColumns = [this._timestamps, this._longitudes, this._latitudes,
      this._altitudes, this._speeds, this._headings, this._categories];
    const oldIds = this._objectIds;
    this._timestamps = new Float64Array(this.maxRows);
    this._longitudes = new Float64Array(this.maxRows);
    this._latitudes = new Float64Array(this.maxRows);
    this._altitudes = new Float64Array(this.maxRows);
    this._speeds = new Float64Array(this.maxRows);
    this._headings = new Float64Array(this.maxRows);
    this._categories = new Uint8Array(this.maxRows);
    this._objectIds = new Array(this.maxRows);
    const columns = [this._timestamps, this._longitudes, this._latitudes,
      this._altitudes, this._speeds, this._headings, this._categories];
    selected.reverse().forEach((source, dest) => {
      if (source >= 0) {
        columns.forEach((column, i) => { column[dest] = oldColumns[i][source]; });
        this._objectIds[dest] = oldIds[source];
      } else {
        this._copyIn(dest, timestamps, longitudes, latitudes, altitudes, speeds, headings, categories, objectIds, -source - 1, 1);
      }
    });
    this._length = selected.length;
  }

  /** Merge just a visible range from another buffer; returns considered rows. */
  mergeRangeFrom(source: PositionBuffer, minUs: number, maxUs: number): number {
    let start = 0;
    while (start < source.length && source._timestamps[start] < minUs) start++;
    let end = start;
    while (end < source.length && source._timestamps[end] <= maxUs) end++;
    if (end === start) return 0;
    this.append(
      BigInt64Array.from(source._timestamps.subarray(start, end), value => BigInt(value)),
      source._longitudes.subarray(start, end), source._latitudes.subarray(start, end),
      source._altitudes.subarray(start, end), source._speeds.subarray(start, end),
      source._headings.subarray(start, end),
      Array.from(source._categories.subarray(start, end), index => source.getCategoryName(index) ?? "unknown"),
      source._objectIds.slice(start, end),
    );
    return end - start;
  }

  /** Shift all data left by `n` rows (evict oldest) */
  private _shiftLeft(n: number): void {
    const remaining = this._length - n;
    this._timestamps.copyWithin(0, n, this._length);
    this._longitudes.copyWithin(0, n, this._length);
    this._latitudes.copyWithin(0, n, this._length);
    this._altitudes.copyWithin(0, n, this._length);
    this._speeds.copyWithin(0, n, this._length);
    this._headings.copyWithin(0, n, this._length);
    this._categories.copyWithin(0, n, this._length);
    this._objectIds.copyWithin(0, n, this._length);
    this._length = remaining;
  }

  /** Copy incoming data into buffer starting at `destOffset` */
  private _copyIn(
    destOffset: number,
    timestamps: BigInt64Array,
    longitudes: Float64Array,
    latitudes: Float64Array,
    altitudes: Float64Array | null,
    speeds: Float64Array | null,
    headings: Float64Array | null,
    categories: (string | null)[],
    objectIds: string[],
    srcStart: number,
    count: number,
  ): void {
    for (let i = 0; i < count; i++) {
      const si = srcStart + i;
      const di = destOffset + i;
      // Convert BigInt timestamp to float64 for GPU compatibility
      this._timestamps[di] = Number(timestamps[si]);
      this._longitudes[di] = longitudes[si];
      this._latitudes[di] = latitudes[si];
      this._altitudes[di] = altitudes ? altitudes[si] : 0;
      this._speeds[di] = speeds ? speeds[si] : 0;
      this._headings[di] = headings ? headings[si] : 0;
      this._categories[di] = this.getCategoryIndex(categories[si] ?? "unknown");
      this._objectIds[di] = objectIds[si];
    }
  }

  /** Time range of buffered data in microseconds */
  get timeRange(): [number, number] | null {
    if (this._length === 0) return null;
    return [this._timestamps[0], this._timestamps[this._length - 1]];
  }

  /** Clear the buffer */
  clear(): void {
    this._length = 0;
    this._objectIds.fill("");
    this.categoryMap.clear();
    this.nextCategoryIndex = 0;
  }
}
