// ---------------------------------------------------------------------------
// Pelorus — Server
// ---------------------------------------------------------------------------
//
// Phase 2: Streams Arrow IPC encoded position data over WebSocket.
// Mock generator produces synthetic moving objects at 1 Hz.
// Clients receive binary Arrow IPC messages they can decode directly.
// ---------------------------------------------------------------------------

mod generator;
mod ipc;
mod schema;

use axum::{
    Router,
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    response::IntoResponse,
    routing::get,
};
use futures::{SinkExt, StreamExt};
use std::net::SocketAddr;
use std::time::Duration;
use tower_http::{cors::CorsLayer, services::ServeDir};
use tracing::{info, warn};

use crate::generator::MockGenerator;
use crate::ipc::batch_to_ipc_bytes;

/// Configuration — will be CLI args or config file later
const NUM_OBJECTS: usize = 200;
const TICK_RATE_HZ: f64 = 1.0;

#[derive(Clone)]
struct AppState {}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "server=debug,tower_http=info".into()),
        )
        .init();

    let state = AppState {};

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .with_state(state)
        .fallback_service(ServeDir::new("client/dist"))
        .layer(CorsLayer::permissive());

    let addr = SocketAddr::from(([127, 0, 0, 1], 3000));
    info!("pelorus server listening on {addr}");
    info!("streaming {NUM_OBJECTS} objects at {TICK_RATE_HZ} Hz");

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn ws_handler(ws: WebSocketUpgrade) -> impl IntoResponse {
    info!("new websocket connection request");
    ws.on_upgrade(handle_socket)
}

async fn handle_socket(socket: WebSocket) {
    let (mut sender, mut receiver) = socket.split();

    info!("client connected — starting data stream");

    let mut generator = MockGenerator::new(NUM_OBJECTS);
    let tick_interval = Duration::from_secs_f64(1.0 / TICK_RATE_HZ);
    let mut interval = tokio::time::interval(tick_interval);
    let mut tick_count: u64 = 0;

    loop {
        tokio::select! {
            // Generate and send data on each tick
            _ = interval.tick() => {
                let batch = generator.tick(1.0 / TICK_RATE_HZ);
                let bytes = batch_to_ipc_bytes(&batch);

                tick_count += 1;
                if tick_count % 10 == 0 {
                    info!(
                        "tick {tick_count}: {rows} rows, {bytes} bytes IPC",
                        rows = batch.num_rows(),
                        bytes = bytes.len()
                    );
                }

                if sender
                    .send(Message::Binary(bytes.into()))
                    .await
                    .is_err()
                {
                    warn!("failed to send — client disconnected");
                    break;
                }
            }

            // Handle incoming client messages (control commands in later phases)
            msg = receiver.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        info!("client message: {text}");
                        // Phase 2: just acknowledge
                        let _ = sender
                            .send(Message::Text(format!("ack: {text}").into()))
                            .await;
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

    info!("session ended after {tick_count} ticks");
}
