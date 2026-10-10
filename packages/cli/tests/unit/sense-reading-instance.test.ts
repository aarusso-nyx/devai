// Invariants: INV-DEVAI-001, INV-DEVAI-002, INV-DEVAI-020; Constitution Article 41.
// A producer observation must remain recordable without rewriting historical evidence.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { verifyChain } from '@devai-nyx/evidence';
import { buildSensorReading, type SensorReading } from '@devai-nyx/sensors';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { recordSensorReading } from '../../src/commands/sense/record.js';
import { resolveSensorReadingInstance } from '../../src/commands/sense/reading-instance.js';
import { resolveScorecardInputs } from '../../../loop/src/scorecard/inputs.js';

const roots: string[] = [];
const CHAIN = 'record/proofs/chain.json';
const T1 = '2026-10-10T09:00:00.000Z';
const T2 = '2026-10-10T10:00:00.000Z';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=DEVAI Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd: root, encoding: 'utf8' },
  ).trim();
}

function put(root: string, path: string, value: unknown): string {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  return target;
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-reading-instance-'));
  roots.push(root);
  put(root, '.gitignore', '.devai/state/\nrecord/proofs/\n');
  put(root, 'README.md', 'first candidate\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture');
  return root;
}

function measurement(timestamp: string, endpoints = 1): SensorReading {
  return buildSensorReading({
    sensorName: 'inventory:api',
    sensorKind: 'inventory_api',
    command: ['devai', 'sense', 'run', 'inventory_api'],
    status: 'pass',
    deterministic: true,
    timestamp,
    metrics: { endpoints },
  });
}

async function resolveInstance(root: string, value: SensorReading) {
  return withAuthorityHostTestScope(() => resolveSensorReadingInstance(root, value));
}

async function record(root: string, value: SensorReading) {
  const input = put(root, '.devai/state/input.json', value);
  return withAuthorityHostTestScope(() => recordSensorReading(root, input));
}

function chain(root: string): { records: unknown[]; head: string | null } {
  return JSON.parse(readFileSync(join(root, CHAIN), 'utf8')) as {
    records: unknown[];
    head: string | null;
  };
}

