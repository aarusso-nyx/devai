// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
import type { AuthorityHostEffectRequest } from '@devai-nyx/authority';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthorityHostBroker } from '../../src/authority/broker.js';
import { routeArgv } from '../../src/command-router.js';
import { getFullRegistry, type RegistryEntry } from '../../src/define-command.js';
import { resolveCliVersion } from '../../src/version.js';

const ROOT = new URL('../../../../', import.meta.url).pathname;
const originalArgv = [...process.argv];
const originalStdout = process.stdout.write;
let entries: readonly RegistryEntry[];

beforeAll(async () => {
  process.argv = [process.execPath, 'devai', '--help'];
  process.stdout.write = (() => true) as typeof process.stdout.write;
  await import('../../src/bin.js');
  entries = getFullRegistry();
  process.stdout.write = originalStdout;
  process.argv = [...originalArgv];
});

afterAll(() => {
  process.stdout.write = originalStdout;
  process.argv = [...originalArgv];
});

type Role = 'owner' | 'architect' | 'inspector' | 'engineer' | 'auditor';

function broker(name: string, role: Role, argv: readonly string[], bootstrapPolicy = true) {
  const entry = entries.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`missing action ${name}`);
  return createAuthorityHostBroker({
    entry,
    entries,
    argv,
    role,
    declaration: { as_role: role },
    repository_root: ROOT,
    package_version: resolveCliVersion(),
    bootstrap_policy: bootstrapPolicy,
  });
}

const TASK_INVOCATION = {
  id: 'TASK-7001',
  round_id: 'R-0007',
} as const;

function roundRunArgv(role: Role = 'engineer'): readonly string[] {
  return [
    process.execPath,
    'devai',
    'round',
    'run',
    '--round',
    TASK_INVOCATION.round_id,
    '--task',
    TASK_INVOCATION.id,
    '--as-role',
    role,
    '--write',
  ];
}

function taskStartArgv(options: { readonly withDb?: boolean } = {}): readonly string[] {
  return [
    process.execPath,
    'devai',
    'task',
    'start',
    '--round',
    TASK_INVOCATION.round_id,
    '--task',
    TASK_INVOCATION.id,
    ...(options.withDb === true ? ['--with-db'] : []),
    '--as-role',
    'engineer',
    '--write',
  ];
}

function effect(
  symbol: string,
  args: readonly unknown[],
  kind: AuthorityHostEffectRequest['kind'] = 'filesystem',
): AuthorityHostEffectRequest {
  return { kind, symbol, arguments: args };
}

