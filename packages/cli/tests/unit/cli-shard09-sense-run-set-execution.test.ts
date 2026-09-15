import type { CAC } from 'cac';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_PASS, EXIT_USAGE } from '@devai-nyx/utils';
import type { SensorKind } from '@devai-nyx/sensors';
import { canonicalRegistry } from '../../src/define-command.js';
import type { ResolvedSenseSelection } from '../../src/commands/sense/facade.js';

const mocks = vi.hoisted(() => ({ sensorAdapter: vi.fn() }));

vi.mock('../../src/commands/sense/adapters.js', () => ({
  sensorAdapter: mocks.sensorAdapter,
}));

import {
  executeResolvedSenseSelection,
  routeSensorChildArgv,
  senseRunSetCmd,
} from '../../src/commands/sense/run-set.js';

interface Options {
  readonly preset?: string;
  readonly round?: string;
  readonly repoRoot?: string;
  readonly input?: string;
  readonly dryRun?: boolean;
  readonly human?: boolean;
}

interface CommandCapture {
  option(): CommandCapture;
  action(callback: (kind: string | undefined, options: Options) => Promise<void>): CommandCapture;
}

let invoke: (kind: string | undefined, options: Options) => Promise<void>;
const originalExitCode = process.exitCode;
const originalStdout = process.stdout.write;
const originalStderr = process.stderr.write;

beforeAll(() => {
  const command: CommandCapture = {
    option: () => command,
    action(callback): CommandCapture {
      invoke = callback;
      return command;
    },
  };
  senseRunSetCmd.register({ command: () => command } as unknown as CAC);
});

beforeEach(() => {
  mocks.sensorAdapter.mockReset();
});

afterEach(() => {
  process.exitCode = originalExitCode;
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
});

