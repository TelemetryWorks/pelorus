// ---------------------------------------------------------------------------
// Pelorus — Arrow IPC serialization
// ---------------------------------------------------------------------------
//
// Serializes RecordBatches to Arrow IPC stream format for WebSocket transport.
// Uses the streaming format (not file format) so the client can decode each
// message independently without needing the full file footer.
// ---------------------------------------------------------------------------

use arrow::ipc::writer::StreamWriter;
use arrow::record_batch::RecordBatch;

/// Serialize a single RecordBatch to Arrow IPC stream bytes.
///
/// The output contains: schema message + record batch message + footer.
/// The `apache-arrow` JS library can decode this directly.
pub fn batch_to_ipc_bytes(batch: &RecordBatch) -> Vec<u8> {
    let mut buf = Vec::with_capacity(batch.get_array_memory_size() + 1024);
    {
        let mut writer = StreamWriter::try_new(&mut buf, &batch.schema())
            .expect("failed to create IPC stream writer");
        writer.write(batch).expect("failed to write batch to IPC");
        writer.finish().expect("failed to finish IPC stream");
    }
    buf
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generator::MockGenerator;
    use arrow::ipc::reader::StreamReader;
    use std::io::Cursor;

    #[test]
    fn roundtrip_ipc() {
        let mut generator = MockGenerator::new(10);
        let batch = generator.tick(1.0);
        let bytes = batch_to_ipc_bytes(&batch);

        // Verify we can read it back
        let cursor = Cursor::new(bytes);
        let mut reader = StreamReader::try_new(cursor, None).unwrap();
        let decoded = reader.next().unwrap().unwrap();
        assert_eq!(decoded.num_rows(), 10);
        assert_eq!(decoded.num_columns(), 8);
    }
}
