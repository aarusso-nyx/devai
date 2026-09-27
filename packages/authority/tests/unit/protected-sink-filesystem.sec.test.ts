import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
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
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createProtectedReleaseHostAdapter,
  createProtectedReleaseSinkFilesystem,
  createProtectedReleaseSinkOwner,
  protectedReleaseHostEffect,
  runWithAuthorityHostEffects,
} from '../../src/boundaries/host-effects.js';
import { createIssuer, runtimeApi } from './authority-runtime-testkit.js';
import { createReleaseRepositoryTestFixture } from './release-repository-test-fixture.js';

// Only the read-only Git identity is shared; every case owns its mutable store and handles.
let repository: ReturnType<typeof createReleaseRepositoryTestFixture>;
beforeAll(() => {
  repository = createReleaseRepositoryTestFixture();
});
afterAll(() => repository?.dispose());
const roots: string[] = [];
const READ = constants.O_RDONLY | constants.O_NOFOLLOW;
const WRITE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'sink filesystem ç ')));
  roots.push(parent);
  const root = join(parent, 'store');
  mkdirSync(root, { mode: 0o700 });
  const owner = createProtectedReleaseSinkOwner('certification', 'test-store');
  return { parent, root, owner, fs: createProtectedReleaseSinkFilesystem(root, owner) };
}

async function inSink<T>(
  f: ReturnType<typeof fixture>,
  callback: () => T,
  owner = f.owner,
): Promise<T> {
  const issuer = createIssuer(await runtimeApi());
  try {
    const adapter = createProtectedReleaseHostAdapter({
      action_id: 'release certify',
      repository: repository.repository,
      helper_identity_sha256: 'a'.repeat(64),
      plan_receipt_digest_sha256: 'b'.repeat(64),
      task_policy_digest_sha256: 'c'.repeat(64),
    });
    return await repository.run(() =>
      runWithAuthorityHostEffects(
        {
          action_id: 'release certify',
          invocation_id: 'invocation-1',
          effect: 'local-write',
          receipt_store: issuer,
          apply_effect: (request, apply) => {
            expect(protectedReleaseHostEffect(request)?.kind).toBe('sink');
            return apply();
          },
        },
        () => adapter.invokeSink(callback, owner),
      ),
    );
  } finally {
    issuer.dispose();
  }
}

