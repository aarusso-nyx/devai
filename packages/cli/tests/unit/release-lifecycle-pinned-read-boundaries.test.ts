import type { CAC } from 'cac';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fs = vi.hoisted(() => ({
  close: vi.fn(),
  fstat: vi.fn(),
  lstat: vi.fn(),
  open: vi.fn<(path: string, directory?: boolean) => number>(() => 17),
  read: vi.fn(),
}));

const lifecycleDoubles = vi.hoisted(() => ({
  action: vi.fn(),
  localProvider: vi.fn(),
  planResolver: vi.fn(() => vi.fn()),
  validate: vi.fn(),
}));

vi.mock('@devai-nyx/authority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@devai-nyx/authority')>();
  fs.close.mockImplementation(actual.closeReadOnlySync);
  fs.fstat.mockImplementation(actual.fstatSync);
  fs.lstat.mockImplementation(actual.lstatSync);
  fs.open.mockImplementation(actual.openReadOnlyNoFollowSync);
  fs.read.mockImplementation(actual.readFileSync);
  return {
    ...actual,
    closeReadOnlySync: fs.close,
    fstatSync: fs.fstat,
    lstatSync: fs.lstat,
    openReadOnlyNoFollowSync: fs.open,
    readFileSync: fs.read,
  };
});

vi.mock('../../src/authority/index.js', () => ({
  declaredInvocationAuthority: () => ({ actor: { kind: 'human' } }),
}));

vi.mock('../../src/services/release-lifecycle-execution.js', () => ({
  ReleaseLifecycleFileStore: class {
    readStateRecords() {
      return [];
    }
  },
  executeReleaseLifecycleAction: lifecycleDoubles.action,
  validateReleaseLifecycleRequest: lifecycleDoubles.validate,
}));

vi.mock('../../src/services/release-policy-resolution.js', () => ({
  createResolvedReleasePlanInputResolver: lifecycleDoubles.planResolver,
  isVerifiedReleasePolicyResolution: () => true,
}));

vi.mock('../../src/services/release-lifecycle-local-adapters.js', () => ({
  builtInReleaseLifecycleLocalProvider: lifecycleDoubles.localProvider,
}));

const lifecycle = await import('../../src/commands/release/lifecycle.js');
const { releasePlan } = lifecycle;

function captureAction(): (options: Record<string, unknown>) => void {
  let handler: ((options: Record<string, unknown>) => void) | undefined;
  const command = {
    option: () => command,
    action: (value: typeof handler) => {
      handler = value;
      return command;
    },
  };
  releasePlan.register({ command: () => command } as unknown as CAC);
  if (handler === undefined) throw new Error('release plan handler missing');
  return handler;
}

function stat(overrides: Record<string, unknown> = {}) {
  return {
    dev: 1,
    ino: 2,
    mode: 0o100644,
    uid: 3,
    gid: 4,
    nlink: 1,
    size: 100,
    mtimeMs: 5,
    ctimeMs: 6,
    isFile: () => true,
    isSymbolicLink: () => false,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
});

