import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  capturePackage: vi.fn(),
  captureCandidate: vi.fn(),
  registerHooks: vi.fn(),
  hooks: [] as Array<{
    resolve: (
      specifier: string,
      context: { parentURL?: string },
      next: (...args: unknown[]) => unknown,
    ) => unknown;
    load: (url: string, context: unknown, next: (...args: unknown[]) => unknown) => unknown;
  }>,
  entryLoads: [] as unknown[],
}));

vi.mock('../../src/services/release-policy-host-snapshot.js', () => ({
  captureReleaseHostPackage: mocks.capturePackage,
  captureReleaseHostCandidate: mocks.captureCandidate,
}));
vi.mock('node:module', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:module')>()),
  registerHooks: mocks.registerHooks,
}));

import { bootstrapReleaseHost } from '../../src/release-host-bootstrap.js';

const roots: string[] = [];
const ENTRY = 'dist/runtime/index/release-host.js';

function installation(source: string) {
  const root = mkdtempSync(join(tmpdir(), 'devai-bootstrap-depth-'));
  roots.push(root);
  mkdirSync(join(root, 'dist/runtime/index'), { recursive: true });
  writeFileSync(join(root, ENTRY), source);
  const bytes = Buffer.from(source);
  const snapshot = {
    read: vi.fn((path: string) => {
      if (path !== ENTRY) throw new Error(`unexpected read: ${path}`);
      return bytes;
    }),
  };
  const verificationInput = { root, manifest: [] };
  const capture = {
    root,
    snapshot,
    readVerificationInput: vi.fn(() => verificationInput),
  };
  mocks.capturePackage.mockReturnValue(capture);
  const entryUrl = pathToFileURL(join(root, ENTRY)).href;
  mocks.registerHooks.mockImplementation((hooks) => {
    mocks.hooks.push(hooks);
    mocks.entryLoads.push(hooks.load(entryUrl, {}, vi.fn()));
    return { deregister: vi.fn() };
  });
  return { root, snapshot, verificationInput, capture };
}

