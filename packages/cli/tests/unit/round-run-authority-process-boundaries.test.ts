import type { AuthorityHostEffectRequest } from '@devai-nyx/authority';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { matchDeclaredRoundTaskProcess } from '../../src/services/round-run/authority-process.js';

const roots: string[] = [];

const invocation = (...extra: readonly string[]) => [
  process.execPath,
  'devai',
  'round',
  'run',
  '--round',
  'R-0007',
  '--task',
  'TASK-7001',
  ...extra,
];

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-round-process-boundaries-'));
  roots.push(root);
  mkdirSync(join(root, '.devai/state/tasks'), { recursive: true });
  return root;
}

function task(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const executor = {
    kind: 'routine',
    argv: ['pnpm', 'run', 'verify'],
    cwd: '.',
    timeout_ms: 12_000,
    ...((overrides.executor as Record<string, unknown> | undefined) ?? {}),
  };
  return {
    schemaVersion: '2.0.0',
    id: 'TASK-7001',
    round_id: 'R-0007',
    status: 'in_progress',
    ...overrides,
    executor,
  };
}

function malformedTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const executorOverride = overrides.executor;
  const executor =
    executorOverride === null
      ? null
      : {
          kind: 'routine',
          argv: ['node', 'invalid-probe'],
          cwd: 'malformed-workspace',
          timeout_ms: 13_000,
          ...((executorOverride as Record<string, unknown> | undefined) ?? {}),
        };
  return {
    schemaVersion: '2.0.0',
    id: 'TASK-6000',
    round_id: 'R-0007',
    status: 'in_progress',
    ...overrides,
    executor,
  };
}

function writeTask(root: string, value: unknown = task(), name = 'TASK-7001.json'): void {
  writeFileSync(join(root, '.devai/state/tasks', name), `${JSON.stringify(value)}\n`);
}

