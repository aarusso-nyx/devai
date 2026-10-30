import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const FIXTURES = resolve(import.meta.dirname, '../fixtures');
const ROOTS = [
  'documentation-authority-baseline',
  'documentation-authority-current-main-baseline',
] as const;
const MANIFEST_SHA256 = '020fb0fda4287889c74d8a977f1f38915569db065e06652b20d2e89da64567eb';
const temporary: string[] = [];
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

function expectedFiles(): Map<string, string> {
  const bytes = readFileSync(join(FIXTURES, 'documentation-authority-integrity.json'));
  assert.equal(sha256(bytes), MANIFEST_SHA256, 'frozen manifest identity');
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  assert(value !== null && typeof value === 'object');
  assert('schemaVersion' in value && value.schemaVersion === '1.0.0');
  assert('roots' in value);
  assert.deepEqual(value.roots, ROOTS);
  assert('files' in value && value.files !== null && typeof value.files === 'object');
  assert(!Array.isArray(value.files));
  const result = new Map<string, string>();
  for (const [path, digest] of Object.entries(value.files)) {
    assert(ROOTS.some((root) => path.startsWith(`${root}/`)) && !path.split('/').includes('..'));
    assert(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest));
    result.set(path, digest);
  }
  assert.equal(result.size, 35);
  assert.equal([...result.keys()].filter((path) => path.startsWith(`${ROOTS[0]}/`)).length, 19);
  assert.equal([...result.keys()].filter((path) => path.startsWith(`${ROOTS[1]}/`)).length, 16);
  return result;
}

function verifyFrozenFiles(base: string): void {
  const expected = expectedFiles();
  const actual: string[] = [];
  function visit(relative: string): void {
    const path = join(base, relative);
    const metadata = lstatSync(path);
    assert(!metadata.isSymbolicLink(), `unexpected symlink: ${relative}`);
    if (metadata.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(`${relative}/${name}`);
      return;
    }
    assert(metadata.isFile(), `unexpected file kind: ${relative}`);
    actual.push(relative);
  }
  for (const root of ROOTS) visit(root);
  assert.deepEqual(actual.sort(), [...expected.keys()].sort(), 'frozen fixture population');
  for (const [path, digest] of expected) {
    assert.equal(sha256(readFileSync(join(base, path))), digest, `frozen fixture bytes: ${path}`);
  }
}

function copiedFixtures(): string {
  const base = mkdtempSync(join(tmpdir(), 'devai-docs-frozen-integrity-'));
  temporary.push(base);
  for (const root of ROOTS) cpSync(join(FIXTURES, root), join(base, root), { recursive: true });
  return base;
}

describe('checksum-controlled documentation authority fixtures', () => {
  it('preserves the exact historical 19 and current-main 16 files and provenance bytes', () => {
    verifyFrozenFiles(FIXTURES);
  });

  it('rejects a changed historical source byte', () => {
    const base = copiedFixtures();
    const path = join(
      base,
      ROOTS[0],
      'canonical/packages/cli/src/authority/documentation-binding.ts',
    );
    writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from('\n')]));
    expect(() => verifyFrozenFiles(base)).toThrow(/frozen fixture bytes:/);
  });

  it('rejects a missing current-main fixture', () => {
    const base = copiedFixtures();
    rmSync(join(base, ROOTS[1], 'canonical/law/constitution.md.txt'));
    expect(() => verifyFrozenFiles(base)).toThrow(/frozen fixture population/);
  });

  it('rejects an extra fixture even when existing hashes remain unchanged', () => {
    const base = copiedFixtures();
    writeFileSync(join(base, ROOTS[0], 'unexpected.ts'), 'export {};\n');
    expect(() => verifyFrozenFiles(base)).toThrow(/frozen fixture population/);
  });

  it('rejects a symlink substituted for a byte-identical fixture', () => {
    const base = copiedFixtures();
    const relative = join(ROOTS[0], 'README.md');
    rmSync(join(base, relative));
    symlinkSync(join(FIXTURES, relative), join(base, relative));
    expect(() => verifyFrozenFiles(base)).toThrow(/unexpected symlink:/);
  });
});
