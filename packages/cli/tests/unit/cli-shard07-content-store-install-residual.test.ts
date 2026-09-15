import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({
  corruptStage: false,
  stageFd: undefined as number | undefined,
  stagePath: undefined as string | undefined,
  expected: Buffer.alloc(0),
  linkError: undefined as NodeJS.ErrnoException | undefined,
  concurrent: Buffer.alloc(0),
}));

vi.mock('@devai-nyx/authority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@devai-nyx/authority')>();
  return {
    ...actual,
    createProtectedReleaseSinkFilesystem: () => ({
      closeSync,
      fsyncSync: (fd: number) => {
        fsyncSync(fd);
        if (controls.corruptStage && fd === controls.stageFd && controls.stagePath !== undefined)
          writeFileSync(controls.stagePath, 'corrupt');
      },
      linkSync: (from: string, to: string) => {
        if (controls.corruptStage) writeFileSync(from, controls.expected);
        if (controls.linkError !== undefined) {
          writeFileSync(to, controls.concurrent);
          throw controls.linkError;
        }
        linkSync(from, to);
      },
      mkdirSync,
      openSync: (path: string, flags: number, mode?: number) => {
        const fd = openSync(path, flags, mode);
        if (path.includes(`${join('', 'staging')}/`)) {
          controls.stageFd = fd;
          controls.stagePath = path;
        }
        return fd;
      },
      writeSync,
      readdirSync,
      assertWriteAuthority: () => undefined,
    }),
  };
});

import { createDurableReleaseContentStore } from '../../src/services/release-content-store.js';

const cleanup: string[] = [];
const failure = 'release-content-store-install-residual-failure';

function fixture() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'content-store-install-residual-')));
  chmodSync(parent, 0o700);
  cleanup.push(parent);
  const root = join(parent, 'store');
  const repository = join(parent, 'repository');
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(repository, { mode: 0o700 });
  mkdirSync(join(root, 'staging'), { mode: 0o700 });
  mkdirSync(join(root, 'objects'), { mode: 0o700 });
  const store = createDurableReleaseContentStore(
    {
      root,
      sink_id: 'content-store-install-residual',
      repository_roots: [repository],
      max_blob_bytes: 64,
    },
    () => {
      throw new Error(failure);
    },
    {},
  );
  return { root, store };
}

describe('CLI shard 07 content-store install residuals', () => {
  afterEach(() => {
    controls.corruptStage = false;
    controls.stageFd = undefined;
    controls.stagePath = undefined;
    controls.expected = Buffer.alloc(0);
    controls.linkError = undefined;
    controls.concurrent = Buffer.alloc(0);
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it('refuses oversized bytes without creating a staging object', () => {
    const f = fixture();
    expect(() => f.store.install(join(f.root, 'objects', 'oversized'), Buffer.alloc(65))).toThrow(
      failure,
    );
    expect(readdirSync(join(f.root, 'staging'))).toHaveLength(0);
  });

  it('refuses corrupted staging bytes before a repairable link', () => {
    const f = fixture();
    controls.corruptStage = true;
    controls.expected = Buffer.from('expected');
    expect(() => f.store.install(join(f.root, 'objects', 'new'), controls.expected)).toThrow(
      failure,
    );
  });

  it('accepts a concurrent EEXIST installation with identical bytes', () => {
    const f = fixture();
    controls.concurrent = Buffer.from('expected');
    controls.linkError = Object.assign(new Error('concurrent install'), { code: 'EEXIST' });
    expect(() =>
      f.store.install(join(f.root, 'objects', 'new'), Buffer.from('expected')),
    ).not.toThrow();
  });

  it('preserves EEXIST when concurrent bytes differ', () => {
    const f = fixture();
    controls.concurrent = Buffer.from('different');
    controls.linkError = Object.assign(new Error('concurrent install'), { code: 'EEXIST' });
    expect(() => f.store.install(join(f.root, 'objects', 'new'), Buffer.from('expected'))).toThrow(
      expect.objectContaining({ code: 'EEXIST' }),
    );
  });

  it('preserves a non-EEXIST link failure', () => {
    const f = fixture();
    controls.concurrent = Buffer.from('expected');
    controls.linkError = Object.assign(new Error('link denied'), { code: 'EACCES' });
    expect(() => f.store.install(join(f.root, 'objects', 'new'), Buffer.from('expected'))).toThrow(
      expect.objectContaining({ code: 'EACCES' }),
    );
  });

  it('reads installed bytes after the no-clobber link', () => {
    const f = fixture();
    const path = join(f.root, 'objects', 'new');
    f.store.install(path, Buffer.from('expected'));
    expect(readFileSync(path)).toEqual(Buffer.from('expected'));
  });
});
