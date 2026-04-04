// ---------------------------------------------------------------------------
// Pelorus — Arrow IPC decoder
// ---------------------------------------------------------------------------
//
// Decodes Arrow IPC stream messages into typed arrays for the position
// buffer and deck.gl rendering pipeline.
// ---------------------------------------------------------------------------

import { tableFromIPC, Table } from "apache-arrow";

export interface BatchStats {
  rowCount: number;
  byteSize: number;
  decodeTimeMs: number;
}

export interface DecodedBatch {
  table: Table;
  stats: BatchStats;
  timestamps: BigInt64Array;
  longitudes: Float64Array;
  latitudes: Float64Array;
  altitudes: Float64Array;
  speeds: Float64Array;
  headings: Float64Array;
  categories: (string | null)[];
  objectIds: string[];
}

/** Decode an Arrow IPC binary message from the WebSocket */
export function decodeBatch(buffer: ArrayBuffer): DecodedBatch {
  const t0 = performance.now();

  const table = tableFromIPC(new Uint8Array(buffer));
  const rowCount = table.numRows;

  const timestamps = table.getChild("timestamp_us")!.toArray() as BigInt64Array;
  const longitudes = table.getChild("longitude")!.toArray() as Float64Array;
  const latitudes = table.getChild("latitude")!.toArray() as Float64Array;

  // Nullable columns — extract with fallback
  const altCol = table.getChild("altitude_m");
  const spdCol = table.getChild("speed_mps");
  const hdgCol = table.getChild("heading_deg");
  const catCol = table.getChild("category");
  const idCol = table.getChild("object_id");

  const altitudes = altCol ? altCol.toArray() as Float64Array : new Float64Array(rowCount);
  const speeds = spdCol ? spdCol.toArray() as Float64Array : new Float64Array(rowCount);
  const headings = hdgCol ? hdgCol.toArray() as Float64Array : new Float64Array(rowCount);

  // String columns — must iterate
  const categories: (string | null)[] = new Array(rowCount);
  const objectIds: string[] = new Array(rowCount);

  for (let i = 0; i < rowCount; i++) {
    categories[i] = catCol ? catCol.get(i) : null;
    objectIds[i] = idCol ? idCol.get(i) ?? `UNK-${i}` : `UNK-${i}`;
  }

  const decodeTimeMs = performance.now() - t0;

  return {
    table,
    stats: { rowCount, byteSize: buffer.byteLength, decodeTimeMs },
    timestamps,
    longitudes,
    latitudes,
    altitudes,
    speeds,
    headings,
    categories,
    objectIds,
  };
}
