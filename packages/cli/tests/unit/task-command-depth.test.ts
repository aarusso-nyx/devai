import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { CAC } from '../../node_modules/cac/dist/index.d.ts';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => {
  class TaskServiceError extends Error {
    constructor(
      readonly code: string,
      readonly exitCode: number,
    ) {
      super(code);
    }
  }
  return {
    add: vi.fn(),
    complete: vi.fn(),
    escalate: vi.fn(),
    finish: vi.fn(),
    list: vi.fn(),
    materialize: vi.fn(),
    next: vi.fn(),
    pause: vi.fn(),
    resourceStatus: vi.fn(),
    resume: vi.fn(),
    start: vi.fn(),
    status: vi.fn(),
    read: vi.fn(),
    TaskServiceError,
  };
});

vi.mock('@devai-nyx/authority', () => ({
  readFileSync: (...args: unknown[]) => runtime.read(...args),
}));

vi.mock('#runtime-core', () => {
  return {
    addRoundQueueEntry: (...args: unknown[]) => runtime.add(...args),
    completeRoundQueueEntry: (...args: unknown[]) => runtime.complete(...args),
    escalateRoundTask: (...args: unknown[]) => runtime.escalate(...args),
    finishRoundTask: (...args: unknown[]) => runtime.finish(...args),
    listRoundQueue: (...args: unknown[]) => runtime.list(...args),
    materializeRoundQueueTask: (...args: unknown[]) => runtime.materialize(...args),
    nextRoundQueueEntry: (...args: unknown[]) => runtime.next(...args),
    pauseRoundTask: (...args: unknown[]) => runtime.pause(...args),
    resumeRoundTask: (...args: unknown[]) => runtime.resume(...args),
    roundTaskResourceStatus: (...args: unknown[]) => runtime.resourceStatus(...args),
    roundTaskStatus: (...args: unknown[]) => runtime.status(...args),
    startRoundTask: (...args: unknown[]) => runtime.start(...args),
    TaskServiceError: runtime.TaskServiceError,
  };
});

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};

type Definition = { readonly name: string; readonly authority?: string; register(cli: CAC): void };
type Module = typeof import('../../src/commands/task/index.js');
let commands!: Module;

beforeAll(async () => {
  // Activate static command definitions in the test realm after mocks are installed.
  vi.resetModules();
  commands = await import('../../src/commands/task/index.js');
});

beforeEach(() => {
  vi.clearAllMocks();
  runtime.add.mockReturnValue({ id: 'QUEUE-1', status: 'queued' });
  runtime.complete.mockReturnValue({ id: 'TASK-1', status: 'completed' });
  runtime.escalate.mockReturnValue({ id: 'TASK-1', status: 'escalated' });
  runtime.finish.mockReturnValue({ id: 'TASK-1', status: 'completed' });
  runtime.list.mockReturnValue([{ id: 'TASK-1', status: 'queued' }]);
  runtime.materialize.mockReturnValue({
    entry: { id: 'TASK-FILE', status: 'queued' },
    task: { id: 'TASK-FILE', status: 'queued' },
  });
  runtime.next.mockReturnValue({ id: 'TASK-1', status: 'queued' });
  runtime.pause.mockReturnValue({ id: 'TASK-1', status: 'paused' });
  runtime.resourceStatus.mockReturnValue({ resource: 'db', values: [] });
  runtime.resume.mockReturnValue({ id: 'TASK-1', status: 'ready' });
  runtime.start.mockReturnValue({ task: { id: 'TASK-1', status: 'ready' } });
  runtime.status.mockReturnValue({ round_id: 'R-1', tasks: [] });
  runtime.read.mockReturnValue(JSON.stringify({ id: 'TASK-FILE', round_id: 'R-1' }));
});

