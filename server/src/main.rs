//! One startup ingest source feeds the archive and all live subscribers.
//! Query headers and their binary frames are sent contiguously by each socket.
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
use chunks::{ChunkConfig, ChunkManager};
use futures::{Sink, SinkExt, StreamExt};
use generator::MockGenerator;
use ipc::batch_to_ipc_bytes;
use protocol::{ClientMessage, ServerMessage};
use std::{
    env,
    net::SocketAddr,
    str::FromStr,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::broadcast;
use tower_http::{cors::CorsLayer, services::ServeDir};
use tracing::{info, warn};

// A stalled socket retains at most 16 queued live frames. On lag it reconnects
// instead of silently displaying a stream with holes. Ingest never waits on it.
const LIVE_QUEUE_FRAMES: usize = 16;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

fn setting<T: FromStr>(key: &str, default: T) -> Result<T, String> {
    match env::var(key) {
        Ok(value) => value.parse().map_err(|_| format!("invalid {key}")),
        Err(env::VarError::NotPresent) => Ok(default),
        Err(_) => Err(format!("invalid {key}")),
    }
}

#[derive(Clone)]
struct AppConfig {
    num_objects: usize,
    tick_rate_hz: f64,
}
impl AppConfig {
    fn interval(&self, max_rows: usize) -> Result<Duration, String> {
        if self.num_objects == 0 || self.num_objects > max_rows {
            return Err("PELORUS_OBJECTS must be positive and <= PELORUS_MAX_ROWS".into());
        }
        if !self.tick_rate_hz.is_finite() || self.tick_rate_hz <= 0.0 {
            return Err("PELORUS_HZ must be finite and positive".into());
        }
        let interval = Duration::try_from_secs_f64(1.0 / self.tick_rate_hz)
            .map_err(|_| "PELORUS_HZ does not produce a representable interval")?;
        if interval.is_zero() {
            return Err("PELORUS_HZ interval rounds to zero".into());
        }
        Ok(interval)
    }
}

#[derive(Clone)]
struct AppState {
    chunks: Arc<Mutex<ChunkManager>>,
    live: broadcast::Sender<Arc<Vec<u8>>>,
}

// Called once per source tick, irrespective of the number of subscribers.
fn ingest_tick(state: &AppState, generator: &mut MockGenerator, dt: f64, timestamp_us: i64) {
    let batch = generator.tick_at(dt, timestamp_us);
    let bytes = Arc::new(batch_to_ipc_bytes(&batch));
    {
        state.chunks.lock().unwrap().ingest(batch);
    }
    // No receivers is normal. Archive ingestion continues.
    let _ = state.live.send(bytes);
}

fn wall_timestamp_us() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros() as i64
}

async fn run_ingest(state: AppState, config: AppConfig, period: Duration, clock: fn() -> i64) {
    let mut generator = MockGenerator::new(config.num_objects);
    let mut timer = tokio::time::interval(period);
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_timestamp = 0;
    loop {
        timer.tick().await;
        let wall_us = clock();
        // Keep this source ordered even if wall time steps backwards.
        last_timestamp = wall_us.max(last_timestamp + 1);
        ingest_tick(
            &state,
            &mut generator,
            1.0 / config.tick_rate_hz,
            last_timestamp,
        );
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "server=info".into()),
        )
        .init();
    let config = AppConfig {
        num_objects: setting("PELORUS_OBJECTS", 2000)?,
        tick_rate_hz: setting("PELORUS_HZ", 10.0)?,
    };
    let chunk_config = ChunkConfig {
        chunk_interval_us: setting("PELORUS_CHUNK_INTERVAL_US", 5_000_000)?,
        max_chunks: setting("PELORUS_MAX_CHUNKS", 720)?,
        max_rows: setting("PELORUS_MAX_ROWS", 1_200_000)?,
    };
    let period = config.interval(chunk_config.max_rows)?;
    info!(
        ?chunk_config,
        "archive retention limits (rows include the open chunk)"
    );
    let state = AppState {
        chunks: Arc::new(Mutex::new(ChunkManager::new(chunk_config)?)),
        live: broadcast::channel(LIVE_QUEUE_FRAMES).0,
    };
    let app = Router::new()
        .route("/ws", get(ws_handler))
        .with_state(state.clone())
        .fallback_service(ServeDir::new("client/dist"))
        .layer(CorsLayer::permissive());
    let addr = SocketAddr::from(([127, 0, 0, 1], 3000));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let ingest = tokio::spawn(run_ingest(state, config, period, wall_timestamp_us));
    info!("pelorus server listening on {addr}");
    let result = axum::serve(listener, app).await;
    ingest.abort();
    result?;
    Ok(())
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.max_message_size(16 * 1024)
        .on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let mut live = state.live.subscribe();
    let (mut sender, mut receiver) = socket.split();
    loop {
        tokio::select! {
            frame = live.recv() => match frame {
                Ok(bytes) => if !matches!(tokio::time::timeout(Duration::from_secs(5),
                    sender.send(Message::Binary(bytes.as_ref().clone().into()))).await, Ok(Ok(()))) { break; },
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    warn!(skipped, "disconnecting lagging client; reconnect for current stream");
                    break;
                },
                Err(broadcast::error::RecvError::Closed) => break,
            },
            msg = receiver.next() => match msg {
                Some(Ok(Message::Text(text))) => {
                    if !matches!(tokio::time::timeout(Duration::from_secs(10),
                        handle_client_message(&text, &state, &mut sender)).await, Ok(Ok(()))) { break; }
                },
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {},
            }
        }
    }
    // Dropping both socket halves closes a stalled/lagging connection without
    // waiting on an unbounded graceful close handshake.
}

