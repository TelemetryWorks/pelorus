// ---------------------------------------------------------------------------
// Pelorus — Client entry point
// ---------------------------------------------------------------------------
//
// Phase 5: Full data pipeline with GPU-side time filtering.
// WebSocket → Arrow decode → Position buffer → deck.gl + DataFilterExtension
//
// The time slider updates only a shader uniform — zero CPU work,
// zero data re-upload during scrubbing.
// ---------------------------------------------------------------------------

import { initTheme, toggleTheme, getTheme } from "./theme";
import { decodeBatch } from "./decode";
import { PositionBuffer } from "./buffer";
import { MapRenderer } from "./map";
import { PerfMonitor } from "./perf";
import { TimeSlider } from "./timeslider";

const WS_URL = `ws://${window.location.host}/ws`;
const RECONNECT_INTERVAL_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 10;

// Buffer: ~60 seconds at 2000 objects × 10 Hz = 1.2M rows
const BUFFER_MAX_ROWS = 1_200_000;

// --- DOM refs ---
const statusEl = document.getElementById("status")!;
const statusLabel = statusEl.querySelector(".label")!;
const logEl = document.getElementById("log")!;
const statsEl = document.getElementById("stats")!;
const perfEl = document.getElementById("perf")!;
const themeBtn = document.getElementById("theme-btn")!;
const mapContainer = document.getElementById("map-container")!;
const sliderContainer = document.getElementById("time-slider")!;

// --- State ---
let ws: WebSocket | null = null;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let totalBatches = 0;

// --- Core objects ---
const buffer = new PositionBuffer({ maxRows: BUFFER_MAX_ROWS });
const perf = new PerfMonitor();
const map = new MapRenderer({ container: mapContainer });
map.setBuffer(buffer);

const timeSlider = new TimeSlider({
  container: sliderContainer,
  windowWidthSec: 1.0,
  onRangeChange: (min, max) => {
    map.setFilterRange(min, max);
  },
});

// --- Theme ---
initTheme();
updateThemeButton();

themeBtn.addEventListener("click", () => {
  toggleTheme();
  updateThemeButton();
  map.invalidate();
});

function updateThemeButton(): void {
  themeBtn.textContent = getTheme() === "dark" ? "◐" : "◑";
  themeBtn.title = `switch to ${getTheme() === "dark" ? "light" : "dark"} mode`;
}

// --- Logging ---
type LogKind = "sent" | "recv" | "sys" | "err" | "data";

