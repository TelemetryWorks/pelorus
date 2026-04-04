// ---------------------------------------------------------------------------
// Pelorus — Position buffer
// ---------------------------------------------------------------------------
//
// Rolling buffer that accumulates decoded Arrow batches into flat typed
// arrays suitable for direct deck.gl consumption. Maintains a configurable
// time window and evicts old data.
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

    // If incoming alone exceeds max, truncate to most recent
    if (incoming >= this.maxRows) {
      const start = incoming - this.maxRows;
      this._copyIn(0, timestamps, longitudes, latitudes, altitudes, speeds, headings, categories, objectIds, start, this.maxRows);
      this._length = this.maxRows;
      return;
    }

    // Evict if needed to make room
    const available = this.maxRows - this._length;
    if (incoming > available) {
      const evict = incoming - available;
      this._shiftLeft(evict);
    }

    // Append at current tail
    this._copyIn(this._length, timestamps, longitudes, latitudes, altitudes, speeds, headings, categories, objectIds, 0, incoming);
    this._length += incoming;
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
  }
}
