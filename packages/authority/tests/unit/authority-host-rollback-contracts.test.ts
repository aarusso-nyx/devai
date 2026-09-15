import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyAuthorityHostEffectsAtomically,
  runAuthorityHostEffectsWithRollback,
  type AtomicAuthorityHostEffect,
} from '../../src/boundaries/host-effects.js';

// Rollback contracts written against the retained authority mutation diagnostic (candidate
// 3dfdc316, report 414957d9); mutant ids below are the report's. Every failing effect here
// names a path unrelated to the effect under test, so what is restored is exactly what the
// earlier effect declared, never what the failure happened to mention.

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devai rollback contract ç-'));
  roots.push(root);
  return root;
}
const effect = (
  symbol: string,
  args: readonly unknown[],
  apply: () => unknown,
): AtomicAuthorityHostEffect => ({
  request: { kind: 'filesystem', symbol, arguments: args },
  apply,
});
const failure = new Error('later authorized effect failed');
const failing = (root: string) =>
  effect('writeFileSync', [join(root, 'unrelated failure')], () => {
    throw failure;
  });

describe('atomic unit capture follows the declared target of each effect', () => {
  // Mutant 1332: a copy declares its destination; it is restored even though no later
  // effect names it.
  it('restores a copy destination that only the copy declared', () => {
    const root = fixture(),
      source = join(root, 'source'),
      destination = join(root, 'destination');
    writeFileSync(source, 'source');
    writeFileSync(destination, 'destination');
    expect(() =>
      applyAuthorityHostEffectsAtomically([
        effect('copyFileSync', [source, destination], () => copyFileSync(source, destination)),
        failing(root),
      ]),
    ).toThrow(failure);
    expect(readFileSync(destination, 'utf8')).toBe('destination');
    expect(readFileSync(source, 'utf8')).toBe('source');
  });

  // Mutant 1334: a symlink declares its link path; a link created by the unit is removed
  // even though no later effect names it.
  it('removes a link that only the symlink effect declared', () => {
    const root = fixture(),
      target = join(root, 'target'),
      link = join(root, 'link');
    writeFileSync(target, 'target');
    expect(() =>
      applyAuthorityHostEffectsAtomically([
        effect('symlinkSync', [target, link], () => symlinkSync(target, link)),
        failing(root),
      ]),
    ).toThrow(failure);
    expect(existsSync(link)).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('target');
  });

  // Mutants 1373, 1374: a special file cannot be snapshotted, so the unit is refused before
  // any effect executes rather than blocking on its contents.
  it('refuses a unit naming a FIFO before any effect executes', () => {
    const root = fixture(),
      fifo = join(root, 'fifo');
    execFileSync('mkfifo', [fifo]);
    const apply = vi.fn();
    expect(() =>
      applyAuthorityHostEffectsAtomically([effect('writeFileSync', [fifo], apply)]),
    ).toThrow('AUTHORITY_ATOMIC_SNAPSHOT_SPECIAL_FILE');
    expect(apply).not.toHaveBeenCalled();
  });

  // Mutants 1391, 1392: a removed directory is recreated together with its missing parents
  // when its own snapshot is restored before the parent's.
  it('recreates a removed nested directory whose parent was removed by a later effect', () => {
    const root = fixture(),
      parent = join(root, 'parent'),
      nested = join(parent, 'nested');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'data'), 'nested bytes');
    writeFileSync(join(parent, 'sibling'), 'sibling bytes');
    expect(() =>
      applyAuthorityHostEffectsAtomically([
        effect('rmSync', [nested, { recursive: true }], () => rmSync(nested, { recursive: true })),
        effect('rmSync', [parent, { recursive: true }], () => rmSync(parent, { recursive: true })),
        failing(root),
      ]),
    ).toThrow(failure);
    expect(readFileSync(join(nested, 'data'), 'utf8')).toBe('nested bytes');
    expect(readFileSync(join(parent, 'sibling'), 'utf8')).toBe('sibling bytes');
  });

  // Mutants 1416, 1417: when the snapshot itself cannot be restored, the unit reports the
  // rollback failure rather than the effect's own error. The parent of the captured file is
  // a regular file by then, so the restore fails for any user.
  it('reports a rollback failure when the original bytes cannot be rewritten', () => {
    const root = fixture(),
      directory = join(root, 'parent'),
      file = join(directory, 'file');
    mkdirSync(directory);
    writeFileSync(file, 'original');
    expect(() =>
      applyAuthorityHostEffectsAtomically([
        effect('unlinkSync', [file], () => {
          rmSync(directory, { recursive: true });
          writeFileSync(directory, 'now a file');
        }),
        failing(root),
      ]),
    ).toThrow('AUTHORITY_ATOMIC_ROLLBACK_FAILED');
    expect(readFileSync(directory, 'utf8')).toBe('now a file');
  });
});

describe('projection rollback target validation', () => {
  // Mutant 1422: one empty target among valid ones refuses the whole projection.
  it('refuses an empty target beside a valid one before the callback executes', () => {
    const root = fixture(),
      callback = vi.fn();
    expect(() => runAuthorityHostEffectsWithRollback([join(root, 'file'), ''], callback)).toThrow(
      'AUTHORITY_ROLLBACK_TARGET_INVALID',
    );
    expect(callback).not.toHaveBeenCalled();
  });

  // Mutants 1476, 1477: a projection whose rollback cannot rewrite a target reports the
  // rollback failure.
  it('reports a rollback failure when a restored file cannot be rewritten', () => {
    const root = fixture(),
      directory = join(root, 'parent'),
      file = join(directory, 'file');
    mkdirSync(directory);
    writeFileSync(file, 'original');
    expect(() =>
      runAuthorityHostEffectsWithRollback([file], () => {
        rmSync(directory, { recursive: true });
        writeFileSync(directory, 'now a file');
        throw failure;
      }),
    ).toThrow('AUTHORITY_ATOMIC_ROLLBACK_FAILED');
    expect(readFileSync(directory, 'utf8')).toBe('now a file');
  });
});
