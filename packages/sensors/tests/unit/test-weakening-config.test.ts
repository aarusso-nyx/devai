import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadTestWeakeningConfig,
  TEST_WEAKENING_DEFAULTS,
} from '../../src/test-weakening-config.js';

let repoRoot = '';

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'devai-twc-'));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function writeConfig(content: object): void {
  mkdirSync(join(repoRoot, '.devai/config'), { recursive: true });
  writeFileSync(join(repoRoot, '.devai/config/test-weakening.json'), JSON.stringify(content));
}

describe('loadTestWeakeningConfig', () => {
  it('returns D-21 defaults when no config file exists', () => {
    const cfg = loadTestWeakeningConfig(repoRoot);
    expect(cfg.source).toBe('defaults');
    expect(cfg.threshold_ratio).toBe(TEST_WEAKENING_DEFAULTS.threshold_ratio);
    expect(cfg.absolute_decrease_floor).toBe(TEST_WEAKENING_DEFAULTS.absolute_decrease_floor);
    expect(cfg.ignored_paths).toEqual([]);
  });

  it('reads an empty config file and falls back to defaults', () => {
    writeConfig({});
    const cfg = loadTestWeakeningConfig(repoRoot);
    expect(cfg.source).toBe('config-file');
    expect(cfg.threshold_ratio).toBe(TEST_WEAKENING_DEFAULTS.threshold_ratio);
  });

  it('overrides threshold_ratio when present', () => {
    writeConfig({ threshold_ratio: 0.35 });
    const cfg = loadTestWeakeningConfig(repoRoot);
    expect(cfg.threshold_ratio).toBe(0.35);
    expect(cfg.absolute_decrease_floor).toBe(TEST_WEAKENING_DEFAULTS.absolute_decrease_floor);
  });

  it('overrides ignored_paths when present', () => {
    writeConfig({ ignored_paths: ['legacy/**', 'packages/old-suite/**'] });
    const cfg = loadTestWeakeningConfig(repoRoot);
    expect(cfg.ignored_paths).toEqual(['legacy/**', 'packages/old-suite/**']);
  });

  it('overrides multiple fields together (mixed config)', () => {
    writeConfig({
      threshold_ratio: 0.5,
      absolute_decrease_floor: 3,
      skip_added_threshold: 2,
      invariant_reference_removed_threshold: 0,
    });
    const cfg = loadTestWeakeningConfig(repoRoot);
    expect(cfg.threshold_ratio).toBe(0.5);
    expect(cfg.absolute_decrease_floor).toBe(3);
    expect(cfg.skip_added_threshold).toBe(2);
    expect(cfg.invariant_reference_removed_threshold).toBe(0);
  });

  it('throws on schema-invalid config (threshold_ratio out of range)', () => {
    writeConfig({ threshold_ratio: 1.5 });
    expect(() => loadTestWeakeningConfig(repoRoot)).toThrow(/test-weakening-config\.schema\.json/);
  });

  it('throws on schema-invalid config (unknown property)', () => {
    writeConfig({ foo: 'bar' });
    expect(() => loadTestWeakeningConfig(repoRoot)).toThrow(/test-weakening-config\.schema\.json/);
  });

  it('throws on unparseable JSON', () => {
    mkdirSync(join(repoRoot, '.devai/config'), { recursive: true });
    writeFileSync(join(repoRoot, '.devai/config/test-weakening.json'), '{this is not json');
    expect(() => loadTestWeakeningConfig(repoRoot)).toThrow(/not valid JSON/);
  });
});
// Invariants: INV-DEVAI-002, INV-DEVAI-012
