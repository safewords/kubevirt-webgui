//! Usage history — the graphs on a Proxmox summary page.
//!
//! Samples come from `metrics.k8s.io` (metrics-server), fetched **with the
//! viewing user's credential**, so nobody sees usage for an object they could
//! not read. Recent samples are kept in memory, so opening a summary shows the
//! last hour at once instead of an empty chart that fills in slowly.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use serde::Serialize;

const KEEP: usize = 720; // an hour at five-second resolution

#[derive(Debug, Clone, Serialize)]
pub struct Sample {
    /// Milliseconds since the epoch.
    pub ts: i64,
    /// CPU in cores.
    pub cpu: f64,
    /// Memory in bytes.
    pub memory: f64,
}

#[derive(Default)]
pub struct MetricsStore {
    series: Mutex<HashMap<String, VecDeque<Sample>>>,
}

impl MetricsStore {
    /// Record a sample, skipping one that repeats the metrics-server window
    /// already stored.
    pub fn record(&self, key: &str, sample: Sample) {
        let mut series = self.series.lock().unwrap();
        let points = series.entry(key.to_string()).or_default();
        if points.back().is_some_and(|last| sample.ts - last.ts < 2_000) {
            return;
        }
        if points.len() >= KEEP {
            points.pop_front();
        }
        points.push_back(sample);
    }

    pub fn history(&self, key: &str) -> Vec<Sample> {
        self.series.lock().unwrap().get(key).map(|p| p.iter().cloned().collect()).unwrap_or_default()
    }
}

/// A Kubernetes quantity as a number: `250m` → 0.25, `1Gi` → 1073741824.
pub fn quantity(value: &str) -> f64 {
    let value = value.trim();
    if value.is_empty() {
        return 0.0;
    }
    const SUFFIXES: &[(&str, f64)] = &[
        ("Ki", 1024.0),
        ("Mi", 1024.0 * 1024.0),
        ("Gi", 1024.0 * 1024.0 * 1024.0),
        ("Ti", 1024.0 * 1024.0 * 1024.0 * 1024.0),
        ("Pi", 1024.0 * 1024.0 * 1024.0 * 1024.0 * 1024.0),
        ("Ei", 1024.0 * 1024.0 * 1024.0 * 1024.0 * 1024.0 * 1024.0),
        ("n", 1e-9),
        ("u", 1e-6),
        ("m", 1e-3),
        ("k", 1e3),
        ("M", 1e6),
        ("G", 1e9),
        ("T", 1e12),
        ("P", 1e15),
        ("E", 1e18),
    ];
    for (suffix, factor) in SUFFIXES {
        if let Some(number) = value.strip_suffix(suffix) {
            return number.parse::<f64>().unwrap_or(0.0) * factor;
        }
    }
    value.parse::<f64>().unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::quantity;

    #[test]
    fn parses_quantities() {
        assert_eq!(quantity("250m"), 0.25);
        assert_eq!(quantity("2"), 2.0);
        assert_eq!(quantity("1Gi"), 1073741824.0);
        assert_eq!(quantity("1500000000n"), 1.5);
        assert_eq!(quantity("128974848"), 128974848.0);
    }
}
