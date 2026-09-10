// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
import type { AuthorityHostEffectRequest } from '@devai-nyx/authority';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createAuthorityHostBroker } from '../../src/authority/broker.js';
import { canonicalRegistry } from '../../src/define-command.js';
import { resolveCliVersion } from '../../src/version.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const entries = canonicalRegistry();
type Role = 'owner' | 'architect' | 'inspector' | 'engineer' | 'auditor';

function invocation(name: string, role: Role): readonly string[] {
  if (name === 'task start') {
    return [
      process.execPath,
      'devai',
      'task',
      'start',
      '--round',
      'R-0007',
      '--task',
      'TASK-7001',
      '--with-db',
      '--as-role',
      role,
      '--write',
    ];
  }
  if (name === 'check') {
    return [
      process.execPath,
      'devai',
      'check',
      '--only',
      'translation',
      '--as-role',
      role,
      '--write',
    ];
  }
  if (name === 'round run') {
    return [
      process.execPath,
      'devai',
      'round',
      'run',
      '--round',
      'R-0007',
      '--task',
      'TASK-7001',
      '--as-role',
      role,
      '--write',
    ];
  }
  if (name === 'evidence record') {
    return [
      process.execPath,
      'devai',
      'evidence',
      'record',
      '--kind',
      'test',
      '--round',
      'R-0007',
      '--cmd',
      'pnpm test',
      '--as-role',
      role,
      '--write',
    ];
  }
  throw new Error(`unsupported test action: ${name}`);
}

function invoke(name: string, role: Role, executable: string, args: readonly string[]): unknown {
  const entry = entries.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`missing action ${name}`);
  const host = createAuthorityHostBroker({
    entry,
    entries,
    argv: invocation(name, role),
    role,
    declaration: { as_role: role },
    repository_root: ROOT,
    package_version: resolveCliVersion(),
    bootstrap_policy: true,
  });
  const request: AuthorityHostEffectRequest = {
    kind: 'process',
    symbol: 'spawnSync',
    arguments: [executable, args],
  };
  try {
    return host.scope.apply_effect(request, () => 'applied');
  } finally {
    host.dispose();
  }
}

describe('authority broker process target classification', () => {
  it.each([
    ['task start', 'engineer', 'psql', ['postgres://host/db-name', '-c', 'CREATE TABLE x()']],
    [
      'task start',
      'engineer',
      'psql',
      ['postgres://host/db-name', '-c', 'INSERT INTO x VALUES (1)'],
    ],
    ['task start', 'engineer', 'psql', ['postgres://host/db-name', '-c', 'UPDATE x SET a=1']],
    ['task start', 'engineer', 'psql', ['postgres://host/db-name', '-c', 'DELETE FROM x']],
    ['task start', 'engineer', 'psql', ['not-a-url', '-c', 'SELECT 1']],
    ['task start', 'engineer', 'docker', ['run', '--name', 'fixture-db']],
    ['task start', 'engineer', 'docker', ['start', 'fixture-db']],
    ['task start', 'engineer', 'docker', ['stop', 'fixture-db']],
    ['check', 'inspector', 'docker', ['run', '--rm', 'fixture']],
    ['check', 'inspector', 'sandbox-exec', ['-p', '(version 1)', 'node']],
    ['round run', 'engineer', 'git', ['worktree', 'add', '-b', 'fixture', '/tmp/wt']],
    ['round run', 'engineer', 'git', ['worktree', 'remove', '/tmp/wt']],
    ['round run', 'engineer', 'git', ['add', 'packages/cli/src/bin.ts']],
    ['round run', 'engineer', 'git', ['rm', 'packages/cli/src/bin.ts']],
    ['round run', 'engineer', 'git', ['commit', '-m', 'fixture']],
    ['evidence record', 'auditor', 'sh', ['-c', 'pnpm test']],
  ] as const)('classifies %s %s %j as its authorized target', (name, role, executable, args) => {
    expect(invoke(name, role, executable, args)).toBe('applied');
  });

  it.each([
    [
      'task start',
      'engineer',
      'git',
      ['push', 'origin', 'HEAD'],
      'AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED',
    ],
    [
      'round run',
      'engineer',
      'git',
      ['mv', 'scratch/a', 'scratch/b'],
      'AUTHORITY_PATH_DOMAIN_VIOLATION',
    ],
    ['task start', 'engineer', 'gh', ['pr', 'create', '--draft'], 'UNCLASSIFIED_RESOURCE'],
    [
      'task start',
      'engineer',
      'gh',
      ['issue', 'create'],
      'AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED',
    ],
    [
      'task start',
      'engineer',
      'other',
      ['pr', 'create'],
      'AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED',
    ],
    ['task start', 'engineer', 'gh', ['pr', 'view'], 'AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED'],
    [
      'round run',
      'engineer',
      'claude',
      ['-p', 'fixture'],
      'AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED',
    ],
    [
      'round run',
      'engineer',
      'codex',
      ['exec', 'fixture'],
      'AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED',
    ],
  ] as const)('refuses misclassified %s %s %j', (name, role, executable, args, code) => {
    expect(() => invoke(name, role, executable, args)).toThrow(code);
  });
});
