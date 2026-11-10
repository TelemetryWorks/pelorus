//! In-memory archive of sealed time chunks. Queries return whole overlapping
//! chunks (inclusive bounds), never the open chunk. Retention also has a row cap.
use arrow::array::Int64Array;
use arrow::compute::concat_batches;
use arrow::record_batch::RecordBatch;
use std::collections::VecDeque;
use std::sync::Arc;

use crate::ipc::batch_to_ipc_bytes;
use crate::schema::pelorus_schema_ref;

struct Chunk {
    min_us: i64,
    max_us: i64,
    row_count: usize,
    ipc_bytes: Arc<Vec<u8>>,
}

#[derive(Debug, Clone)]
pub struct ChunkConfig {
    pub chunk_interval_us: i64,
    pub max_chunks: usize,
    /// Includes both sealed and open rows; not a byte-memory guarantee.
    pub max_rows: usize,
}

impl Default for ChunkConfig {
    fn default() -> Self {
        Self {
            chunk_interval_us: 5_000_000,
            max_chunks: 720,
            max_rows: 1_200_000,
        }
    }
}

pub struct QuerySnapshot {
    pub frames: Vec<Arc<Vec<u8>>>,
    pub total_rows: usize,
}

pub struct ChunkManager {
    config: ChunkConfig,
    sealed: VecDeque<Chunk>,
    open_batches: Vec<RecordBatch>,
    open_min_us: Option<i64>,
    open_max_us: i64,
    open_rows: usize,
    sealed_rows: usize,
}

impl ChunkManager {
    pub fn new(config: ChunkConfig) -> Result<Self, String> {
        if config.chunk_interval_us <= 0 || config.max_chunks == 0 || config.max_rows == 0 {
            return Err("chunk interval, max chunks and max rows must be positive".into());
        }
        Ok(Self {
            config,
            sealed: VecDeque::new(),
            open_batches: Vec::new(),
            open_min_us: None,
            open_max_us: 0,
            open_rows: 0,
            sealed_rows: 0,
        })
    }

    pub fn ingest(&mut self, batch: RecordBatch) {
        if batch.num_rows() == 0 {
            return;
        }
        let batch = if batch.num_rows() > self.config.max_rows {
            batch.slice(
                batch.num_rows() - self.config.max_rows,
                self.config.max_rows,
            )
        } else {
            batch
        };
        let ts = batch
            .column(0)
            .as_any()
            .downcast_ref::<Int64Array>()
            .expect("canonical timestamp column");
        let min = ts.values().iter().copied().min().unwrap();
        let max = ts.values().iter().copied().max().unwrap();
        if self
            .open_min_us
            .is_some_and(|start| max.saturating_sub(start) >= self.config.chunk_interval_us)
            || self.open_rows + batch.num_rows() > self.config.max_rows
        {
            self.seal();
        }
        self.open_min_us = Some(self.open_min_us.map_or(min, |start| start.min(min)));
        self.open_max_us = if self.open_rows == 0 {
            max
        } else {
            self.open_max_us.max(max)
        };
        self.open_rows += batch.num_rows();
        self.open_batches.push(batch);
        self.evict();
    }

    fn seal(&mut self) {
        if self.open_rows == 0 {
            return;
        }
        let batch =
            concat_batches(&pelorus_schema_ref(), &self.open_batches).expect("canonical batches");
        self.sealed.push_back(Chunk {
            min_us: self.open_min_us.take().unwrap(),
            max_us: self.open_max_us,
            row_count: self.open_rows,
            ipc_bytes: Arc::new(batch_to_ipc_bytes(&batch)),
        });
        self.sealed_rows += self.open_rows;
        self.open_rows = 0;
        self.open_batches.clear();
        self.evict();
    }

    fn evict(&mut self) {
        while self.sealed.len() > self.config.max_chunks
            || self.sealed_rows + self.open_rows > self.config.max_rows
        {
            let old = self.sealed.pop_front().expect("open rows fit the row cap");
            self.sealed_rows -= old.row_count;
        }
    }

