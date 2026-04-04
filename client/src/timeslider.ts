// ---------------------------------------------------------------------------
// Pelorus — Time slider
// ---------------------------------------------------------------------------
//
// Manages the scrubbable time window. Two modes:
//
//   "live" — cursor auto-advances to latest timestamp, window slides forward
//   "scrub" — user has grabbed the slider, cursor is manual
//
// The slider position maps to a timestamp. A configurable window width
// determines how much time is visible around the cursor. The output is
// a [filterMin, filterMax] range in microseconds that the GPU shader
// uses to show/hide points.
// ---------------------------------------------------------------------------

export interface TimeSliderConfig {
  /** Container element for the slider UI */
  container: HTMLElement;
  /** Initial window width in seconds */
  windowWidthSec?: number;
  /** Callback fired when the filter range changes */
  onRangeChange?: (min: number, max: number) => void;
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
  private _windowWidthUs: number;  // microseconds
  private _bufferMinUs = 0;
  private _bufferMaxUs = 0;
  private _cursorUs = 0;
  private _onRangeChange: ((min: number, max: number) => void) | null;

  constructor(config: TimeSliderConfig) {
    this.container = config.container;
    this._windowWidthUs = (config.windowWidthSec ?? 1.0) * 1_000_000;
    this._onRangeChange = config.onRangeChange ?? null;

    // Build UI
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
      // User is scrubbing — switch to scrub mode
      if (this._mode === "live") {
        this._mode = "scrub";
        this.modeEl.textContent = "SCRUB";
        this.modeEl.classList.add("scrub");
      }
      this._updateCursorFromSlider();
      this._emitRange();
    });

    // Window width
    this.windowEl.addEventListener("input", () => {
      // Map slider 1-100 → 0.1s to 30s (exponential)
      const val = parseInt(this.windowEl.value);
      const sec = 0.1 * Math.pow(300, val / 100);
      this._windowWidthUs = sec * 1_000_000;
      this.windowLabelEl.textContent = sec < 10
        ? `${sec.toFixed(1)}s`
        : `${sec.toFixed(0)}s`;
      this._emitRange();
    });

    // Initialize window label
    const initSec = this._windowWidthUs / 1_000_000;
    this.windowLabelEl.textContent = `${initSec.toFixed(1)}s`;
  }

  get mode(): TimeSliderMode { return this._mode; }

  /** Update the buffer's time range. Call on each batch. */
  setBufferRange(minUs: number, maxUs: number): void {
    this._bufferMinUs = minUs;
    this._bufferMaxUs = maxUs;

    if (this._mode === "live") {
      this._cursorUs = maxUs;
      this.sliderEl.value = "1000"; // pinned to end
      this._updateLabel();
      this._emitRange();
    }
  }

  /** Get the current filter range [min, max] in microseconds */
  getFilterRange(): [number, number] {
    const halfWindow = this._windowWidthUs / 2;
    return [
      this._cursorUs - halfWindow,
      this._cursorUs + halfWindow,
    ];
  }

  private _updateCursorFromSlider(): void {
    const t = parseInt(this.sliderEl.value) / 1000; // 0..1
    this._cursorUs = this._bufferMinUs + t * (this._bufferMaxUs - this._bufferMinUs);
    this._updateLabel();
  }

  private _updateLabel(): void {
    const totalSec = (this._bufferMaxUs - this._bufferMinUs) / 1_000_000;
    const cursorSec = (this._cursorUs - this._bufferMinUs) / 1_000_000;

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
}