// No guard escapes this synchronous function. Only immutable frame snapshots
// are retained while network I/O is pending; a query may outlive eviction.
fn response(text: &str, state: &AppState) -> (ServerMessage, Vec<Arc<Vec<u8>>>) {
    let error = |message: String| (ServerMessage::Error { message }, Vec::new());
    match serde_json::from_str::<ClientMessage>(text) {
        Err(e) => error(format!("invalid message: {e}")),
        Ok(ClientMessage::Meta) => {
            let meta = state.chunks.lock().unwrap().meta();
            (
                ServerMessage::Meta {
                    chunk_count: meta.chunk_count,
                    total_rows: meta.total_rows,
                    min_us: meta.min_us,
                    max_us: meta.max_us,
                    chunk_interval_us: meta.chunk_interval_us,
                },
                Vec::new(),
            )
        }
        Ok(ClientMessage::Query { min_us, max_us }) => {
            if min_us > max_us || min_us < -MAX_SAFE_INTEGER || max_us > MAX_SAFE_INTEGER {
                return error("query bounds must be ordered safe integer microseconds".into());
            }
            let snapshot = state.chunks.lock().unwrap().query_range(min_us, max_us);
            (
                ServerMessage::QueryResponse {
                    chunk_count: snapshot.frames.len(),
                    min_us,
                    max_us,
                    total_rows: snapshot.total_rows,
                },
                snapshot.frames,
            )
        }
    }
}

