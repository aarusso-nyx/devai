import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { rebuildSensorReadings } from '../../src/commands/sense/readings-rebuild.js';

const boundary = vi.hoisted(() => ({ forceDescendingInventoryEntries: false }));

vi.mock('@devai-nyx/authority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@devai-nyx/authority')>();
  return {
    ...actual,
    readdirSync: (path: string) => {
      const entries = actual.readdirSync(path) as string[];
      return boundary.forceDescendingInventoryEntries && path.endsWith('/inventory_api')
        ? [...entries].sort().reverse()
        : entries;
    },
  };
});

const roots: string[] = [];

beforeEach(() => {
  boundary.forceDescendingInventoryEntries = false;
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(root: string, path: string, body: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, body);
}

describe('shard 09 synthesized inventory reading contract', () => {
  it('preserves canonical identity, metadata, diagnostic, and sorted body order', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-09-11T08:00:00.000Z');
    boundary.forceDescendingInventoryEntries = true;

    const root = mkdtempSync(join(tmpdir(), 'devai-shard09-readings-synthesize-'));
    roots.push(root);
    const firstBody = '.devai/state/sensors/inventory_api/a.json';
    const secondBody = '.devai/state/sensors/inventory_api/z.json';
    put(root, secondBody, '{"route":"z"}\n');
    put(root, firstBody, '{"route":"a"}\n');

    const result = await withAuthorityHostTestScope(() => rebuildSensorReadings(root));
    expect(result.report.entries.map(({ body_path }) => body_path)).toEqual([
      firstBody,
      secondBody,
    ]);

    const firstEntry = result.report.entries[0];
    expect(firstEntry).toBeDefined();
    const bodyAbsPath = join(root, firstBody);
    const idSeed = createHash('sha256')
      .update(`inventory_api::${firstBody}::rebuild`)
      .digest('hex')
      .slice(0, 16);
    const id = `SR-${idSeed}`;
    const command = `devai sense record --rebuild --repo-root . (synthesized from ${firstBody})`;
    const commandHash = createHash('sha256').update(command).digest('hex');
    const persisted = JSON.parse(readFileSync(firstEntry?.reading_path ?? '', 'utf8')) as unknown;

    expect(firstEntry).toEqual({
      kind: 'inventory_api',
      body_path: firstBody,
      reading_path: join(root, '.devai/state/sensor-readings/inventory_api', `${id}.json`),
      action: 'created',
    });
    expect(persisted).toEqual({
      schemaVersion: '1.0.0',
      id,
      sensor: { name: 'inventory:api', kind: 'inventory_api', version: '1.0.0' },
      timestamp: '2026-09-11T08:00:00.000Z',
      status: 'pass',
      deterministic: true,
      command,
      command_hash: commandHash,
      tier: 'L0',
      evidence_path: bodyAbsPath,
      findings: [
        {
          severity: 'info',
          code: 'REBUILT_FROM_BODY',
          message:
            'SensorReading synthesized from an existing body file by `devai sense record --rebuild`. Findings and metrics from the original sensor run are not preserved.',
        },
      ],
    });
  });
});