describe('producer reading instances and exact candidate custody', () => {
  it('reuses an identical exact measurement and leaves its file and chain bytes unchanged', async () => {
    const root = repo();
    const first = await resolveInstance(root, measurement(T1));
    const saved = await record(root, first);
    const bytes = readFileSync(saved.path);
    const chainBytes = readFileSync(join(root, CHAIN));

    const same = await resolveInstance(root, measurement(T1));
    expect(same).toEqual(first);
    expect((await record(root, same)).action).toBe('already-recorded');
    expect(readFileSync(saved.path).equals(bytes)).toBe(true);
    expect(readFileSync(join(root, CHAIN)).equals(chainBytes)).toBe(true);
    expect(verifyChain(join(root, CHAIN))).toEqual({ valid: true, errors: [] });
  });

  it('records a later measurement with unchanged verdict as a new superseding instance', async () => {
    const root = repo();
    const first = await resolveInstance(root, measurement(T1));
    const saved = await record(root, first);
    const bytes = readFileSync(saved.path);
    const previousRecords = chain(root).records;

    const later = await resolveInstance(root, measurement(T2, 2));
    expect(later.id).not.toBe(first.id);
    expect(later.supersedes).toBe(first.id);
    expect(later.metrics).toEqual({ endpoints: 2 });
    expect(later.timestamp).toBe(T2);
    expect((await record(root, later)).action).toBe('created');
    expect(readFileSync(saved.path).equals(bytes)).toBe(true);
    expect(chain(root).records.slice(0, previousRecords.length)).toEqual(previousRecords);
    expect(verifyChain(join(root, CHAIN))).toEqual({ valid: true, errors: [] });
    expect(await resolveInstance(root, measurement(T2, 2))).toEqual(later);
  });

  it.each(['timestamp', 'duration_ms', 'findings'] as const)(
    'includes %s in measurement identity even with unchanged metrics and verdict',
    async (field) => {
      const root = repo();
      const first = await resolveInstance(root, measurement(T1));
      await record(root, first);
      const changed = {
        ...measurement(T1),
        ...(field === 'timestamp' ? { timestamp: T2 } : {}),
        ...(field === 'duration_ms' ? { duration_ms: 123 } : {}),
        ...(field === 'findings'
          ? {
              findings: [
                { severity: 'info' as const, code: 'OBSERVED', message: 'New observation' },
              ],
            }
          : {}),
      };
      const instance = await resolveInstance(root, changed);
      expect(instance.id).not.toBe(first.id);
      expect(instance.supersedes).toBe(first.id);
      expect(instance[field]).toEqual(changed[field]);
      await record(root, instance);
      expect(await resolveInstance(root, changed)).toEqual(instance);
    },
  );

  it('binds a new candidate measurement without superseding a prior candidate reading', async () => {
    const root = repo();
    const first = await resolveInstance(root, measurement(T1));
    const saved = await record(root, first);
    const bytes = readFileSync(saved.path);
    const firstHead = git(root, 'rev-parse', 'HEAD');
    put(root, 'README.md', 'second candidate\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-qm', 'second fixture candidate');

    const later = await resolveInstance(root, measurement(T2));
    expect(later.id).not.toBe(first.id);
    expect(later.supersedes).toBeUndefined();
    const recorded = await record(root, later);
    expect(recorded.action).toBe('created');
    expect(readFileSync(saved.path).equals(bytes)).toBe(true);
    const contexts = chain(root).records as { context?: { git?: { head_sha?: string } } }[];
    expect(contexts[0]?.context?.git?.head_sha).toBe(firstHead);
    expect(contexts.at(-1)?.context?.git?.head_sha).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(verifyChain(join(root, CHAIN))).toEqual({ valid: true, errors: [] });
  });

  it('reuses exact immutable bytes on a new candidate only after recorder adds that candidate custody', async () => {
    const root = repo();
    const first = await resolveInstance(root, measurement(T1));
    const saved = await record(root, first);
    const bytes = readFileSync(saved.path);
    const prefix = chain(root).records;
    put(root, 'README.md', 'second candidate\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-qm', 'second fixture candidate');

    const selected = await resolveInstance(root, measurement(T1));
    expect(selected).toEqual(first);
    expect(chain(root).records).toEqual(prefix);
    expect((await record(root, selected)).action).toBe('already-recorded');
    expect(readFileSync(saved.path).equals(bytes)).toBe(true);
    expect(chain(root).records).toHaveLength(prefix.length + 1);
    expect(chain(root).records.slice(0, prefix.length)).toEqual(prefix);
    expect(
      (chain(root).records.at(-1) as { context: { git: { head_sha: string } } }).context.git
        .head_sha,
    ).toBe(git(root, 'rev-parse', 'HEAD'));
    const next = await resolveInstance(root, measurement(T2));
    expect(next.supersedes).toBe(first.id);
    expect(verifyChain(join(root, CHAIN))).toEqual({ valid: true, errors: [] });
  });

  it('gives a prior candidate superseding body a fresh root instance without carrying its edge', async () => {
    const root = repo();
    const first = await resolveInstance(root, measurement(T1));
    await record(root, first);
    const next = await resolveInstance(root, measurement(T2));
    await record(root, next);
    expect(next.supersedes).toBe(first.id);
    put(root, 'README.md', 'second candidate\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-qm', 'second fixture candidate');
    const fresh = await resolveInstance(root, next);
    expect(fresh.id).not.toBe(next.id);
    expect(fresh.supersedes).toBeUndefined();
    expect(fresh.timestamp).toBe(next.timestamp);
    await record(root, fresh);
    expect(verifyChain(join(root, CHAIN))).toEqual({ valid: true, errors: [] });
  });

  it('refuses an unverified incoming supersedes edge before a store exists', async () => {
    const root = repo();
    await expect(
      resolveInstance(root, { ...measurement(T1), supersedes: 'SR-1111111111111111' }),
    ).rejects.toThrow();
  });

  it('keeps recorder collision rejection for the same ID with a different full body', async () => {
    const root = repo();
    const first = await resolveInstance(root, measurement(T1));
    const saved = await record(root, first);
    const bytes = readFileSync(saved.path);
    const chainBytes = readFileSync(join(root, CHAIN));
    await expect(record(root, { ...first, timestamp: T2 })).rejects.toThrow(
      'SENSE_RECORD_ID_CONFLICT',
    );
    expect(readFileSync(saved.path).equals(bytes)).toBe(true);
    expect(readFileSync(join(root, CHAIN)).equals(chainBytes)).toBe(true);
  });

  it.each(['wrong-kind', 'wrong-filename'] as const)(
    'refuses a stored %s identity',
    async (defect) => {
      const root = repo();
      const first = await resolveInstance(root, measurement(T1));
      const saved = await record(root, first);
      if (defect === 'wrong-kind') {
        writeFileSync(
          saved.path,
          JSON.stringify({ ...first, sensor: { ...first.sensor, kind: 'inventory_routes' } }),
        );
      } else {
        put(root, '.devai/state/sensor-readings/inventory_api/SR-2222222222222222.json', first);
      }
      const chainBytes = readFileSync(join(root, CHAIN));
      await expect(resolveInstance(root, measurement(T2))).rejects.toThrow(
        'SENSE_INSTANCE_STORE_IDENTITY_MISMATCH',
      );
      expect(readFileSync(join(root, CHAIN)).equals(chainBytes)).toBe(true);
    },
  );

  it('refuses a digest-tampered predecessor and leaves the chain and reading untouched', async () => {
    const root = repo();
    const first = await resolveInstance(root, measurement(T1));
    const saved = await record(root, first);
    const tampered = { ...first, metrics: { endpoints: 999 } };
    writeFileSync(saved.path, JSON.stringify(tampered));
    const bytes = readFileSync(saved.path);
    const chainBytes = readFileSync(join(root, CHAIN));

    await expect(resolveInstance(root, measurement(T2))).rejects.toThrow();
    expect(readFileSync(saved.path).equals(bytes)).toBe(true);
    expect(readFileSync(join(root, CHAIN)).equals(chainBytes)).toBe(true);
  });

  it('refuses forged candidate custody even when the artifact digest is unchanged', async () => {
    const root = repo();
    const first = await resolveInstance(root, measurement(T1));
    await record(root, first);
    put(root, 'README.md', 'second candidate\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-qm', 'second fixture candidate');
    const forged = chain(root) as {
      records: { context: { git: { head_sha: string } } }[];
      head: string | null;
    };
    const forgedRecord = forged.records[0];
    if (forgedRecord === undefined) throw new Error('Fixture chain missing');
    forgedRecord.context.git.head_sha = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, CHAIN), JSON.stringify(forged));
    const chainBytes = readFileSync(join(root, CHAIN));
    expect(verifyChain(join(root, CHAIN)).valid).toBe(false);
    await expect(resolveInstance(root, measurement(T2))).rejects.toThrow();
    expect(readFileSync(join(root, CHAIN)).equals(chainBytes)).toBe(true);
  });

  it.each(['missing', 'other-candidate'] as const)(
    'refuses a current predecessor whose supersedes edge names a %s reading',
    async (defect) => {
      const root = repo();
      const first = await resolveInstance(root, measurement(T1));
      if (defect === 'other-candidate') {
        await record(root, first);
        put(root, 'README.md', 'second candidate\n');
        git(root, 'add', 'README.md');
        git(root, 'commit', '-qm', 'second fixture candidate');
      }
      await record(root, {
        ...measurement(T2),
        id: 'SR-3333333333333333',
        supersedes: defect === 'missing' ? 'SR-4444444444444444' : first.id,
      });
      const chainBytes = readFileSync(join(root, CHAIN));
      await expect(
        resolveInstance(root, measurement('2026-10-10T11:00:00.000Z')),
      ).rejects.toThrow();
      expect(readFileSync(join(root, CHAIN)).equals(chainBytes)).toBe(true);
    },
  );

  it('refuses a disconnected supersession cycle even alongside one apparent current head', async () => {
    const root = repo();
    await record(root, {
      ...measurement(T1),
      id: 'SR-5555555555555555',
      supersedes: 'SR-6666666666666666',
    });
    await record(root, {
      ...measurement(T2),
      id: 'SR-6666666666666666',
      supersedes: 'SR-5555555555555555',
    });
    await record(root, { ...measurement(T2, 3), id: 'SR-7777777777777777' });
    const chainBytes = readFileSync(join(root, CHAIN));
    await expect(resolveInstance(root, measurement('2026-10-10T11:00:00.000Z'))).rejects.toThrow();
    expect(readFileSync(join(root, CHAIN)).equals(chainBytes)).toBe(true);
  });

  it('refuses two independent current-candidate predecessor heads instead of selecting by clock', async () => {
    const root = repo();
    await record(root, measurement(T1));
    await record(root, { ...measurement(T2, 2), id: 'SR-1111111111111111' });
    const chainBytes = readFileSync(join(root, CHAIN));

    await expect(resolveInstance(root, measurement('2026-10-10T11:00:00.000Z'))).rejects.toThrow();
    expect(readFileSync(join(root, CHAIN)).equals(chainBytes)).toBe(true);
  });

  it('composes disk readings only from the requested candidate verified custody', async () => {
    const root = repo();
    const candidateA = git(root, 'rev-parse', 'HEAD');
    const first = await resolveInstance(root, measurement(T1));
    await record(root, first);
    put(root, 'README.md', 'second candidate\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-qm', 'second fixture candidate');
    const candidateB = git(root, 'rev-parse', 'HEAD');
    const score = (head: string) =>
      withAuthorityHostTestScope(() =>
        resolveScorecardInputs({
          repoRoot: root,
          inputs: undefined,
          timestamp: T2,
          integrationHead: head,
        }),
      );
    expect((await score(candidateB)).readings).toEqual([]);
    expect((await score(candidateA)).readings).toEqual([first]);
    const second = await resolveInstance(root, { ...measurement(T2, 0), status: 'fail' });
    expect(second.supersedes).toBeUndefined();
    await record(root, second);
    expect((await score(candidateB)).readings).toEqual([second]);
    expect((await score(candidateA)).readings).toEqual([first]);
  });
});
