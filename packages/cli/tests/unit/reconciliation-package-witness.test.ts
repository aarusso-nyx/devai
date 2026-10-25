import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  unlinkSync,
  renameSync,
  chmodSync,
  utimesSync,
  linkSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { reconciliationPackageWitness } from '../../src/authority/reconciliation-package-witness.js';
const roots: string[] = [];
const sha = (s: Uint8Array | string) => createHash('sha256').update(s).digest('hex');
const fixture = () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'devai-witness-review-')));
  roots.push(top);
  const root = join(top, 'node_modules/rootpkg');
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'rootpkg', version: '1.0.0' }));
  writeFileSync(join(root, 'sub/input.txt'), 'exact');
  utimesSync(join(root, 'sub/input.txt'), 1700000000, 1700000000);
  const files: Record<string, { present: boolean; sha256: string }> = {};
  for (const p of ['package.json', 'sub/input.txt'])
    files[p] = { present: true, sha256: sha(readFileSync(join(root, p))) };
  return {
    top,
    root,
    file: join(root, 'sub/input.txt'),
    bundle: {
      package_root: root,
      packages: { [root]: { files, dependencies: { optionalx: { present: false } } } },
    },
  };
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it.each([
  'samebytes-inode',
  'restored-mtime',
  'chmod-back',
  'nlink',
  'leaf-symlink',
  'parent-symlink',
  'added-file',
  'removed-file',
  'optional-emergence',
])('fresh witness rejects %s and never revives', (kind) => {
  const f = fixture(),
    w = reconciliationPackageWitness(f.bundle);
  w.verify();
  const st = lstatSync(f.file),
    ns = lstatSync(f.file, { bigint: true });
  if (kind === 'samebytes-inode') {
    unlinkSync(f.file);
    writeFileSync(f.file, 'exact');
  }
  if (kind === 'restored-mtime') {
    writeFileSync(f.file, 'other');
    writeFileSync(f.file, 'exact');
    utimesSync(f.file, st.atime, st.mtime);
    expect(lstatSync(f.file, { bigint: true }).mtimeNs).toBe(ns.mtimeNs);
  }
  if (kind === 'chmod-back') {
    chmodSync(f.file, 0o600);
    chmodSync(f.file, Number(st.mode & 0o7777));
  }
  if (kind === 'nlink') linkSync(f.file, join(f.top, 'foreign-link'));
  if (kind === 'leaf-symlink') {
    renameSync(f.file, join(f.top, 'original'));
    symlinkSync(join(f.top, 'original'), f.file);
  }
  if (kind === 'parent-symlink') {
    renameSync(join(f.root, 'sub'), join(f.top, 'saved-sub'));
    symlinkSync(join(f.top, 'saved-sub'), join(f.root, 'sub'));
  }
  if (kind === 'added-file') writeFileSync(join(f.root, 'extra'), 'foreign');
  if (kind === 'removed-file') unlinkSync(f.file);
  if (kind === 'optional-emergence') {
    mkdirSync(join(f.top, 'node_modules/optionalx'));
    writeFileSync(
      join(f.top, 'node_modules/optionalx/package.json'),
      JSON.stringify({ name: 'optionalx', version: '1.0.0' }),
    );
  }
  expect(() => w.verify()).toThrow('AUTHORITY_RECONCILIATION_OPERATION_STALE');
  if (kind === 'added-file') unlinkSync(join(f.root, 'extra'));
  expect(() => w.verify()).toThrow('AUTHORITY_RECONCILIATION_OPERATION_STALE');
  w.dispose();
});
it('cold body mismatch and disposal cannot produce a live cache', () => {
  const f = fixture();
  writeFileSync(f.file, 'other');
  expect(() => reconciliationPackageWitness(f.bundle)).toThrow();
  const g = fixture(),
    w = reconciliationPackageWitness(g.bundle);
  w.dispose();
  expect(() => w.verify()).toThrow();
  expect(() => w.verify()).toThrow();
});
it('unselected hoisted optional manifest rewrite cannot emerge or retarget silently', () => {
  const f = fixture(),
    candidate = join(f.top, 'node_modules/optionalx');
  mkdirSync(candidate);
  writeFileSync(
    join(candidate, 'package.json'),
    JSON.stringify({ name: 'foreignxx', version: '1.0.0' }),
  );
  const resolver = createRequire(join(f.root, 'package.json')),
    resolved = resolver.resolve('optionalx/package.json');
  expect(JSON.parse(readFileSync(resolved, 'utf8')).name).toBe('foreignxx');
  const w = reconciliationPackageWitness(f.bundle),
    before = lstatSync(candidate, { bigint: true });
  writeFileSync(
    join(candidate, 'package.json'),
    JSON.stringify({ name: 'optionalx', version: '1.0.0' }),
  );
  const after = lstatSync(candidate, { bigint: true });
  expect([after.dev, after.ino, after.ctimeNs, after.mtimeNs]).toEqual([
    before.dev,
    before.ino,
    before.ctimeNs,
    before.mtimeNs,
  ]);
  expect(JSON.parse(readFileSync(resolver.resolve('optionalx/package.json'), 'utf8')).name).toBe(
    'optionalx',
  );
  expect(() => w.verify()).toThrow('AUTHORITY_RECONCILIATION_OPERATION_STALE');
});

