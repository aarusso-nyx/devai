import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseSourceManifest } from '../../src/commands/source/manifest.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const input = (changes: Record<string, unknown> = {}) =>
  JSON.stringify({
    schemaVersion: '1.0.0',
    target: 'packages/example/src/a.ts',
    expected: { kind: 'absent' },
    content_utf8: 'hello\n',
    content_sha256: sha('hello\n'),
    ...changes,
  });

describe('source manifest data boundary', () => {
  it('accepts immutable create and replacement descriptions', () => {
    const created = parseSourceManifest(input());
    expect(created.target).toBe('packages/example/src/a.ts');
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.expected)).toBe(true);
    expect(
      parseSourceManifest(input({ expected: { kind: 'file', sha256: sha('old'), mode: 0o755 } }))
        .expected,
    ).toEqual({ kind: 'file', sha256: sha('old'), mode: 0o755 });
  });
  it.each([
    '/a',
    'a//b',
    'a/../b',
    './a',
    'a\\b',
    'a\0b',
    '.git/config',
    'a/.git/config',
    '.devai/config/a',
    'record/a',
  ])('rejects unsafe target %s', (target) => {
    expect(() => parseSourceManifest(input({ target }))).toThrow('SOURCE_MANIFEST_INVALID');
  });
  it('rejects invented authority, invalid preimages, wrong digests and unpaired surrogates', () => {
    for (const change of [
      { role: 'engineer' },
      { expected: { kind: 'absent', mode: 0 } },
      { expected: { kind: 'file', sha256: sha('old'), mode: 0o1000 } },
      { content_sha256: sha('different') },
      { content_utf8: '\ud800', content_sha256: sha('\ud800') },
    ])
      expect(() => parseSourceManifest(input(change))).toThrow('SOURCE_MANIFEST_INVALID');
  });
});
