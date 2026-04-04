// ---------------------------------------------------------------------------
// Phase 1 — WebSocket client with auto-reconnect
// ---------------------------------------------------------------------------

const WS_URL = `ws://${window.location.host}/ws`;
const RECONNECT_INTERVAL_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 10;

// --- DOM refs ---
const statusEl = document.getElementById("status")!;
const statusLabel = statusEl.querySelector(".label")!;
const logEl = document.getElementById("log")!;
const inputEl = document.getElementById("msg-input") as HTMLInputElement;
const sendBtn = document.getElementById("send-btn")!;

// --- State ---
let ws: WebSocket | null = null;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// --- Logging ---
type LogKind = "sent" | "recv" | "sys" | "err";

function log(kind: LogKind, text: string): void {
  const entry = document.createElement("div");
  entry.className = `entry ${kind}`;
  const ts = new Date().toISOString().slice(11, 23);
  const prefix = kind === "sent" ? "→" : kind === "recv" ? "←" : kind === "err" ? "✗" : "·";
  entry.textContent = `${ts} ${prefix} ${text}`;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

// --- Connection ---
function setStatus(connected: boolean): void {
  if (connected) {
    statusEl.classList.add("connected");
    statusLabel.textContent = "connected";
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

  ws.binaryType = "arraybuffer"; // Arrow IPC in phase 2

  ws.addEventListener("open", () => {
    reconnectAttempts = 0;
    setStatus(true);
    log("sys", "connection established");
  });

  ws.addEventListener("message", (ev: MessageEvent) => {
    if (typeof ev.data === "string") {
      log("recv", ev.data);
    } else if (ev.data instanceof ArrayBuffer) {
      log("recv", `[binary ${ev.data.byteLength} bytes]`);
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

// --- Send ---
function send(text: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log("err", "not connected");
    return;
  }
  ws.send(text);
  log("sent", text);
}

// --- UI bindings ---
sendBtn.addEventListener("click", () => {
  const text = inputEl.value.trim();
  if (text) {
    send(text);
    inputEl.value = "";
  }
});

inputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
  if (ev.key === "Enter") {
    sendBtn.click();
  }
});

// --- Boot ---
connect();