it.skipIf(process.platform === 'win32')(
  'dispose, stale and late cold failure close every retained readonly FD',
  () => {
    const f = fixture();
    const count = () =>
      readdirSync(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd').length;
    const before = count();
    const w = reconciliationPackageWitness(f.bundle);
    expect(count()).toBe(before + 2);
    w.dispose();
    expect(count()).toBe(before);
    w.dispose();
    expect(count()).toBe(before);
    const x = reconciliationPackageWitness(f.bundle);
    writeFileSync(f.file, 'other');
    expect(() => x.verify()).toThrow();
    expect(count()).toBe(before);
    expect(() => reconciliationPackageWitness(f.bundle)).toThrow();
    expect(count()).toBe(before);
  },
);

it.skipIf(process.platform === 'win32')(
  '8192 readonly descriptor cap refuses larger closure and closes all cold pins',
  () => {
    const f = fixture(),
      empty = sha('');
    const metadata = f.bundle.packages[f.root];
    if (metadata === undefined) throw new Error('Missing fixture package');
    for (let i = 0; i < 8191; i++) {
      const name = 'sub/extra-' + String(i).padStart(5, '0');
      writeFileSync(join(f.root, name), '');
      metadata.files[name] = { present: true, sha256: empty };
    }
    const count = () =>
        readdirSync(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd').length,
      before = count();
    expect(() => reconciliationPackageWitness(f.bundle)).toThrow(
      'AUTHORITY_RECONCILIATION_OPERATION_STALE',
    );
    expect(count()).toBe(before);
  },
  30000,
);

it.each([
  'directory-rename-return',
  'directory-chmod-return',
  'file-add-remove',
  'child-directory-add-remove',
  'two-path-swap-return',
])('unchanged names cannot hide %s directory drift', (kind) => {
  const f = fixture(),
    dir = join(f.root, 'sub'),
    w = reconciliationPackageWitness(f.bundle);
  const before = lstatSync(dir, { bigint: true });
  if (kind === 'directory-rename-return') {
    renameSync(dir, join(f.root, 'moved'));
    renameSync(join(f.root, 'moved'), dir);
  }
  if (kind === 'directory-chmod-return') {
    chmodSync(dir, 0o700);
    chmodSync(dir, Number(before.mode & 0o7777n));
  }
  if (kind === 'file-add-remove') {
    writeFileSync(join(dir, 'transient'), '');
    unlinkSync(join(dir, 'transient'));
  }
  if (kind === 'child-directory-add-remove') {
    mkdirSync(join(dir, 'transient'));
    rmSync(join(dir, 'transient'), { recursive: true });
  }
  if (kind === 'two-path-swap-return') {
    const original = join(dir, 'input.txt'),
      other = join(dir, 'other');
    writeFileSync(other, 'exact');
    renameSync(original, join(dir, 'swap'));
    renameSync(other, original);
    renameSync(join(dir, 'swap'), other);
    unlinkSync(other);
  }
  expect(readdirSync(dir)).toEqual(['input.txt']);
  expect(lstatSync(dir, { bigint: true }).ctimeNs).not.toBe(before.ctimeNs);
  expect(() => w.verify()).toThrow('AUTHORITY_RECONCILIATION_OPERATION_STALE');
  expect(() => w.verify()).toThrow('AUTHORITY_RECONCILIATION_OPERATION_STALE');
  w.dispose();
});