describe('protected evidence-store filesystem', () => {
  it('reads confined files and closes only its own read descriptors', () => {
    const f = fixture();
    const path = join(f.root, 'report.json');
    writeFileSync(path, '{"complete":true}', { mode: 0o600 });
    expect(f.fs.root).toBe(f.root);
    expect(f.fs.lstatSync(path).isFile()).toBe(true);
    expect(f.fs.readdirSync(f.root)).toEqual(['report.json']);
    expect(
      f.fs.readdirSync(f.root, { withFileTypes: true }).map((entry) => {
        if (typeof entry === 'string') throw Error('directory entry metadata missing');
        return [entry.name, entry.isFile()];
      }),
    ).toEqual([['report.json', true]]);
    expect(f.fs.readFileSync(path).toString()).toBe('{"complete":true}');
    const fd = f.fs.openSync(path, READ);
    expect(f.fs.fstatSync(fd).ino).toBe(statSync(path).ino);
    expect(f.fs.readFileSync(fd).toString()).toBe('{"complete":true}');
    f.fs.closeSync(fd);
    expect(() => f.fs.fstatSync(fd)).toThrow('AUTHORITY_PROTECTED_SINK_DESCRIPTOR_INVALID');
    expect(() => f.fs.closeSync(fd)).toThrow('AUTHORITY_PROTECTED_SINK_DESCRIPTOR_INVALID');
  });

  it('rejects forged owners, shared roots, and nonprivate store permissions', () => {
    const f = fixture();
    expect(() => createProtectedReleaseSinkFilesystem(f.root, {})).toThrow(
      'AUTHORITY_PROTECTED_SINK_OWNER_INVALID',
    );
    const other = join(f.parent, 'other');
    mkdirSync(other, { mode: 0o700 });
    expect(() => createProtectedReleaseSinkFilesystem(other, f.owner)).toThrow(
      'AUTHORITY_PROTECTED_SINK_OWNER_INVALID',
    );
    chmodSync(other, 0o755);
    expect(() =>
      createProtectedReleaseSinkFilesystem(
        other,
        createProtectedReleaseSinkOwner('certification', 'other'),
      ),
    ).toThrow('AUTHORITY_PROTECTED_SINK_ROOT_INVALID');
  });

  it.each(['relative', 'parent', 'unnormalized', 'sibling'])(
    'refuses %s paths without touching outside bytes',
    (kind) => {
      const f = fixture();
      const outside = join(f.parent, 'outside');
      writeFileSync(outside, 'preserve');
      const paths = {
        relative: 'report',
        parent: f.root + '/../outside',
        unnormalized: f.root + '/./report',
        sibling: outside,
      };
      const path = paths[kind as keyof typeof paths];
      expect(() => f.fs.readFileSync(path)).toThrow('AUTHORITY_PROTECTED_SINK_PATH_INVALID');
      expect(() => f.fs.openSync(path, READ)).toThrow('AUTHORITY_PROTECTED_SINK_PATH_INVALID');
      expect(readFileSync(outside, 'utf8')).toBe('preserve');
    },
  );

  it('refuses both leaf and ancestor symlinks', () => {
    const f = fixture();
    const other = join(f.parent, 'outside');
    mkdirSync(other);
    writeFileSync(join(other, 'report'), 'private');
    symlinkSync(other, join(f.root, 'directory-link'));
    symlinkSync(join(other, 'report'), join(f.root, 'file-link'));
    for (const path of [join(f.root, 'directory-link/report'), join(f.root, 'file-link')]) {
      expect(() => f.fs.readFileSync(path)).toThrow('AUTHORITY_PROTECTED_SINK_PATH_INVALID');
      expect(() => f.fs.lstatSync(path)).toThrow('AUTHORITY_PROTECTED_SINK_PATH_INVALID');
    }
  });

  it.each(['permissions', 'inode'])('refuses root %s drift', (kind) => {
    const f = fixture();
    if (kind === 'permissions') chmodSync(f.root, 0o755);
    else {
      renameSync(f.root, join(f.parent, 'old'));
      mkdirSync(f.root, { mode: 0o700 });
    }
    expect(() => f.fs.readdirSync(f.root)).toThrow('AUTHORITY_PROTECTED_SINK_ROOT_INVALID');
  });

  it('refuses descriptors opened by unrelated code', () => {
    const f = fixture();
    const path = join(f.root, 'report');
    writeFileSync(path, 'preserve');
    const fd = openSync(path, 'r');
    try {
      expect(() => f.fs.readFileSync(fd)).toThrow('AUTHORITY_PROTECTED_SINK_DESCRIPTOR_INVALID');
      expect(() => f.fs.closeSync(fd)).toThrow('AUTHORITY_PROTECTED_SINK_DESCRIPTOR_INVALID');
      expect(readFileSync(fd).toString()).toBe('preserve');
    } finally {
      closeSync(fd);
    }
  });

  it('requires the exact exclusive no-follow write flags and private mode', () => {
    const f = fixture();
    const path = join(f.root, 'report');
    for (const flags of [
      constants.O_WRONLY,
      WRITE & ~constants.O_NOFOLLOW,
      WRITE | constants.O_TRUNC,
    ])
      expect(() => f.fs.openSync(path, flags)).toThrow('AUTHORITY_PROTECTED_SINK_OPEN_INVALID');
    expect(() => f.fs.openSync(path, WRITE, 0o644)).toThrow(
      'AUTHORITY_PROTECTED_SINK_OPEN_INVALID',
    );
    expect(() => f.fs.openSync(path, WRITE)).toThrow(
      'AUTHORITY_PROTECTED_SINK_OPERATION_FORBIDDEN',
    );
    expect(existsSync(path)).toBe(false);
  });

  it('writes and links exact private bytes only inside its synchronous owner scope', async () => {
    const f = fixture();
    const dir = join(f.root, 'objects');
    const path = join(dir, 'report');
    await inSink(f, () => {
      f.fs.assertWriteAuthority();
      f.fs.mkdirSync(dir);
      const fd = f.fs.openSync(path, WRITE);
      expect(f.fs.writeSync(fd, Buffer.from('evidence'), 0, 8, null)).toBe(8);
      f.fs.fsyncSync(fd);
      f.fs.closeSync(fd);
      f.fs.linkSync(path, join(dir, 'retained'));
      expect(() => f.fs.openSync(path, WRITE)).toThrow();
    });
    expect(readFileSync(path, 'utf8')).toBe('evidence');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'retained')).ino).toBe(statSync(path).ino);
    expect(() => f.fs.assertWriteAuthority()).toThrow(
      'AUTHORITY_PROTECTED_SINK_OPERATION_FORBIDDEN',
    );
  });

  it('refuses writes through a read descriptor even under valid authority', async () => {
    const f = fixture();
    const path = join(f.root, 'report');
    writeFileSync(path, 'preserve', { mode: 0o600 });
    const fd = f.fs.openSync(path, READ);
    try {
      await inSink(f, () =>
        expect(() => f.fs.writeSync(fd, Buffer.from('x'), 0, 1, 0)).toThrow(
          'AUTHORITY_PROTECTED_SINK_DESCRIPTOR_INVALID',
        ),
      );
      expect(readFileSync(path, 'utf8')).toBe('preserve');
    } finally {
      f.fs.closeSync(fd);
    }
  });

  it('refuses public directories and links from nonprivate files or directories', async () => {
    const f = fixture();
    const publicFile = join(f.root, 'public');
    writeFileSync(publicFile, 'preserve', { mode: 0o644 });
    const destination = join(f.root, 'linked');
    await inSink(f, () => {
      expect(() => f.fs.mkdirSync(join(f.root, 'public-directory'), { mode: 0o755 })).toThrow(
        'AUTHORITY_PROTECTED_SINK_MODE_INVALID',
      );
      for (const source of [publicFile, f.root])
        expect(() => f.fs.linkSync(source, destination)).toThrow(
          'AUTHORITY_PROTECTED_SINK_PATH_INVALID',
        );
    });
    expect(existsSync(destination)).toBe(false);
    expect(existsSync(join(f.root, 'public-directory'))).toBe(false);
    expect(readFileSync(publicFile, 'utf8')).toBe('preserve');
  });

  it('refuses cross-owner access and asynchronous authority escape', async () => {
    const f = fixture();
    await inSink(
      f,
      () =>
        expect(() => f.fs.assertWriteAuthority()).toThrow(
          'AUTHORITY_PROTECTED_SINK_OPERATION_FORBIDDEN',
        ),
      createProtectedReleaseSinkOwner('certification', 'different'),
    );
    await inSink(f, async () => {
      f.fs.assertWriteAuthority();
      await Promise.resolve();
      expect(() => f.fs.assertWriteAuthority()).toThrow(
        'AUTHORITY_PROTECTED_SINK_OPERATION_FORBIDDEN',
      );
    });
  });
});
