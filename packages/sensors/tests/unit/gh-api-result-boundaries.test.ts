import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnSync = vi.hoisted(() => vi.fn());
vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawnSync,
}));

import { invokeGhJson } from '../../src/harness/gh-api.js';

interface SpawnFixture {
  readonly error?: NodeJS.ErrnoException;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr?: string;
}

function spawnResult(result: SpawnFixture): void {
  spawnSync.mockReturnValueOnce(result);
}

afterEach(() => {
  spawnSync.mockReset();
  vi.unstubAllEnvs();
});

describe('GitHub API result boundaries', () => {
  it('forwards the command, cwd, timeout, and JSON output shape', () => {
    vi.stubEnv('DEVAI_GH_WRAPPER_TEST', 'fixture-environment');
    spawnResult({ status: 0, stdout: '{"runs":2}' });

    const result = invokeGhJson<{ runs: number }>({
      cwd: '/repo',
      args: ['run', 'list', '--json', 'conclusion'],
      timeoutMs: 1_250,
    });

    expect(result).toEqual({ ok: true, data: { runs: 2 } });
    expect(spawnSync).toHaveBeenCalledWith(
      'gh',
      ['run', 'list', '--json', 'conclusion'],
      expect.objectContaining({
        cwd: '/repo',
        encoding: 'utf8',
        timeout: 1_250,
        env: expect.objectContaining({ DEVAI_GH_WRAPPER_TEST: 'fixture-environment' }),
      }),
    );
  });

  it('uses the wrapper timeout when the caller omits one', () => {
    spawnResult({ status: 0, stdout: '[]', stderr: '' });

    expect(invokeGhJson({ cwd: '/repo', args: ['run', 'list'] })).toEqual({ ok: true, data: [] });
    expect(spawnSync.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ timeout: 30_000 }));
  });

  it('maps unavailable, nonzero, and malformed JSON results to explicit reasons', () => {
    const unavailable = Object.assign(new Error('missing gh'), { code: 'ENOENT' });
    spawnResult({ error: unavailable, status: null, stdout: '', stderr: '' });
    expect(invokeGhJson({ cwd: '/repo', args: ['run', 'list'] })).toEqual({
      ok: false,
      reason: 'gh-cli-unavailable',
    });

    spawnResult({ status: 2, stdout: '' });
    expect(invokeGhJson({ cwd: '/repo', args: ['run', 'list'] })).toEqual({
      ok: false,
      reason: 'gh-cli-nonzero-exit: ',
    });

    spawnResult({ status: 0, stdout: '{invalid', stderr: '' });
    const malformed = invokeGhJson({ cwd: '/repo', args: ['run', 'list'] });
    expect(malformed.ok).toBe(false);
    expect(malformed).toMatchObject({ reason: expect.stringContaining('gh-cli-parse-error:') });
  });

  it('preserves a non-ENOENT process error reason', () => {
    spawnResult({
      error: Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      status: null,
      stdout: '',
      stderr: '',
    });

    expect(invokeGhJson({ cwd: '/repo', args: ['run', 'list'] })).toEqual({
      ok: false,
      reason: 'gh-cli-error: permission denied',
    });
  });

  it('trims stderr after limiting the nonzero error detail to 256 characters', () => {
    const stderr = `    ${'e'.repeat(300)}`;
    spawnResult({ status: 2, stdout: '', stderr });

    expect(invokeGhJson({ cwd: '/repo', args: ['run', 'list'] })).toEqual({
      ok: false,
      reason: `gh-cli-nonzero-exit: ${'e'.repeat(252)}`,
    });
  });
});
