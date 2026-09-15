import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReleaseRepositoryTestFixture } from './release-repository-test-fixture.js';

const fault = vi.hoisted(() => ({
  result: undefined as unknown,
  mutate: undefined as ((result: unknown) => unknown) | undefined,
  calls: 0,
  at: 1,
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => {
      if (fault.result !== undefined || fault.mutate !== undefined) {
        fault.calls += 1;
        if (fault.calls === fault.at) {
          if (fault.mutate !== undefined)
            return fault.mutate(Reflect.apply(actual.spawnSync, undefined, args));
          return fault.result;
        }
      }
      return Reflect.apply(actual.spawnSync, undefined, args);
    },
  };
});

const fixtures: ReturnType<typeof createReleaseRepositoryTestFixture>[] = [];
afterEach(() => {
  fault.result = undefined;
  fault.mutate = undefined;
  fault.calls = 0;
  fault.at = 1;
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

describe('protected repository probe failure before context entry', () => {
  it.each([
    ['nonzero exit', { status: 1 }],
    ['terminated process', { status: null, signal: 'SIGTERM' }],
    ['spawn failure', { error: new Error('fixture spawn failure') }],
    ['invalid UTF-8', { stdout: Buffer.from([0xff]) }],
    [
      'unterminated config',
      { stdout: Buffer.from('remote.origin.url\nhttps://github.com/fixture/repository.git') },
    ],
    ['missing origin value', { stdout: Buffer.from('remote.origin.url\0') }],
    ['empty configuration', { stdout: Buffer.alloc(0) }],
  ])('refuses %s without executing the protected callback', async (_name, override) => {
    // Establish the context through real Git first. Inject only the subsequent
    // tool response, rather than forging a context or its private identity.
    const fixture = createReleaseRepositoryTestFixture();
    fixtures.push(fixture);
    fault.result = {
      status: 0,
      signal: null,
      error: undefined,
      stdout: Buffer.from('remote.origin.url\nhttps://github.com/fixture/repository.git\0'),
      stderr: Buffer.alloc(0),
      ...override,
    };
    const callback = vi.fn();
    await expect(fixture.run(callback)).rejects.toThrow(
      'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
    );
    expect(callback).not.toHaveBeenCalled();
    expect(fault.calls).toBe(1);
  });

  it.each([
    ['repository root', 2, 0],
    ['Git directory', 2, 1],
    ['common Git directory', 2, 2],
    ['candidate commit', 3, 0],
    ['candidate tree', 3, 1],
  ] as const)('refuses malformed %s probe output before entry', async (_name, at, field) => {
    const fixture = createReleaseRepositoryTestFixture();
    fixtures.push(fixture);
    // Keep every preceding Git response real, then corrupt only the selected
    // identity field. A valid context captured earlier cannot authorize entry.
    fault.at = at;
    fault.mutate = (result) => {
      const observed = result as { readonly stdout: Buffer };
      const fields = observed.stdout.toString('utf8').slice(0, -1).split('\n');
      fields[field] = 'untrusted';
      return { ...observed, stdout: Buffer.from(`${fields.join('\n')}\n`) };
    };
    const callback = vi.fn();
    await expect(fixture.run(callback)).rejects.toThrow(
      'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
    );
    expect(callback).not.toHaveBeenCalled();
    expect(fault.calls).toBe(at);
  });
});
