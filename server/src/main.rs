// ---------------------------------------------------------------------------
// Pelorus — Server
// ---------------------------------------------------------------------------
//
// Phase 6: Temporal chunk manager + query protocol.
//
// The server maintains a shared ChunkManager that archives incoming
// data into fixed-interval chunks. Clients receive the live stream
// AND can request historical chunks by time range.
//
// Binary WS messages: Arrow IPC frames (live data + query responses)
// Text WS messages:   JSON protocol (commands + metadata)
// ---------------------------------------------------------------------------

mod chunks;
mod generator;
mod ipc;
mod protocol;
mod schema;

use axum::{
    Router,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::IntoResponse,
    routing::get,
};
use futures::{SinkExt, StreamExt};
use std::env;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tower_http::{cors::CorsLayer, services::ServeDir};
use tracing::{info, warn};

use crate::chunks::{ChunkConfig, ChunkManager};
use crate::generator::MockGenerator;
use crate::ipc::batch_to_ipc_bytes;
use crate::protocol::{ClientMessage, ServerMessage};

fn env_usize(key: &str, default: usize) -> usize {
    env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn env_f64(key: &str, default: f64) -> f64 {
    env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn env_i64(key: &str, default: i64) -> i64 {
    env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

#[derive(Clone)]
struct AppConfig {
    num_objects: usize,
    tick_rate_hz: f64,
}

/// Shared state across all client connections
#[derive(Clone)]
struct AppState {
    config: AppConfig,
    chunks: Arc<Mutex<ChunkManager>>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "server=debug,tower_http=info".into()),
        )
        .init();

    let config = AppConfig {
        num_objects: env_usize("PELORUS_OBJECTS", 2000),
        tick_rate_hz: env_f64("PELORUS_HZ", 10.0),
    };

    let chunk_config = ChunkConfig {
        chunk_interval_us: env_i64("PELORUS_CHUNK_INTERVAL_US", 5_000_000),
        max_chunks: env_usize("PELORUS_MAX_CHUNKS", 720),
    };

    info!(
        "chunk config: {}s intervals, {} max chunks ({}s retention)",
        chunk_config.chunk_interval_us as f64 / 1_000_000.0,
        chunk_config.max_chunks,
        (chunk_config.chunk_interval_us as f64 / 1_000_000.0) * chunk_config.max_chunks as f64,
    );

    let state = AppState {
        config,
        chunks: Arc::new(Mutex::new(ChunkManager::new(chunk_config))),
    };

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .with_state(state)
        .fallback_service(ServeDir::new("client/dist"))
        .layer(CorsLayer::permissive());

    let addr = SocketAddr::from(([127, 0, 0, 1], 3000));
    info!("pelorus server listening on {addr}");
    info!(
        "streaming: {} objects @ {} Hz ({} records/sec)",
        env_usize("PELORUS_OBJECTS", 2000),
        env_f64("PELORUS_HZ", 10.0),
        (env_usize("PELORUS_OBJECTS", 2000) as f64 * env_f64("PELORUS_HZ", 10.0)) as u64
    );

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    info!("new websocket connection request");
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();

    let config = &state.config;
    info!(
        "client connected — streaming {} objects at {} Hz",
        config.num_objects, config.tick_rate_hz
    );

    let mut generator = MockGenerator::new(config.num_objects);
    let tick_interval = Duration::from_secs_f64(1.0 / config.tick_rate_hz);
    let mut interval = tokio::time::interval(tick_interval);
    let dt = 1.0 / config.tick_rate_hz;
    let mut tick_count: u64 = 0;
    let mut total_bytes: u64 = 0;

    loop {
        tokio::select! {
            _ = interval.tick() => {
                let batch = generator.tick(dt);
                let bytes = batch_to_ipc_bytes(&batch);
                let byte_len = bytes.len() as u64;
                total_bytes += byte_len;
                tick_count += 1;

                // Archive into chunk manager
                {
                    let mut chunks = state.chunks.lock().unwrap();
                    chunks.ingest(batch);
                }

                // Log periodically
                if tick_count % (config.tick_rate_hz as u64 * 5).max(1) == 0 {
                    let mb = total_bytes as f64 / 1_048_576.0;
                    let secs = tick_count as f64 / config.tick_rate_hz;
                    let chunk_meta = state.chunks.lock().unwrap().meta();
                    info!(
                        "tick {tick_count}: {byte_len} B/frame, \
                         {mb:.1} MB total ({rate:.1} MB/s), \
                         {chunks} chunks ({chunk_rows} rows archived)",
                        rate = mb / secs,
                        chunks = chunk_meta.chunk_count,
                        chunk_rows = chunk_meta.total_rows,
                    );
                }

                // Send live frame to client
                if sender.send(Message::Binary(bytes.into())).await.is_err() {
                    warn!("send failed — client disconnected");
                    break;
                }
            }

            msg = receiver.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        handle_client_message(&text, &state, &mut sender).await;
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        info!("client disconnected");
                        break;
                    }
                    Some(Err(e)) => {
                        warn!("websocket error: {e}");
                        break;
                    }
                    _ => {}
                }
            }
        }
    }

    info!("session ended: {tick_count} ticks, {:.1} MB sent", total_bytes as f64 / 1_048_576.0);
}

async fn handle_client_message(
    text: &str,
    state: &AppState,
    sender: &mut futures::stream::SplitSink<WebSocket, Message>,
) {
    let msg: ClientMessage = match serde_json::from_str(text) {
        Ok(m) => m,
        Err(e) => {
            let err = ServerMessage::Error {
                message: format!("invalid message: {e}"),
            };
            let _ = sender
                .send(Message::Text(serde_json::to_string(&err).unwrap().into()))
                .await;
            return;
        }
    };

    match msg {
        ClientMessage::Meta => {
            let meta = state.chunks.lock().unwrap().meta();
            let resp = ServerMessage::Meta {
                chunk_count: meta.chunk_count,
                total_rows: meta.total_rows,
                min_us: meta.min_us,
                max_us: meta.max_us,
                chunk_interval_us: meta.chunk_interval_us,
            };
            let _ = sender
                .send(Message::Text(serde_json::to_string(&resp).unwrap().into()))
                .await;
        }

        ClientMessage::Query { min_us, max_us } => {
            let chunks = state.chunks.lock().unwrap();
            let ipc_frames = chunks.query_range(min_us, max_us);
            let chunk_count = ipc_frames.len();
            let total_rows: usize = ipc_frames.iter().map(|_| 0).count(); // approximate

            info!(
                "query [{min_us} .. {max_us}]: {} chunks",
                chunk_count
            );

            // Send header
            let header = ServerMessage::QueryResponse {
                chunk_count,
                min_us,
                max_us,
                total_rows,
            };
            let _ = sender
                .send(Message::Text(serde_json::to_string(&header).unwrap().into()))
                .await;

            // Drop the lock before sending binary frames
            let frames: Vec<_> = ipc_frames;
            drop(chunks);

            // Send each chunk as a binary frame
            for frame in frames {
                if sender
                    .send(Message::Binary(frame.as_ref().clone().into()))
                    .await
                    .is_err()
                {
                    warn!("failed to send query chunk");
                    break;
                }
            }
        }
    }
}
