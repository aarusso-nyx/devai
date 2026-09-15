import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { countPatternMatches } from '../../src/test-pattern-walker.js';

function file(root: string, relativePath: string, content = 'needle'): string {
  const path = join(root, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function sorted(paths: readonly string[]): string[] {
  return [...paths].sort();
}

describe('test pattern walker mutation boundaries', () => {
  it('accepts only terminal test and spec extensions and reports absolute matches', () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-wave7-extensions-'));
    try {
      const testFile = file(root, 'tests/keep.test.ts');
      const specFile = file(root, 'tests/keep.spec.tsx');
      file(root, 'tests/path.test.ts', 'no-match');
      file(root, 'tests/suffix.test.ts.bak');
      file(root, 'tests/notes.txt');

      const reading = countPatternMatches(root, /needle/, ['tests']);

      expect({ ...reading, matchedFiles: sorted(reading.matchedFiles) }).toEqual({
        total: 3,
        matched: 2,
        matchedFiles: sorted([testFile, specFile]),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not descend into any ignored directory name', () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-wave7-ignored-'));
    try {
      const kept = file(root, 'packages/app/test/keep.test.ts');
      for (const ignored of ['node_modules', '.git', 'dist', 'build']) {
        file(root, `packages/app/test/${ignored}/hidden.test.ts`);
      }

      const reading = countPatternMatches(root, /needle/, ['packages/*/test']);

      expect(reading).toEqual({
        total: 1,
        matched: 1,
        matchedFiles: [kept],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('expands both leading and packages wildcard roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-wave7-wildcards-'));
    try {
      const leading = [file(root, 'alpha/test/a.test.ts'), file(root, 'beta/test/b.test.ts')];
      const packages = [
        file(root, 'packages/alpha/test/pa.test.ts'),
        file(root, 'packages/beta/test/pb.test.ts'),
      ];

      const reading = countPatternMatches(root, /needle/, ['*/test', 'packages/*/test']);

      expect(reading.total).toBe(4);
      expect(reading.matched).toBe(4);
      expect(sorted(reading.matchedFiles)).toEqual(sorted([...leading, ...packages]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
