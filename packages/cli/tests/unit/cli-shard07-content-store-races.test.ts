import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const faults = vi.hoisted(() => ({
  fstat: undefined as undefined | ((value: Stats) => Stats),
  lstat: undefined as undefined | ((path: string, value: Stats) => Stats),
  readFile: undefined as undefined | ((value: Buffer) => Buffer),
  mkdirError: undefined as undefined | NodeJS.ErrnoException,
  writeResult: undefined as undefined | number,
  linkError: undefined as undefined | NodeJS.ErrnoException,
  linkConcurrentValue: 'different',
  corruptAfterLink: false,
  partialWrites: false,
  writeCalls: 0,
  readdir: undefined as undefined | ((path: string) => void),
  closeCalls: 0,
  fsyncCalls: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    lstatSync: (path: string) => {
      const value = actual.lstatSync(path);
      return faults.lstat?.(path, value) ?? value;
    },
    fstatSync: (fd: number) => {
      const value = actual.fstatSync(fd);
      return faults.fstat?.(value) ?? value;
    },
    readFileSync: (path: Parameters<typeof actual.readFileSync>[0]) => {
      const value = actual.readFileSync(path) as Buffer;
      return faults.readFile?.(value) ?? value;
    },
  };
});

vi.mock('@devai-nyx/authority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@devai-nyx/authority')>();
  const filesystem = await import('node:fs');
  return {
    ...actual,
    createProtectedReleaseSinkFilesystem: () => ({
      closeSync: (fd: number) => {
        faults.closeCalls += 1;
        filesystem.closeSync(fd);
      },
      fsyncSync: (fd: number) => {
        faults.fsyncCalls += 1;
        filesystem.fsyncSync(fd);
      },
      linkSync: (from: string, to: string) => {
        if (faults.linkError !== undefined) {
          filesystem.writeFileSync(to, faults.linkConcurrentValue);
          throw faults.linkError;
        }
        filesystem.linkSync(from, to);
        if (faults.corruptAfterLink) filesystem.writeFileSync(to, 'different');
      },
      mkdirSync: (path: string, options: object) => {
        if (faults.mkdirError !== undefined) throw faults.mkdirError;
        filesystem.mkdirSync(path, options);
      },
      openSync: filesystem.openSync,
      writeSync: (
        fd: number,
        value: Uint8Array,
        offset: number,
        length: number,
        position: number,
      ) =>
        faults.writeResult ??
        filesystem.writeSync(
          fd,
          value,
          offset,
          faults.partialWrites && faults.writeCalls++ === 0 ? 1 : length,
          position,
        ),
      readdirSync: (path: string, options: object) => {
        const result = filesystem.readdirSync(path, options as never);
        faults.readdir?.(path);
        return result;
      },
      assertWriteAuthority: () => undefined,
    }),
  };
});

import { createDurableReleaseContentStore } from '../../src/services/release-content-store.js';

const roots: string[] = [];
const failure = 'release-content-store-race-fixture-failure';

