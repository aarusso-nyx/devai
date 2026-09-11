import type { CAC } from 'cac';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fs = vi.hoisted(() => ({
  close: vi.fn(),
  fstat: vi.fn(),
  lstat: vi.fn(),
  open: vi.fn(() => 17),
  read: vi.fn(),
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

const { releasePlan } = await import('../../src/commands/release/lifecycle.js');

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
});