describe('release lifecycle pinned receipt reads', () => {
  it.each(['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'mtimeMs', 'ctimeMs'] as const)(
    'rejects an opened descriptor whose %s differs from the path snapshot',
    (field) => {
      fs.open.mockReturnValueOnce(17);
      fs.close.mockImplementationOnce(() => undefined);
      fs.lstat.mockReturnValueOnce(stat());
      fs.fstat.mockReturnValueOnce(stat({ [field]: stat()[field] + 1 }));
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      captureAction()({ intent: '/fixture/intent.json', repository: 'fixture/repository' });

      expect(stderr).toHaveBeenCalledWith(
        'devai release plan: RELEASE_PLAN_FAILED: release-receipt-path-unsafe\n',
      );
      expect(fs.read).not.toHaveBeenCalledWith(17);
      expect(fs.close).toHaveBeenCalledWith(17);
    },
  );

  it.each([
    ['symbolic link', { isSymbolicLink: () => true }],
    ['hard-linked file', { nlink: 2 }],
  ] as const)('rejects an initial %s before opening it', (_name, overrides) => {
    fs.lstat.mockReturnValueOnce(stat(overrides));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    captureAction()({ intent: '/fixture/intent.json', repository: 'fixture/repository' });

    expect(stderr).toHaveBeenCalledWith(
      'devai release plan: RELEASE_PLAN_FAILED: release-receipt-path-unsafe\n',
    );
    expect(fs.open).not.toHaveBeenCalledWith('/fixture/intent.json');
  });

  it('rejects a descriptor whose opened identity is not the lstat identity', () => {
    fs.open.mockReturnValueOnce(17);
    fs.close.mockImplementationOnce(() => undefined);
    fs.lstat.mockReturnValueOnce(stat());
    fs.fstat.mockReturnValueOnce(stat({ isFile: () => false }));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    captureAction()({ intent: '/fixture/intent.json', repository: 'fixture/repository' });
    expect(fs.lstat).toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      'devai release plan: RELEASE_PLAN_FAILED: release-receipt-path-unsafe\n',
    );
    expect(fs.read).not.toHaveBeenCalledWith(17);
    expect(fs.close).toHaveBeenCalledWith(17);
  });

  it('rejects identity drift after reading the pinned descriptor', () => {
    fs.open.mockReturnValueOnce(17);
    fs.close.mockImplementationOnce(() => undefined);
    fs.lstat.mockReturnValueOnce(stat()).mockReturnValueOnce(stat({ size: 101 }));
    fs.fstat.mockReturnValueOnce(stat()).mockReturnValueOnce(stat({ size: 101 }));
    fs.read.mockReturnValueOnce(
      Buffer.from(
        JSON.stringify({
          candidate: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
          release_unit: '@fixture/package',
        }),
      ),
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    captureAction()({ intent: '/fixture/intent.json', repository: 'fixture/repository' });
    expect(fs.lstat).toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      'devai release plan: RELEASE_PLAN_FAILED: release-receipt-path-unsafe\n',
    );
    expect(fs.read).toHaveBeenCalledWith(17);
    expect(fs.close).toHaveBeenCalledWith(17);
  });

  it('rejects an exact parent traversal before consulting its filesystem identity', async () => {
    const request = {
      repository_locator: {
        id: 'fixture/repository',
        commit: 'a'.repeat(40),
        tree: 'b'.repeat(40),
      },
      candidate_locator: {
        commit: 'a'.repeat(40),
        tree: 'b'.repeat(40),
        release_units: [{ release_unit: '@fixture/package' }],
      },
    };
    const snapshot = stat();
    fs.open.mockReturnValueOnce(17);
    fs.close.mockImplementationOnce(() => undefined);
    fs.lstat.mockReturnValueOnce(snapshot).mockReturnValueOnce(snapshot);
    fs.fstat.mockReturnValueOnce(snapshot).mockReturnValueOnce(snapshot);
    fs.read.mockReturnValueOnce(Buffer.from(JSON.stringify(request)));
    lifecycleDoubles.validate.mockReturnValueOnce(request);
    lifecycleDoubles.localProvider.mockImplementationOnce((input: Record<string, unknown>) => {
      const read = input['read_contained_bytes'];
      if (typeof read !== 'function') throw new Error('contained reader missing');
      expect(() => Reflect.apply(read, undefined, ['..'])).toThrow('release-receipt-path-unsafe');
      return vi.fn();
    });
    const resolution = {
      repository: request.repository_locator,
      release_unit: '@fixture/package',
      readInput: vi.fn(),
    };
    const uninstall = lifecycle.installReleaseLifecycleCommandAdapters({
      policy_resolution: () =>
        resolution as unknown as import('../../src/services/release-policy-resolution.js').VerifiedReleasePolicyResolution,
      provider: () => undefined,
      offline_verification_provider: () => undefined,
      authorization: () => undefined,
      offline_receipt_verifier: () => undefined,
      publication_controls: () => undefined,
    });

    await captureActionFor(lifecycle.releasePreflight)({
      request: '/fixture/request.json',
      repoRoot: '/fixture/root',
    });

    expect(fs.lstat).toHaveBeenCalledTimes(2);
    expect(lifecycleDoubles.action).toHaveBeenCalled();
    uninstall();
  });
});

function captureActionFor(
  definition: typeof lifecycle.releasePreflight,
): (options: Record<string, unknown>) => void | Promise<void> {
  let handler: ((options: Record<string, unknown>) => void | Promise<void>) | undefined;
  const command = {
    option: () => command,
    action: (value: typeof handler) => {
      handler = value;
      return command;
    },
  };
  definition.register({ command: () => command } as unknown as CAC);
  if (handler === undefined) throw new Error('release action handler missing');
  return handler;
}
