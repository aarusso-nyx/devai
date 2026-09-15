import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { countPatternMatches } from '../../src/test-pattern-walker.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'devai-pattern-roots-'));
  roots.push(value);
  return value;
}

describe('test pattern walker root boundaries', () => {
  it('scans the default package test and source roots and matches relative paths/content', () => {
    const repo = root();
    mkdirSync(join(repo, 'packages', 'alpha', 'test'), { recursive: true });
    mkdirSync(join(repo, 'packages', 'alpha', 'src'), { recursive: true });
    mkdirSync(join(repo, 'packages', 'beta', 'test'), { recursive: true });
    writeFileSync(
      join(repo, 'packages', 'alpha', 'test', 'alpha.test.ts'),
      'describe("needle", () => {});\n',
    );
    writeFileSync(
      join(repo, 'packages', 'alpha', 'src', 'alpha.spec.ts'),
      'export const value = "needle";\n',
    );
    writeFileSync(
      join(repo, 'packages', 'beta', 'test', 'beta.spec.ts'),
      'describe("other", () => {});\n',
    );
    mkdirSync(join(repo, 'packages', 'ignored', 'dist'), { recursive: true });
    writeFileSync(join(repo, 'packages', 'ignored', 'dist', 'needle.test.ts'), 'needle\n');

    const counts = countPatternMatches(repo, /needle/);

    expect(counts).toMatchObject({ total: 3, matched: 2 });
    expect(counts.matchedFiles).toEqual([
      join(repo, 'packages', 'alpha', 'test', 'alpha.test.ts'),
      join(repo, 'packages', 'alpha', 'src', 'alpha.spec.ts'),
    ]);
  });

  it('honors simple configurable roots and falls back to an external file basename', () => {
    const repo = root();
    const external = `${repo}-outside`;
    roots.push(external);
    mkdirSync(join(repo, 'packages', 'gamma', 'fixtures'), { recursive: true });
    mkdirSync(join(external, 'nested'), { recursive: true });
    const configured = join(repo, 'packages', 'gamma', 'fixtures', 'configured.test.ts');
    const outside = join(external, 'nested', 'needle.test.ts');
    writeFileSync(configured, 'ordinary content\n');
    writeFileSync(outside, 'ordinary content\n');

    const configuredCounts = countPatternMatches(
      repo,
      /^packages\/gamma\/fixtures\/configured\.test\.ts$/,
      ['packages/*/fixtures'],
    );
    expect(configuredCounts).toMatchObject({ total: 1, matched: 1 });
    expect(configuredCounts.matchedFiles).toEqual([configured]);

    mkdirSync(join(repo, 'modules', 'packages', 'gamma', 'fixtures', 'unit'), { recursive: true });
    writeFileSync(
      join(repo, 'modules', 'packages', 'gamma', 'fixtures', 'unit', 't.test.ts'),
      'ordinary content\n',
    );
    const nestedCounts = countPatternMatches(
      repo,
      /^modules\/packages\/gamma\/fixtures\/unit\/t\.test\.ts$/,
      ['modules/packages/*/fixtures/unit'],
    );
    expect(nestedCounts).toMatchObject({ total: 1, matched: 1 });

    const externalCounts = countPatternMatches(repo, /^needle\.test\.ts$/, [external]);
    expect(externalCounts).toMatchObject({ total: 1, matched: 1 });
    expect(externalCounts.matchedFiles).toEqual([outside]);
  });
});
