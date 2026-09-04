import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { build, currentFixture, fixture } from '../helpers/release-mutation-inputs-fixture.js';

const guard = vi.hoisted(() => ({
  subprocess: vi.fn(() => {
    throw new Error('subprocess unavailable in history-free fixture test');
  }),
  reads: [] as string[],
  corrupt: undefined as string | undefined,
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  exec: guard.subprocess,
  execSync: guard.subprocess,
  execFile: guard.subprocess,
  execFileSync: guard.subprocess,
  spawn: guard.subprocess,
  spawnSync: guard.subprocess,
}));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      const path = String(args[0]);
      guard.reads.push(path);
      if (path.split(/[\\/]/u).includes('.git'))
        throw new Error('Git metadata unavailable in history-free fixture test');
      const bytes = actual.readFileSync(...args);
      if (
        guard.corrupt !== undefined &&
        path.endsWith(`/historical-mutation-inputs/${guard.corrupt}`)
      ) {
        const corrupted = Buffer.from(bytes);
        corrupted[0] = 0;
        return corrupted;
      }
      return bytes;
    },
  };
});

const ROOT = resolve(import.meta.dirname, '../fixtures/historical-mutation-inputs');
const historical = [
  ['devai-adoption.json', '24982a246ee22c18779114f079e020bfbb7e23cb1fd34c002f5865c6508391b1'],
  [
    'release-verification-profile.schema.json',
    '973db5abc11fa3511e063a17ce34caf06e861534a675303638f5e6ce1364ae52',
  ],
] as const;

beforeEach(() => {
  guard.subprocess.mockClear();
  guard.reads.length = 0;
  guard.corrupt = undefined;
});

describe('historical mutation inputs without ambient Git history (ADR-MUT-0008)', () => {
  it('retains the exact two raw documents from revision 8ce7f7d with independent pinned digests', () => {
    for (const [name, expected] of historical) {
      const bytes = readFileSync(resolve(ROOT, name));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected);
      expect(bytes.at(-1)).toBe(10);
    }
    const historicalFixture = fixture();
    expect(
      historicalFixture.installed.read(
        'dist/runtime/index/schemas/release-verification-profile.schema.json',
      ),
    ).toEqual(readFileSync(resolve(ROOT, 'release-verification-profile.schema.json')));
    expect(historicalFixture.installed.identity.version).toBe('1.4.5');
  });

  it('derives historical and current plans while Git subprocesses and .git reads are unavailable', () => {
    const old = build(fixture());
    const current = build(currentFixture());
    expect(old.plan.execution_template_version).toBe('1.1.0');
    expect(current.plan.execution_template_version).toBe('1.2.0');
    expect(old.plan.packages).toHaveLength(10);
    expect(current.plan.packages).toHaveLength(10);
    expect(old.plan.grants).toEqual({ execution: false, certification: false, reuse: false });
    expect(current.plan.grants).toEqual(old.plan.grants);
    expect(guard.subprocess).not.toHaveBeenCalled();
    expect(guard.reads.some((path) => path.split(/[\\/]/u).includes('.git'))).toBe(false);
    for (const [name] of historical) expect(guard.reads).toContain(resolve(ROOT, name));
  });

  it.each(historical)(
    'refuses same-size corruption of %s before constructing the frozen fixture',
    (name) => {
      guard.corrupt = name;
      expect(() => fixture()).toThrow('historical mutation fixture digest mismatch');
      expect(guard.subprocess).not.toHaveBeenCalled();
    },
  );

  it('keeps the current v1.2 opt-in independent of historical fixtures', () => {
    guard.corrupt = 'devai-adoption.json';
    const current = currentFixture();
    expect(current.installed.identity.version).toBe('1.5.0');
    expect(build(current).plan.execution_template_version).toBe('1.2.0');
    expect(guard.reads.some((path) => path.includes('/historical-mutation-inputs/'))).toBe(false);
    expect(guard.subprocess).not.toHaveBeenCalled();
  });
});
