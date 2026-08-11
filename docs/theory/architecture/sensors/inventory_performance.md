# Sensor: `inventory_performance` → F4×T7

## Property semantics

**T7 Performance and Efficiency** (Constitution Article 5) for F4 (Inventory): "how long do inventory walks take?" Concretely: the per-kind execution time of inventory readings, aggregated from persisted SensorReading `duration_ms` fields.

## Operational definition

Walks `record/proofs/sensor-readings/inventory_*/` (the canonical 21.E + 23.G persistence path); for each persisted SR, reads `duration_ms`. Aggregates per kind:

- `count` per kind
- `mean_ms` per kind
- `p95_ms` per kind

Overall:

- `overall_p95_ms` — 95th percentile across all observations.
- `kinds_observed` — count of distinct inventory_* kinds with ≥ 1 reading.

## PASS / REVIEW / FAIL boundaries

- **PASS:** `overall_p95_ms < 2000` (most inventory walks complete in under 2s).
- **REVIEW:** `2000 ≤ overall_p95_ms < 5000`.
- **FAIL:** `overall_p95_ms ≥ 5000`.

If no inventory SRs exist (adopter hasn't run sense-inventory-* yet): `status='review'` with `INVENTORY_PERFORMANCE_NO_READINGS`.

## Adopter overrides

- `extractor_params.inventory_performance.thresholds: {pass:number, review:number}` — override the p95 boundaries in milliseconds.
- `extractor_params.inventory_performance.readings_dir: string` — override the readings directory. Default `record/proofs/sensor-readings`.

## Out of scope

- **Per-sensor wall-clock budgets.** Per-kind p95 is exposed in `metrics` but doesn't drive PASS/REVIEW/FAIL on its own; only the overall p95 does.
- **Memory/CPU profiling.** Wall-clock only.
- **Trend analysis over time.** Single-snapshot only.
