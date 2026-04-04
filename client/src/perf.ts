// ---------------------------------------------------------------------------
// Pelorus — Performance monitor
// ---------------------------------------------------------------------------

export interface PerfSnapshot {
  fps: number;
  batchesPerSec: number;
  rowsPerSec: number;
  bytesPerSec: number;
  avgDecodeMs: number;
  avgRenderMs: number;
  bufferRows: number;
}

export class PerfMonitor {
  private frameTimes: number[] = [];
  private batchCount = 0;
  private rowCount = 0;
  private byteCount = 0;
  private decodeTimes: number[] = [];
  private renderTimes: number[] = [];
  private lastResetTime = performance.now();
  private _bufferRows = 0;

  /** Call once per requestAnimationFrame */
  recordFrame(): void {
    this.frameTimes.push(performance.now());
  }

  /** Call after each batch decode */
  recordBatch(rows: number, bytes: number, decodeMs: number): void {
    this.batchCount++;
    this.rowCount += rows;
    this.byteCount += bytes;
    this.decodeTimes.push(decodeMs);
  }

  /** Call after each render update */
  recordRender(renderMs: number): void {
    this.renderTimes.push(renderMs);
  }

  /** Track current buffer size */
  setBufferRows(n: number): void {
    this._bufferRows = n;
  }

  /** Snapshot and reset counters. Call every ~1 second. */
  snapshot(): PerfSnapshot {
    const now = performance.now();
    const elapsed = (now - this.lastResetTime) / 1000;

    // FPS from frame times in window
    const recentFrames = this.frameTimes.filter(t => t > now - 1000);
    const fps = recentFrames.length;

    const batchesPerSec = elapsed > 0 ? this.batchCount / elapsed : 0;
    const rowsPerSec = elapsed > 0 ? this.rowCount / elapsed : 0;
    const bytesPerSec = elapsed > 0 ? this.byteCount / elapsed : 0;

    const avgDecodeMs = this.decodeTimes.length > 0
      ? this.decodeTimes.reduce((a, b) => a + b, 0) / this.decodeTimes.length
      : 0;

    const avgRenderMs = this.renderTimes.length > 0
      ? this.renderTimes.reduce((a, b) => a + b, 0) / this.renderTimes.length
      : 0;

    // Reset
    this.frameTimes = recentFrames;
    this.batchCount = 0;
    this.rowCount = 0;
    this.byteCount = 0;
    this.decodeTimes = [];
    this.renderTimes = [];
    this.lastResetTime = now;

    return {
      fps,
      batchesPerSec,
      rowsPerSec,
      bytesPerSec,
      avgDecodeMs,
      avgRenderMs,
      bufferRows: this._bufferRows,
    };
  }
}
