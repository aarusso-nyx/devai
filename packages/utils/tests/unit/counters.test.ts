import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COUNTERS_PATH_REL, nextCounterId } from '../../src/counters/index.js';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devai-counters-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const effects = { mkdirSync, writeFileSync };

describe('shared counter allocation', () => {
  it('allocates independent persisted counters while preserving unrelated keys', () => {
    const repoRoot = fixture();
    mkdirSync(join(repoRoot, '.devai/state'), { recursive: true });
    const path = join(repoRoot, COUNTERS_PATH_REL);
    writeFileSync(path, JSON.stringify({ REL: 8, OTHER: 91 }));
    expect(nextCounterId({ repoRoot, key: 'REL', prefix: 'REL', effects })).toBe('REL-0009');
    expect(nextCounterId({ repoRoot, key: 'RTM', prefix: 'TRACE', effects })).toBe('TRACE-0001');
    expect(nextCounterId({ repoRoot, key: 'REL', prefix: 'REL', effects })).toBe('REL-0010');
    expect(readFileSync(path, 'utf8')).toBe(
      JSON.stringify({ REL: 10, OTHER: 91, RTM: 1 }, null, 2) + '\n',
    );
  });

  it.each([
    { options: {}, expected: 'T-0001' },
    { options: { padTo: 2 }, expected: 'T-01' },
    { options: { padTo: 0 }, expected: 'T-1' },
    { options: { padTo: 8 }, expected: 'T-00000001' },
  ])('honors minimum padding %s without changing the numeric state', ({ options, expected }) => {
    const repoRoot = fixture();
    const value = nextCounterId({ repoRoot, key: 'TASK', prefix: 'T', effects, ...options });
    expect(value).toBe(expected);
    expect(JSON.parse(readFileSync(join(repoRoot, COUNTERS_PATH_REL), 'utf8'))).toEqual({
      TASK: 1,
    });
  });

  it.each(['{', 'null', 'false', '42', '"text"'])(
    'uses the documented fresh default for invalid counter-file contents %s',
    (source) => {
      const repoRoot = fixture();
      mkdirSync(join(repoRoot, '.devai/state'), { recursive: true });
      writeFileSync(join(repoRoot, COUNTERS_PATH_REL), source);
      expect(nextCounterId({ repoRoot, key: 'RGR', prefix: 'RGR', effects })).toBe('RGR-0001');
      expect(JSON.parse(readFileSync(join(repoRoot, COUNTERS_PATH_REL), 'utf8'))).toEqual({
        RGR: 1,
      });
    },
  );

  it.each(['mkdir', 'write'] as const)(
    'returns the allocated ID when the injected %s effect refuses persistence',
    (step) => {
      const repoRoot = fixture();
      const mkdir = vi.fn(() => {
        if (step === 'mkdir') throw new Error('permission denied');
      });
      const write = vi.fn(() => {
        throw new Error('read-only');
      });
      expect(
        nextCounterId({
          repoRoot,
          key: 'REL',
          prefix: 'REL',
          effects: { mkdirSync: mkdir, writeFileSync: write },
        }),
      ).toBe('REL-0001');
      expect(mkdir).toHaveBeenCalledWith(join(repoRoot, '.devai/state'), { recursive: true });
      if (step === 'mkdir') expect(write).not.toHaveBeenCalled();
      else
        expect(write).toHaveBeenCalledWith(join(repoRoot, COUNTERS_PATH_REL), '{\n  "REL": 1\n}\n');
    },
  );
});
