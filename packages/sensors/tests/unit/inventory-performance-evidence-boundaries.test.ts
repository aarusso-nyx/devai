import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseInventoryPerformance } from '../../src/inventory-performance.js';

let root: string;
const now = '2026-09-08T12:00:00Z';
const defaults = 'record/proofs/sensor-readings';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-inventory-timing-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
function raw(path: string, content: string) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
function reading(path: string, value: unknown) {
  raw(path, JSON.stringify(value));
}
const observe = () => senseInventoryPerformance({ repoRoot: root, now });

describe('inventory performance uses valid observations and exact percentile boundaries', () => {
  it.each([1999, 2000, 4999, 5000])(
    'classifies an observed duration of %i milliseconds',
    (duration) => {
      reading(`${defaults}/inventory_api/a.json`, {
        sensor: { kind: 'inventory_api' },
        duration_ms: duration,
      });
      const result = observe();
      expect(result.status).toBe(duration < 2000 ? 'pass' : duration < 5000 ? 'review' : 'fail');
      expect(result.metrics).toEqual({
        kinds_observed: 1,
        total_observations: 1,
        overall_p95_ms: duration,
        overall_mean_ms: duration,
        threshold_pass: 2000,
        threshold_review: 5000,
        inventory_api_count: 1,
        inventory_api_p95_ms: duration,
        inventory_api_mean_ms: duration,
      });
      expect(result.findings?.map((f) => [f.code, f.severity])).toEqual(
        duration < 2000
          ? []
          : duration < 5000
            ? [['INVENTORY_PERFORMANCE_SLOW', 'warning']]
            : [['INVENTORY_PERFORMANCE_TOO_SLOW', 'error']],
      );
    },
  );

  it('uses nearest rank and a sample-weighted mean across unequal kind populations', () => {
    for (let i = 1; i <= 20; i++) reading(`${defaults}/inventory_z/z${i}.json`, { duration_ms: i });
    reading(`${defaults}/inventory_a/a.json`, { duration_ms: 10000 });
    const result = observe();
    expect(result.status).toBe('pass');
    expect(result.metrics).toMatchObject({
      kinds_observed: 2,
      total_observations: 21,
      overall_p95_ms: 20,
      overall_mean_ms: 486,
      inventory_z_count: 20,
      inventory_z_p95_ms: 19,
      inventory_z_mean_ms: 11,
      inventory_a_p95_ms: 10000,
    });
    expect(Object.keys(result.metrics ?? {}).filter((k) => k.startsWith('inventory_'))).toEqual([
      'inventory_a_count',
      'inventory_a_p95_ms',
      'inventory_a_mean_ms',
      'inventory_z_count',
      'inventory_z_p95_ms',
      'inventory_z_mean_ms',
    ]);
  });

  it.each(['missing', 'file', 'empty'])(
    'reports unavailable observations for a %s readings directory',
    (mode) => {
      if (mode === 'file') raw(defaults, 'not a directory');
      if (mode === 'empty') mkdirSync(join(root, defaults), { recursive: true });
      const result = observe();
      expect(result.status).toBe('review');
      expect(result.metrics).toEqual({ kinds_observed: 0, total_observations: 0 });
      expect(result.findings?.map((f) => f.code)).toEqual(['INVENTORY_PERFORMANCE_NO_READINGS']);
    },
  );

  it.each(['-1', '1e400', '"20"', 'null'])(
    'does not count invalid duration %s as timing evidence',
    (duration) => {
      raw(`${defaults}/inventory_api/a.json`, `{"duration_ms":${duration}}`);
      const result = observe();
      expect(result.status).toBe('review');
      expect(result.metrics?.total_observations).toBe(0);
    },
  );

  it.each(['"unit_test"', '42', '""'])('rejects a declared non-inventory kind %s', (kind) => {
    raw(`${defaults}/inventory_api/a.json`, `{"duration_ms":20,"sensor":{"kind":${kind}}}`);
    expect(observe().metrics?.total_observations).toBe(0);
  });

  it('retains zero-duration observations and ignores malformed or unrelated members', () => {
    reading(`${defaults}/inventory_api/a.json`, { duration_ms: 0 });
    raw(`${defaults}/inventory_api/b.json`, '{');
    raw(`${defaults}/inventory_api/c.json`, 'null');
    reading(`${defaults}/inventory_api/d.txt`, { duration_ms: 10000 });
    reading(`${defaults}/unit_test/e.json`, { duration_ms: 10000 });
    raw(`${defaults}/inventory_file`, 'not a directory');
    const result = observe();
    expect(result.status).toBe('pass');
    expect(result.metrics?.total_observations).toBe(1);
    expect(result.metrics?.overall_mean_ms).toBe(0);
    expect(result.sensor).toEqual({ name: 'inventory-performance', kind: 'inventory_performance' });
    expect(result.command).toBe('devai sense-inventory-performance');
    expect(result.timestamp).toBe(now);
    expect(result.tier).toBe('L0');
    expect(result.deterministic).toBe(true);
  });

  it.each([false, true])(
    'honors custom readings location, absolute=%s, and exact configured thresholds',
    (absolute) => {
      reading('custom/inventory_api/a.json', { duration_ms: 10 });
      const result = senseInventoryPerformance({
        repoRoot: root,
        readingsDir: absolute ? join(root, 'custom') : 'custom',
        thresholds: { pass: 5, review: 10 },
        now,
      });
      expect(result.status).toBe('fail');
      expect(result.metrics).toMatchObject({
        threshold_pass: 5,
        threshold_review: 10,
        overall_p95_ms: 10,
      });
      expect(result.findings?.[0]?.message).toBe('Inventory p95 10ms above review threshold 10ms.');
    },
  );
});
