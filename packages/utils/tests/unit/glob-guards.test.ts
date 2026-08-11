import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  evaluateGlobGuard,
  evaluateGlobGuards,
  loadGlobGuards,
} from '../../src/glob-guards/index.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'devai-glob-guards-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function touch(relPath: string): void {
  const full = join(dir, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, '');
}

describe('evaluateGlobGuard', () => {
  it('reports zero matches when the base directory does not exist at all (stynx-shape bug)', () => {
    const result = evaluateGlobGuard(dir, {
      id: 'DEAD_DIR',
      pattern: 'docs/architecture/invariants/*.json',
    });
    expect(result.match_count).toBe(0);
    expect(result.ok).toBe(false);
  });

  it('matches files under an existing directory against the glob', () => {
    touch('docs/framework/arch/invariants/INV-001.json');
    touch('docs/framework/arch/invariants/INV-002.json');
    touch('docs/framework/arch/invariants/README.md');
    const result = evaluateGlobGuard(dir, {
      id: 'INVARIANTS',
      pattern: 'docs/framework/arch/invariants/*.json',
    });
    expect(result.match_count).toBe(2);
    expect(result.ok).toBe(true);
    expect(result.sample_matches).toEqual(
      expect.arrayContaining([
        'docs/framework/arch/invariants/INV-001.json',
        'docs/framework/arch/invariants/INV-002.json',
      ]),
    );
  });

  it('honors min_matches as a regression threshold, not just zero-detection', () => {
    touch('a/one.json');
    touch('a/two.json');
    const result = evaluateGlobGuard(dir, { id: 'THRESHOLD', pattern: 'a/*.json', min_matches: 5 });
    expect(result.match_count).toBe(2);
    expect(result.ok).toBe(false);
  });

  it('recurses with **', () => {
    touch('src/x/one.ts');
    touch('src/y/z/two.ts');
    const result = evaluateGlobGuard(dir, { id: 'RECURSIVE', pattern: 'src/**/*.ts' });
    expect(result.match_count).toBe(2);
    expect(result.ok).toBe(true);
  });

  it('treats a glob-metacharacter-free pattern as a literal file existence check', () => {
    touch('.github/workflows/devai-gates.yml');
    const present = evaluateGlobGuard(dir, {
      id: 'LITERAL_PRESENT',
      pattern: '.github/workflows/devai-gates.yml',
    });
    expect(present.match_count).toBe(1);
    expect(present.ok).toBe(true);

    const absent = evaluateGlobGuard(dir, {
      id: 'LITERAL_ABSENT',
      pattern: '.github/workflows/does-not-exist.yml',
    });
    expect(absent.match_count).toBe(0);
    expect(absent.ok).toBe(false);
  });

  it('defaults min_matches to 1 when omitted', () => {
    const result = evaluateGlobGuard(dir, { id: 'DEFAULT', pattern: 'nothing/here/*.json' });
    expect(result.min_matches).toBe(1);
  });

  it('never descends into node_modules or .git even when the pattern would otherwise match', () => {
    touch('node_modules/pkg/file.json');
    touch('.git/objects/file.json');
    touch('real/file.json');
    const result = evaluateGlobGuard(dir, { id: 'NO_JUNK', pattern: '**/*.json' });
    expect(result.sample_matches).toEqual(['real/file.json']);
  });
});

describe('loadGlobGuards', () => {
  it('returns an empty array when the registry file is absent', () => {
    expect(loadGlobGuards(join(dir, 'does-not-exist.json'))).toEqual([]);
  });

  it('returns an empty array for an unparseable file rather than throwing', () => {
    const p = join(dir, 'glob-guards.json');
    writeFileSync(p, '{ not valid json');
    expect(loadGlobGuards(p)).toEqual([]);
  });

  it('parses a well-formed registry', () => {
    const p = join(dir, 'glob-guards.json');
    writeFileSync(
      p,
      JSON.stringify({
        schemaVersion: '1.0.0',
        guards: [{ id: 'A', pattern: 'x/*.json' }],
      }),
    );
    expect(loadGlobGuards(p)).toEqual([{ id: 'A', pattern: 'x/*.json' }]);
  });
});

describe('evaluateGlobGuards', () => {
  it('evaluates every guard in the registry against the repo root', () => {
    touch('a/one.json');
    const p = join(dir, 'glob-guards.json');
    writeFileSync(
      p,
      JSON.stringify({
        schemaVersion: '1.0.0',
        guards: [
          { id: 'PRESENT', pattern: 'a/*.json' },
          { id: 'MISSING', pattern: 'b/*.json' },
        ],
      }),
    );
    const results = evaluateGlobGuards(dir, p);
    expect(results.map((r) => r.id)).toEqual(['PRESENT', 'MISSING']);
    expect(results.find((r) => r.id === 'PRESENT')?.ok).toBe(true);
    expect(results.find((r) => r.id === 'MISSING')?.ok).toBe(false);
  });
});
// Invariants: INV-DEVAI-014
