import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const race = vi.hoisted(() => ({
  stageFd: undefined as number | undefined,
  stagePath: undefined as string | undefined,
  expected: Buffer.from('expected'),
  linkCalls: 0,
}));

vi.mock('@devai-nyx/authority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@devai-nyx/authority')>();
  return {
    ...actual,
    createProtectedReleaseSinkFilesystem: () => ({
      closeSync,
      fsyncSync: (fd: number) => {
        fsyncSync(fd);
        if (fd === race.stageFd && race.stagePath !== undefined)
          writeFileSync(race.stagePath, 'corrupt');
      },
      linkSync: (_from: string, to: string) => {
        race.linkCalls += 1;
        writeFileSync(to, race.expected);
        throw Object.assign(new Error('concurrent install'), { code: 'EEXIST' });
      },
      mkdirSync,
      openSync: (path: string, flags: number, mode?: number) => {
        const fd = openSync(path, flags, mode);
        if (path.includes(`${join('', 'staging')}/`)) {
          race.stageFd = fd;
          race.stagePath = path;
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
const failure = 'release-content-store-staging-race-failure';

describe('CLI shard 07 content-store staging race', () => {
  afterEach(() => {
    race.stageFd = undefined;
    race.stagePath = undefined;
    race.linkCalls = 0;
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it('refuses corrupt staging before observing a matching concurrent destination', () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'content-store-staging-race-')));
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
        sink_id: 'content-store-staging-race',
        repository_roots: [repository],
        max_blob_bytes: 64,
      },
      () => {
        throw new Error(failure);
      },
      {},
    );

    expect(() => store.install(join(root, 'objects', 'new'), race.expected)).toThrow(failure);
    expect(race.linkCalls).toBe(0);
  });
});
