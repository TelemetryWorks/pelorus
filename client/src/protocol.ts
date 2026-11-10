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
    return JSON.parse(text) as ServerTextMessage;
  } catch {
    return null;
  }
}

export function sendMessage(ws: WebSocket, msg: ClientMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
