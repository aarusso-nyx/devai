// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
import type { AuthorityHostEffectRequest } from '@devai-nyx/authority';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createAuthorityHostBroker } from '../../src/authority/broker.js';
import { canonicalRegistry } from '../../src/define-command.js';
import { resolveCliVersion } from '../../src/version.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const entries = canonicalRegistry();
const senseRun = (() => {
  const entry = entries.find((entry) => entry.name === 'sense run');
  if (entry === undefined) throw new Error('missing action sense run');
  return entry;
})();

function effect(executable: unknown, args: unknown): AuthorityHostEffectRequest {
  return { kind: 'process', symbol: 'spawnSync', arguments: [executable, args] };
}

function invoke(kind: string, executable: unknown, args: unknown): () => unknown {
  const host = createAuthorityHostBroker({
    entry: senseRun,
    entries,
    argv: [process.execPath, 'devai', 'sense', 'run', kind],
    role: 'auditor',
    declaration: { as_role: 'auditor' },
    repository_root: ROOT,
    package_version: resolveCliVersion(),
    bootstrap_policy: true,
  });
  return () => {
    try {
      return host.scope.apply_effect(effect(executable, args), () => 'allowed');
    } finally {
      host.dispose();
    }
  };
}

describe('sense read-only process shape boundaries', () => {
  it.each([
    ['lint', 'npx', ['eslint', '--format=json', '.']],
    ['type_check', 'npx', ['tsc', '--noEmit']],
    ['type_check', 'npx', ['tsc', '--noEmit', '-p', 'packages/cli/tsconfig.json']],
    ['build', 'pnpm', ['-r', 'build']],
    ['unit_test', 'pnpm', ['vitest', 'run']],
    [
      'integration_test',
      'pnpm',
      ['vitest', 'run', '--config', 'tests/config/t4.regression.config.ts'],
    ],
    ['runtime_probe_api', 'true', []],
    ['runtime_probe_api', 'false', []],
    ['runtime_probe_api', 'node', ['-e', 'process.exit(1);']],
    ['runtime_probe_api', 'node', ['--version']],
    ['runtime_probe_api', 'node', ['--help']],
    ['runtime_probe_api', 'pnpm', ['audit', '--json']],
    ['runtime_probe_api', 'npm', ['audit', '--json', '--package-lock-only']],
    ['runtime_probe_api', 'sh', ['-lc', 'command -v claude']],
    ['runtime_probe_api', 'sh', ['-lc', 'command -v codex']],
    ['runtime_probe_api', 'git', ['rev-parse', 'HEAD']],
    ['runtime_probe_api', 'docker', ['ps']],
    ['runtime_probe_api', 'command', ['-v', 'git']],
  ] as const)('admits %s: %s %j', (kind, executable, args) => {
    expect(invoke(kind, executable, args)()).toBe('allowed');
  });

  it.each([
    ['lint', 1, ['eslint', '--format=json', '.']],
    ['lint', 'npx', 'not-an-array'],
    ['lint', 'npx', ['eslint', '--format=json']],
    ['lint', 'npx', ['eslint', '--format=json', '.', 'extra']],
    ['lint', 'npx', ['other', '--format=json', '.']],
    ['lint', 'npx', ['eslint', '--other', '.']],
    ['lint', 'npx', ['eslint', '--format=json', 1]],
    ['type_check', 'npx', ['tsc']],
    ['type_check', 'npx', ['other', '--noEmit']],
    ['type_check', 'npx', ['tsc', '--emit']],
    ['type_check', 'npx', ['tsc', '--noEmit', '--project', 'packages/cli/tsconfig.json']],
    ['type_check', 'npx', ['tsc', '--noEmit', '-p', '../outside.json']],
    ['type_check', 'npx', ['tsc', '--noEmit', '-p', '/outside.json']],
    ['build', 'pnpm', ['-r']],
    ['build', 'pnpm', ['-r', 'build', 'extra']],
    ['build', 'pnpm', ['other', 'build']],
    ['build', 'pnpm', ['-r', 'other']],
    ['unit_test', 'pnpm', ['vitest']],
    ['unit_test', 'pnpm', ['vitest', 'run', 'extra']],
    ['unit_test', 'pnpm', ['other', 'run']],
    ['unit_test', 'pnpm', ['vitest', 'other']],
    [
      'integration_test',
      'pnpm',
      ['vitest', 'run', '--config', 'tests/config/not-governed.config.ts'],
    ],
    ['integration_test', 'pnpm', ['vitest', 'run', '--config']],
    [
      'integration_test',
      'pnpm',
      ['other', 'run', '--config', 'tests/config/t4.regression.config.ts'],
    ],
    [
      'integration_test',
      'pnpm',
      ['vitest', 'other', '--config', 'tests/config/t4.regression.config.ts'],
    ],
    [
      'integration_test',
      'pnpm',
      ['vitest', 'run', '--other', 'tests/config/t4.regression.config.ts'],
    ],
    ['runtime_probe_api', 'true', ['extra']],
    ['runtime_probe_api', 'node', ['-e']],
    ['runtime_probe_api', 'node', ['-e', 'console.log(1)']],
    ['runtime_probe_api', 'node', ['other', 'process.exit(1);']],
    ['runtime_probe_api', 'node', ['--version', 'extra']],
    ['runtime_probe_api', 'pnpm', ['audit']],
    ['runtime_probe_api', 'pnpm', ['other', '--json']],
    ['runtime_probe_api', 'pnpm', ['audit', '--other']],
    ['runtime_probe_api', 'npm', ['audit', '--json']],
    ['runtime_probe_api', 'npm', ['other', '--json', '--package-lock-only']],
    ['runtime_probe_api', 'npm', ['audit', '--other', '--package-lock-only']],
    ['runtime_probe_api', 'npm', ['audit', '--json', '--other']],
    ['runtime_probe_api', 'sh', ['other', 'command -v claude']],
    ['runtime_probe_api', 'sh', ['-lc', 1]],
    ['runtime_probe_api', 'sh', ['-lc', 'echo unsafe']],
  ] as const)('refuses %s: %s %j', (kind, executable, args) => {
    expect(invoke(kind, executable, args)).toThrow('AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED');
  });
});
