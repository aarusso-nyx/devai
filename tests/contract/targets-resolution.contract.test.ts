// ADR-SCR-0004 IA-003 (framework contract): every performance and robustness target
// names a sensor kind registered in law/policy/sensor-registry.json and a metric that
// sensor actually emits, compared against a numeric threshold, and binds invariants that
// exist as records.
//
// The target files are read live: a target naming an unregistered kind, a retired
// sensor, or a metric its emitter never produces fails here rather than reading as a
// silent pass in spec_performance_targets or spec_robustness_targets.
//
// How "a metric the sensor emits" is decided (no sensor is executed; several shell out
// to gh or pnpm):
//   - metric_source `metrics`: the registry entry's `emitter_module` source contains the
//     metric as an object key (`<metric>:`) and builds a `metrics` object.
//   - metric_source `reading`: the metric is a numeric top-level property of
//     law/schemas/sensor-reading.schema.json AND the emitter module sets it (`<metric>:`).
//
// Interface assumptions (records merged by TASK-0231, sensors aligned by TASK-0233):
//   - law/targets/performance.json has kind `performance`, law/targets/robustness.json
//     has kind `robustness`; each `targets[]` item carries id, sensor_kind, metric,
//     metric_source, comparator (lte|gte|eq), threshold (number), unit, invariants[],
//     and source { doc, anchor } per law/schemas/targets.schema.json.
//   - Registry entries are `entries[]` with `kind`, `status`, and `emitter_module`.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

interface Target {
  readonly id: string;
  readonly sensor_kind: string;
  readonly metric: string;
  readonly metric_source: 'metrics' | 'reading';
  readonly comparator: string;
  readonly threshold: unknown;
  readonly unit: string;
  readonly invariants: readonly string[];
  readonly source: { readonly doc: string; readonly anchor: string };
}

interface TargetsFile {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly targets: readonly Target[];
}

interface RegistryEntry {
  readonly kind: string;
  readonly status: string;
  readonly emitter_module: string;
}

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8')) as T;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TARGET_FILES = ['law/targets/performance.json', 'law/targets/robustness.json'] as const;
const files = TARGET_FILES.map((rel) => ({ rel, record: readJson<TargetsFile>(rel) }));
const targets = files.flatMap(({ rel, record }) =>
  record.targets.map((target) => ({ file: rel, kind: record.kind, target })),
);
const registry = readJson<{ entries: readonly RegistryEntry[] }>('law/policy/sensor-registry.json');
const registryByKind = new Map(registry.entries.map((entry) => [entry.kind, entry]));
const readingSchema = readJson<{
  properties: Readonly<Record<string, { type?: unknown }>>;
}>('law/schemas/sensor-reading.schema.json');
const invariantIds = new Set(
  readdirSync(join(REPO_ROOT, 'law/invariants'))
    .filter((file) => file.endsWith('.json'))
    .map((file) => readJson<{ id: string }>(`law/invariants/${file}`).id),
);

describe('ADR-SCR-0004 IA-003: every target resolves to a registered sensor metric', () => {
  it('reads both target files with the kind their path declares and at least one target', () => {
    expect(files.map(({ record }) => record.kind)).toEqual(['performance', 'robustness']);
    for (const { rel, record } of files) {
      expect(record.status, rel).toBe('active');
      expect(record.targets.length, rel).toBeGreaterThan(0);
    }
    const ids = targets.map(({ target }) => target.id);
    expect(new Set(ids).size, 'target ids are unique across both files').toBe(ids.length);
  });

  it.each(targets.map(({ file, target }) => [target.id, target.sensor_kind, file, target]))(
    '%s names registered active sensor kind %s',
    (_id, kind) => {
      const entry = registryByKind.get(kind as string);
      expect(entry, `${String(kind)} is not in law/policy/sensor-registry.json`).toBeDefined();
      expect(entry?.status).toBe('active');
      expect(existsSync(join(REPO_ROOT, entry?.emitter_module ?? '<none>'))).toBe(true);
    },
  );

  it.each(targets.map(({ target }) => [target.id, target.metric, target.metric_source, target]))(
    '%s names metric %s (%s) that its sensor emits',
    (_id, metric, metricSource, target) => {
      const t = target as Target;
      const entry = registryByKind.get(t.sensor_kind);
      expect(entry, t.sensor_kind).toBeDefined();
      const source = readFileSync(join(REPO_ROOT, entry?.emitter_module ?? ''), 'utf8');
      const keyRe = new RegExp(`(?<![\\w.$])${escapeRe(metric as string)}\\s*:`);
      expect(
        keyRe.test(source),
        `${entry?.emitter_module ?? ''} never sets ${String(metric)}`,
      ).toBe(true);
      if (metricSource === 'metrics') {
        expect(/\bmetrics\s*[:,}]/.test(source), 'emitter builds a metrics object').toBe(true);
      } else {
        expect(metricSource).toBe('reading');
        const property = readingSchema.properties[metric as string];
        expect(property, `${String(metric)} is not a SensorReading property`).toBeDefined();
        const type = property?.type;
        const types = Array.isArray(type) ? type : [type];
        expect(types.some((ty) => ty === 'number' || ty === 'integer')).toBe(true);
      }
    },
  );

  it.each(targets.map(({ target }) => [target.id, target]))(
    '%s carries a numeric threshold, a known comparator, and existing invariants and source',
    (_id, target) => {
      const t = target as Target;
      expect(typeof t.threshold === 'number' && Number.isFinite(t.threshold)).toBe(true);
      expect(['lte', 'gte', 'eq']).toContain(t.comparator);
      expect(['ms', 'percent', 'count', 'boolean']).toContain(t.unit);
      if (t.unit === 'percent') {
        expect(t.threshold as number).toBeGreaterThanOrEqual(0);
        expect(t.threshold as number).toBeLessThanOrEqual(100);
      }
      if (t.unit === 'boolean') expect([0, 1]).toContain(t.threshold);
      expect(t.invariants.length).toBeGreaterThan(0);
      for (const id of t.invariants) expect(invariantIds.has(id), `${t.id} -> ${id}`).toBe(true);
      expect(existsSync(join(REPO_ROOT, t.source.doc)), t.source.doc).toBe(true);
    },
  );

  it('the performance invariant is bound by at least one performance target', () => {
    const perf = targets.filter(({ kind }) => kind === 'performance');
    expect(perf.some(({ target }) => target.invariants.includes('INV-PERF-001'))).toBe(true);
  });
});
