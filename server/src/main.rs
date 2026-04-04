use axum::{
    Router,
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    response::IntoResponse,
    routing::get,
};
use futures::{SinkExt, StreamExt};
use std::net::SocketAddr;
use tower_http::{
    cors::CorsLayer,
    services::ServeDir,
};
use tracing::{info, warn};

/// Application state (will hold shared data in later phases)
#[derive(Clone)]
struct AppState {}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "server=debug,tower_http=debug".into()),
        )
        .init();

    let state = AppState {};

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .with_state(state)
        .fallback_service(ServeDir::new("client/dist"))
        .layer(CorsLayer::permissive());

    let addr = SocketAddr::from(([127, 0, 0, 1], 3000));
    info!("listening on {addr}");

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn ws_handler(ws: WebSocketUpgrade) -> impl IntoResponse {
    info!("new websocket connection request");
    ws.on_upgrade(handle_socket)
}

async fn handle_socket(socket: WebSocket) {
    let (mut sender, mut receiver) = socket.split();

    info!("client connected");

    // Phase 1: echo mode — reflects everything back
    // Phase 2 will replace this with Arrow IPC streaming
    while let Some(msg) = receiver.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                info!("received text: {text}");
                if sender.send(Message::Text(text.into())).await.is_err() {
                    break;
                }
            }
            Ok(Message::Binary(data)) => {
                info!("received binary: {} bytes", data.len());
                if sender.send(Message::Binary(data)).await.is_err() {
                    break;
                }
            }
            Ok(Message::Ping(data)) => {
                if sender.send(Message::Pong(data)).await.is_err() {
                    break;
                }
            }
            Ok(Message::Close(_)) => {
                info!("client sent close");
                break;
            }
            Err(e) => {
                warn!("websocket error: {e}");
                break;
            }
            _ => {}
        }
    }

    info!("client disconnected");
}
