import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import {
  ReleaseLifecycleFileStore,
  type ReleaseLifecycleRequest,
} from '../../src/services/release-lifecycle-execution.js';

const interception = vi.hoisted(() => ({
  path: '',
  beforeOpen: undefined as (() => void) | undefined,
  afterOpen: undefined as (() => void) | undefined,
}));
vi.mock('@devai-nyx/authority', async (importOriginal) => {
  const original = await importOriginal<typeof import('@devai-nyx/authority')>();
  return {
    ...original,
    openReadOnlyNoFollowSync: (...args: Parameters<typeof original.openReadOnlyNoFollowSync>) => {
      if (args[0] === interception.path && interception.beforeOpen !== undefined) {
        const callback = interception.beforeOpen;
        interception.beforeOpen = undefined;
        callback();
      }
      const descriptor = original.openReadOnlyNoFollowSync(...args);
      if (args[0] === interception.path && interception.afterOpen !== undefined) {
        const callback = interception.afterOpen;
        interception.afterOpen = undefined;
        callback();
      }
      return descriptor;
    },
  };
});
const roots: string[] = [];
afterEach(() => {
  interception.beforeOpen = undefined;
  interception.path = '';
  interception.afterOpen = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-directory-identity-')));
  roots.push(root);
  const request = (
    JSON.parse(readFileSync('law/schemas/release-lifecycle-request.schema.json', 'utf8')) as {
      examples: ReleaseLifecycleRequest[];
    }
  ).examples[0];
  if (request === undefined) throw new Error('missing canonical request example');
  const store = new ReleaseLifecycleFileStore(root, request);
  await withAuthorityHostTestScope(() => store.initialize());
  return { root, store };
}
describe('release lifecycle directory identity', () => {
  it('permits unrelated child-directory creation between ancestor stat and open', async () => {
    const { root, store } = await fixture();
    const before = lstatSync(root);
    interception.path = root;
    interception.beforeOpen = () => mkdirSync(join(root, 'another-campaign'), { mode: 0o700 });
    await expect(withAuthorityHostTestScope(() => store.initialize())).resolves.toBeUndefined();
    const after = lstatSync(root);
    expect(after.ino).toBe(before.ino);
    expect(after.dev).toBe(before.dev);
    expect(after.nlink).not.toBe(before.nlink);
  });
  it('refuses replacement of a campaign directory between stat and open', async () => {
    const { store } = await fixture();
    interception.path = store.campaignDirectory;
    interception.beforeOpen = () => {
      renameSync(store.campaignDirectory, `${store.campaignDirectory}.replaced`);
      mkdirSync(store.campaignDirectory, { mode: 0o700 });
    };
    await expect(withAuthorityHostTestScope(() => store.initialize())).rejects.toThrow(
      'release-state-store-unsafe',
    );
  });
  it('refuses permission changes between campaign directory stat and open', async () => {
    const { store } = await fixture();
    interception.path = store.campaignDirectory;
    interception.beforeOpen = () => chmodSync(store.campaignDirectory, 0o755);
    await expect(withAuthorityHostTestScope(() => store.initialize())).rejects.toThrow(
      'release-state-store-unsafe',
    );
  });
  it('refuses a directory unlinked after opening its descriptor', async () => {
    const { store } = await fixture();
    interception.path = store.campaignDirectory;
    interception.afterOpen = () => rmSync(store.campaignDirectory, { recursive: true });
    // Some filesystems retain a positive nlink on an open, deleted directory;
    // the subsequent pathname identity check must still refuse its absence.
    await expect(withAuthorityHostTestScope(() => store.initialize())).rejects.toThrow(
      /release-state-store-unsafe|ENOENT/u,
    );
  });
});