function root(prefix: string): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-`)));
  chmodSync(value, 0o700);
  roots.push(value);
  return value;
}

function fixture(limit = 16) {
  const parent = root('content-store-race');
  const storeRoot = join(parent, 'store');
  const repository = join(parent, 'repository');
  mkdirSync(storeRoot, { mode: 0o700 });
  mkdirSync(repository, { mode: 0o700 });
  mkdirSync(join(storeRoot, 'staging'), { mode: 0o700 });
  mkdirSync(join(storeRoot, 'objects'), { mode: 0o700 });
  const store = createDurableReleaseContentStore(
    {
      root: storeRoot,
      sink_id: 'content-store-races',
      repository_roots: [repository],
      max_blob_bytes: limit,
    },
    () => {
      throw new Error(failure);
    },
    {},
  );
  return { store, storeRoot, parent };
}

function changed(value: Stats, overrides: object): Stats {
  return Object.assign(Object.create(Object.getPrototypeOf(value)), value, overrides) as Stats;
}

describe('CLI shard 07 content-store descriptor and race custody', () => {
  afterEach(() => {
    faults.fstat = undefined;
    faults.lstat = undefined;
    faults.readFile = undefined;
    faults.mkdirError = undefined;
    faults.writeResult = undefined;
    faults.linkError = undefined;
    faults.linkConcurrentValue = 'different';
    faults.corruptAfterLink = false;
    faults.partialWrites = false;
    faults.writeCalls = 0;
    faults.readdir = undefined;
    faults.closeCalls = 0;
    faults.fsyncCalls = 0;
    for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it.each([
    ['non-file path identity', { isFile: () => false }],
    ['oversized path identity', { size: 17 }],
  ])('rejects a %s before opening it', (_label, drift) => {
    const f = fixture();
    const path = join(f.storeRoot, 'objects', 'value');
    writeFileSync(path, 'x');
    faults.lstat = (candidate, value) => (candidate === path ? changed(value, drift) : value);
    expect(() => f.store.read(path)).toThrow(failure);
  });

  it.each([
    ['descriptor type', { isFile: () => false }],
    ['descriptor device', { dev: -1 }],
    ['descriptor inode', { ino: -1 }],
    ['descriptor size', { size: 17 }],
  ])('rejects %s drift between path inspection and the opened descriptor', (_label, drift) => {
    const f = fixture();
    const path = join(f.storeRoot, 'objects', 'value');
    writeFileSync(path, 'x');
    faults.fstat = (value) => changed(value, drift);
    expect(() => f.store.read(path)).toThrow(failure);
    expect(faults.closeCalls).toBe(1);
  });

  it('rejects bytes that exceed the limit after descriptor reading', () => {
    const f = fixture(1);
    const path = join(f.storeRoot, 'objects', 'value');
    writeFileSync(path, 'x');
    faults.readFile = () => Buffer.from('xx');
    expect(() => f.store.read(path)).toThrow(failure);
  });

  it.each([
    ['root ancestor symlink', { isSymbolicLink: () => true }],
    ['root ancestor device', { dev: -1 }],
    ['root ancestor inode', { ino: -1 }],
  ])('rejects %s drift during root checking', (_label, drift) => {
    const f = fixture();
    faults.lstat = (candidate, value) => (candidate === f.parent ? changed(value, drift) : value);
    expect(() => f.store.checkRoot()).toThrow(failure);
  });

  it('rejects root ownership drift after construction', () => {
    const f = fixture();
    faults.lstat = (candidate, value) =>
      candidate === f.storeRoot ? changed(value, { uid: value.uid + 1 }) : value;
    expect(() => f.store.checkRoot()).toThrow(failure);
  });

  it.each([
    ['ancestor symlink', { isSymbolicLink: () => true }],
    ['ancestor device', { dev: -1 }],
    ['ancestor inode', { ino: -1 }],
  ])('rejects %s drift after reading', (_label, drift) => {
    const f = fixture();
    const path = join(f.storeRoot, 'objects', 'value');
    writeFileSync(path, 'x');
    let seen = 0;
    faults.lstat = (candidate, value) => {
      if (candidate === f.storeRoot && ++seen === 3) return changed(value, drift);
      return value;
    };
    expect(() => f.store.read(path)).toThrow(failure);
  });

  it('propagates a non-EEXIST mkdir failure', () => {
    const f = fixture();
    faults.mkdirError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    expect(() => f.store.ensureDirectory(join(f.storeRoot, 'new'))).toThrow('permission denied');
  });

  it('flushes and closes directory descriptors', () => {
    const f = fixture();
    f.store.ensureDirectory(join(f.storeRoot, 'new'));
    expect(faults.fsyncCalls).toBeGreaterThan(0);
    expect(faults.closeCalls).toBeGreaterThan(0);
  });

  it('rejects a non-directory descriptor while flushing', () => {
    const f = fixture();
    faults.fstat = (value) => changed(value, { isDirectory: () => false });
    expect(() => f.store.ensureDirectory(join(f.storeRoot, 'new'))).toThrow(failure);
  });

  it('rejects a non-directory path after mkdir', () => {
    const f = fixture();
    const path = join(f.storeRoot, 'new');
    faults.lstat = (candidate, value) =>
      candidate === path ? changed(value, { isDirectory: () => false }) : value;
    expect(() => f.store.ensureDirectory(path)).toThrow(failure);
  });

  it.each([Number.NaN, 0])('rejects a non-progressing staging write of %s', (written) => {
    const f = fixture();
    faults.writeResult = written;
    expect(() => f.store.install(join(f.storeRoot, 'objects', 'new'), Buffer.from('x'))).toThrow(
      failure,
    );
    expect(faults.closeCalls).toBeGreaterThan(0);
  });

  it('uses the remaining byte count after a partial staging write', () => {
    const f = fixture();
    faults.partialWrites = true;
    expect(() =>
      f.store.install(join(f.storeRoot, 'objects', 'partial'), Buffer.from('abc')),
    ).not.toThrow();
  });

  it('syncs and closes an already installed object descriptor', () => {
    const f = fixture();
    const path = join(f.storeRoot, 'objects', 'existing');
    f.store.install(path, Buffer.from('x'));
    faults.closeCalls = 0;
    faults.fsyncCalls = 0;
    f.store.install(path, Buffer.from('x'));
    expect(faults.fsyncCalls).toBe(2);
    expect(faults.closeCalls).toBe(3);
  });

  it('rejects EEXIST when the concurrently installed bytes differ', () => {
    const f = fixture();
    const path = join(f.storeRoot, 'objects', 'new');
    faults.linkError = Object.assign(new Error('exists'), { code: 'EEXIST' });
    expect(() => f.store.install(path, Buffer.from('x'))).toThrow(
      expect.objectContaining({ code: 'EEXIST' }),
    );
  });

  it('accepts EEXIST when the concurrently installed bytes match', () => {
    const f = fixture();
    const path = join(f.storeRoot, 'objects', 'new');
    faults.linkConcurrentValue = 'x';
    faults.linkError = Object.assign(new Error('exists'), { code: 'EEXIST' });
    expect(() => f.store.install(path, Buffer.from('x'))).not.toThrow();
  });

  it('rejects bytes corrupted after the no-clobber link', () => {
    const f = fixture();
    faults.corruptAfterLink = true;
    expect(() => f.store.install(join(f.storeRoot, 'objects', 'new'), Buffer.from('x'))).toThrow(
      failure,
    );
  });

  it('rejects a mismatching staging read before installation', () => {
    const f = fixture();
    let reads = 0;
    faults.readFile = (value) => (++reads === 1 ? Buffer.from('different') : value);
    expect(() => f.store.install(join(f.storeRoot, 'objects', 'new'), Buffer.from('x'))).toThrow(
      failure,
    );
  });

  it('rejects directory identity drift across listing', () => {
    const f = fixture();
    const path = join(f.storeRoot, 'objects');
    faults.readdir = (candidate) => {
      if (candidate !== path) return;
      const moved = `${path}-moved`;
      roots.push(moved);
      renameSync(path, moved);
      mkdirSync(path, { mode: 0o700 });
    };
    expect(() => f.store.list(path)).toThrow(failure);
  });
});