    pub fn query_range(&self, min_us: i64, max_us: i64) -> QuerySnapshot {
        let mut result = QuerySnapshot {
            frames: Vec::new(),
            total_rows: 0,
        };
        if min_us > max_us {
            return result;
        }
        for chunk in &self.sealed {
            if chunk.max_us >= min_us && chunk.min_us <= max_us {
                result.frames.push(chunk.ipc_bytes.clone());
                result.total_rows += chunk.row_count;
            }
        }
        result
    }

    pub fn meta(&self) -> ChunkMeta {
        ChunkMeta {
            chunk_count: self.sealed.len(),
            total_rows: self.sealed_rows,
            min_us: self.sealed.iter().map(|c| c.min_us).min().unwrap_or(0),
            max_us: self.sealed.iter().map(|c| c.max_us).max().unwrap_or(0),
            chunk_interval_us: self.config.chunk_interval_us,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ChunkMeta {
    pub chunk_count: usize,
    pub total_rows: usize,
    pub min_us: i64,
    pub max_us: i64,
    pub chunk_interval_us: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generator::MockGenerator;
    use arrow::ipc::reader::StreamReader;
    use std::io::Cursor;

    fn batch_at(timestamp: i64, rows: usize) -> RecordBatch {
        MockGenerator::seeded(rows).tick_at(0.1, timestamp)
    }

    #[test]
    fn deterministic_sealing_query_counts_and_eviction() {
        let mut mgr = ChunkManager::new(ChunkConfig {
            chunk_interval_us: 10,
            max_chunks: 2,
            max_rows: 100,
        })
        .unwrap();
        for time in [100, 105, 110, 120, 130] {
            mgr.ingest(batch_at(time, 3));
        }
        let meta = mgr.meta();
        assert_eq!(
            (meta.chunk_count, meta.total_rows, meta.min_us, meta.max_us),
            (2, 6, 110, 120)
        );
        let snapshot = mgr.query_range(110, 120);
        assert_eq!(snapshot.frames.len(), 2);
        let actual: usize = snapshot
            .frames
            .iter()
            .map(|frame| {
                StreamReader::try_new(Cursor::new(frame.as_slice()), None)
                    .unwrap()
                    .map(|batch| batch.unwrap().num_rows())
                    .sum::<usize>()
            })
            .sum();
        assert_eq!(snapshot.total_rows, actual);
        assert_eq!(actual, 6); // rows, not the two chunks
        assert_eq!(mgr.query_range(110, 110).frames.len(), 1);
        assert!(mgr.query_range(0, 99).frames.is_empty());
    }

    #[test]
    fn reversed_query_is_empty() {
        let mut mgr = ChunkManager::new(ChunkConfig {
            chunk_interval_us: 10,
            ..ChunkConfig::default()
        })
        .unwrap();
        for time in [100, 105, 110] {
            mgr.ingest(batch_at(time, 3));
        }
        assert!(mgr.query_range(104, 101).frames.is_empty());
    }

    #[test]
    fn empty_archive_and_empty_batch_have_zero_bounds() {
        let mut mgr = ChunkManager::new(ChunkConfig::default()).unwrap();
        mgr.ingest(batch_at(100, 0));
        assert_eq!(
            (mgr.meta().total_rows, mgr.meta().min_us, mgr.meta().max_us),
            (0, 0, 0)
        );
    }

    #[test]
    fn invalid_settings_are_rejected() {
        for config in [
            ChunkConfig {
                chunk_interval_us: 0,
                ..ChunkConfig::default()
            },
            ChunkConfig {
                chunk_interval_us: -1,
                ..ChunkConfig::default()
            },
            ChunkConfig {
                max_chunks: 0,
                ..ChunkConfig::default()
            },
            ChunkConfig {
                max_rows: 0,
                ..ChunkConfig::default()
            },
        ] {
            assert!(ChunkManager::new(config).is_err());
        }
    }

    #[test]
    fn row_cap_includes_open_rows_even_when_clock_does_not_advance() {
        let mut mgr = ChunkManager::new(ChunkConfig {
            max_rows: 7,
            ..ChunkConfig::default()
        })
        .unwrap();
        for _ in 0..20 {
            mgr.ingest(batch_at(100, 3));
            assert!(mgr.sealed_rows + mgr.open_rows <= 7);
        }
        mgr.ingest(batch_at(101, 20));
        assert_eq!(mgr.open_rows, 7);
        assert_eq!(mgr.sealed_rows, 0);
    }
}
