import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSensorParams } from '../../src/pack-resolver/index.js';

/**
 * Phase 19.B (D-61): unit tests for the resolveSensorParams() runtime
 * helper. The schema field `extractor_params` has existed since Phase
 * 17.G; this helper finally wires it into sense / sensor consumers.
 */

let workdir = '';
let adopter = '';

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'devai-rsp-work-'));
  adopter = mkdtempSync(join(tmpdir(), 'devai-rsp-adopter-'));
});

afterEach(() => {
  try {
    rmSync(workdir, { recursive: true, force: true });
    rmSync(adopter, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

function writePack(packId: string, body: Record<string, unknown>): void {
  const dir = join(workdir, 'examples', `redox-pack-${packId}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stack-adapter.json'), JSON.stringify(body));
}

describe('resolveSensorParams (Phase 19.B)', () => {
  it('returns null when no pack matches', () => {
    writePack('xstack', {
      schemaVersion: '1.0.0',
      id: 'redox-pack-xstack',
      name: 'X',
      version: '1.0.0',
      stack: { backend: 'x', frontend: 'x', db: 'x' },
      detect: {
        signals: [{ kind: 'file_present', path: 'never-present-file.txt' }],
        priority: 50,
      },
    });
    const r = resolveSensorParams({
      packsRoot: workdir,
      adopterRoot: adopter,
      sensorKind: 'inventory_api',
    });
    expect(r).toBeNull();
  });

  it('returns params subset for the resolved sensor kind', () => {
    writePack('match', {
      schemaVersion: '1.0.0',
      id: 'redox-pack-match',
      name: 'M',
      version: '1.0.0',
      stack: { backend: 'm', frontend: 'm', db: 'm' },
      detect: {
        signals: [{ kind: 'file_present', path: 'marker.txt' }],
        priority: 50,
      },
      extractor_params: {
        inventory_api: { scan_dir: 'src/api', framework: 'nestjs' },
        inventory_routes: { scan_dir: 'src/web' },
      },
    });
    writeFileSync(join(adopter, 'marker.txt'), '');
    const r = resolveSensorParams({
      packsRoot: workdir,
      adopterRoot: adopter,
      sensorKind: 'inventory_api',
    });
    expect(r).not.toBeNull();
    expect(r?.pack.id).toBe('redox-pack-match');
    expect(r?.params).toEqual({ scan_dir: 'src/api', framework: 'nestjs' });
  });

  it('returns an empty params object when the pack declares no params for the sensor kind', () => {
    writePack('match', {
      schemaVersion: '1.0.0',
      id: 'redox-pack-match',
      name: 'M',
      version: '1.0.0',
      stack: { backend: 'm', frontend: 'm', db: 'm' },
      detect: { signals: [{ kind: 'file_present', path: 'marker.txt' }], priority: 50 },
      extractor_params: {
        inventory_api: { scan_dir: 'src/api' },
      },
    });
    writeFileSync(join(adopter, 'marker.txt'), '');
    const r = resolveSensorParams({
      packsRoot: workdir,
      adopterRoot: adopter,
      sensorKind: 'inventory_coverage',
    });
    expect(r).not.toBeNull();
    expect(r?.params).toEqual({});
  });

  it('honors explicitId to skip auto-detection', () => {
    writePack('forced', {
      schemaVersion: '1.0.0',
      id: 'redox-pack-forced',
      name: 'F',
      version: '1.0.0',
      stack: { backend: 'f', frontend: 'f', db: 'f' },
      detect: {
        signals: [{ kind: 'file_present', path: 'never-present.txt' }],
        priority: 10,
      },
      extractor_params: {
        inventory_api: { scan_dir: 'explicit/api' },
      },
    });
    const r = resolveSensorParams({
      packsRoot: workdir,
      adopterRoot: adopter,
      sensorKind: 'inventory_api',
      explicitId: 'redox-pack-forced',
    });
    expect(r).not.toBeNull();
    expect(r?.pack.id).toBe('redox-pack-forced');
    expect(r?.params).toEqual({ scan_dir: 'explicit/api' });
  });
});
// Invariants: INV-DEVAI-002, INV-DEVAI-012
