// ---------------------------------------------------------------------------
// Pelorus — Client entry point
// ---------------------------------------------------------------------------
//
// Phase 6: Temporal chunk manager + historical query support.
//
// Live data streams in via Arrow IPC. When the user scrubs beyond the
// client buffer range, a query is sent to the server for historical
// chunks. Responses are decoded and merged into the same buffer.
// ---------------------------------------------------------------------------

import { initTheme, toggleTheme, getTheme } from "./theme";
import { decodeBatch } from "./decode";
import { PositionBuffer } from "./buffer";
import { MapRenderer } from "./map";
import { PerfMonitor } from "./perf";
import { TimeSlider } from "./timeslider";
import {
  sendMessage,
  parseServerMessage,
  ServerTextMessage,
  MetaResponse,
} from "./protocol";

const WS_URL = `ws://${window.location.host}/ws`;
const RECONNECT_INTERVAL_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 10;

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

// Query state machine
let pendingQueryChunks = 0; // how many binary frames to expect as query results
let queryInFlight = false;
let lastQueryMin = 0;
let lastQueryMax = 0;

// Server meta
let serverMeta: MetaResponse | null = null;

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
  onScrubBeyondBuffer: (min, max) => {
    requestHistoricalChunks(min, max);
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

// --- Historical chunk requests ---
function requestHistoricalChunks(minUs: number, maxUs: number): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (queryInFlight) return; // one at a time

  // Don't re-request the same range
  if (minUs === lastQueryMin && maxUs === lastQueryMax) return;

  queryInFlight = true;
  lastQueryMin = minUs;
  lastQueryMax = maxUs;

  log("sys", `requesting chunks [${formatTime(minUs)} .. ${formatTime(maxUs)}]`);
  sendMessage(ws, { type: "query", min_us: minUs, max_us: maxUs });
}

function requestMeta(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  sendMessage(ws, { type: "meta" });
}

function formatTime(us: number): string {
  return `${(us / 1_000_000).toFixed(1)}s`;
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
    // Request initial server metadata
    requestMeta();
  });

  ws.addEventListener("message", (ev: MessageEvent) => {
    if (ev.data instanceof ArrayBuffer) {
      handleBinaryMessage(ev.data);
    } else if (typeof ev.data === "string") {
      handleTextMessage(ev.data);
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

function handleTextMessage(text: string): void {
  const msg = parseServerMessage(text);
  if (!msg) {
    log("recv", text);
    return;
  }

  switch (msg.type) {
    case "meta":
      serverMeta = msg;
      timeSlider.setServerRange(msg.min_us, msg.max_us);
      log("sys",
        `server: ${msg.chunk_count} chunks, ` +
        `${msg.total_rows.toLocaleString()} rows, ` +
        `${((msg.max_us - msg.min_us) / 1_000_000).toFixed(1)}s history`
      );
      break;

    case "query_response":
      pendingQueryChunks = msg.chunk_count;
      log("sys", `receiving ${msg.chunk_count} historical chunks`);
      if (msg.chunk_count === 0) {
        queryInFlight = false;
      }
      break;

    case "error":
      log("err", `server: ${msg.message}`);
      queryInFlight = false;
      break;
  }
}

function handleBinaryMessage(data: ArrayBuffer): void {
  try {
    const decoded = decodeBatch(data);
    const isHistorical = pendingQueryChunks > 0;

    if (isHistorical) {
      pendingQueryChunks--;
      if (pendingQueryChunks === 0) {
        queryInFlight = false;
        log("sys", "historical chunk load complete");
      }
    }

    totalBatches++;

    // Append to rolling buffer (both live and historical data)
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
    const serverSec = serverMeta
      ? ((serverMeta.max_us - serverMeta.min_us) / 1_000_000).toFixed(0)
      : "—";

    statsEl.innerHTML = [
      `<span class="stat">objects <b>${decoded.stats.rowCount.toLocaleString()}</b></span>`,
      `<span class="stat">batch <b>#${totalBatches}</b></span>`,
      `<span class="stat">buffer <b>${windowSec}s</b></span>`,
      `<span class="stat">server <b>${serverSec}s</b></span>`,
      `<span class="stat">mode <b>${timeSlider.mode}</b></span>`,
      isHistorical ? `<span class="stat" style="color:var(--warn)">loading <b>${pendingQueryChunks}</b></span>` : "",
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

// --- Periodic meta refresh ---
setInterval(() => {
  requestMeta();
}, 10_000);

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