async function invoke(definition: Definition, argv: readonly string[]) {
  const cli = cac('devai-task-depth');
  definition.register(cli);
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let stdout = '';
  let stderr = '';
  try {
    process.argv = ['node', 'devai', ...argv];
    process.exitCode = undefined;
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    cli.parse(process.argv, { run: false });
    await cli.runMatchedCommand();
    await new Promise<void>((done) => setImmediate(done));
    return { exit: process.exitCode ?? 0, stdout, stderr };
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

function json(text: string): unknown {
  return JSON.parse(text.trim()) as unknown;
}

describe('task command registration and routing', () => {
  it('activates the complete immutable public command inventory', () => {
    expect(commands.taskCommands.map(({ name, authority }) => ({ name, authority }))).toEqual(
      [
        'task queue add',
        'task queue complete',
        'task queue list',
        'task queue next',
        'task start',
        'task finish',
        'task escalate',
        'task pause',
        'task resume',
        'task status',
      ].map((name) => ({ name, authority: 'mesh_controller' })),
    );
  });

  it('registers the exact CAC command and option surface', () => {
    const common = ['--repo-root <path>', '--round <round_id>', '--human'];
    const expected = [
      [
        commands.taskQueueAdd,
        'task-queue-add',
        'Add one active-round queue item',
        [
          ...common,
          '--title <text>',
          '--priority <number>',
          '--description <text>',
          '--input <path>',
        ],
      ],
      [
        commands.taskQueueComplete,
        'task-queue-complete',
        'Complete one queue item',
        [...common, '--task <task_id>'],
      ],
      [commands.taskQueueList, 'task-queue-list', 'List active-round queue items', common],
      [commands.taskQueueNext, 'task-queue-next', 'Read the next queue item', common],
      [
        commands.taskStart,
        'task-start',
        'Start one active-round task',
        [
          ...common,
          '--task <task_id>',
          '--with-worktree',
          '--with-db',
          '--database-url <url>',
          '--base-ref <ref>',
        ],
      ],
      [
        commands.taskFinish,
        'task-finish',
        'Finish one round-subordinate task and release its declared resources.',
        [
          ...common,
          '--task <task_id>',
          '--destroy-worktree',
          '--drop-db',
          '--database-url <url>',
          '--evidence <ref>',
          '--completed-by-role <role>',
        ],
      ],
      [
        commands.taskEscalate,
        'task-escalate',
        'Escalate one round-subordinate task through hidden plumbing.',
        [
          ...common,
          '--task <task_id>',
          '--destroy-worktree',
          '--drop-db',
          '--database-url <url>',
          '--evidence <ref>',
          '--completed-by-role <role>',
        ],
      ],
      [
        commands.taskPause,
        'task-pause',
        'Pause one task on a governed gap',
        [...common, '--task <task_id>', '--gap <gap_id>'],
      ],
      [
        commands.taskResume,
        'task-resume',
        'Resume one task after gap resolution',
        [...common, '--task <task_id>', '--gap <gap_id>'],
      ],
      [
        commands.taskStatus,
        'task-status',
        'Read active-round task status',
        [
          ...common,
          '--task <task_id>',
          '--resources <kind>',
          '--container-name <name>',
          '--database-url <url>',
        ],
      ],
    ] as const;
    for (const [definition, rawName, description, optionNames] of expected) {
      const cli = cac('devai-task-registration');
      definition.register(cli);
      const registered = cli.commands[0];
      expect(registered).toBeDefined();
      expect(registered?.rawName).toBe(rawName);
      expect(registered?.description).toBe(description);
      expect(registered?.options.map((option) => option.rawName)).toEqual(optionNames);
      expect(registered?.options.slice(0, 3).map((option) => option.description)).toEqual([
        'Repository root (default: cwd)',
        'Explicit active owning round (required)',
        'Human-readable output',
      ]);
    }
    for (const [definition, descriptions] of [
      [commands.taskQueueAdd, ['Queue item title', 'Priority (default: 50)']],
      [commands.taskQueueComplete, ['Queue task identity']],
      [commands.taskStart, ['Task identity', 'Provision the declared managed worktree']],
      [commands.taskFinish, ['Task identity', 'Destroy the declared managed worktree']],
      [commands.taskPause, ['Task identity', 'Governed gap identity']],
      [commands.taskResume, ['Task identity', 'Governed gap identity']],
      [
        commands.taskStatus,
        ['Optional task identity', 'Resource projection: db, locks, or worktrees'],
      ],
    ] as const) {
      const cli = cac('devai-task-help');
      definition.register(cli);
      expect(
        cli.commands[0]?.options.slice(3, 3 + descriptions.length).map((item) => item.description),
      ).toEqual(descriptions);
    }
  });

  it('routes queue operations with exact identities and deterministic output', async () => {
    const root = resolve('/fixture/repository');
    expect(
      json(
        (
          await invoke(commands.taskQueueAdd, [
            'task-queue-add',
            '--repo-root',
            root,
            '--round',
            'R-1',
            '--title',
            'One task',
            '--priority',
            '7',
            '--description',
            'bounded',
          ])
        ).stdout,
      ),
    ).toEqual({ id: 'QUEUE-1', status: 'queued' });
    expect(runtime.add).toHaveBeenCalledWith({
      repoRoot: root,
      round: 'R-1',
      title: 'One task',
      priority: 7,
      description: 'bounded',
    });

    const complete = await invoke(commands.taskQueueComplete, [
      'task-queue-complete',
      '--repo-root',
      root,
      '--round',
      'R-1',
      '--task',
      'TASK-1',
      '--human',
    ]);
    expect(complete).toMatchObject({
      exit: 0,
      stdout: 'task queue complete: TASK-1\n',
      stderr: '',
    });
    expect(runtime.complete).toHaveBeenCalledWith({
      repoRoot: root,
      round: 'R-1',
      taskId: 'TASK-1',
    });

    expect(
      json((await invoke(commands.taskQueueList, ['task-queue-list', '--round', 'R-1'])).stdout),
    ).toEqual({
      round_id: 'R-1',
      count: 1,
      entries: [{ id: 'TASK-1', status: 'queued' }],
    });
    expect(
      json((await invoke(commands.taskQueueNext, ['task-queue-next', '--round', 'R-1'])).stdout),
    ).toEqual({
      round_id: 'R-1',
      next: { id: 'TASK-1', status: 'queued' },
    });
    runtime.next.mockReturnValueOnce(null);
    expect(
      (await invoke(commands.taskQueueNext, ['task-queue-next', '--round', 'R-1', '--human']))
        .stdout,
    ).toBe('task queue next: (empty)\n');
  });

  it('materializes only a repository-contained task record', async () => {
    const root = resolve('/fixture/repository');
    const result = await invoke(commands.taskQueueAdd, [
      'task-queue-add',
      '--repo-root',
      root,
      '--round',
      'R-1',
      '--input',
      'work/task.json',
    ]);
    expect(result.exit).toBe(0);
    expect(runtime.read).toHaveBeenCalledWith(resolve(root, 'work/task.json'), 'utf8');
    expect(runtime.materialize).toHaveBeenCalledWith({
      repoRoot: root,
      round: 'R-1',
      task: { id: 'TASK-FILE', round_id: 'R-1' },
    });
    expect(json(result.stdout)).toEqual({
      entry: { id: 'TASK-FILE', status: 'queued' },
      task: { id: 'TASK-FILE', status: 'queued' },
    });
  });

  it('routes lifecycle transitions with only explicitly requested effects', async () => {
    const root = resolve('/fixture/repository');
    await invoke(commands.taskStart, [
      'task-start',
      '--repo-root',
      root,
      '--round',
      'R-1',
      '--task',
      'TASK-1',
      '--with-worktree',
      '--with-db',
      '--database-url',
      'postgres://fixture',
      '--base-ref',
      'abc123',
    ]);
    expect(runtime.start).toHaveBeenCalledWith({
      repoRoot: root,
      round: 'R-1',
      taskId: 'TASK-1',
      withWorktree: true,
      withDb: true,
      databaseUrl: 'postgres://fixture',
      baseRef: 'abc123',
    });

    await invoke(commands.taskFinish, [
      'task-finish',
      '--repo-root',
      root,
      '--round',
      'R-1',
      '--task',
      'TASK-1',
      '--destroy-worktree',
      '--drop-db',
      '--database-url',
      'postgres://fixture',
      '--evidence',
      'E-1',
      '--evidence',
      'E-2',
      '--completed-by-role',
      'owner',
    ]);
    expect(runtime.finish).toHaveBeenCalledWith({
      repoRoot: root,
      round: 'R-1',
      taskId: 'TASK-1',
      destroyWorktree: true,
      databaseUrl: 'postgres://fixture',
      evidence: ['E-1', 'E-2'],
      completedByRole: 'owner',
    });

    await invoke(commands.taskEscalate, ['task-escalate', '--round', 'R-1', '--task', 'TASK-1']);
    expect(runtime.escalate).toHaveBeenCalledWith({
      repoRoot: process.cwd(),
      round: 'R-1',
      taskId: 'TASK-1',
    });
    await invoke(commands.taskPause, [
      'task-pause',
      '--round',
      'R-1',
      '--task',
      'TASK-1',
      '--gap',
      'GAP-1',
    ]);
    expect(runtime.pause).toHaveBeenCalledWith({
      repoRoot: process.cwd(),
      round: 'R-1',
      taskId: 'TASK-1',
      gapId: 'GAP-1',
    });
    await invoke(commands.taskResume, [
      'task-resume',
      '--round',
      'R-1',
      '--task',
      'TASK-1',
      '--gap',
      'GAP-1',
    ]);
    expect(runtime.resume).toHaveBeenCalledWith({
      repoRoot: process.cwd(),
      round: 'R-1',
      taskId: 'TASK-1',
      gapId: 'GAP-1',
    });
  });

  it('selects task and resource status projections exactly', async () => {
    const ordinary = await invoke(commands.taskStatus, [
      'task-status',
      '--round',
      'R-1',
      '--task',
      'TASK-1',
    ]);
    expect(json(ordinary.stdout)).toEqual({ round_id: 'R-1', tasks: [] });
    expect(runtime.status).toHaveBeenCalledWith({
      repoRoot: process.cwd(),
      round: 'R-1',
      taskId: 'TASK-1',
    });

    const resource = await invoke(commands.taskStatus, [
      'task-status',
      '--repo-root',
      '/fixture/repository',
      '--round',
      'R-1',
      '--resources',
      'db',
      '--container-name',
      'fixture-db',
      '--database-url',
      'postgres://fixture',
      '--human',
    ]);
    expect(resource.stdout).toBe('task status: R-1 db\n');
    expect(runtime.resourceStatus).toHaveBeenCalledWith({
      repoRoot: '/fixture/repository',
      round: 'R-1',
      resource: 'db',
      containerName: 'fixture-db',
      databaseUrl: 'postgres://fixture',
    });
  });
});

describe('task command validation and refusal', () => {
  it('requires the owning round before every operation reaches runtime', async () => {
    for (const [definition, executable, operation] of [
      [commands.taskQueueAdd, 'task-queue-add', 'queue add'],
      [commands.taskQueueComplete, 'task-queue-complete', 'queue complete'],
      [commands.taskQueueList, 'task-queue-list', 'queue list'],
      [commands.taskQueueNext, 'task-queue-next', 'queue next'],
      [commands.taskStart, 'task-start', 'start'],
      [commands.taskFinish, 'task-finish', 'finish'],
      [commands.taskEscalate, 'task-escalate', 'escalate'],
      [commands.taskPause, 'task-pause', 'pause'],
      [commands.taskResume, 'task-resume', 'resume'],
      [commands.taskStatus, 'task-status', 'status'],
    ] as const) {
      const result = await invoke(definition, [executable]);
      expect(json(result.stderr)).toEqual({ code: 'TASK_ROUND_REQUIRED', operation, exit: 2 });
      expect(result).toMatchObject({ exit: 2, stdout: '' });
    }
    expect(
      [
        runtime.add,
        runtime.complete,
        runtime.list,
        runtime.next,
        runtime.start,
        runtime.finish,
        runtime.escalate,
        runtime.pause,
        runtime.resume,
        runtime.status,
        runtime.resourceStatus,
      ].every((mock) => mock.mock.calls.length === 0),
    ).toBe(true);
  });

  it('rejects queue conflicts, escapes, unreadable JSON, and missing title', async () => {
    const conflict = await invoke(commands.taskQueueAdd, [
      'task-queue-add',
      '--round',
      'R-1',
      '--input',
      'task.json',
      '--title',
      'conflict',
    ]);
    expect(json(conflict.stderr)).toMatchObject({ code: 'TASK_QUEUE_INPUT_CONFLICT', exit: 2 });

    const missing = await invoke(commands.taskQueueAdd, ['task-queue-add', '--round', 'R-1']);
    expect(json(missing.stderr)).toMatchObject({ code: 'TASK_QUEUE_TITLE_REQUIRED', exit: 2 });

    const escape = await invoke(commands.taskQueueAdd, [
      'task-queue-add',
      '--repo-root',
      '/fixture/repository',
      '--round',
      'R-1',
      '--input',
      '../outside.json',
    ]);
    expect(json(escape.stderr)).toMatchObject({ code: 'TASK_QUEUE_INPUT_ESCAPE', exit: 2 });
    expect(runtime.read).not.toHaveBeenCalled();

    runtime.read.mockImplementationOnce(() => {
      throw new Error('unreadable');
    });
    const unreadable = await invoke(commands.taskQueueAdd, [
      'task-queue-add',
      '--round',
      'R-1',
      '--input',
      'task.json',
    ]);
    expect(json(unreadable.stderr)).toMatchObject({ code: 'TASK_RECORD_INVALID', exit: 2 });
    runtime.read.mockReturnValueOnce('{invalid');
    const malformed = await invoke(commands.taskQueueAdd, [
      'task-queue-add',
      '--round',
      'R-1',
      '--input',
      'task.json',
    ]);
    expect(json(malformed.stderr)).toMatchObject({ code: 'TASK_RECORD_INVALID', exit: 2 });
  });

  it('requires task and gap identities at their exact command boundaries', async () => {
    for (const [definition, executable] of [
      [commands.taskQueueComplete, 'task-queue-complete'],
      [commands.taskStart, 'task-start'],
      [commands.taskFinish, 'task-finish'],
      [commands.taskEscalate, 'task-escalate'],
    ] as const) {
      const result = await invoke(definition, [executable, '--round', 'R-1']);
      expect(json(result.stderr)).toMatchObject({ code: 'TASK_ID_REQUIRED', exit: 2 });
    }
    for (const [definition, executable] of [
      [commands.taskPause, 'task-pause'],
      [commands.taskResume, 'task-resume'],
    ] as const) {
      const result = await invoke(definition, [executable, '--round', 'R-1', '--gap', 'GAP-1']);
      expect(json(result.stderr)).toMatchObject({ code: 'TASK_ID_REQUIRED', exit: 2 });
    }
    for (const [definition, executable] of [
      [commands.taskPause, 'task-pause'],
      [commands.taskResume, 'task-resume'],
    ] as const) {
      const result = await invoke(definition, [executable, '--round', 'R-1', '--task', 'TASK-1']);
      expect(json(result.stderr)).toMatchObject({ code: 'TASK_GAP_REQUIRED', exit: 2 });
    }
  });

  it('requires explicit database destruction consent and valid resource kinds', async () => {
    const noUrl = await invoke(commands.taskFinish, [
      'task-finish',
      '--round',
      'R-1',
      '--task',
      'TASK-1',
      '--drop-db',
    ]);
    expect(json(noUrl.stderr)).toMatchObject({ code: 'TASK_DATABASE_URL_REQUIRED', exit: 2 });
    const noConsent = await invoke(commands.taskFinish, [
      'task-finish',
      '--round',
      'R-1',
      '--task',
      'TASK-1',
      '--database-url',
      'postgres://fixture',
    ]);
    expect(json(noConsent.stderr)).toMatchObject({
      code: 'TASK_DROP_DB_CONSENT_REQUIRED',
      exit: 2,
    });
    const resource = await invoke(commands.taskStatus, [
      'task-status',
      '--round',
      'R-1',
      '--resources',
      'network',
    ]);
    expect(json(resource.stderr)).toMatchObject({ code: 'TASK_RESOURCE_KIND_INVALID', exit: 2 });
    expect(runtime.finish).not.toHaveBeenCalled();
    expect(runtime.resourceStatus).not.toHaveBeenCalled();
  });

  it('maps unexpected service failures to the closed generic operation error', async () => {
    runtime.status.mockImplementationOnce(() => {
      throw new Error('sensitive internal detail');
    });
    const result = await invoke(commands.taskStatus, ['task-status', '--round', 'R-1']);
    expect(json(result.stderr)).toEqual({
      code: 'TASK_OPERATION_FAILED',
      operation: 'status',
      exit: 2,
    });
    expect(result.stdout).toBe('');
  });
});
