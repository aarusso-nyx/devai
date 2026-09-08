import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock('@devai-nyx/authority', async (original) => ({
  ...(await original<typeof import('@devai-nyx/authority')>()),
  execFileSync: host.execFileSync,
}));
import { senseTestWeakening } from '../../src/test-weakening.js';

let root: string;
const base = new Map<string, string>();
const absent = new Set<string>();
const faults = new Map<string, Error>();
const assertions = (count: number) =>
  Array.from({ length: count }, (_, i) => `expect(${i}).toBe(${i});`).join('\n');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-weakening-evidence-'));
  base.clear();
  absent.clear();
  faults.clear();
  host.execFileSync.mockReset();
  host.execFileSync.mockImplementation(
    (command: string, args: string[], options: { cwd: string }) => {
      expect(command).toBe('git');
      expect(options.cwd).toBe(root);
      const operation = args[0];
      if (operation === undefined) throw new Error('Missing Git operation');
      if (faults.has(operation)) throw faults.get(operation);
      if (args[0] === 'diff') return [...base.keys()].join('\n') + '\n';
      if (args[0] === 'show') {
        const object = args[1];
        if (object === undefined) throw new Error('Missing Git object');
        const path = object.slice(object.indexOf(':') + 1);
        if (!base.has(path)) throw new Error('base blob unavailable');
        return base.get(path);
      }
      if (args[0] === 'ls-tree') {
        const path = args.at(-1);
        if (path === undefined) throw new Error('Missing Git path');
        return absent.has(path) ? '' : path + '\0';
      }
      throw new Error(`Unexpected Git operation ${args.join(' ')}`);
    },
  );
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

function file(name: string, before: string, after: string) {
  base.set(name, before);
  writeFileSync(join(root, name), after);
}