function request(
  cwd: string,
  args?: readonly unknown[],
  overrides: Record<string, unknown> = {},
): AuthorityHostEffectRequest {
  return {
    kind: 'process',
    symbol: 'spawnSync',
    arguments: args ?? ['pnpm', ['run', 'verify'], { cwd, shell: false, timeout: 12_000 }],
    ...overrides,
  } as AuthorityHostEffectRequest;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('round-run authority process validation boundaries', () => {
  it('does not authorize otherwise matching tasks with malformed fields', () => {
    const cases: readonly [
      string,
      (root: string) => {
        readonly value: unknown;
        readonly args: readonly unknown[];
      },
    ][] = [
      [
        'schema',
        (root) => ({
          value: malformedTask({ schemaVersion: '1.0.0' }),
          args: [
            'node',
            ['invalid-probe'],
            { cwd: join(root, 'malformed-workspace'), shell: false, timeout: 13_000 },
          ],
        }),
      ],
      [
        'id',
        (root) => ({
          value: malformedTask({ id: 6000 }),
          args: [
            'node',
            ['invalid-probe'],
            { cwd: join(root, 'malformed-workspace'), shell: false, timeout: 13_000 },
          ],
        }),
      ],
      [
        'status',
        (root) => ({
          value: malformedTask({ status: 'ready' }),
          args: [
            'node',
            ['invalid-probe'],
            { cwd: join(root, 'malformed-workspace'), shell: false, timeout: 13_000 },
          ],
        }),
      ],
      [
        'kind',
        (root) => ({
          value: malformedTask({ executor: { kind: 'shell' } }),
          args: [
            'node',
            ['invalid-probe'],
            { cwd: join(root, 'malformed-workspace'), shell: false, timeout: 13_000 },
          ],
        }),
      ],
      [
        'cwd-empty',
        (root) => ({
          value: malformedTask({ executor: { cwd: '' } }),
          args: ['node', ['invalid-probe'], { cwd: root, shell: false, timeout: 13_000 }],
        }),
      ],
      [
        'cwd-absolute',
        (root) => {
          const cwd = join(root, 'absolute-workspace');
          mkdirSync(cwd);
          return {
            value: malformedTask({ executor: { cwd } }),
            args: ['node', ['invalid-probe'], { cwd, shell: false, timeout: 13_000 }],
          };
        },
      ],
      [
        'cwd-parent-posix',
        (root) => ({
          value: malformedTask({ executor: { cwd: '..' } }),
          args: [
            'node',
            ['invalid-probe'],
            { cwd: join(root, '..'), shell: false, timeout: 13_000 },
          ],
        }),
      ],
      [
        'cwd-parent-windows',
        (root) => {
          const cwd = join(root, '..\\escape');
          mkdirSync(cwd);
          return {
            value: malformedTask({ executor: { cwd: '..\\escape' } }),
            args: ['node', ['invalid-probe'], { cwd, shell: false, timeout: 13_000 }],
          };
        },
      ],
      [
        'timeout-zero',
        (root) => ({
          value: malformedTask({ executor: { timeout_ms: 0 } }),
          args: [
            'node',
            ['invalid-probe'],
            { cwd: join(root, 'malformed-workspace'), shell: false, timeout: 0 },
          ],
        }),
      ],
      [
        'timeout-negative',
        (root) => ({
          value: malformedTask({ executor: { timeout_ms: -1 } }),
          args: [
            'node',
            ['invalid-probe'],
            { cwd: join(root, 'malformed-workspace'), shell: false, timeout: -1 },
          ],
        }),
      ],
      [
        'timeout-fractional',
        (root) => ({
          value: malformedTask({ executor: { timeout_ms: 1.5 } }),
          args: [
            'node',
            ['invalid-probe'],
            { cwd: join(root, 'malformed-workspace'), shell: false, timeout: 1.5 },
          ],
        }),
      ],
      [
        'timeout-unsafe',
        (root) => ({
          value: malformedTask({ executor: { timeout_ms: Number.MAX_SAFE_INTEGER + 1 } }),
          args: [
            'node',
            ['invalid-probe'],
            {
              cwd: join(root, 'malformed-workspace'),
              shell: false,
              timeout: Number.MAX_SAFE_INTEGER + 1,
            },
          ],
        }),
      ],
    ];

    for (const [label, makeCase] of cases) {
      const root = repository();
      mkdirSync(join(root, 'malformed-workspace'));
      const { value, args } = makeCase(root);
      writeTask(root, value, 'TASK-6000.json');
      expect(
        matchDeclaredRoundTaskProcess(
          root,
          [process.execPath, 'devai', 'round', 'run', '--round', 'R-0007'],
          request(root, args),
        ),
        `${label}: malformed candidate`,
      ).toBeUndefined();

      writeTask(root);
      expect(matchDeclaredRoundTaskProcess(root, invocation(), request(root)), label).toEqual({
        taskId: 'TASK-7001',
        cwd: realpathSync(root),
      });
    }
  });

  it('rejects structurally unmatchable malformed task values without throwing', () => {
    const malformed: readonly [string, unknown][] = [
      ['null', null],
      ['array', []],
      ['round', malformedTask({ round_id: 7 })],
      ['executor-null', malformedTask({ executor: null })],
      ['argv-object', malformedTask({ executor: { argv: {} } })],
      ['argv-empty', malformedTask({ executor: { argv: [] } })],
      ['argv-value', malformedTask({ executor: { argv: ['node', 7] } })],
      ['cwd-type', malformedTask({ executor: { cwd: 7 } })],
      ['timeout-type', malformedTask({ executor: { timeout_ms: '13000' } })],
    ];
    for (const [label, value] of malformed) {
      const root = repository();
      writeTask(root, value, 'TASK-6000.json');
      expect(
        matchDeclaredRoundTaskProcess(root, invocation(), request(root)),
        label,
      ).toBeUndefined();
    }
  });

  it('rejects absent, malformed, and non-task task sources without throwing', () => {
    const missing = mkdtempSync(join(tmpdir(), 'devai-round-process-no-tasks-'));
    roots.push(missing);
    expect(matchDeclaredRoundTaskProcess(missing, invocation(), request(missing))).toBeUndefined();

    const malformed = repository();
    writeFileSync(join(malformed, '.devai/state/tasks/TASK-7001.json'), '{');
    expect(
      matchDeclaredRoundTaskProcess(malformed, invocation(), request(malformed)),
    ).toBeUndefined();

    for (const name of [
      'TASK-x.json',
      'TASK-7001.txt',
      'prefix-TASK-7001.json',
      'TASK-7001-suffix.json',
      'TASK-7001.json.bak',
    ]) {
      const root = repository();
      writeTask(root, task(), name);
      expect(
        matchDeclaredRoundTaskProcess(root, invocation(), request(root)),
        name,
      ).toBeUndefined();
    }
  });

  it('rejects each invocation and host request shape independently', () => {
    const root = repository();
    writeTask(root);
    const valid = request(root);
    const invalidInvocations: readonly (readonly string[])[] = [
      invocation().filter((value) => value !== '--round' && value !== 'R-0007'),
      invocation().with(5, 'R-7'),
      invocation().with(5, 'prefix-R-0007'),
      invocation().with(5, 'R-0007-suffix'),
      [...invocation(), '--round', 'R-0008'],
      [...invocation(), '--task', 'TASK-x'],
      [...invocation(), '--task', 'prefix-TASK-7001'],
      [...invocation(), '--task', 'TASK-7001-suffix'],
    ];
    for (const argv of invalidInvocations) {
      expect(matchDeclaredRoundTaskProcess(root, argv, valid), argv.join(' ')).toBeUndefined();
    }
    for (const argv of [
      [...invocation(), '--round'],
      [...invocation(), '--task'],
    ]) {
      expect(matchDeclaredRoundTaskProcess(root, argv, valid), argv.join(' ')).toEqual({
        taskId: 'TASK-7001',
        cwd: realpathSync(root),
      });
    }

    const arrayOptions = Object.assign([], { shell: false, cwd: root, timeout: 12_000 });
    const invalidRequests: readonly AuthorityHostEffectRequest[] = [
      request(root, undefined, { kind: 'filesystem' }),
      request(root, undefined, { symbol: 'execFileSync' }),
      request(root, [7, ['run', 'verify'], { cwd: root, shell: false, timeout: 12_000 }]),
      request(root, ['pnpm', 'run verify', { cwd: root, shell: false, timeout: 12_000 }]),
      request(root, ['pnpm', ['run', 7], { cwd: root, shell: false, timeout: 12_000 }]),
      request(root, ['pnpm', ['run', 'verify'], null]),
      request(root, ['pnpm', ['run', 'verify'], arrayOptions]),
      request(root, ['pnpm', ['run', 'verify'], 'options']),
      request(root, ['pnpm', ['run', 'verify'], { cwd: root, timeout: 12_000 }]),
      request(root, ['pnpm', ['run', 'verify'], { cwd: root, shell: true, timeout: 12_000 }]),
      request(root, ['pnpm', ['run', 'verify'], { cwd: 7, shell: false, timeout: 12_000 }]),
      request(root, ['pnpm', ['run', 'verify'], { cwd: root, shell: false, timeout: '12000' }]),
    ];
    for (const effect of invalidRequests) {
      expect(matchDeclaredRoundTaskProcess(root, invocation(), effect)).toBeUndefined();
    }
  });

  it('uses the last round, validates every task selector, and matches exact command fields', () => {
    const root = repository();
    writeTask(root, task({ id: 'TASK-6000' }), 'TASK-6000.json');
    writeTask(root);
    expect(
      matchDeclaredRoundTaskProcess(
        root,
        [...invocation(), '--round', 'R-0007', '--task', 'TASK-6000'],
        request(root),
      ),
    ).toEqual({ taskId: 'TASK-6000', cwd: realpathSync(root) });
    const singleRoot = repository();
    writeTask(singleRoot);
    expect(
      matchDeclaredRoundTaskProcess(
        singleRoot,
        [process.execPath, 'devai', 'round', 'run', '--round', 'R-0007'],
        request(singleRoot),
      ),
    ).toEqual({ taskId: 'TASK-7001', cwd: realpathSync(singleRoot) });
    expect(
      matchDeclaredRoundTaskProcess(
        root,
        [...invocation(), '--task', 'TASK-6000', '--task', 'invalid'],
        request(root),
      ),
    ).toBeUndefined();

    const mismatches: readonly (readonly unknown[])[] = [
      ['node', ['run', 'verify'], { cwd: root, shell: false, timeout: 12_000 }],
      ['pnpm', ['verify', 'run'], { cwd: root, shell: false, timeout: 12_000 }],
      ['pnpm', ['run'], { cwd: root, shell: false, timeout: 12_000 }],
      ['pnpm', ['run', 'verify', '--extra'], { cwd: root, shell: false, timeout: 12_000 }],
      ['pnpm', ['run', 'verify'], { cwd: root, shell: false, timeout: 11_999 }],
    ];
    for (const args of mismatches) {
      expect(
        matchDeclaredRoundTaskProcess(root, invocation(), request(root, args)),
      ).toBeUndefined();
    }
  });

  it('binds declared cwd by real path and rejects missing or drifting cwd', () => {
    const root = repository();
    mkdirSync(join(root, 'workspace'));
    writeTask(root, task({ executor: { cwd: 'workspace' } }));
    const workspace = join(root, 'workspace');
    const alias = join(root, 'workspace-alias');
    symlinkSync('workspace', alias);
    expect(matchDeclaredRoundTaskProcess(root, invocation(), request(workspace))).toEqual({
      taskId: 'TASK-7001',
      cwd: realpathSync(workspace),
    });
    expect(matchDeclaredRoundTaskProcess(root, invocation(), request(alias))).toEqual({
      taskId: 'TASK-7001',
      cwd: realpathSync(workspace),
    });
    expect(matchDeclaredRoundTaskProcess(root, invocation(), request(root))).toBeUndefined();
    expect(
      matchDeclaredRoundTaskProcess(root, invocation(), request(join(root, 'missing'))),
    ).toBeUndefined();

    const absent = repository();
    writeTask(absent, task({ executor: { cwd: 'missing' } }));
    expect(matchDeclaredRoundTaskProcess(absent, invocation(), request(absent))).toBeUndefined();
  });

  it('accepts only an exact registered worktree contained by the managed root', () => {
    const cases: readonly [string, (root: string) => unknown, (root: string) => string][] = [
      ['missing-registry', () => undefined, (root) => root],
      ['malformed-registry', () => '{', (root) => root],
      ['array-registry', () => [], (root) => root],
      ['missing-record', () => ({ worktrees: [] }), (root) => root],
      [
        'wrong-task',
        (root) => ({
          worktrees: [
            {
              id: 'WT-7001',
              task_id: 'TASK-9999',
              path: join(root, '.devai/worktrees/WT-7001'),
            },
          ],
        }),
        (root) => join(root, '.devai/worktrees/WT-7001'),
      ],
      [
        'wrong-id',
        (root) => ({
          worktrees: [
            {
              id: 'WT-other',
              task_id: 'TASK-7001',
              path: join(root, '.devai/worktrees/WT-other'),
            },
          ],
        }),
        (root) => join(root, '.devai/worktrees/WT-other'),
      ],
      [
        'missing-path',
        (root) => ({
          worktrees: [{ id: 'WT-7001', task_id: 'TASK-7001', path: join(root, 'missing') }],
        }),
        (root) => root,
      ],
      [
        'outside',
        (root) => ({ worktrees: [{ id: 'WT-7001', task_id: 'TASK-7001', path: root }] }),
        (root) => root,
      ],
      [
        'prefix-sibling',
        (root) => ({
          worktrees: [
            {
              id: 'WT-7001',
              task_id: 'TASK-7001',
              path: join(root, '.devai/worktrees-escape/WT-7001'),
            },
          ],
        }),
        (root) => join(root, '.devai/worktrees-escape/WT-7001'),
      ],
    ];

    for (const [label, registry, cwd] of cases) {
      const root = repository();
      mkdirSync(join(root, '.devai/worktrees/WT-7001'), { recursive: true });
      mkdirSync(join(root, '.devai/worktrees/WT-other'), { recursive: true });
      mkdirSync(join(root, '.devai/worktrees-escape/WT-7001'), { recursive: true });
      writeTask(root, task({ worktree_id: 'WT-7001' }));
      const value = registry(root);
      if (value !== undefined) {
        writeFileSync(
          join(root, '.devai/state/worktrees.json'),
          typeof value === 'string' ? value : `${JSON.stringify(value)}\n`,
        );
      }
      expect(
        matchDeclaredRoundTaskProcess(root, invocation(), request(cwd(root))),
        label,
      ).toBeUndefined();
    }

    const root = repository();
    const managedRoot = join(root, '.devai/worktrees');
    const nested = join(managedRoot, 'WT-7001');
    mkdirSync(nested, { recursive: true });
    writeTask(root, task({ worktree_id: 'WT-7001' }));
    writeFileSync(
      join(root, '.devai/state/worktrees.json'),
      `${JSON.stringify({
        worktrees: [{ id: 'WT-7001', task_id: 'TASK-7001', path: nested }],
      })}\n`,
    );
    expect(matchDeclaredRoundTaskProcess(root, invocation(), request(nested))).toEqual({
      taskId: 'TASK-7001',
      cwd: realpathSync(nested),
    });

    writeFileSync(
      join(root, '.devai/state/worktrees.json'),
      `${JSON.stringify({
        worktrees: [{ id: 'WT-7001', task_id: 'TASK-7001', path: managedRoot }],
      })}\n`,
    );
    expect(matchDeclaredRoundTaskProcess(root, invocation(), request(managedRoot))).toEqual({
      taskId: 'TASK-7001',
      cwd: realpathSync(managedRoot),
    });
  });
});
