// Invariants: INV-DEVAI-017
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isAdoptionProfile, profileAtLeast, readProfile } from '../../src/profile/index.js';
import { pruneState } from '../../src/state/index.js';

const roots: string[] = [];
const NOW = new Date('2026-07-25T00:00:00.000Z');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'devai-state-profile-'));
  roots.push(path);
  return path;
}

function put(base: string, relativePath: string, body: string): string {
  const path = join(base, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

describe('state pruning', () => {
  it('discovers only old regular files under disposable roots and applies through effects', () => {
    const repo = root();
    const old = new Date('2026-06-01T00:00:00.000Z');
    const fresh = new Date('2026-07-24T00:00:00.000Z');
    for (const path of [
      put(repo, '.devai/cache/old.json', '{}'),
      put(repo, '.devai/state/tmp/nested/old.txt', 'old'),
      put(repo, 'coverage/old.json', '{}'),
    ]) {
      utimesSync(path, old, old);
    }
    const freshPath = put(repo, '.devai/state/v8-coverage/fresh.json', '{}');
    utimesSync(freshPath, fresh, fresh);
    const outside = put(repo, 'outside.json', '{}');
    symlinkSync(outside, join(repo, '.devai/cache/link.json'));

    const preview = pruneState({ repoRoot: repo, olderThanDays: 30, now: NOW });
    expect(preview).toMatchObject({
      applied: false,
      older_than_days: 30,
      candidates: ['.devai/cache/old.json', '.devai/state/tmp/nested/old.txt', 'coverage/old.json'],
      deleted: [],
    });
    expect(preview.preserved_roots).toContain('.devai/state/counters.json');

    const removed: string[] = [];
    expect(
      pruneState({
        repoRoot: repo,
        olderThanDays: 30,
        apply: true,
        now: NOW,
        effects: {
          rmSync(path) {
            removed.push(path);
          },
        },
      }).deleted,
    ).toEqual(preview.candidates);
    expect(removed.map((path) => path.slice(repo.length + 1))).toEqual(preview.candidates);
  });

  it('rejects invalid cutoffs and authority-free mutation', () => {
    const repo = root();
    for (const olderThanDays of [0, -1, 1.5, Number.NaN]) {
      expect(() => pruneState({ repoRoot: repo, olderThanDays })).toThrow(
        'olderThanDays must be a positive integer',
      );
    }
    expect(() => pruneState({ repoRoot: repo, apply: true })).toThrow(
      'authority-backed mutation effects adapter',
    );
  });
});

describe('adoption profiles', () => {
  it('defaults malformed or absent declarations to the strongest floor', () => {
    const repo = root();
    expect(readProfile(repo)).toBe('tier3');
    put(repo, '.devai/config/project.json', '{');
    expect(readProfile(repo)).toBe('tier3');
    put(repo, '.devai/config/project.json', '{"profile":"tier0"}');
    expect(readProfile(repo)).toBe('tier3');
    put(repo, '.devai/config/project.json', '{"profile":"tier2"}');
    expect(readProfile(repo)).toBe('tier2');
    expect(isAdoptionProfile('tier1')).toBe(true);
    expect(isAdoptionProfile('tier3')).toBe(true);
    expect(isAdoptionProfile('tier0')).toBe(false);
    expect(isAdoptionProfile(null)).toBe(false);
  });

  it('orders assurance floors', () => {
    expect(profileAtLeast('tier3', 'tier1')).toBe(true);
    expect(profileAtLeast('tier2', 'tier2')).toBe(true);
    expect(profileAtLeast('tier1', 'tier2')).toBe(false);
  });
});

describe('disposable state boundaries', () => {
  it('never follows a symlink used as a disposable root', () => {
    const repo = root();
    const external = root();
    const path = put(external, 'old.json', 'preserve');
    const old = new Date('2026-06-01T00:00:00.000Z');
    utimesSync(path, old, old);
    mkdirSync(join(repo, '.devai'), { recursive: true });
    symlinkSync(external, join(repo, '.devai/cache'));
    expect(pruneState({ repoRoot: repo, now: NOW }).candidates).toEqual([]);
  });

  it('never follows a symlink ancestor of a disposable root', () => {
    const repo = root();
    const external = root();
    const path = put(external, 'cache/old.json', 'preserve');
    const old = new Date('2026-06-01T00:00:00.000Z');
    utimesSync(path, old, old);
    symlinkSync(external, join(repo, '.devai'));
    expect(pruneState({ repoRoot: repo, now: NOW }).candidates).toEqual([]);
  });

  it('uses the default 30-day cutoff strictly and preserves records at the cutoff', () => {
    const repo = root();
    const cutoff = NOW.getTime() - 30 * 86400000;
    for (const [name, offset] of [
      ['before', -1000],
      ['at', 0],
      ['after', 1000],
    ] as const) {
      const path = put(repo, `coverage/${name}.json`, '{}');
      const stamp = new Date(cutoff + offset);
      utimesSync(path, stamp, stamp);
    }
    expect(pruneState({ repoRoot: repo, now: NOW })).toEqual({
      applied: false,
      older_than_days: 30,
      candidates: ['coverage/before.json'],
      deleted: [],
      preserved_roots: [
        '.devai/state/counters.json',
        '.devai/state/leases',
        '.devai/state/pointers',
      ],
    });
  });
});

describe('pruning application receipt', () => {
  it('accepts the minimum one-day retention and reports exact applied effects', () => {
    const repo = root();
    const path = put(repo, 'coverage/old.json', '{}');
    const old = new Date(NOW.getTime() - 2 * 86400000);
    utimesSync(path, old, old);
    const calls: unknown[] = [];
    const result = pruneState({
      repoRoot: repo,
      olderThanDays: 1,
      now: NOW,
      apply: true,
      effects: {
        rmSync: (target, options) => {
          calls.push([target, options]);
          rmSync(target, options);
        },
      },
    });
    expect(result).toEqual({
      applied: true,
      older_than_days: 1,
      candidates: ['coverage/old.json'],
      deleted: ['coverage/old.json'],
      preserved_roots: [
        '.devai/state/counters.json',
        '.devai/state/leases',
        '.devai/state/pointers',
      ],
    });
    expect(calls).toEqual([[path, { force: true }]]);
    expect(pruneState({ repoRoot: repo, now: NOW }).candidates).toEqual([]);
  });
});
