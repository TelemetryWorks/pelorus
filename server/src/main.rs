// ---------------------------------------------------------------------------
// Pelorus — Server
// ---------------------------------------------------------------------------
//
// Phase 3: Configurable high-rate Arrow IPC streaming.
// Env vars: PELORUS_OBJECTS (default 2000), PELORUS_HZ (default 10)
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
use std::env;
use std::net::SocketAddr;
use std::time::Duration;
use tower_http::{cors::CorsLayer, services::ServeDir};
use tracing::{info, warn};

use crate::generator::MockGenerator;
use crate::ipc::batch_to_ipc_bytes;

fn env_usize(key: &str, default: usize) -> usize {
    env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn env_f64(key: &str, default: f64) -> f64 {
    env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

#[derive(Clone)]
struct AppConfig {
    num_objects: usize,
    tick_rate_hz: f64,
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

    let app = Router::new()
        .route("/ws", get({
            let config = config.clone();
            move |ws| ws_handler(ws, config)
        }))
        .fallback_service(ServeDir::new("client/dist"))
        .layer(CorsLayer::permissive());

    let addr = SocketAddr::from(([127, 0, 0, 1], 3000));
    info!("pelorus server listening on {addr}");
    info!(
        "config: {} objects @ {} Hz ({} records/sec)",
        config.num_objects,
        config.tick_rate_hz,
        (config.num_objects as f64 * config.tick_rate_hz) as u64
    );

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn ws_handler(ws: WebSocketUpgrade, config: AppConfig) -> impl IntoResponse {
    info!("new websocket connection request");
    ws.on_upgrade(move |socket| handle_socket(socket, config))
}

async fn handle_socket(socket: WebSocket, config: AppConfig) {
    let (mut sender, mut receiver) = socket.split();

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

                if tick_count % (config.tick_rate_hz as u64 * 5).max(1) == 0 {
                    let mb = total_bytes as f64 / 1_048_576.0;
                    let secs = tick_count as f64 / config.tick_rate_hz;
                    info!(
                        "tick {tick_count}: {rows} rows, {byte_len} B/frame, \
                         {mb:.1} MB total in {secs:.0}s ({rate:.1} MB/s)",
                        rows = batch.num_rows(),
                        rate = mb / secs,
                    );
                }

                if sender.send(Message::Binary(bytes.into())).await.is_err() {
                    warn!("send failed — client disconnected");
                    break;
                }
            }

            msg = receiver.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        info!("client: {text}");
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

    info!("session ended: {tick_count} ticks, {:.1} MB sent", total_bytes as f64 / 1_048_576.0);
}
