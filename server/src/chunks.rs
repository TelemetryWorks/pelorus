// ---------------------------------------------------------------------------
// Pelorus — Temporal chunk manager
// ---------------------------------------------------------------------------
//
// Partitions incoming RecordBatches into fixed-duration time chunks and
// maintains a ring buffer of chunks with configurable retention.
//
// Each chunk covers a fixed interval (e.g., 5 seconds). When a new batch
// arrives, it is appended to the current (open) chunk. When the chunk's
// time range exceeds the interval, it is sealed and a new chunk opens.
//
// Clients can query by time range to retrieve historical chunks for
// on-demand loading when scrubbing beyond the live window.
// ---------------------------------------------------------------------------

use arrow::array::Int64Array;
use arrow::compute::concat_batches;
use arrow::record_batch::RecordBatch;
use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::ipc::batch_to_ipc_bytes;
use crate::schema::pelorus_schema_ref;

/// A sealed chunk of position data covering a time interval.
#[derive(Debug, Clone)]
pub struct Chunk {
    /// Inclusive lower bound (microseconds since epoch)
    pub min_us: i64,
    /// Inclusive upper bound (microseconds since epoch)
    pub max_us: i64,
    /// Number of rows in this chunk
    pub row_count: usize,
    /// The concatenated RecordBatch for this chunk
    batch: RecordBatch,
    /// Pre-serialized IPC bytes (cached to avoid re-serializing on query)
    ipc_bytes: Arc<Vec<u8>>,
}

impl Chunk {
    /// Serialize to IPC bytes (returns cached copy)
    pub fn ipc_bytes(&self) -> Arc<Vec<u8>> {
        self.ipc_bytes.clone()
    }
}

/// Configuration for the chunk manager
#[derive(Debug, Clone)]
pub struct ChunkConfig {
    /// Duration of each chunk in microseconds
    pub chunk_interval_us: i64,
    /// Maximum number of sealed chunks to retain
    pub max_chunks: usize,
}

impl Default for ChunkConfig {
    fn default() -> Self {
        Self {
            chunk_interval_us: 5_000_000, // 5 seconds
            max_chunks: 720,               // 720 × 5s = 1 hour
        }
    }
}

/// Manages temporal chunking and retention of position data.
pub struct ChunkManager {
    config: ChunkConfig,
    /// Sealed chunks in chronological order
    sealed: VecDeque<Chunk>,
    /// Batches accumulating in the current open chunk
    open_batches: Vec<RecordBatch>,
    /// Time bounds of the open chunk
    open_min_us: Option<i64>,
    open_max_us: Option<i64>,
    /// Total rows across all sealed chunks
    total_sealed_rows: usize,
}

impl ChunkManager {
    pub fn new(config: ChunkConfig) -> Self {
        Self {
            config,
            sealed: VecDeque::new(),
            open_batches: Vec::new(),
            open_min_us: None,
            open_max_us: None,
            total_sealed_rows: 0,
        }
    }

    /// Ingest a new RecordBatch. May seal the current chunk if the
    /// time interval is exceeded.
    pub fn ingest(&mut self, batch: RecordBatch) {
        // Extract timestamp range from this batch
        let ts_col = batch
            .column(0)
            .as_any()
            .downcast_ref::<Int64Array>()
            .expect("column 0 must be Int64 (timestamp_us)");

        let batch_min = ts_col.value(0);
        let batch_max = ts_col.value(ts_col.len() - 1);

        // Determine the chunk boundary for this batch
        let chunk_start = self.open_min_us.unwrap_or(batch_min);

        // If this batch crosses the chunk boundary, seal and start new
        if batch_max - chunk_start >= self.config.chunk_interval_us {
            self.seal_open_chunk();
        }

        // Update open chunk bounds
        match self.open_min_us {
            None => {
                self.open_min_us = Some(batch_min);
                self.open_max_us = Some(batch_max);
            }
            Some(_) => {
                self.open_max_us = Some(batch_max);
            }
        }

        self.open_batches.push(batch);
    }

