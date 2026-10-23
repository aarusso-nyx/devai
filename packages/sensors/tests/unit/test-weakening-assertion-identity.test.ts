// ADR-GOV-0026 (issue #412): the weakening sensor reports an edit to an existing assertion even
// when the file keeps its `expect` count. A loss the count drop already explains (a removal)
// stays the count finding alone; a base assertion changed in place, moved or re-marked adds one
// `assertion_changed` review finding naming the assertions, judged against the given base.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { senseTestWeakening } from '../../src/test-weakening.js';

let root: string;
function git(...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      ...args,
    ],
    { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-weakening-identity-'));
  git('init', '-q');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const BASE = [
  "it('adds', () => {",
  '  expect(add(1, 1)).toBe(2);',
  '  expect(add(2, 2)).toBe(4);',
  '});',
  '',
].join('\n');

function commitBase(): string {
  writeFileSync(join(root, 'add.test.ts'), BASE);
  git('add', '.');
  git('commit', '-qm', 'base');
  return git('rev-parse', 'HEAD');
}

function sense(baseRef: string) {
  return withAuthorityHostTestScope(() => senseTestWeakening({ cwd: root, baseRef }));
}

describe('test weakening per-assertion identity', () => {
  it('flags an assertion edited in place although the count is unchanged', async () => {
    const base = commitBase();
    writeFileSync(join(root, 'add.test.ts'), BASE.replace('toBe(4)', 'toBeGreaterThan(0)'));
    const reading = await sense(base);
    expect(reading.status).toBe('review');
    expect(reading.findings?.map((f) => [f.file, f.code])).toEqual([
      ['add.test.ts', 'assertion_changed'],
    ]);
    expect(reading.findings?.[0]?.message).toContain('toBe(4)');
    expect(reading.metrics).toEqual({ files_checked: 1, drift_count: 0 });
  });

  it('flags a test skipped without touching its assertions', async () => {
    const base = commitBase();
    writeFileSync(join(root, 'add.test.ts'), BASE.replace("it('adds'", "it.skip('adds'"));
    const reading = await sense(base);
    expect(reading.findings?.map((f) => f.code)).toEqual(['assertion_changed']);
  });

  it('reports a plain removal through the count finding alone', async () => {
    const base = commitBase();
    writeFileSync(join(root, 'add.test.ts'), BASE.replace('  expect(add(2, 2)).toBe(4);\n', ''));
    const reading = await sense(base);
    expect(reading.findings?.map((f) => f.code)).toEqual(['unjustified_weakening']);
  });

  it('passes a change that only adds tests and assertions', async () => {
    const base = commitBase();
    writeFileSync(
      join(root, 'add.test.ts'),
      `${BASE.replace('toBe(4);', 'toBe(4);\n  expect(add(3, 3)).toBe(6);')}it('adds zero', () => expect(add(0, 0)).toBe(0));\n`,
    );
    const reading = await sense(base);
    expect(reading.status).toBe('pass');
    expect(reading.findings).toEqual([]);
  });

  it('judges against the task base, not the previous commit', async () => {
    const base = commitBase();
    writeFileSync(join(root, 'add.test.ts'), BASE.replace('toBe(2)', 'toBeDefined()'));
    git('commit', '-qam', 'edit an assertion');
    writeFileSync(join(root, 'other.ts'), 'export {};\n');
    git('add', '.');
    git('commit', '-qm', 'an unrelated later commit');
    const fromTaskBase = await sense(base);
    expect(fromTaskBase.findings?.map((f) => f.code)).toEqual(['assertion_changed']);
    const fromPrevious = await sense('HEAD~1');
    expect(fromPrevious.findings).toEqual([]);
  });
});