const VALID_RUNTIME = `
  export function verifyReleasePackageSnapshot(input) {
    return Object.freeze({ verified: true, root: input.root });
  }
  export function bindReleaseHostPackageSnapshot(snapshot) {
    if (snapshot.verified !== true) throw new Error('unverified');
  }
  export function verifyReleaseCandidateSnapshot(input) {
    return Object.freeze({ verifiedCandidate: input });
  }
`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hooks.length = 0;
  mocks.entryLoads.length = 0;
  mocks.captureCandidate.mockImplementation((input) => ({ captured: input }));
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('release host bootstrap depth', () => {
  it('loads exact captured entry bytes, binds its verified package, and verifies candidates', async () => {
    const fixture = installation(VALID_RUNTIME);
    const controls = { packageRoot: fixture.root };
    const session = await bootstrapReleaseHost(controls as never);
    expect(mocks.capturePackage).toHaveBeenCalledWith(controls);
    expect(fixture.snapshot.read).toHaveBeenCalledWith(ENTRY);
    expect(mocks.entryLoads[0]).toEqual({
      format: 'module',
      source: Buffer.from(VALID_RUNTIME),
      shortCircuit: true,
    });
    expect(fixture.capture.readVerificationInput).toHaveBeenCalledTimes(1);
    expect(session.installed_package).toMatchObject({ verified: true, root: fixture.root });
    expect(Object.isFrozen(session)).toBe(true);

    const candidateControls = { repositoryRoot: '/candidate' };
    expect(session.collectCandidate(candidateControls as never)).toEqual({
      verifiedCandidate: { captured: candidateControls },
    });
    expect(mocks.captureCandidate).toHaveBeenCalledWith(candidateControls);

    const hooks = mocks.hooks[0];
    if (hooks === undefined) throw new Error('loader hooks missing');
    const nextResolve = vi.fn(() => ({ url: 'file:///outside/next.js' }));
    expect(hooks.resolve('fs', { parentURL: 'file:///outside/main.js' }, nextResolve)).toEqual({
      url: 'node:fs',
      shortCircuit: true,
    });
    expect(
      hooks.resolve('node:path', { parentURL: 'file:///outside/main.js' }, nextResolve),
    ).toEqual({ url: 'node:path', shortCircuit: true });
    const entryUrl = pathToFileURL(join(fixture.root, ENTRY)).href;
    expect(hooks.resolve(entryUrl, { parentURL: 'file:///outside/main.js' }, nextResolve)).toEqual({
      url: entryUrl,
      shortCircuit: true,
    });
    expect(hooks.resolve('/outside.js', {}, nextResolve)).toEqual({
      url: 'file:///outside/next.js',
    });
    expect(
      hooks.resolve('./next.js', { parentURL: 'file:///outside/main.js' }, nextResolve),
    ).toEqual({
      url: 'file:///outside/next.js',
    });
    expect(hooks.resolve('./next.js', {}, nextResolve)).toEqual({
      url: 'file:///outside/next.js',
    });
    expect(
      hooks.load(
        'file:///outside.js',
        {},
        vi.fn(() => ({ format: 'module' })),
      ),
    ).toEqual({
      format: 'module',
    });
    expect(() => hooks.resolve('external', { parentURL: entryUrl }, nextResolve)).toThrow(
      'rpl-package-identity-mismatch',
    );
    expect(() =>
      hooks.resolve(
        join(fixture.root, 'other.js'),
        { parentURL: 'file:///outside.js' },
        nextResolve,
      ),
    ).toThrow('rpl-package-identity-mismatch');
    expect(() =>
      hooks.resolve(
        pathToFileURL(join(fixture.root, 'other.js')).href,
        { parentURL: 'file:///outside.js' },
        nextResolve,
      ),
    ).toThrow('rpl-package-identity-mismatch');
    expect(() =>
      hooks.resolve(
        './other.js',
        { parentURL: pathToFileURL(join(fixture.root, 'parent.js')).href },
        nextResolve,
      ),
    ).toThrow('rpl-package-identity-mismatch');
    expect(
      hooks.resolve(
        'bare-package',
        { parentURL: pathToFileURL(join(fixture.root, 'parent.js')).href },
        nextResolve,
      ),
    ).toEqual({ url: 'file:///outside/next.js' });
    expect(() =>
      hooks.load(pathToFileURL(join(fixture.root, 'other.js')).href, {}, vi.fn()),
    ).toThrow('rpl-package-identity-mismatch');

    await expect(bootstrapReleaseHost(controls as never)).rejects.toThrow(
      'rpl-package-identity-mismatch',
    );
  });

  it('refuses protected relative imports even when their files exist', async () => {
    const fixture = installation(`import './dependency.js'; ${VALID_RUNTIME}`);
    writeFileSync(
      join(fixture.root, 'dist/runtime/index/dependency.js'),
      'export const value = 1;',
    );
    const entryUrl = pathToFileURL(join(fixture.root, ENTRY)).href;
    let protectedImportRefused = false;
    mocks.registerHooks.mockImplementationOnce((hooks) => {
      mocks.hooks.push(hooks);
      hooks.load(entryUrl, {}, vi.fn());
      try {
        hooks.resolve('./dependency.js', { parentURL: entryUrl }, vi.fn());
      } catch {
        protectedImportRefused = true;
      }
      return { deregister: vi.fn() };
    });
    await expect(bootstrapReleaseHost({ packageRoot: fixture.root } as never)).rejects.toThrow(
      'rpl-package-identity-mismatch',
    );
    expect(protectedImportRefused).toBe(true);
  });

  it('sanitizes capture and runtime-verification failures', async () => {
    mocks.capturePackage.mockImplementationOnce(() => {
      throw new Error('/secret/rejected-member.js');
    });
    await expect(bootstrapReleaseHost({ packageRoot: '/secret' } as never)).rejects.toThrow(
      'rpl-package-identity-mismatch',
    );

    const fixture = installation(`
      export function verifyReleasePackageSnapshot() { throw new Error('native details'); }
      export function bindReleaseHostPackageSnapshot() {}
      export function verifyReleaseCandidateSnapshot() {}
    `);
    await expect(bootstrapReleaseHost({ packageRoot: fixture.root } as never)).rejects.toThrow(
      'rpl-package-identity-mismatch',
    );
    const hooks = mocks.hooks.at(-1);
    if (hooks === undefined) throw new Error('failed loader hooks missing');
    const entryUrl = pathToFileURL(join(fixture.root, ENTRY)).href;
    const subjectUrl = pathToFileURL(
      join(process.cwd(), 'packages/cli/src/release-host-bootstrap.ts'),
    ).href;
    expect(() => hooks.resolve(entryUrl, { parentURL: subjectUrl }, vi.fn())).toThrow(
      'rpl-package-identity-mismatch',
    );
    expect(() => hooks.load(entryUrl, {}, vi.fn())).toThrow('rpl-package-identity-mismatch');
  });

  it('refuses a runtime import that bypasses the registered load hook', async () => {
    const fixture = installation(VALID_RUNTIME);
    mocks.registerHooks.mockImplementationOnce((hooks) => {
      mocks.hooks.push(hooks);
      return { deregister: vi.fn() };
    });
    await expect(bootstrapReleaseHost({ packageRoot: fixture.root } as never)).rejects.toThrow(
      'rpl-package-identity-mismatch',
    );
  });

  it('allows only the bootstrap module to resolve the entry before readiness', async () => {
    const fixture = installation(VALID_RUNTIME);
    const entryUrl = pathToFileURL(join(fixture.root, ENTRY)).href;
    let wrongParentAccepted = false;
    mocks.registerHooks.mockImplementationOnce((hooks) => {
      mocks.hooks.push(hooks);
      try {
        hooks.resolve(entryUrl, { parentURL: 'file:///outside.js' }, vi.fn());
        wrongParentAccepted = true;
      } catch {
        // Expected while the captured runtime has not completed verification.
      }
      mocks.entryLoads.push(hooks.load(entryUrl, {}, vi.fn()));
      return { deregister: vi.fn() };
    });
    await expect(bootstrapReleaseHost({ packageRoot: fixture.root } as never)).rejects.toThrow(
      'rpl-package-identity-mismatch',
    );
    expect(wrongParentAccepted).toBe(false);
  });

  it('activates bootstrap constants through a fresh module instance', async () => {
    const fixture = installation(VALID_RUNTIME);
    vi.resetModules();
    // @ts-expect-error the query creates a distinct ESM identity for static mutation activation
    const fresh = await import('../../src/release-host-bootstrap.js?fresh-bootstrap-depth');
    await expect(fresh.bootstrapReleaseHost({ packageRoot: fixture.root })).resolves.toBeDefined();
    expect(fixture.snapshot.read).toHaveBeenCalledWith(ENTRY);
    mocks.capturePackage.mockImplementationOnce(() => {
      throw new Error('sensitive detail');
    });
    await expect(fresh.bootstrapReleaseHost({ packageRoot: '/rejected' })).rejects.toThrow(
      'rpl-package-identity-mismatch',
    );
  });
});
