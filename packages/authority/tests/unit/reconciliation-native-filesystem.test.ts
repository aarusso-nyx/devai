import { afterEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { assertNativeProvisionFilesystem } from '../../src/boundaries/reconciliation-host-namespace.js';

const query = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawnSync: query }));
const path = tmpdir();
const paths = { repository_root: path, git_dir: path, common_dir: path, private_root: path };
const success = {
  status: 0,
  signal: null,
  stdout: 'Filesystem\n/dev/disk on /native\n',
  stderr: '',
};
afterEach(() => {
  vi.unstubAllGlobals();
  query.mockReset();
});

describe('actual native APFS qualification', () => {
  it('uses the system filesystem-name filter with bounded isolated execution', () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    query.mockReturnValue(success);
    expect(() => assertNativeProvisionFilesystem(paths)).not.toThrow();
    expect(query).toHaveBeenCalledExactlyOnceWith('/bin/df', ['-T', 'apfs', path], {
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
      timeout: 1000,
      maxBuffer: 8192,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
  });
  it('refuses another platform without invoking a program', () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    expect(() => assertNativeProvisionFilesystem(paths)).toThrow(
      'RECONCILIATION_PROVISION_UNSUPPORTED',
    );
    expect(query).not.toHaveBeenCalled();
  });
  it.each([
    { status: 1 },
    { error: new Error('timeout') },
    { signal: 'SIGTERM' },
    { stdout: '' },
    { stdout: null },
    { stderr: 'warning' },
  ])('refuses an unsuccessful or malformed filesystem query %o', (override) => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    query.mockReturnValue({ ...success, ...override });
    expect(() => assertNativeProvisionFilesystem(paths)).toThrow(
      'RECONCILIATION_PROVISION_UNSUPPORTED',
    );
  });
});
