import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
const { readPinnedNpmCache } = await import(
  pathToFileURL(resolve('scripts/release-host/npm-cache.mjs')).href
);
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-npm-cache-')));
  temporary.push(root);
  const repository = join(root, 'candidate'),
    directory = join(root, 'cache'),
    manifest = join(root, 'manifest.json');
  mkdirSync(repository);
  mkdirSync(directory);
  const content = 'pinned package cache bytes';
  writeFileSync(join(directory, 'content'), content);
  writeFileSync(
    manifest,
    JSON.stringify({
      files: [{ path: 'content', sha256: sha(content), size: Buffer.byteLength(content) }],
    }),
  );
  return {
    repository,
    directory,
    manifest,
    content,
    control: { directory, manifest, manifest_sha256: sha(readFileSync(manifest)) },
  };
}
it('retains exact pinned bytes without editing the seed', () => {
  const f = fixture(),
    result = readPinnedNpmCache(f.control, f.repository);
  expect(result.entries).toEqual([
    { path: '.devai-npm-cache/content', mode: '100644', bytes: Buffer.from(f.content) },
  ]);
  expect(readFileSync(join(f.directory, 'content'), 'utf8')).toBe(f.content);
  expect(readPinnedNpmCache(undefined, f.repository)).toBeUndefined();
});
it('refuses changed, extra, missing, oversized and unpinned inputs', () => {
  const f = fixture();
  expect(() =>
    readPinnedNpmCache({ ...f.control, manifest_sha256: '0'.repeat(64) }, f.repository),
  ).toThrow();
  expect(() => readPinnedNpmCache(f.control, f.repository, 1)).toThrow();
  writeFileSync(join(f.directory, 'extra'), 'unexpected');
  expect(() => readPinnedNpmCache(f.control, f.repository)).toThrow();
  rmSync(join(f.directory, 'extra'));
  writeFileSync(join(f.directory, 'content'), 'tampered');
  expect(() => readPinnedNpmCache(f.control, f.repository)).toThrow();
  rmSync(join(f.directory, 'content'));
  expect(() => readPinnedNpmCache(f.control, f.repository)).toThrow();
});
it('refuses links and candidate-owned cache selection', () => {
  const f = fixture();
  rmSync(join(f.directory, 'content'));
  symlinkSync(f.manifest, join(f.directory, 'content'));
  expect(() => readPinnedNpmCache(f.control, f.repository)).toThrow();
  expect(() =>
    readPinnedNpmCache({ ...f.control, directory: f.repository }, f.repository),
  ).toThrow();
});
