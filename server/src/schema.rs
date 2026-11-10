// ---------------------------------------------------------------------------
// Pelorus — Arrow schema definition
// ---------------------------------------------------------------------------
//
// Core schema for tracked object position records. Designed for flexibility:
// required fields are always present, optional fields are nullable and can
// be omitted by data sources that don't produce them.
//
// All timestamps are microseconds since Unix epoch (UTC).
// ---------------------------------------------------------------------------

use arrow::datatypes::{DataType, Field, Schema};
use std::sync::Arc;

/// Build the canonical Pelorus record schema.
///
/// Fields:
///   - timestamp_us  : Int64, NOT NULL  — microseconds since epoch
///   - object_id     : Utf8, NOT NULL   — unique object identifier
///   - longitude     : Float64, NOT NULL
///   - latitude      : Float64, NOT NULL
///   - altitude_m    : Float64, nullable — meters above reference
///   - speed_mps     : Float64, nullable — meters per second
///   - heading_deg   : Float64, nullable — degrees true north [0, 360)
///   - category      : Utf8, nullable    — arbitrary grouping label
pub fn pelorus_schema() -> Schema {
    Schema::new(vec![
        Field::new("timestamp_us", DataType::Int64, false),
        Field::new("object_id", DataType::Utf8, false),
        Field::new("longitude", DataType::Float64, false),
        Field::new("latitude", DataType::Float64, false),
        Field::new("altitude_m", DataType::Float64, true),
        Field::new("speed_mps", DataType::Float64, true),
        Field::new("heading_deg", DataType::Float64, true),
        Field::new("category", DataType::Utf8, true),
    ])
}

/// Arc-wrapped schema for shared use across threads
pub fn pelorus_schema_ref() -> Arc<Schema> {
    Arc::new(pelorus_schema())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_has_expected_fields() {
        let schema = pelorus_schema();
        assert_eq!(schema.fields().len(), 8);
        assert_eq!(schema.field(0).name(), "timestamp_us");
        assert!(!schema.field(0).is_nullable());
        assert_eq!(schema.field(4).name(), "altitude_m");
        assert!(schema.field(4).is_nullable());
    }
}
