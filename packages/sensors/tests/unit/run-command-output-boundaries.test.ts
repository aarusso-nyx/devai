// INV-DEVAI-012: complete command output is required; overflow never succeeds.
import { describe, expect, it, vi } from 'vitest';
import { runCommand } from '../../src/run-command.js';

// Exercise actual OS buffering at this unit's host seam; production authority is unchanged.
vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawnSync: (await import('node:child_process')).spawnSync,
}));

describe('command report output boundaries', () => {
  it('captures a real report beyond Node default maxBuffer without truncating it', () => {
    const result = runCommand([
      process.execPath,
      '-e',
      "process.stdout.write('x'.repeat(2 * 1024 * 1024))",
    ]);
    expect(result.exit_code).toBe(0);
    expect(result.killed).toBe(false);
    expect(result.stdout).toHaveLength(2 * 1024 * 1024);
    expect(result.stderr).toBe('');
  });

  it('retains a failed observation when a real process exceeds the finite output ceiling', () => {
    const result = runCommand([
      process.execPath,
      '-e',
      "process.stdout.write('x'.repeat(66 * 1024 * 1024))",
    ]);
    expect(result.exit_code).not.toBe(0);
    expect(result.stderr).toContain('ENOBUFS');
  });
});