    /// Seal the current open chunk (concatenate batches, serialize, store).
    fn seal_open_chunk(&mut self) {
        if self.open_batches.is_empty() {
            return;
        }

        let schema = pelorus_schema_ref();
        let combined = concat_batches(&schema, &self.open_batches)
            .expect("failed to concatenate chunk batches");

        let min_us = self.open_min_us.unwrap();
        let max_us = self.open_max_us.unwrap();
        let row_count = combined.num_rows();
        let ipc_bytes = Arc::new(batch_to_ipc_bytes(&combined));

        let chunk = Chunk {
            min_us,
            max_us,
            row_count,
            batch: combined,
            ipc_bytes,
        };

        self.sealed.push_back(chunk);
        self.total_sealed_rows += row_count;

        // Evict oldest chunks if over retention limit
        while self.sealed.len() > self.config.max_chunks {
            if let Some(evicted) = self.sealed.pop_front() {
                self.total_sealed_rows -= evicted.row_count;
            }
        }

        // Reset open state
        self.open_batches.clear();
        self.open_min_us = None;
        self.open_max_us = None;
    }

    /// Query chunks that overlap with the given time range.
    /// Returns IPC bytes for each matching chunk.
    pub fn query_range(&self, min_us: i64, max_us: i64) -> Vec<Arc<Vec<u8>>> {
        self.sealed
            .iter()
            .filter(|c| c.max_us >= min_us && c.min_us <= max_us)
            .map(|c| c.ipc_bytes())
            .collect()
    }

    /// Get metadata about the chunk store.
    pub fn meta(&self) -> ChunkMeta {
        let (min_us, max_us) = if let (Some(first), Some(last)) =
            (self.sealed.front(), self.sealed.back())
        {
            (first.min_us, last.max_us)
        } else {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_micros() as i64;
            (now, now)
        };

        ChunkMeta {
            chunk_count: self.sealed.len(),
            total_rows: self.total_sealed_rows,
            min_us,
            max_us,
            chunk_interval_us: self.config.chunk_interval_us,
            open_batches: self.open_batches.len(),
        }
    }

    /// Number of sealed chunks
    pub fn len(&self) -> usize {
        self.sealed.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sealed.is_empty()
    }
}

/// Metadata about the chunk store, serializable for the client.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ChunkMeta {
    pub chunk_count: usize,
    pub total_rows: usize,
    pub min_us: i64,
    pub max_us: i64,
    pub chunk_interval_us: i64,
    pub open_batches: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generator::MockGenerator;

    #[test]
    fn chunks_are_created_and_sealed() {
        let config = ChunkConfig {
            chunk_interval_us: 1_000_000, // 1 second chunks for testing
            max_chunks: 10,
        };
        let mut mgr = ChunkManager::new(config);
        let mut generator = MockGenerator::new(10);

        // Ingest several batches
        for _ in 0..20 {
            let batch = generator.tick(0.1);
            mgr.ingest(batch);
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        // Should have at least 1 sealed chunk after 2 seconds
        assert!(mgr.len() >= 1, "expected sealed chunks, got {}", mgr.len());

        let meta = mgr.meta();
        assert!(meta.total_rows > 0);
    }

    #[test]
    fn query_range_returns_matching_chunks() {
        let config = ChunkConfig {
            chunk_interval_us: 500_000, // 0.5 second chunks
            max_chunks: 100,
        };
        let mut mgr = ChunkManager::new(config);
        let mut generator = MockGenerator::new(5);

        // Generate data over ~2 seconds
        for _ in 0..20 {
            let batch = generator.tick(0.1);
            mgr.ingest(batch);
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        let meta = mgr.meta();
        // Query the full range — should get all chunks
        let all = mgr.query_range(meta.min_us, meta.max_us);
        assert_eq!(all.len(), mgr.len());

        // Query with impossibly old range — should get nothing
        let none = mgr.query_range(0, 1000);
        assert!(none.is_empty());
    }

    #[test]
    fn old_chunks_are_evicted() {
        let config = ChunkConfig {
            chunk_interval_us: 100_000, // 100ms chunks
            max_chunks: 3,
        };
        let mut mgr = ChunkManager::new(config);
        let mut generator = MockGenerator::new(5);

        for _ in 0..50 {
            let batch = generator.tick(0.05);
            mgr.ingest(batch);
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        assert!(mgr.len() <= 3, "expected max 3 chunks, got {}", mgr.len());
    }
}
