// Invariants: INV-DEVAI-017
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isAdoptionProfile, profileAtLeast, readProfile } from '../../src/profile/index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'devai-profile-'));
  roots.push(path);
  return path;
}

function put(base: string, relativePath: string, body: string): string {
  const path = join(base, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

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
