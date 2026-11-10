// ---------------------------------------------------------------------------
// Pelorus — Time slider
// ---------------------------------------------------------------------------
//
// Two modes:
//   "live"  — cursor auto-advances to latest timestamp
//   "scrub" — user drags to historical position
//
// The slider covers the server's full archive range (not just the
// client buffer). When the user scrubs to a time outside the client
// buffer, `onScrubBeyondBuffer` fires so the host can request chunks.
// ---------------------------------------------------------------------------

export interface TimeSliderConfig {
  container: HTMLElement;
  windowWidthSec?: number;
  onRangeChange?: (min: number, max: number) => void;
  onScrubBeyondBuffer?: (min: number, max: number) => void;
}

export type TimeSliderMode = "live" | "scrub";

export class TimeSlider {
  private container: HTMLElement;
  private sliderEl: HTMLInputElement;
  private labelEl: HTMLElement;
  private modeEl: HTMLElement;
  private windowEl: HTMLInputElement;
  private windowLabelEl: HTMLElement;

  private _mode: TimeSliderMode = "live";
  private _windowWidthUs: number;
  private _bufferMinUs = 0;
  private _bufferMaxUs = 0;
  private _serverMinUs = 0;
  private _serverMaxUs = 0;
  private _cursorUs = 0;
  private _onRangeChange: ((min: number, max: number) => void) | null;
  private _onScrubBeyondBuffer: ((min: number, max: number) => void) | null;

  constructor(config: TimeSliderConfig) {
    this.container = config.container;
    this._windowWidthUs = (config.windowWidthSec ?? 1.0) * 1_000_000;
    this._onRangeChange = config.onRangeChange ?? null;
    this._onScrubBeyondBuffer = config.onScrubBeyondBuffer ?? null;

    this.container.innerHTML = `
      <div class="ts-row">
        <button class="ts-mode" title="toggle live/scrub">LIVE</button>
        <input class="ts-slider" type="range" min="0" max="1000" value="1000" />
        <span class="ts-label">0.0s</span>
      </div>
      <div class="ts-row ts-row-secondary">
        <span class="ts-window-label">window</span>
        <input class="ts-window" type="range" min="1" max="100" value="10" />
        <span class="ts-window-value">1.0s</span>
      </div>
    `;

    this.modeEl = this.container.querySelector(".ts-mode")!;
    this.sliderEl = this.container.querySelector(".ts-slider")!;
    this.labelEl = this.container.querySelector(".ts-label")!;
    this.windowEl = this.container.querySelector(".ts-window")!;
    this.windowLabelEl = this.container.querySelector(".ts-window-value")!;

    // Mode toggle
    this.modeEl.addEventListener("click", () => {
      if (this._mode === "live") {
        this._mode = "scrub";
        this.modeEl.textContent = "SCRUB";
        this.modeEl.classList.add("scrub");
      } else {
        this._mode = "live";
        this.modeEl.textContent = "LIVE";
        this.modeEl.classList.remove("scrub");
      }
    });

    // Slider interaction
    this.sliderEl.addEventListener("input", () => {
      if (this._mode === "live") {
        this._mode = "scrub";
        this.modeEl.textContent = "SCRUB";
        this.modeEl.classList.add("scrub");
      }
      this._updateCursorFromSlider();
      this._emitRange();
      this._checkBeyondBuffer();
    });

    // Window width
    this.windowEl.addEventListener("input", () => {
      const val = parseInt(this.windowEl.value);
      const sec = 0.1 * Math.pow(300, val / 100);
      this._windowWidthUs = sec * 1_000_000;
      this.windowLabelEl.textContent = sec < 10
        ? `${sec.toFixed(1)}s`
        : `${sec.toFixed(0)}s`;
      this._emitRange();
    });

    const initSec = this._windowWidthUs / 1_000_000;
    this.windowLabelEl.textContent = `${initSec.toFixed(1)}s`;
  }

  get mode(): TimeSliderMode { return this._mode; }

  /** Update the client buffer's time range. Call on each batch. */
  setBufferRange(minUs: number, maxUs: number): void {
    this._bufferMinUs = minUs;
    this._bufferMaxUs = maxUs;

    if (this._mode === "live") {
      this._cursorUs = maxUs;
      // Position slider relative to the full range (server or buffer)
      this._syncSliderPosition();
      this._updateLabel();
      this._emitRange();
    }
  }

  /** Update the server's full archive range (from meta response). */
  setServerRange(minUs: number, maxUs: number): void {
    this._serverMinUs = minUs;
    this._serverMaxUs = maxUs;
  }

  /** Get the current filter range [min, max] in microseconds */
  getFilterRange(): [number, number] {
    const halfWindow = this._windowWidthUs / 2;
    return [
      this._cursorUs - halfWindow,
      this._cursorUs + halfWindow,
    ];
  }

  /** The full navigable range — union of server and buffer */
  private get _fullMinUs(): number {
    if (this._serverMinUs > 0 && this._serverMinUs < this._bufferMinUs) {
      return this._serverMinUs;
    }
    return this._bufferMinUs;
  }

  private get _fullMaxUs(): number {
    return Math.max(this._bufferMaxUs, this._serverMaxUs);
  }

  private _syncSliderPosition(): void {
    const fullRange = this._fullMaxUs - this._fullMinUs;
    if (fullRange <= 0) {
      this.sliderEl.value = "1000";
      return;
    }
    const t = (this._cursorUs - this._fullMinUs) / fullRange;
    this.sliderEl.value = String(Math.round(t * 1000));
  }

  private _updateCursorFromSlider(): void {
    const t = parseInt(this.sliderEl.value) / 1000;
    this._cursorUs = this._fullMinUs + t * (this._fullMaxUs - this._fullMinUs);
    this._updateLabel();
  }

  private _updateLabel(): void {
    const totalSec = (this._fullMaxUs - this._fullMinUs) / 1_000_000;
    const cursorSec = (this._cursorUs - this._fullMinUs) / 1_000_000;

    if (this._mode === "live") {
      this.labelEl.textContent = `${totalSec.toFixed(1)}s`;
    } else {
      this.labelEl.textContent = `${cursorSec.toFixed(1)}s / ${totalSec.toFixed(1)}s`;
    }
  }

  private _emitRange(): void {
    if (this._onRangeChange) {
      const [min, max] = this.getFilterRange();
      this._onRangeChange(min, max);
    }
  }

  /** Check if the cursor is outside the client buffer and fire callback */
  private _checkBeyondBuffer(): void {
    if (!this._onScrubBeyondBuffer) return;
    if (this._bufferMinUs === 0 && this._bufferMaxUs === 0) return;

    const [filterMin, filterMax] = this.getFilterRange();

    // If the filter range extends before the buffer's start, request history
    if (filterMin < this._bufferMinUs) {
      this._onScrubBeyondBuffer(filterMin, this._bufferMinUs);
    }
  }
}
