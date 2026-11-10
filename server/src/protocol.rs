// ---------------------------------------------------------------------------
// Pelorus — WebSocket protocol
// ---------------------------------------------------------------------------
//
// Defines the text (JSON) message protocol between client and server.
// Binary messages are always Arrow IPC frames.
// Text messages are JSON commands and responses.
// ---------------------------------------------------------------------------

use serde::{Deserialize, Serialize};

/// Messages the client can send to the server.
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum ClientMessage {
    /// Request metadata about the chunk store
    #[serde(rename = "meta")]
    Meta,

    /// Request historical chunks for a time range
    #[serde(rename = "query")]
    Query {
        /// Inclusive lower bound (microseconds since epoch)
        min_us: i64,
        /// Inclusive upper bound (microseconds since epoch)
        max_us: i64,
    },
}

/// Messages the server sends to the client (as JSON text).
#[derive(Debug, Serialize)]
#[serde(tag = "type")]
pub enum ServerMessage {
    /// Chunk store metadata
    #[serde(rename = "meta")]
    Meta {
        chunk_count: usize,
        total_rows: usize,
        min_us: i64,
        max_us: i64,
        chunk_interval_us: i64,
    },

    /// Response to a query — header sent before binary chunk frames
    #[serde(rename = "query_response")]
    QueryResponse {
        /// Number of binary IPC frames that will follow this message
        chunk_count: usize,
        min_us: i64,
        max_us: i64,
        total_rows: usize,
    },

    /// Only after a completed query and before its first resumed live frame.
    /// Tokio's exact lost count; resume at the oldest retained frame, not latest.
    #[serde(rename = "live_reset")]
    LiveReset { skipped_frames: u64 },

    /// Error response
    #[serde(rename = "error")]
    Error { message: String },
}
