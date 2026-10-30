import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const scriptPath = resolve(import.meta.dirname, '../../../../scripts/run-native-apfs-tests.mjs');
const source = readFileSync(scriptPath, 'utf8')
  .replace(/^#!.*\n/, '')
  .replace(/^import .*;\n/gm, '')
  .replace('import.meta.dirname', "'/private/source/scripts'");

type Host = { platform: string; node: string; uv: string; filesystem: bigint; apfs: boolean };
const supported: Host = {
  platform: 'darwin',
  node: '24.20.0',
  uv: '1.52.1',
  filesystem: 26n,
  apfs: true,
};

function runHost(overrides: Partial<Host>) {
  const host = { ...supported, ...overrides };
  let stderr = '';
  let directories = 0;
  let spawns = 0;
  const process = {
    platform: host.platform,
    versions: { node: host.node, uv: host.uv },
    env: { SECRET: 'diagnostic-secret', GITHUB_OUTPUT: '/private/output' },
    stderr: {
      write: (text: string) => {
        stderr += text;
      },
    },
    stdout: { write: () => {} },
    exit: () => {
      throw new Error('unexpected exit');
    },
  };
  const context = {
    process,
    tmpdir: () => '/private/temporary',
    realpathSync: (path: string) => path,
    statfsSync: () => ({ type: host.filesystem }),
    resolve: () => '/private/source',
    join: (...parts: string[]) => parts.join('/'),
    mkdtempSync: () => {
      directories++;
      return '/private/directory';
    },
    appendFileSync: () => {},
    spawnSync: (program: string) => {
      if (program === '/bin/df')
        return {
          status: host.apfs ? 0 : 1,
          signal: null,
          stdout: host.apfs ? 'Filesystem\n/dev/disk on /native\n' : '',
          stderr: '',
        };
      spawns++;
      throw new Error('qualification reached');
    },
  };
  let error = '';
  try {
    runInNewContext(source, context);
  } catch (caught) {
    error = (caught as Error).message;
  }
  return { host, stderr, directories, spawns, error };
}

describe('native APFS host diagnostic', () => {
  it.each([
    ['platform', { platform: 'linux' }],
    ['filesystem', { filesystem: 26n, apfs: false }],
    ['Node', { node: '24.21.0' }],
    ['libuv', { uv: '1.52.0' }],
  ])(
    'refuses an unsupported %s before qualification and emits bounded metadata',
    (_name, override) => {
      const result = runHost(override);
      expect(result.error).toBe('NATIVE_APFS_QUALIFICATION_HOST_UNSUPPORTED');
      expect(result.directories).toBe(0);
      expect(result.spawns).toBe(0);
      expect(result.stderr.endsWith('\n')).toBe(true);
      expect(result.stderr.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(result.stderr)).toEqual({
        platform: result.host.platform,
        node: result.host.node,
        uv: result.host.uv,
        filesystem_type: String(result.host.filesystem),
      });
      expect(result.stderr).not.toContain('diagnostic-secret');
      expect(result.stderr).not.toContain('/private/');
    },
  );

  it.each([26n, 27n, 99n])(
    'continues qualification for actual APFS with dynamic type %s',
    (filesystem) => {
      expect(runHost({ filesystem }).error).toBe('qualification reached');
    },
  );

  it.each(['24.20.0', '24.22.0'])('continues qualification for supported Node %s', (node) => {
    const result = runHost({ node });
    expect(result.error).toBe('qualification reached');
    expect(result.directories).toBe(1);
    expect(result.spawns).toBe(1);
    expect(result.stderr).toBe('');
  });
});
