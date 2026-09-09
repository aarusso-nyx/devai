import type { CAC } from 'cac';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_GATE, EXIT_PASS, EXIT_REVIEW, EXIT_USAGE } from '@devai-nyx/utils';
import { canonicalRegistry } from '../../src/define-command.js';

const mocks = vi.hoisted(() => ({ sensorAdapter: vi.fn() }));

vi.mock('../../src/commands/sense/adapters.js', () => ({
  sensorAdapter: mocks.sensorAdapter,
}));

import { routeSensorChildArgv, senseRunSetCmd } from '../../src/commands/sense/run-set.js';

interface Options {
  readonly preset?: string;
  readonly round?: string;
  readonly repoRoot?: string;
  readonly input?: string;
  readonly dryRun?: boolean;
  readonly human?: boolean;
}

interface Capture {
  option(): Capture;
  action(callback: (kind: string | undefined, options: Options) => Promise<void>): Capture;
}

let invoke: (kind: string | undefined, options: Options) => Promise<void>;
const originalExitCode = process.exitCode;
const originalStdout = process.stdout.write;
const originalStderr = process.stderr.write;

beforeAll(() => {
  const command: Capture = {
    option(): Capture {
      return command;
    },
    action(callback): Capture {
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

describe('sense run command boundaries', () => {
  it('routes child argv only through a registered dispatch action', () => {
    const entries = canonicalRegistry();
    expect(
      routeSensorChildArgv(['sense', 'run', 'type_check', '--json'], '/cli.js', entries, '1.5.0'),
    ).toEqual(['sense', 'run', 'type_check']);
    expect(() =>
      routeSensorChildArgv(['sense', 'run', 'unknown'], '/cli.js', entries, '1.5.0'),
    ).toThrow('SENSE_RUN_CHILD_ROUTE_INVALID');
    expect(() => routeSensorChildArgv(['--version'], '/cli.js', entries, '1.5.0')).toThrow(
      'SENSE_RUN_CHILD_ACTION_UNKNOWN',
    );
  });

  it('resolves an exact kind and preset without executing adapters in dry-run mode', async () => {
    const kind = await run('type_check', { dryRun: true, repoRoot: '/unused' });
    expect(kind.stderr).toBe('');
    expect(kind.exit).toBe(EXIT_PASS);
    expect(JSON.parse(kind.stdout)).toMatchObject({
      ok: true,
      dry_run: true,
      selection: { type: 'kind', value: 'type_check' },
      aggregate_effect: 'read',
      members: [{ kind: 'type_check', effect: 'read' }],
    });

    const preset = await run(undefined, { preset: 'structural', dryRun: true });
    expect(preset.exit).toBe(EXIT_PASS);
    expect(JSON.parse(preset.stdout)).toMatchObject({
      ok: true,
      dry_run: true,
      selection: { type: 'preset', value: 'structural' },
    });
    expect(mocks.sensorAdapter).not.toHaveBeenCalled();
  });

  it('executes a selected adapter with parsed inputs and emits the JSON aggregate', async () => {
    const adapter = vi.fn(async () => ({
      sensor: { kind: 'type_check' },
      status: 'pass',
      findings: [],
    }));
    mocks.sensorAdapter.mockReturnValue(adapter);

    const result = await run('type_check', {
      repoRoot: '/owned/repository',
      input: '{"project":"cli"}',
    });
    expect(result.stderr).toBe('');
    expect(result.exit).toBe(EXIT_PASS);
    expect(mocks.sensorAdapter).toHaveBeenCalledWith('type_check');
    expect(adapter).toHaveBeenCalledWith({
      repoRoot: '/owned/repository',
      inputs: { project: 'cli' },
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      dry_run: false,
      execution_status: 'pass',
      readiness_status: 'pass',
      applicable_count: 1,
      exit_code: EXIT_PASS,
      results: [
        {
          command: 'devai sense run type_check',
          status: EXIT_PASS,
          na: false,
        },
      ],
    });
  });

  it('renders review status in human mode', async () => {
    mocks.sensorAdapter.mockReturnValue(
      vi.fn(async () => ({ sensor: { kind: 'type_check' }, status: 'review' })),
    );
    const result = await run('type_check', { human: true });
    expect(result).toEqual({
      stdout:
        'devai sense run (type_check): execution=PASS readiness=REVIEW executed=1 excluded=0\n',
      stderr: '',
      exit: EXIT_REVIEW,
    });
  });

  it('fails usage for invalid selection and non-object inputs before adapter execution', async () => {
    for (const [kind, options, diagnostic] of [
      [undefined, {}, 'SENSE_SELECTION_EXACTLY_ONE_REQUIRED'],
      ['type_check', { preset: 'baseline' }, 'SENSE_SELECTION_EXACTLY_ONE_REQUIRED'],
      ['unknown_kind', {}, 'SENSE_KIND_UNKNOWN:unknown_kind'],
      ['type_check', { input: '[]' }, 'SENSE_INPUT_MUST_BE_JSON_OBJECT'],
    ] as const) {
      const result = await run(kind, options);
      expect(result.stdout).toBe('');
      expect(result.exit).toBe(EXIT_USAGE);
      expect(result.stderr).toContain(`devai sense run: ${diagnostic}`);
    }
    expect(mocks.sensorAdapter).not.toHaveBeenCalled();
  });

  it('preserves an optional-dependency refusal for the caller to classify', async () => {
    mocks.sensorAdapter.mockReturnValue(
      vi.fn(async () => {
        throw new Error('OPTIONAL_DEPENDENCY_MISSING:@scope/runtime');
      }),
    );
    await expect(run('type_check', {})).rejects.toThrow(
      'OPTIONAL_DEPENDENCY_MISSING:@scope/runtime',
    );
  });

  it('turns adapter identity and execution failures into failed child results', async () => {
    mocks.sensorAdapter.mockReturnValueOnce(
      vi.fn(async () => ({ sensor: { kind: 'lint' }, status: 'pass' })),
    );
    const mismatch = await run('type_check', {});
    expect(mismatch.stderr).toBe('');
    expect(mismatch.exit).toBe(EXIT_GATE);
    expect(JSON.parse(mismatch.stdout)).toMatchObject({
      ok: false,
      execution_status: 'error',
      results: [
        {
          command: 'devai sense run type_check',
          stderr: 'SENSE_ADAPTER_KIND_MISMATCH:type_check:lint',
        },
      ],
    });

    mocks.sensorAdapter.mockReturnValueOnce(
      vi.fn(async () => {
        throw 'sensor transport unavailable';
      }),
    );
    const failed = await run('type_check', {});
    expect(failed.exit).toBe(EXIT_GATE);
    expect(JSON.parse(failed.stdout)).toMatchObject({
      ok: false,
      execution_status: 'error',
      results: [{ stderr: 'sensor transport unavailable' }],
    });
  });
});
