import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';

const controls = vi.hoisted(() => ({
  failingReadSuffix: '',
  failGeneratedWrite: false,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readFileSync: ((...args: unknown[]) => {
      if (
        controls.failingReadSuffix !== '' &&
        String(args[0]).endsWith(controls.failingReadSuffix)
      ) {
        throw new Error('x'.repeat(260));
      }
      return (actual.readFileSync as (...values: unknown[]) => unknown)(...args);
    }) as typeof actual.readFileSync,
    writeFileSync: ((...args: unknown[]) => {
      if (
        controls.failGeneratedWrite &&
        String(args[0]).includes('/sensor-readings/inventory_rbac/')
      ) {
        throw new Error('generated reading write refused');
      }
      return (actual.writeFileSync as (...values: unknown[]) => unknown)(...args);
    }) as typeof actual.writeFileSync,
  };
});

const { rebuildSensorReadings } = await import('../../src/commands/sense/readings-rebuild.js');

const roots: string[] = [];

afterEach(() => {
  controls.failingReadSuffix = '';
  controls.failGeneratedWrite = false;
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-shard09-readings-rebuild-'));
  roots.push(root);
  return root;
}

function put(root: string, path: string, body: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, body);
}

async function rebuild(root: string) {
  return withAuthorityHostTestScope(() => rebuildSensorReadings(root));
}

describe('CLI shard 09 readings rebuild core boundaries', () => {
  it('records an exact inventory directory read failure', async () => {
    const root = repository();
    const bodyDirectory = join(root, '.devai/state/sensors/inventory_api');
    put(root, '.devai/state/sensors/inventory_api', 'regular file');

    const result = await rebuild(root);

    expect(result.report).toMatchObject({ ok: false, created: 0, skipped: 0 });
    expect(result.report.errors).toHaveLength(1);
    expect(result.report.errors[0]).toMatch(
      new RegExp(`^read ${bodyDirectory.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} failed: `, 'u'),
    );
    expect(result.reading).toMatchObject({
      status: 'fail',
      findings: [
        expect.objectContaining({
          severity: 'error',
          code: 'READINGS_REBUILD_ERROR',
          message: result.report.errors[0]?.slice(0, 200),
        }),
      ],
    });
  });

  it('records an exact generated-reading write failure', async () => {
    const root = repository();
    put(root, '.devai/state/sensors/inventory_rbac/body.json', '{"roles":1}\n');
    controls.failGeneratedWrite = true;

    const result = await rebuild(root);

    expect(result.report).toMatchObject({ ok: false, created: 0, skipped: 0 });
    expect(result.report.errors).toHaveLength(1);
    expect(result.report.errors[0]).toMatch(
      /^write .*\/sensor-readings\/inventory_rbac\/SR-[0-9a-f]{16}\.json failed: generated reading write refused$/u,
    );
    expect(result.reading.findings).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'READINGS_REBUILD_ERROR',
        message: result.report.errors[0]?.slice(0, 200),
      }),
    ]);
  });

  it('limits failure findings and truncates their messages', async () => {
    const root = repository();
    put(root, '.devai/state/sensors/inventory_rbac/00-long.json', '{}\n');
    for (let index = 1; index <= 5; index += 1) {
      put(root, `.devai/state/sensors/inventory_rbac/0${index}-broken.json`, '{broken');
    }
    controls.failingReadSuffix = '00-long.json';

    const result = await rebuild(root);

    expect(result.report.errors).toHaveLength(6);
    expect(result.reading.findings).toHaveLength(5);
    expect(result.reading.findings?.[0]).toMatchObject({
      severity: 'error',
      code: 'READINGS_REBUILD_ERROR',
      message: result.report.errors[0]?.slice(0, 200),
    });
    expect(result.reading.findings?.[0]?.message).toHaveLength(200);
  });

  it('binds the aggregate command and timestamp into its unique id', async () => {
    vi.useFakeTimers();
    const root = repository();
    vi.setSystemTime(new Date('2026-09-11T08:00:00.000Z'));
    const first = await rebuild(root);
    vi.setSystemTime(new Date('2026-09-11T08:00:01.000Z'));
    const second = await rebuild(root);

    expect(first.reading.command).toBe('devai sense record --rebuild');
    expect(second.reading.command).toBe('devai sense record --rebuild');
    expect(second.reading.id).not.toBe(first.reading.id);
    expect(
      readdirSync(join(root, '.devai/state/sensor-readings/inventory_regeneration')).sort(),
    ).toEqual([`${first.reading.id}.json`, `${second.reading.id}.json`].sort());
  });
});