describe('authority broker production boundary depth', () => {
  it('bootstraps only the exact installed-Constitution binding in an unbound adopter', () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-init-bind-bootstrap-'));
    const entry = entries.find((candidate) => candidate.name === 'init bind');
    if (entry === undefined) throw new Error('missing action init bind');
    const create = (argv: readonly string[]) =>
      createAuthorityHostBroker({
        entry,
        entries,
        argv,
        role: 'architect',
        declaration: { as_role: 'architect' },
        repository_root: root,
        package_version: resolveCliVersion(),
        bootstrap_policy: true,
      });

    try {
      const exact = create([
        process.execPath,
        'devai',
        'init',
        'bind',
        '--constitution',
        '--as-role',
        'architect',
        '--write',
      ]);
      try {
        expect(
          exact.scope.apply_effect(
            effect('writeFileSync', [join(root, '.devai/config/project.json'), '{}\n']),
            () => 'allowed',
          ),
        ).toBe('allowed');
        expect(() =>
          exact.scope.apply_effect(
            effect('writeFileSync', [join(root, '.devai/config/other.json'), '{}\n']),
            () => 'forbidden',
          ),
        ).toThrow('AUTHORITY_BOOTSTRAP_TARGET_FORBIDDEN');
        expect(() =>
          exact.scope.apply_effect(
            effect('rmSync', [join(root, '.devai/config/project.json')]),
            () => 'forbidden',
          ),
        ).toThrow('AUTHORITY_BOOTSTRAP_TARGET_FORBIDDEN');
      } finally {
        exact.dispose();
      }

      expect(() =>
        create([
          process.execPath,
          'devai',
          'init',
          'bind',
          '--constitution',
          '--operational-law',
          '--as-role',
          'architect',
          '--write',
        ]),
      ).toThrow('bound Constitution not found');
      expect(
        routeArgv(
          [
            process.execPath,
            'devai',
            'init',
            'bind',
            '--constitution',
            '--operational-law',
            '--write',
            '--format',
            'json',
          ],
          entries,
          resolveCliVersion(),
        ),
      ).toMatchObject({ kind: 'output', exitCode: 2 });
      expect(() =>
        create([process.execPath, 'devai', 'init', 'bind', '--as-role', 'architect', '--write']),
      ).toThrow('bound Constitution not found');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bounds host recipe installation to the two canonical skills roots', () => {
    const host = broker(
      'init apply harness',
      'architect',
      [
        process.execPath,
        'devai',
        'init',
        'apply',
        'harness',
        '--include',
        'skills',
        '--as-role',
        'architect',
        '--write',
      ],
      true,
    );
    try {
      for (const target of [
        join(ROOT, '.agents/skills/devai-assess/SKILL.md'),
        join(ROOT, '.claude/skills/devai-assess/devai.recipe.json'),
      ]) {
        expect(
          host.scope.apply_effect(effect('writeFileSync', [target, 'adapter\n']), () => 'allowed'),
        ).toBe('allowed');
      }
      expect(() =>
        host.scope.apply_effect(
          effect('writeFileSync', [join(ROOT, '.claude/settings.json'), '{}\n']),
          () => 'forbidden',
        ),
      ).toThrow('UNCLASSIFIED_RESOURCE');
    } finally {
      host.dispose();
    }
  });

  it('authorizes bounded filesystem effects and tracks descriptor lifecycles', () => {
    const host = broker('round run', 'engineer', roundRunArgv());
    try {
      let applied = 0;
      expect(
        host.scope.apply_effect(effect('openSync', ['.devai/state/broker-depth.json', 'w']), () => {
          applied += 1;
          return 41;
        }),
      ).toBe(41);
      expect(
        host.scope.apply_effect(effect('writeSync', [41, '{}\n']), () => {
          applied += 1;
          return 3;
        }),
      ).toBe(3);
      expect(
        host.scope.apply_effect(effect('closeSync', [41]), () => {
          applied += 1;
        }),
      ).toBeUndefined();
      expect(applied).toBe(3);
      expect(
        host.scope.apply_effect(effect('mkdirSync', [ROOT, { recursive: true }]), () => {
          throw new Error('existing directory must be a no-op');
        }),
      ).toBeUndefined();
    } finally {
      host.dispose();
    }
  });

  it('applies bounded-batch effects immediately and refuses unadapted processes', () => {
    const host = broker(
      'init apply owner',
      'owner',
      [process.execPath, 'devai', 'init', 'apply', 'owner', '--as-role', 'owner', '--write'],
      true,
    );
    try {
      let applied = 0;
      host.scope.apply_effect(effect('writeFileSync', ['product/broker-a.json', '{}\n']), () => {
        applied += 1;
      });
      host.scope.apply_effect(effect('writeFileSync', ['product/broker-b.json', '{}\n']), () => {
        applied += 1;
      });
      expect(applied).toBe(2);
      expect(host.commit_exact).toBeUndefined();
      expect(() =>
        host.scope.apply_effect(
          effect('spawnSync', ['git', ['update-ref', 'refs/heads/x', 'HEAD']], 'process'),
          () => undefined,
        ),
      ).toThrow('AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED');
    } finally {
      host.dispose();
    }
  });

  it('passes read-only processes and refuses unadapted process or read-action mutation', () => {
    const host = broker('sense run', 'auditor', [
      process.execPath,
      'devai',
      'sense',
      'run',
      'lint',
      '--as-role',
      'auditor',
    ]);
    try {
      expect(
        host.scope.apply_effect(effect('spawnSync', ['git', ['status']], 'process'), () => 'ok'),
      ).toBe('ok');
      expect(() =>
        host.scope.apply_effect(effect('spawnSync', ['sh', ['-lc', 'true']], 'process'), () => 'x'),
      ).toThrow('AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED');
    } finally {
      host.dispose();
    }

    const read = broker('catalog actions', 'auditor', ['catalog', 'actions']);
    try {
      expect(() =>
        read.scope.apply_effect(effect('writeFileSync', ['scratch/forbidden', 'x']), () => 'x'),
      ).toThrow('AUTHORITY_READ_ACTION_MUTATION_FORBIDDEN');
      expect(() =>
        read.scope.apply_effect(effect('spawnSync', ['sh', ['-lc', 'true']], 'process'), () => 'x'),
      ).toThrow('AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED');
    } finally {
      read.dispose();
    }
  });

  it('keeps task action scopes bounded', () => {
    expect(
      routeArgv(
        [process.execPath, 'devai', 'task', 'start', '--task', TASK_INVOCATION.id],
        entries,
        resolveCliVersion(),
      ),
    ).toMatchObject({
      kind: 'output',
      exitCode: 2,
      text: expect.stringContaining('"exit":2'),
    });

    const invocation = broker('round run', 'auditor', roundRunArgv('auditor'));
    try {
      expect(invocation.session_operation).toBeUndefined();
    } finally {
      invocation.dispose();
    }

    const task = broker('task start', 'engineer', taskStartArgv());
    try {
      expect(() =>
        task.scope.apply_effect(
          effect('writeFileSync', ['law/forbidden.json', '{}\n']),
          () => undefined,
        ),
      ).toThrow('AUTHORITY_ACTION_DENIED');
    } finally {
      task.dispose();
    }
  });

  it('classifies the complete governed process-target matrix without executing host commands', () => {
    const checkTranslationArgv = [
      process.execPath,
      'devai',
      'check',
      '--only',
      'translation',
      '--as-role',
      'inspector',
      '--write',
    ] as const;
    const evidenceTestArgv = [
      process.execPath,
      'devai',
      'evidence',
      'record',
      '--kind',
      'test',
      '--round',
      'R-0007',
      '--as-role',
      'auditor',
      '--write',
    ] as const;
    const roundPlanDiagramsArgv = [
      process.execPath,
      'devai',
      'round',
      'plan',
      '--documents',
      'diagrams',
      '--as-role',
      'architect',
      '--write',
    ] as const;
    const cases: ReadonlyArray<
      readonly [string, Role, readonly string[], string, readonly string[]]
    > = [
      ['task start', 'engineer', taskStartArgv(), 'npx', ['eslint', '--format=json', '.']],
      ['task start', 'engineer', taskStartArgv(), 'npx', ['tsc', '--noEmit']],
      ['task start', 'engineer', taskStartArgv(), 'pnpm', ['test']],
      [
        'task start',
        'engineer',
        taskStartArgv(),
        'node',
        ['--test', '--test-name-pattern', 'works', 'packages/cli/tests/a.test.ts'],
      ],
      [
        'task start',
        'engineer',
        taskStartArgv({ withDb: true }),
        'psql',
        ['postgres://host/db-name', '-c', 'CREATE TABLE x()'],
      ],
      [
        'task start',
        'engineer',
        taskStartArgv({ withDb: true }),
        'psql',
        ['postgres://host/db-name', '-c', 'INSERT INTO x VALUES (1)'],
      ],
      [
        'task start',
        'engineer',
        taskStartArgv({ withDb: true }),
        'psql',
        ['postgres://host/db-name', '-c', 'UPDATE x SET a=1'],
      ],
      [
        'task start',
        'engineer',
        taskStartArgv({ withDb: true }),
        'psql',
        ['postgres://host/db-name', '-c', 'DELETE FROM x'],
      ],
      [
        'task start',
        'engineer',
        taskStartArgv({ withDb: true }),
        'psql',
        ['not-a-url', '-c', 'SELECT 1'],
      ],
      [
        'task start',
        'engineer',
        taskStartArgv({ withDb: true }),
        'docker',
        ['run', '--name', 'fixture-db'],
      ],
      [
        'task start',
        'engineer',
        taskStartArgv({ withDb: true }),
        'docker',
        ['start', 'fixture-db'],
      ],
      ['task start', 'engineer', taskStartArgv({ withDb: true }), 'docker', ['stop', 'fixture-db']],
      ['check', 'inspector', checkTranslationArgv, 'docker', ['run', '--rm', 'fixture']],
      ['check', 'inspector', checkTranslationArgv, 'sandbox-exec', ['-p', '(version 1)', 'node']],
      ['task start', 'engineer', taskStartArgv(), 'git', ['push', 'origin', 'HEAD']],
      [
        'init bind',
        'architect',
        [process.execPath, 'devai', 'init', 'bind', '--as-role', 'architect', '--write'],
        'git',
        ['fetch', 'upstream remote!', 'branch/name'],
      ],
      [
        'round run',
        'engineer',
        roundRunArgv(),
        'git',
        ['worktree', 'add', '-b', 'fixture', '/tmp/wt'],
      ],
      ['round run', 'engineer', roundRunArgv(), 'git', ['worktree', 'remove', '/tmp/wt']],
      ['round run', 'engineer', roundRunArgv(), 'git', ['add', 'packages/cli/src/bin.ts']],
      ['round run', 'engineer', roundRunArgv(), 'git', ['rm', 'packages/cli/src/bin.ts']],
      ['round run', 'engineer', roundRunArgv(), 'git', ['commit', '-m', 'fixture']],
      ['round run', 'engineer', roundRunArgv(), 'git', ['mv', 'scratch/a', 'scratch/b']],
      ['task start', 'engineer', taskStartArgv(), 'gh', ['pr', 'create', '--draft']],
      ['evidence record', 'auditor', evidenceTestArgv, 'sh', ['-c', 'pnpm test']],
      ['round run', 'engineer', roundRunArgv(), 'claude', ['-p', 'fixture']],
      ['round run', 'engineer', roundRunArgv(), 'codex', ['exec', 'fixture']],
      [
        'round plan',
        'architect',
        roundPlanDiagramsArgv,
        'mmdc',
        ['--input', 'a.mmd', '--output', 'scratch/a.svg'],
      ],
    ];

    let classified = 0;
    for (const [name, role, argv, executable, args] of cases) {
      const host = broker(name, role, argv);
      try {
        try {
          host.scope.apply_effect(effect('spawnSync', [executable, args], 'process'), () => {
            classified += 1;
            return 'applied';
          });
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          classified += 1;
        }
      } finally {
        host.dispose();
      }
    }
    expect(classified).toBe(cases.length);
  });

  it('admits only exact read-only subprocess shapes for sensor actions', () => {
    const cases: ReadonlyArray<readonly [string, string, readonly string[], boolean]> = [
      ['lint', 'npx', ['eslint', '--format=json', '.'], true],
      ['lint', 'npx', ['eslint', '--fix', '.'], false],
      ['type_check', 'npx', ['tsc', '--noEmit'], true],
      ['type_check', 'npx', ['tsc', '--noEmit', '-p', 'packages/cli/tsconfig.json'], true],
      ['type_check', 'npx', ['tsc', '--noEmit', '-p', '../outside.json'], false],
      ['build', 'pnpm', ['-r', 'build'], true],
      ['unit_test', 'pnpm', ['vitest', 'run'], true],
      [
        'integration_test',
        'pnpm',
        ['vitest', 'run', '--config', 'tests/config/t4.regression.config.ts'],
        true,
      ],
      ['unit_test', 'pnpm', ['vitest', 'watch'], false],
      ['runtime_probe_api', 'true', [], true],
      ['runtime_probe_api', 'false', [], true],
      ['runtime_probe_api', 'node', ['-e', 'process.exit(1);'], true],
      ['runtime_probe_api', 'node', ['--version'], true],
      ['runtime_probe_api', 'pnpm', ['audit', '--json'], true],
      ['runtime_probe_api', 'npm', ['audit', '--json', '--package-lock-only'], true],
      ['runtime_probe_api', 'sh', ['-lc', 'command -v claude'], true],
      ['runtime_probe_api', 'sh', ['-lc', 'echo unsafe'], false],
      ['runtime_probe_api', 'git', ['rev-parse', 'HEAD'], true],
      ['runtime_probe_api', 'docker', ['ps'], true],
      ['runtime_probe_api', 'command', ['-v', 'git'], true],
    ];
    for (const [kind, executable, args, allowed] of cases) {
      const host = broker('sense run', 'auditor', [
        process.execPath,
        'devai',
        'sense',
        'run',
        kind,
      ]);
      try {
        const invoke = () =>
          host.scope.apply_effect(effect('spawnSync', [executable, args], 'process'), () => 'ok');
        if (allowed) expect(invoke()).toBe('ok');
        else expect(invoke).toThrow('AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED');
      } finally {
        host.dispose();
      }
    }
  });

  it('fails closed for malformed filesystem targets, escapes, and descriptors', () => {
    const host = broker('round run', 'engineer', roundRunArgv());
    try {
      expect(() =>
        host.scope.apply_effect(effect('writeFileSync', [undefined]), () => undefined),
      ).toThrow('AUTHORITY_FS_TARGET_INVALID');
      expect(() =>
        host.scope.apply_effect(effect('writeFileSync', ['/tmp/outside']), () => undefined),
      ).toThrow('AUTHORITY_FS_SYMLINK_ESCAPE');
      expect(() =>
        host.scope.apply_effect(effect('writeSync', [999, 'x']), () => undefined),
      ).toThrow('AUTHORITY_FS_DESCRIPTOR_UNKNOWN');
      host.scope.apply_effect(
        effect('renameSync', ['.devai/state/from', '.devai/state/to']),
        () => undefined,
      );
      host.scope.apply_effect(
        effect('copyFileSync', ['.devai/state/from', '.devai/state/copied']),
        () => undefined,
      );
      host.scope.apply_effect(
        effect('symlinkSync', ['.devai/state/from', '.devai/state/link']),
        () => undefined,
      );
    } finally {
      host.dispose();
    }
  });
});