async fn handle_client_message<S: Sink<Message> + Unpin>(
    text: &str,
    state: &AppState,
    sender: &mut S,
) -> Result<(), S::Error> {
    let (header, frames) = response(text, state);
    sender
        .send(Message::Text(
            serde_json::to_string(&header).unwrap().into(),
        ))
        .await?;
    for frame in frames {
        sender
            .send(Message::Binary(frame.as_ref().clone().into()))
            .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        pin::Pin,
        task::{Context, Poll},
    };

    fn state() -> AppState {
        AppState {
            chunks: Arc::new(Mutex::new(
                ChunkManager::new(ChunkConfig {
                    chunk_interval_us: 10,
                    max_chunks: 2,
                    max_rows: 100,
                })
                .unwrap(),
            )),
            live: broadcast::channel(2).0,
        }
    }

    #[test]
    fn source_archives_without_clients_and_fans_out_the_same_objects_once() {
        let state = state();
        let mut generator = MockGenerator::seeded(3);
        ingest_tick(&state, &mut generator, 0.1, 100);
        ingest_tick(&state, &mut generator, 0.1, 110);
        assert_eq!(state.chunks.lock().unwrap().meta().total_rows, 3);
        let mut a = state.live.subscribe();
        let mut b = state.live.subscribe();
        ingest_tick(&state, &mut generator, 0.1, 120);
        assert!(Arc::ptr_eq(&a.try_recv().unwrap(), &b.try_recv().unwrap()));
        assert_eq!(state.chunks.lock().unwrap().meta().total_rows, 6);
        drop(a);
        drop(b);
        ingest_tick(&state, &mut generator, 0.1, 130);
        assert_eq!(state.chunks.lock().unwrap().meta().total_rows, 6); // retention, not client count
    }

    #[tokio::test(start_paused = true)]
    async fn startup_task_ingests_with_no_sockets_or_subscribers() {
        use std::sync::atomic::{AtomicI64, Ordering};
        static TIME: AtomicI64 = AtomicI64::new(100);
        fn clock() -> i64 {
            TIME.fetch_add(10, Ordering::SeqCst)
        }
        let state = state();
        let task = tokio::spawn(run_ingest(
            state.clone(),
            AppConfig {
                num_objects: 3,
                tick_rate_hz: 1.0,
            },
            Duration::from_secs(1),
            clock,
        ));
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
        let meta = state.chunks.lock().unwrap().meta();
        assert_eq!((meta.total_rows, meta.min_us, meta.max_us), (3, 100, 100));
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
    }

    #[test]
    fn lag_is_explicit_and_bounded() {
        let state = state();
        let mut slow = state.live.subscribe();
        let mut generator = MockGenerator::seeded(1);
        for time in 100..105 {
            ingest_tick(&state, &mut generator, 0.1, time);
        }
        assert!(matches!(
            slow.try_recv(),
            Err(broadcast::error::TryRecvError::Lagged(3))
        ));
    }

    struct CheckedSink {
        state: AppState,
        messages: Vec<Message>,
    }
    impl Sink<Message> for CheckedSink {
        type Error = ();
        fn poll_ready(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), ()>> {
            assert!(
                self.state.chunks.try_lock().is_ok(),
                "archive locked during network await"
            );
            Poll::Ready(Ok(()))
        }
        fn start_send(mut self: Pin<&mut Self>, message: Message) -> Result<(), ()> {
            self.messages.push(message);
            Ok(())
        }
        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), ()>> {
            Poll::Ready(Ok(()))
        }
        fn poll_close(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), ()>> {
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn header_counts_actual_rows_and_all_sends_release_lock() {
        let state = state();
        let mut generator = MockGenerator::seeded(3);
        for time in [100, 105, 110] {
            ingest_tick(&state, &mut generator, 0.1, time);
        }
        let mut sink = CheckedSink {
            state: state.clone(),
            messages: Vec::new(),
        };
        handle_client_message(
            r#"{"type":"query","min_us":100,"max_us":105}"#,
            &state,
            &mut sink,
        )
        .await
        .unwrap();
        assert_eq!(sink.messages.len(), 2);
        let Message::Text(header) = &sink.messages[0] else {
            panic!("expected header")
        };
        let header: serde_json::Value = serde_json::from_str(header).unwrap();
        assert_eq!(header["total_rows"], 6);
        assert_eq!(header["chunk_count"], 1);
        assert!(matches!(sink.messages[1], Message::Binary(_)));
        handle_client_message(r#"{"type":"meta"}"#, &state, &mut sink)
            .await
            .unwrap();
    }

    #[test]
    fn query_validation_and_empty_response() {
        let state = state();
        for text in [
            "oops",
            r#"{"type":"query","min_us":2,"max_us":1}"#,
            r#"{"type":"query","min_us":0.1,"max_us":1}"#,
            r#"{"type":"query","min_us":0,"max_us":9007199254740992}"#,
        ] {
            assert!(matches!(
                response(text, &state).0,
                ServerMessage::Error { .. }
            ));
        }
        assert!(matches!(
            response(r#"{"type":"query","min_us":0,"max_us":1}"#, &state).0,
            ServerMessage::QueryResponse {
                chunk_count: 0,
                total_rows: 0,
                ..
            }
        ));
    }

    #[test]
    fn invalid_tick_settings_do_not_panic() {
        for hz in [
            0.0,
            -1.0,
            f64::NAN,
            f64::INFINITY,
            f64::MAX,
            f64::MIN_POSITIVE,
        ] {
            assert!(
                AppConfig {
                    num_objects: 1,
                    tick_rate_hz: hz
                }
                .interval(100)
                .is_err()
            );
        }
        assert!(
            AppConfig {
                num_objects: 0,
                tick_rate_hz: 1.0
            }
            .interval(100)
            .is_err()
        );
        assert!(
            AppConfig {
                num_objects: 101,
                tick_rate_hz: 1.0
            }
            .interval(100)
            .is_err()
        );
        assert_eq!(
            AppConfig {
                num_objects: 1,
                tick_rate_hz: 10.0
            }
            .interval(100)
            .unwrap(),
            Duration::from_millis(100)
        );
    }
}