function log(kind: LogKind, text: string): void {
  const entry = document.createElement("div");
  entry.className = `entry ${kind}`;
  const ts = new Date().toISOString().slice(11, 23);
  const prefix =
    kind === "sent" ? "→" :
    kind === "recv" ? "←" :
    kind === "data" ? "▪" :
    kind === "err"  ? "✗" : "·";
  entry.textContent = `${ts} ${prefix} ${text}`;
  logEl.appendChild(entry);

  while (logEl.childElementCount > 200) {
    logEl.removeChild(logEl.firstChild!);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

// --- Stats display ---
function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

function formatRate(bps: number): string {
  if (bps < 1024) return `${bps.toFixed(0)} B/s`;
  if (bps < 1048576) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / 1048576).toFixed(1)} MB/s`;
}

function updatePerfDisplay(): void {
  const snap = perf.snapshot();

  perfEl.innerHTML = [
    `<span class="stat">fps <b>${snap.fps}</b></span>`,
    `<span class="stat">batches <b>${snap.batchesPerSec.toFixed(1)}/s</b></span>`,
    `<span class="stat">rows <b>${snap.rowsPerSec.toLocaleString(undefined, { maximumFractionDigits: 0 })}/s</b></span>`,
    `<span class="stat">throughput <b>${formatRate(snap.bytesPerSec)}</b></span>`,
    `<span class="stat">decode <b>${snap.avgDecodeMs.toFixed(2)}ms</b></span>`,
    `<span class="stat">render <b>${snap.avgRenderMs.toFixed(2)}ms</b></span>`,
    `<span class="stat">buffer <b>${snap.bufferRows.toLocaleString()}</b></span>`,
  ].join("");
}

// --- Connection ---
function setStatus(connected: boolean): void {
  if (connected) {
    statusEl.classList.add("connected");
    statusLabel.textContent = "streaming";
  } else {
    statusEl.classList.remove("connected");
    statusLabel.textContent = "disconnected";
  }
}

function connect(): void {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  log("sys", `connecting to ${WS_URL}...`);
  ws = new WebSocket(WS_URL);
  ws.binaryType = "arraybuffer";

  ws.addEventListener("open", () => {
    reconnectAttempts = 0;
    setStatus(true);
    log("sys", "connected — streaming Arrow IPC");
  });

  ws.addEventListener("message", (ev: MessageEvent) => {
    if (ev.data instanceof ArrayBuffer) {
      handleBinaryMessage(ev.data);
    } else if (typeof ev.data === "string") {
      log("recv", ev.data);
    }
  });

  ws.addEventListener("close", (ev: CloseEvent) => {
    setStatus(false);
    log("sys", `closed (code=${ev.code})`);
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    log("err", "connection error");
  });
}

function handleBinaryMessage(data: ArrayBuffer): void {
  try {
    const decoded = decodeBatch(data);
    totalBatches++;

    // Append to rolling buffer
    buffer.append(
      decoded.timestamps,
      decoded.longitudes,
      decoded.latitudes,
      decoded.altitudes,
      decoded.speeds,
      decoded.headings,
      decoded.categories,
      decoded.objectIds,
    );

    perf.recordBatch(decoded.stats.rowCount, decoded.stats.byteSize, decoded.stats.decodeTimeMs);
    perf.setBufferRows(buffer.length);

    // Tell renderer buffer has new data
    map.markDataDirty();

    // Update time slider with buffer range
    const timeRange = buffer.timeRange;
    if (timeRange) {
      timeSlider.setBufferRange(timeRange[0], timeRange[1]);
    }

    // Update data stats bar
    const windowSec = timeRange
      ? ((timeRange[1] - timeRange[0]) / 1_000_000).toFixed(1)
      : "0";

    statsEl.innerHTML = [
      `<span class="stat">objects <b>${decoded.stats.rowCount.toLocaleString()}</b></span>`,
      `<span class="stat">batch <b>#${totalBatches}</b></span>`,
      `<span class="stat">window <b>${windowSec}s</b></span>`,
      `<span class="stat">categories <b>${buffer.categoryCount}</b></span>`,
      `<span class="stat">slider <b>${timeSlider.mode}</b></span>`,
    ].join("");

    // Log sample every 50 batches
    if (totalBatches % 50 === 1 && decoded.objectIds.length > 0) {
      log("data",
        `${decoded.objectIds[0]} ` +
        `lon=${decoded.longitudes[0].toFixed(3)} ` +
        `lat=${decoded.latitudes[0].toFixed(3)} ` +
        `alt=${decoded.altitudes[0]?.toFixed(0) ?? "—"} ` +
        `[${decoded.categories[0] ?? "—"}]`
      );
    }

  } catch (e) {
    log("err", `decode failed: ${e}`);
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    log("err", "max reconnect attempts reached");
    return;
  }
  reconnectAttempts++;
  log("sys", `reconnecting in ${RECONNECT_INTERVAL_MS}ms (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_INTERVAL_MS);
}

// --- Render loop ---
function renderLoop(): void {
  perf.recordFrame();

  const renderMs = map.update();
  if (renderMs > 0) {
    perf.recordRender(renderMs);
  }

  requestAnimationFrame(renderLoop);
}

// --- Perf display update (1 Hz) ---
setInterval(updatePerfDisplay, 1000);

// --- Boot ---
connect();
requestAnimationFrame(renderLoop);
