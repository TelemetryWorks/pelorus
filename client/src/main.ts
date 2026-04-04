// ---------------------------------------------------------------------------
// Pelorus — Client entry point
// ---------------------------------------------------------------------------
//
// Phase 2: Connects to WebSocket, decodes Arrow IPC binary messages,
// displays batch stats and sample data in the log.
// ---------------------------------------------------------------------------

import { initTheme, toggleTheme, getTheme } from "./theme";
import { decodeBatch, sampleRecords, BatchStats } from "./decode";

const WS_URL = `ws://${window.location.host}/ws`;
const RECONNECT_INTERVAL_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 10;

// --- DOM refs ---
const statusEl = document.getElementById("status")!;
const statusLabel = statusEl.querySelector(".label")!;
const logEl = document.getElementById("log")!;
const statsEl = document.getElementById("stats")!;
const themeBtn = document.getElementById("theme-btn")!;
const mapContainer = document.getElementById("map-container")!;

// --- State ---
let ws: WebSocket | null = null;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let totalBatches = 0;
let totalRows = 0;
let totalBytes = 0;
let lastDecodeMs = 0;

// --- Theme ---
initTheme();
updateThemeButton();

themeBtn.addEventListener("click", () => {
  toggleTheme();
  updateThemeButton();
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

  // Keep log from growing unbounded
  while (logEl.childElementCount > 200) {
    logEl.removeChild(logEl.firstChild!);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

// --- Stats display ---
function updateStats(batch: BatchStats): void {
  totalBatches++;
  totalRows += batch.rowCount;
  totalBytes += batch.byteSize;
  lastDecodeMs = batch.decodeTimeMs;

  statsEl.innerHTML = [
    `<span class="stat">batches <b>${totalBatches}</b></span>`,
    `<span class="stat">rows <b>${totalRows.toLocaleString()}</b></span>`,
    `<span class="stat">bytes <b>${formatBytes(totalBytes)}</b></span>`,
    `<span class="stat">decode <b>${lastDecodeMs.toFixed(1)}ms</b></span>`,
    `<span class="stat">batch <b>${batch.rowCount} rows</b></span>`,
  ].join("");
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
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
    log("sys", "connected — awaiting Arrow IPC stream");
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

function handleBinaryMessage(buffer: ArrayBuffer): void {
  try {
    const decoded = decodeBatch(buffer);
    updateStats(decoded.stats);

    // Log sample records every 10th batch to avoid flooding
    if (totalBatches % 10 === 1) {
      const samples = sampleRecords(decoded.table, 3);
      for (const r of samples) {
        log(
          "data",
          `${r.object_id} ` +
          `lon=${r.longitude.toFixed(3)} ` +
          `lat=${r.latitude.toFixed(3)} ` +
          `alt=${r.altitude_m?.toFixed(0) ?? "—"} ` +
          `spd=${r.speed_mps?.toFixed(1) ?? "—"} ` +
          `hdg=${r.heading_deg?.toFixed(0) ?? "—"}° ` +
          `[${r.category ?? "—"}]`
        );
      }
    }

    // Update map container with live count
    mapContainer.textContent =
      `${decoded.stats.rowCount} objects tracked · ` +
      `batch ${totalBatches} · ` +
      `map canvas — phase 3`;

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
  log("sys", `reconnecting in ${RECONNECT_INTERVAL_MS}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_INTERVAL_MS);
}

// --- Boot ---
connect();
