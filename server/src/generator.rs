// ---------------------------------------------------------------------------
// Pelorus — Mock data generator
// ---------------------------------------------------------------------------
//
// Produces synthetic moving objects with smooth random-walk trajectories.
// Each tick advances all objects by one timestep, applies velocity +
// heading perturbation, and builds an Arrow RecordBatch.
// ---------------------------------------------------------------------------

use arrow::array::{Float64Builder, Int64Builder, StringBuilder};
use arrow::record_batch::RecordBatch;
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::schema::pelorus_schema_ref;

const CATEGORIES: &[&str] = &["alpha", "bravo", "charlie", "delta"];

/// State for a single tracked object
#[derive(Debug, Clone)]
struct TrackedObject {
    id: String,
    lon: f64,
    lat: f64,
    alt: f64,
    speed: f64,       // m/s
    heading: f64,     // degrees
    category: String,
}

impl TrackedObject {
    fn new(id: String, rng: &mut impl Rng) -> Self {
        let category = CATEGORIES[rng.gen_range(0..CATEGORIES.len())].to_string();
        Self {
            id,
            lon: rng.gen_range(-180.0..180.0),
            lat: rng.gen_range(-70.0..70.0),
            alt: rng.gen_range(100.0..15000.0),
            speed: rng.gen_range(50.0..300.0),
            heading: rng.gen_range(0.0..360.0),
            category,
        }
    }

    /// Advance one tick (dt in seconds). Applies heading perturbation and
    /// moves the object along its heading at its current speed.
    fn tick(&mut self, dt: f64, rng: &mut impl Rng) {
        // Perturb heading slightly
        self.heading += rng.gen_range(-5.0..5.0);
        self.heading = self.heading.rem_euclid(360.0);

        // Perturb speed slightly
        self.speed += rng.gen_range(-2.0..2.0);
        self.speed = self.speed.clamp(20.0, 500.0);

        // Perturb altitude
        self.alt += rng.gen_range(-10.0..10.0);
        self.alt = self.alt.clamp(0.0, 20000.0);

        // Convert heading to radians and compute displacement
        let heading_rad = self.heading.to_radians();
        // Approximate: 1 degree lat ≈ 111,320 m, 1 degree lon ≈ 111,320 * cos(lat)
        let dist = self.speed * dt;
        let dlat = (heading_rad.cos() * dist) / 111_320.0;
        let dlon = (heading_rad.sin() * dist) / (111_320.0 * self.lat.to_radians().cos().max(0.01));

        self.lat += dlat;
        self.lon += dlon;

        // Wrap coordinates
        self.lat = self.lat.clamp(-85.0, 85.0);
        if self.lon > 180.0 { self.lon -= 360.0; }
        if self.lon < -180.0 { self.lon += 360.0; }
    }
}

/// Mock data generator that manages a fleet of tracked objects
pub struct MockGenerator {
    objects: Vec<TrackedObject>,
    rng: StdRng,
}

impl MockGenerator {
    /// Create a new generator with `n` synthetic objects
    pub fn new(n: usize) -> Self {
        let mut rng = StdRng::from_entropy();
        let objects = (0..n)
            .map(|i| TrackedObject::new(format!("OBJ-{i:04}"), &mut rng))
            .collect();
        Self { objects, rng }
    }

    /// Advance all objects by `dt` seconds and return a RecordBatch
    /// containing the current state of all objects.
    pub fn tick(&mut self, dt: f64) -> RecordBatch {
        let now_us = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_micros() as i64;

        let n = self.objects.len();
        let schema = pelorus_schema_ref();

        let mut ts_builder = Int64Builder::with_capacity(n);
        let mut id_builder = StringBuilder::with_capacity(n, n * 10);
        let mut lon_builder = Float64Builder::with_capacity(n);
        let mut lat_builder = Float64Builder::with_capacity(n);
        let mut alt_builder = Float64Builder::with_capacity(n);
        let mut spd_builder = Float64Builder::with_capacity(n);
        let mut hdg_builder = Float64Builder::with_capacity(n);
        let mut cat_builder = StringBuilder::with_capacity(n, n * 8);

        for obj in &mut self.objects {
            obj.tick(dt, &mut self.rng);

            ts_builder.append_value(now_us);
            id_builder.append_value(&obj.id);
            lon_builder.append_value(obj.lon);
            lat_builder.append_value(obj.lat);
            alt_builder.append_value(obj.alt);
            spd_builder.append_value(obj.speed);
            hdg_builder.append_value(obj.heading);
            cat_builder.append_value(&obj.category);
        }

        RecordBatch::try_new(
            schema,
            vec![
                Arc::new(ts_builder.finish()),
                Arc::new(id_builder.finish()),
                Arc::new(lon_builder.finish()),
                Arc::new(lat_builder.finish()),
                Arc::new(alt_builder.finish()),
                Arc::new(spd_builder.finish()),
                Arc::new(hdg_builder.finish()),
                Arc::new(cat_builder.finish()),
            ],
        )
        .expect("schema mismatch in mock generator")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generator_produces_valid_batches() {
        let mut generator = MockGenerator::new(50);
        let batch = generator.tick(1.0);
        assert_eq!(batch.num_rows(), 50);
        assert_eq!(batch.num_columns(), 8);
    }

    #[test]
    fn objects_move_between_ticks() {
        let mut generator = MockGenerator::new(1);
        let b1 = generator.tick(1.0);
        let b2 = generator.tick(1.0);

        let lon1 = b1.column(2).as_any().downcast_ref::<arrow::array::Float64Array>().unwrap().value(0);
        let lon2 = b2.column(2).as_any().downcast_ref::<arrow::array::Float64Array>().unwrap().value(0);
        assert_ne!(lon1, lon2);
    }
}
