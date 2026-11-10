// ---------------------------------------------------------------------------
// Pelorus — Client protocol
// ---------------------------------------------------------------------------
//
// JSON message types for client ↔ server communication.
// Binary messages are always Arrow IPC frames.
// Text messages are JSON commands/responses.
// ---------------------------------------------------------------------------

export interface MetaRequest {
  type: "meta";
}

export interface QueryRequest {
  type: "query";
  min_us: number;
  max_us: number;
}

export type ClientMessage = MetaRequest | QueryRequest;

export interface MetaResponse {
  type: "meta";
  chunk_count: number;
  total_rows: number;
  min_us: number;
  max_us: number;
  chunk_interval_us: number;
}

export interface QueryResponse {
  type: "query_response";
  chunk_count: number;
  min_us: number;
  max_us: number;
  total_rows: number;
}

export interface ErrorResponse {
  type: "error";
  message: string;
}

export type ServerTextMessage = MetaResponse | QueryResponse | ErrorResponse;

export function parseServerMessage(text: string): ServerTextMessage | null {
  try {
    const msg = JSON.parse(text);
    if (!msg || typeof msg !== "object") return null;
    if (msg.type === "error") return typeof msg.message === "string" ? msg : null;
    if (msg.type !== "meta" && msg.type !== "query_response") return null;
    if (![msg.min_us, msg.max_us].every(Number.isSafeInteger) || msg.min_us > msg.max_us) return null;
    if (![msg.chunk_count, msg.total_rows].every(n => Number.isSafeInteger(n) && n >= 0)) return null;
    if (msg.total_rows < msg.chunk_count || (msg.chunk_count === 0) !== (msg.total_rows === 0)) return null;
    if (msg.type === "meta" && (!Number.isSafeInteger(msg.chunk_interval_us) || msg.chunk_interval_us <= 0)) return null;
    return msg;
  } catch {
    return null;
  }
}

export function sendMessage(ws: WebSocket, msg: ClientMessage): void {
  if (ws.readyState !== WebSocket.OPEN) throw new Error("socket is not open");
  ws.send(JSON.stringify(msg));
}
