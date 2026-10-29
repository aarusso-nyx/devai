import { createHash } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { publishSourceFile } from '../../src/boundaries/host-source-publish.js';
import { publishSourceFileSync } from '../../src/boundaries/host-effects.js';

const roots: string[] = [];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const root = () => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'devai-source-')));
  roots.push(path);
  return path;
};
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
describe('source publication', () => {
  it('refuses the guarded entry point without an invocation scope', () => {
    const dir = root();
    expect(() =>
      publishSourceFileSync({
        root: dir,
        target: 'a',
        expected: { kind: 'absent' },
        content: 'one',
        sha256: hash('one'),
      }),
    ).toThrow();
  });
  it('creates without replacement and preserves mode when replacing', () => {
    const dir = root();
    publishSourceFile({
      root: dir,
      target: 'a',
      expected: { kind: 'absent' },
      content: 'one',
      sha256: hash('one'),
    });
    expect(readFileSync(join(dir, 'a'), 'utf8')).toBe('one');
    expect(() =>
      publishSourceFile({
        root: dir,
        target: 'a',
        expected: { kind: 'absent' },
        content: 'two',
        sha256: hash('two'),
      }),
    ).toThrow();
    chmodSync(join(dir, 'a'), 0o755);
    publishSourceFile({
      root: dir,
      target: 'a',
      expected: { kind: 'file', mode: 0o755, sha256: hash('one') },
      content: 'two',
      sha256: hash('two'),
    });
    expect(readFileSync(join(dir, 'a'), 'utf8')).toBe('two');
    expect(statSync(join(dir, 'a')).mode & 0o777).toBe(0o755);
  });
  it('rejects wrong preimage and linked files without altering them', () => {
    const dir = root();
    const file = join(dir, 'a');
    writeFileSync(file, 'one');
    expect(() =>
      publishSourceFile({
        root: dir,
        target: 'a',
        expected: { kind: 'file', mode: 0o644, sha256: hash('bad') },
        content: 'two',
        sha256: hash('two'),
      }),
    ).toThrow();
    linkSync(file, join(dir, 'other'));
    expect(() =>
      publishSourceFile({
        root: dir,
        target: 'a',
        expected: { kind: 'file', mode: 0o644, sha256: hash('one') },
        content: 'two',
        sha256: hash('two'),
      }),
    ).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('one');
    symlinkSync(file, join(dir, 'link'));
    expect(() =>
      publishSourceFile({
        root: dir,
        target: 'link',
        expected: { kind: 'file', mode: 0o644, sha256: hash('one') },
        content: 'two',
        sha256: hash('two'),
      }),
    ).toThrow();
  });
  it('refuses an observed pre-publication change and preserves a later foreign write', () => {
    const dir = root();
    const path = join(dir, 'a');
    writeFileSync(path, 'one');
    const request = {
      root: dir,
      target: 'a',
      expected: { kind: 'file' as const, mode: 0o644, sha256: hash('one') },
      content: 'two',
      sha256: hash('two'),
    };
    expect(() =>
      publishSourceFile(request, { beforeFinalCheck: () => writeFileSync(path, 'NEW') }),
    ).toThrow('SOURCE_PUBLICATION_CONFLICT');
    expect(readFileSync(path, 'utf8')).toBe('NEW');
    writeFileSync(path, 'one');
    expect(() =>
      publishSourceFile(request, {
        afterPublish: () => {
          writeFileSync(path, 'foreign');
          throw new Error('simulated fault');
        },
      }),
    ).toThrow('SOURCE_PUBLICATION_INDETERMINATE');
    expect(readFileSync(path, 'utf8')).toBe('foreign');
  });
  it('refuses an observed parent swap and reports the retained stage without touching the other directory', () => {
    const dir = root();
    mkdirSync(join(dir, 'parent'));
    mkdirSync(join(dir, 'other'));
    expect(() =>
      publishSourceFile(
        {
          root: dir,
          target: 'parent/a',
          expected: { kind: 'absent' },
          content: 'one',
          sha256: hash('one'),
        },
        {
          beforeFinalCheck: () => {
            renameSync(join(dir, 'parent'), join(dir, 'moved'));
            symlinkSync(join(dir, 'other'), join(dir, 'parent'));
          },
        },
      ),
    ).toThrow('SOURCE_PUBLICATION_STAGING_REMAINS');
    expect(() => readFileSync(join(dir, 'other/a'))).toThrow();
  });
});