async function run(kind: string | undefined, options: Options) {
  let stdout = '';
  let stderr = '';
  process.exitCode = undefined;
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await invoke(kind, options);
    return { stdout, stderr, exit: process.exitCode ?? 0 };
  } finally {
    process.exitCode = originalExitCode;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

const member = (kind: string) => ({
  kind,
  effect: 'read' as const,
  capabilities: [] as const,
  consent: { write: false, publish: false },
});

describe('CLI shard 09 sense run set execution', () => {
  it('preserves member order, omission semantics, status exits, and frozen results', async () => {
    const statuses = [
      ['type_check', 'pass', 0, false],
      ['lint', 'review', 1, false],
      ['build', 'fail', 2, false],
      ['unit_test', 'skipped', 0, true],
      ['integration_test', 'error', 2, false],
      ['e2e_test', 'killed', 2, false],
    ] as const;
    const adapters = new Map(
      statuses.map(([kind, status]) => [
        kind,
        vi.fn(async () => ({ sensor: { kind }, status, findings: [] })),
      ]),
    );
    mocks.sensorAdapter.mockImplementation((kind: SensorKind) =>
      adapters.get(kind as (typeof statuses)[number][0]),
    );
    const resolved = {
      selection: { type: 'preset', value: 'fixture' },
      members: statuses.map(([kind]) => member(kind)),
      executed: statuses.map(([kind]) => kind),
      excluded: [],
      round_required: false,
      aggregate_effect: 'read',
      generic_ceiling: 'remote-write',
      implicit_persistence: false,
    } satisfies ResolvedSenseSelection;

    const results = await executeResolvedSenseSelection(resolved, {
      repoRoot: '/repo',
      inputs: { fixture: true },
    });

    expect(Object.isFrozen(results)).toBe(true);
    expect(results).toEqual(
      statuses.map(([kind, status, processStatus, na]) => ({
        command: `devai sense run ${kind}`,
        processStatus,
        stdout: JSON.stringify({ sensor: { kind }, status, findings: [] }),
        stderr: '',
        na,
      })),
    );
    for (const [kind] of statuses) {
      expect(mocks.sensorAdapter).toHaveBeenCalledWith(kind);
      expect(adapters.get(kind)).toHaveBeenCalledWith({
        repoRoot: '/repo',
        inputs: { fixture: true },
      });
    }

    const withoutInputs = vi.fn(async (_request: unknown) => ({
      sensor: { kind: 'type_check' },
      status: 'pass',
    }));
    mocks.sensorAdapter.mockReturnValue(withoutInputs);
    await executeResolvedSenseSelection(
      { ...resolved, members: [member('type_check')], executed: ['type_check'] },
      { repoRoot: '/repo' },
    );
    expect(withoutInputs).toHaveBeenCalledWith({ repoRoot: '/repo' });
    expect(Object.keys(withoutInputs.mock.calls[0]?.[0] ?? {})).toEqual(['repoRoot']);

    mocks.sensorAdapter.mockReturnValue(
      vi.fn(async () => ({ sensor: { kind: 'lint' }, status: 'pass' })),
    );
    await expect(
      executeResolvedSenseSelection(
        { ...resolved, members: [member('type_check')], executed: ['type_check'] },
        { repoRoot: '/repo' },
      ),
    ).resolves.toEqual([
      {
        command: 'devai sense run type_check',
        processStatus: null,
        stdout: '',
        stderr: 'SENSE_ADAPTER_KIND_MISMATCH:type_check:lint',
      },
    ]);

    for (const token of ['pkg', '@scope/pkg-._']) {
      const refusal = new Error(`OPTIONAL_DEPENDENCY_MISSING:${token}`);
      mocks.sensorAdapter.mockReturnValue(vi.fn(async () => Promise.reject(refusal)));
      await expect(
        executeResolvedSenseSelection(
          { ...resolved, members: [member('type_check')], executed: ['type_check'] },
          { repoRoot: '/repo' },
        ),
      ).rejects.toBe(refusal);
    }

    for (const diagnostic of [
      'prefixOPTIONAL_DEPENDENCY_MISSING:pkg',
      'OPTIONAL_DEPENDENCY_MISSING:pkg!',
    ]) {
      mocks.sensorAdapter.mockReturnValue(vi.fn(async () => Promise.reject(new Error(diagnostic))));
      await expect(
        executeResolvedSenseSelection(
          { ...resolved, members: [member('type_check')], executed: ['type_check'] },
          { repoRoot: '/repo' },
        ),
      ).resolves.toEqual([
        {
          command: 'devai sense run type_check',
          processStatus: null,
          stdout: '',
          stderr: diagnostic,
        },
      ]);
    }
  });

  it('preserves registered paths and suffix arguments and rejects every invalid input shape', async () => {
    expect(
      routeSensorChildArgv(
        ['sense', 'run', 'type_check', '--repo-root', '/repo'],
        '/cli.js',
        canonicalRegistry(),
        '1.5.0',
      ),
    ).toEqual(['sense', 'run', 'type_check', '--repo-root', '/repo']);
    expect(() =>
      routeSensorChildArgv(['sense', 'run', 'unknown'], '/cli.js', canonicalRegistry(), '1.5.0'),
    ).toThrow('SENSE_RUN_CHILD_ROUTE_INVALID');
    expect(() =>
      routeSensorChildArgv(['--version'], '/cli.js', canonicalRegistry(), '1.5.0'),
    ).toThrow('SENSE_RUN_CHILD_ACTION_UNKNOWN');

    for (const input of ['null', '[]', '"text"', '1', 'true', '{']) {
      const result = await run('type_check', { input });
      expect(result.stdout).toBe('');
      expect(result.exit).toBe(EXIT_USAGE);
      expect(result.stderr).toMatch(/^devai sense run: .+\n$/u);
    }
    expect(mocks.sensorAdapter).not.toHaveBeenCalled();

    const adapter = vi.fn(async () => ({
      sensor: { kind: 'type_check' },
      status: 'pass',
      findings: [],
    }));
    mocks.sensorAdapter.mockReturnValue(adapter);
    const defaulted = await run('type_check', {});
    expect(defaulted).toMatchObject({ stderr: '', exit: EXIT_PASS });
    expect(adapter).toHaveBeenLastCalledWith({ repoRoot: '.' });

    const explicit = await run('type_check', { repoRoot: '/repo', input: '{"value":false}' });
    expect(explicit).toMatchObject({ stderr: '', exit: EXIT_PASS });
    expect(adapter).toHaveBeenLastCalledWith({ repoRoot: '/repo', inputs: { value: false } });

    for (const [kind, options] of [
      [undefined, {}],
      ['type_check', { preset: 'baseline' }],
    ] as const) {
      const result = await run(kind, options);
      expect(result).toMatchObject({ stdout: '', exit: EXIT_USAGE });
      expect(result.stderr).toBe('devai sense run: SENSE_SELECTION_EXACTLY_ONE_REQUIRED\n');
    }
  });
});
