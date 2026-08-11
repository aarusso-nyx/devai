// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTION_REGISTRY } from '../../src/generated/action-registry.js';

const originalArgv = [...process.argv];
const originalExitCode = process.exitCode;
const originalStdout = process.stdout.write;
const originalStderr = process.stderr.write;
const originalExit = process.exit;

afterEach(() => {
  process.argv = [...originalArgv];
  process.exitCode = originalExitCode;
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
  process.exit = originalExit;
});

async function run(args: readonly string[]): Promise<{
  stdout: string;
  stderr: string;
  exit: number;
}> {
  vi.resetModules();
  let stdout = '';
  let stderr = '';
  process.argv = ['node', 'devai', ...args, '--format', 'json'];
  process.exitCode = undefined;
  process.stdout.write = ((chunk: unknown) => {
    stdout += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  }) as typeof process.stderr.write;
  await import('../../src/bin.js');
  await new Promise<void>((done) => setImmediate(done));
  return {
    stdout,
    stderr,
    exit: typeof process.exitCode === 'number' ? process.exitCode : 0,
  };
}

const expectedCatalog = ACTION_REGISTRY.map((entry) => ({
  name: entry.action_id,
  path: entry.path,
  status: entry.status,
  profiles: entry.profiles,
  effects: entry.effect,
  authority: entry.authority ?? 'mesh_controller',
  description: entry.description,
  authority_contract_version: entry.authority_contract_version,
}));

describe('public read-action runtime seams', () => {
  it('catalog actions returns the exact 41 current actions in canonical registry order', async () => {
    expect(ACTION_REGISTRY).toHaveLength(41);

    const result = await run(['catalog', 'actions']);
    expect(result.exit, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: '1.0.0',
      action_id: 'catalog actions',
      ok: true,
      result: {
        media_type: 'application/json',
        value: expectedCatalog,
      },
    });
  }, 30_000);

});
