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
  MetaResponse,
} from "./protocol";

const WS_URL = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;
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

// One request per connection, followed by a contiguous binary response.
let pendingQueryChunks = 0;
let queryInFlight = false;
let activeRange: [number, number] | null = null;
let queuedRange: [number, number] | null = null;
let loadedRange: [number, number] | null = null;
let queryRows = 0;
let receivedQueryRows = 0;
let viewRange: [number, number] | null = null;
let queryTimer: ReturnType<typeof setTimeout> | null = null;
let filterRange: [number, number] | null = null;
let liveResetAllowed = false;

// Server meta
let serverMeta: MetaResponse | null = null;

// --- Core objects ---
const buffer = new PositionBuffer({ maxRows: BUFFER_MAX_ROWS });
// Allocate history storage only when first queried. Each buffer is capped.
let historyBuffer: PositionBuffer | null = null;
const perf = new PerfMonitor();
const map = new MapRenderer({ container: mapContainer });
map.setBuffer(buffer);

const timeSlider = new TimeSlider({
  container: sliderContainer,
  windowWidthSec: 1.0,
  onRangeChange: (min, max) => {
    filterRange = [min, max];
    const liveRange = buffer.timeRange;
    if (timeSlider.mode === "live" || (liveRange && min >= liveRange[0] && max <= liveRange[1])) queuedRange = null;
    map.setFilterRange(min, max);
    selectView();
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
function selectView(): void {
  const useHistory = timeSlider.mode === "scrub" && historyBuffer && viewRange && filterRange
    && filterRange[0] >= viewRange[0] && filterRange[1] <= viewRange[1];
  map.setBuffer(useHistory ? historyBuffer! : buffer);
}

function resetQuery(): void {
  if (queryTimer !== null) clearTimeout(queryTimer);
  queryTimer = null;
  queryInFlight = false;
  pendingQueryChunks = 0;
  activeRange = null;
  queuedRange = null;
}

function resetConnection(): void {
  resetQuery();
  liveResetAllowed = false;
  loadedRange = null;
  viewRange = null;
  serverMeta = null;
  historyBuffer?.clear();
  buffer.clear();
  timeSlider.setServerRange(0, 0);
  timeSlider.setBufferRange(0, 0);
  map.setBuffer(buffer);
  map.markDataDirty();
}

function requestHistoricalChunks(minUs: number, maxUs: number): void {
  minUs = Math.floor(minUs);
  maxUs = Math.ceil(maxUs);
  if (!Number.isSafeInteger(minUs) || !Number.isSafeInteger(maxUs) || minUs > maxUs) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (loadedRange && minUs >= loadedRange[0] && maxUs <= loadedRange[1]) { queuedRange = null; selectView(); return; }
  if (queryInFlight) {
    queuedRange = activeRange?.[0] === minUs && activeRange?.[1] === maxUs ? null : [minUs, maxUs];
    return;
  }
  queryInFlight = true;
  activeRange = [minUs, maxUs];
  queryRows = 0;
  receivedQueryRows = 0;
  historyBuffer ??= new PositionBuffer({ maxRows: BUFFER_MAX_ROWS });
  log("sys", `requesting chunks [${formatTime(minUs)} .. ${formatTime(maxUs)}]`);
  try {
    sendMessage(ws, { type: "query", min_us: minUs, max_us: maxUs });
    queryTimer = setTimeout(() => { resetQuery(); ws?.close(); }, 15_000);
  } catch {
    resetQuery();
    ws.close();
  }
}

function finishQuery(): void {
  liveResetAllowed = true;
  const next = queuedRange;
  // Only cache coverage when the entire nonempty result fits. A row cap can
  // truncate a response; that must not suppress a later request for missing data.
  const liveRows = activeRange && historyBuffer
    ? historyBuffer.mergeRangeFrom(buffer, ...activeRange) : 0;
  loadedRange = queryRows > 0 && queryRows + liveRows <= BUFFER_MAX_ROWS ? activeRange : null;
  viewRange = historyBuffer?.length ? activeRange : null;
  resetQuery();
  selectView();
  if (next) requestHistoricalChunks(...next);
}

function requestMeta(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try { sendMessage(ws, { type: "meta" }); } catch { ws.close(); }
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
  resetConnection();
  const socket = new WebSocket(WS_URL);
  ws = socket;
  ws.binaryType = "arraybuffer";

  ws.addEventListener("open", () => {
    if (ws !== socket) return;
    reconnectAttempts = 0;
    setStatus(true);
    log("sys", "connected — streaming Arrow IPC");
    // Request initial server metadata
    requestMeta();
  });

  ws.addEventListener("message", (ev: MessageEvent) => {
    if (ws !== socket) return;
    if (ev.data instanceof ArrayBuffer) {
      handleBinaryMessage(ev.data);
    } else if (typeof ev.data === "string") {
      handleTextMessage(ev.data);
    }
  });

  ws.addEventListener("close", (ev: CloseEvent) => {
    if (ws !== socket) return;
    resetConnection();
    setStatus(false);
    log("sys", `closed (code=${ev.code})`);
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    if (ws !== socket) return;
    log("err", "connection error");
    resetConnection();
    socket.close();
  });
}

function handleTextMessage(text: string): void {
  const msg = parseServerMessage(text);
  if (!msg) {
    log("err", "invalid server protocol message");
    resetQuery();
    ws?.close();
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
      if (!queryInFlight || pendingQueryChunks !== 0 || !activeRange
        || msg.min_us !== activeRange[0] || msg.max_us !== activeRange[1]) {
        resetQuery();
        ws?.close();
        return;
      }
      // Keep completed history while a new request awaits its header. A live
      // reset from the previous response can still arrive during that window.
      historyBuffer!.clear();
      loadedRange = null;
      viewRange = null;
      selectView();
      pendingQueryChunks = msg.chunk_count;
      queryRows = msg.total_rows;
      log("sys", `receiving ${msg.chunk_count} historical chunks (${queryRows} rows)`);
      if (msg.chunk_count === 0) finishQuery();
      break;

    case "live_reset":
      if (!liveResetAllowed || pendingQueryChunks > 0) {
        resetQuery();
        ws?.close();
        return;
      }
      liveResetAllowed = false;
      buffer.clear();
      timeSlider.setBufferRange(0, 0);
      selectView();
      map.markDataDirty();
      perf.setBufferRows(0);
      log("sys", `live stream restarted after history: ${msg.skipped_frames} frames skipped; resuming oldest retained frame`);
      break;

    case "error": {
      log("err", `server: ${msg.message}`);
      const next = queuedRange;
      resetQuery();
      if (next) requestHistoricalChunks(...next);
      break;
    }
  }
}

function handleBinaryMessage(data: ArrayBuffer): void {
  try {
    const isHistorical = pendingQueryChunks > 0;
    const decoded = decodeBatch(data);
    if (!isHistorical) liveResetAllowed = false;
    totalBatches++;
    const target = isHistorical ? historyBuffer! : buffer;
    target.append(
      decoded.timestamps, decoded.longitudes, decoded.latitudes,
      decoded.altitudes, decoded.speeds, decoded.headings,
      decoded.categories, decoded.objectIds,
    );
    if (isHistorical) {
      receivedQueryRows += decoded.stats.rowCount;
      if (--pendingQueryChunks === 0) {
        if (receivedQueryRows !== queryRows) throw new Error("query row count mismatch");
        finishQuery();
      }
    }

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
    // Remaining response frames cannot safely be reclassified as live.
    resetQuery();
    ws?.close();
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