describe('test weakening compares actual evidence through the guarded host seam', () => {
  it.each([
    [10, 10, 'pass', undefined],
    [10, 11, 'pass', undefined],
    [10, 9, 'review', 'weakening'],
    [10, 8, 'review', 'weakening'],
    [10, 7, 'fail', 'unjustified_weakening'],
    [0, 1, 'pass', undefined],
  ] as const)('classifies %i to %i assertions as %s', (before, after, status, code) => {
    file('case.test.ts', assertions(before), assertions(after));
    const reading = senseTestWeakening({ cwd: root });
    expect(reading.status).toBe(status);
    expect(reading.metrics).toEqual({ files_checked: 1, drift_count: code ? 1 : 0 });
    expect(reading.findings?.map((f) => f.code)).toEqual(code ? [code] : []);
    expect(host.execFileSync).toHaveBeenCalledWith(
      'git',
      ['diff', '--name-only', 'HEAD~1', '--', '*.test.ts', '*.spec.ts'],
      { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
    );
  });

  it('uses an explicit threshold and reports all independent file decreases', () => {
    file('a.test.ts', assertions(4), assertions(3));
    file('b.spec.ts', assertions(4), assertions(2));
    const reading = senseTestWeakening({
      cwd: root,
      baseRef: 'approved-base',
      thresholdRatio: 0.25,
      files: ['a.test.ts', 'b.spec.ts'],
    });
    expect(reading.status).toBe('fail');
    expect(reading.metrics).toEqual({ files_checked: 2, drift_count: 2 });
    expect(reading.findings?.map((f) => [f.file, f.code, f.severity])).toEqual([
      ['a.test.ts', 'weakening', 'warning'],
      ['b.spec.ts', 'unjustified_weakening', 'error'],
    ]);
    expect(host.execFileSync).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['diff']),
      expect.anything(),
    );
  });

  it('counts nested expect calls and exact skip annotations without counting lookalikes', () => {
    file(
      'case.test.ts',
      `describe('nested', () => { ${assertions(5)} }); obj.expect(1); other(1);`,
      `it.skip('a', () => {}); it.todo('b'); describe.only('c', () => {}); test.skip('ignored'); it.elsewhere('ignored'); ${assertions(3)}`,
    );
    const reading = senseTestWeakening({ cwd: root, files: ['case.test.ts'] });
    expect(reading.findings).toEqual([
      {
        severity: 'error',
        code: 'unjustified_weakening',
        file: 'case.test.ts',
        message: 'assertions 5 → 3 (decrease ratio 0.40); skip delta 3',
      },
    ]);
  });

  it('does not call a denied base read a successful comparison', () => {
    faults.set('show', new Error('AUTHORITY_FINAL_BOUNDARY_REQUIRED'));
    faults.set('ls-tree', new Error('AUTHORITY_FINAL_BOUNDARY_REQUIRED'));
    const reading = senseTestWeakening({ cwd: root, files: ['existing.test.ts'] });
    expect(reading.status).toBe('error');
    expect(reading.metrics?.files_checked).toBe(0);
    expect(reading.findings?.map((f) => f.code)).toEqual(['git_base_read_failed']);
  });

  it('skips a new file only after Git confirms its absence in the base tree', () => {
    absent.add('new.test.ts');
    writeFileSync(join(root, 'new.test.ts'), assertions(3));
    const reading = senseTestWeakening({ cwd: root, files: ['new.test.ts'] });
    expect(reading.status).toBe('pass');
    expect(reading.findings).toEqual([]);
    expect(reading.metrics).toEqual({ files_checked: 0, drift_count: 0 });
    expect(host.execFileSync).toHaveBeenCalledWith(
      'git',
      ['ls-tree', '-z', '--name-only', 'HEAD~1', '--', 'new.test.ts'],
      expect.anything(),
    );
  });

  it('reports an unreadable existing base blob independently of a valid comparison', () => {
    file('valid.test.ts', assertions(5), assertions(4));
    const reading = senseTestWeakening({ cwd: root, files: ['broken.test.ts', 'valid.test.ts'] });
    expect(reading.status).toBe('error');
    expect(reading.findings?.map((f) => f.code)).toEqual(['git_base_read_failed', 'weakening']);
    expect(reading.metrics).toEqual({ files_checked: 1, drift_count: 1 });
  });

  it('detects removal of an existing test file as complete assertion loss', () => {
    base.set('deleted.test.ts', assertions(2));
    const reading = senseTestWeakening({ cwd: root, files: ['deleted.test.ts'] });
    expect(reading.status).toBe('fail');
    expect(reading.findings?.[0]?.message).toBe(
      'assertions 2 → 0 (decrease ratio 1.00); skip delta 0',
    );
  });

  it('reports an unreadable current file rather than silently passing', () => {
    base.set('.', assertions(2));
    const reading = senseTestWeakening({ cwd: root, files: ['.'] });
    expect(reading.status).toBe('error');
    expect(reading.findings?.map((f) => f.code)).toEqual(['head_read_failed']);
    expect(reading.metrics?.files_checked).toBe(0);
  });

  it('reports failure to infer files and retains the exact requested base identity', () => {
    faults.set('diff', new Error('authority refused'));
    const reading = senseTestWeakening({ cwd: root, baseRef: 'exact-base', files: [] });
    expect(reading.status).toBe('error');
    expect(reading.metrics).toBeUndefined();
    expect(reading.command).toBe('devai sense test-weakening --base-ref exact-base');
    expect(reading.findings).toEqual([
      { severity: 'critical', code: 'git_diff_failed', message: 'authority refused' },
    ]);
  });

  it('records separate observations when the clock advances', () => {
    file('case.test.ts', assertions(1), assertions(1));
    vi.useFakeTimers();
    vi.setSystemTime('2026-09-08T12:00:00Z');
    const first = senseTestWeakening({ cwd: root });
    vi.setSystemTime('2026-09-08T12:00:00.001Z');
    const second = senseTestWeakening({ cwd: root });
    expect(first.id).not.toBe(second.id);
    expect(first.findings).toEqual(second.findings);
  });
});
