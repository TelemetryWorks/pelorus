// ---------------------------------------------------------------------------
// Pelorus — Arrow IPC decoder
// ---------------------------------------------------------------------------
//
// Decodes Arrow IPC stream messages received over WebSocket into typed
// arrays suitable for direct GPU upload (Phase 3+) or display.
// ---------------------------------------------------------------------------

import { tableFromIPC, Table } from "apache-arrow";

/// Decoded position record matching the server schema
export interface PositionRecord {
  timestamp_us: bigint;
  object_id: string;
  longitude: number;
  latitude: number;
  altitude_m: number | null;
  speed_mps: number | null;
  heading_deg: number | null;
  category: string | null;
}

/// Summary stats for a decoded batch
export interface BatchStats {
  rowCount: number;
  byteSize: number;
  decodeTimeMs: number;
  timestampRange: [bigint, bigint] | null;
}

/// Decoded batch result
export interface DecodedBatch {
  table: Table;
  stats: BatchStats;
  /// Raw typed arrays for direct GPU upload in later phases
  longitudes: Float64Array;
  latitudes: Float64Array;
  timestamps: BigInt64Array;
}

/// Decode an Arrow IPC binary message from the WebSocket
export function decodeBatch(buffer: ArrayBuffer): DecodedBatch {
  const t0 = performance.now();

  const table = tableFromIPC(new Uint8Array(buffer));
  const rowCount = table.numRows;

  // Extract typed arrays — these are zero-copy views into the Arrow buffers
  const tsCol = table.getChild("timestamp_us")!;
  const lonCol = table.getChild("longitude")!;
  const latCol = table.getChild("latitude")!;

  const timestamps = tsCol.toArray() as BigInt64Array;
  const longitudes = lonCol.toArray() as Float64Array;
  const latitudes = latCol.toArray() as Float64Array;

  // Compute timestamp range
  let tsMin = timestamps[0];
  let tsMax = timestamps[0];
  for (let i = 1; i < timestamps.length; i++) {
    if (timestamps[i] < tsMin) tsMin = timestamps[i];
    if (timestamps[i] > tsMax) tsMax = timestamps[i];
  }

  const decodeTimeMs = performance.now() - t0;

  return {
    table,
    stats: {
      rowCount,
      byteSize: buffer.byteLength,
      decodeTimeMs,
      timestampRange: rowCount > 0 ? [tsMin, tsMax] : null,
    },
    longitudes,
    latitudes,
    timestamps,
  };
}

/// Extract a few sample records for display/debug
export function sampleRecords(table: Table, n: number = 5): PositionRecord[] {
  const records: PositionRecord[] = [];
  const count = Math.min(n, table.numRows);

  for (let i = 0; i < count; i++) {
    const row = table.get(i)!;
    records.push({
      timestamp_us: row.timestamp_us,
      object_id: row.object_id,
      longitude: row.longitude,
      latitude: row.latitude,
      altitude_m: row.altitude_m ?? null,
      speed_mps: row.speed_mps ?? null,
      heading_deg: row.heading_deg ?? null,
      category: row.category ?? null,
    });
  }

  return records;
}
