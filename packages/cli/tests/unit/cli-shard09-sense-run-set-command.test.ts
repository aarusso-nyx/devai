import type { CAC } from 'cac';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveSenseSelection } from '../../src/commands/sense/facade.js';

const mocks = vi.hoisted(() => ({ sensorAdapter: vi.fn() }));

vi.mock('../../src/commands/sense/adapters.js', () => ({
  sensorAdapter: mocks.sensorAdapter,
}));

const { senseRunSetCmd } = await import('../../src/commands/sense/run-set.js');

interface Options {
  readonly preset?: string;
  readonly round?: string;
  readonly repoRoot?: string;
  readonly input?: string;
  readonly dryRun?: boolean;
  readonly human?: boolean;
}

type Action = (kind: string | undefined, options: Options) => Promise<void>;

interface Registration {
  readonly command: readonly [string, string];
  readonly options: readonly (readonly [string, string])[];
  readonly actions: readonly Action[];
}

interface Invocation {
  readonly stdout: string;
  readonly stderr: string;
  readonly exit: number;
}

const originalExitCode = process.exitCode;
const originalStdout = process.stdout.write;
const originalStderr = process.stderr.write;

function registration(): Registration {
  let commandCall: readonly [string, string] | undefined;
  const options: Array<readonly [string, string]> = [];
  const actions: Action[] = [];
  const command = {
    option(flag: string, description: string) {
      options.push([flag, description]);
      return command;
    },
    action(callback: Action) {
      actions.push(callback);
      return command;
    },
  };
  senseRunSetCmd.register({
    command(name: string, description: string) {
      commandCall = [name, description];
      return command;
    },
  } as unknown as CAC);
  if (commandCall === undefined) throw new Error('SENSE_RUN_SET_COMMAND_NOT_REGISTERED');
  return { command: commandCall, options, actions };
}

async function invoke(
  action: Action,
  kind: string | undefined,
  options: Options,
): Promise<Invocation> {
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
    await action(kind, options);
    return { stdout, stderr, exit: process.exitCode ?? 0 };
  } finally {
    process.exitCode = originalExitCode;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

beforeEach(() => {
  mocks.sensorAdapter.mockReset();
});

afterEach(() => {
  process.exitCode = originalExitCode;
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
});

describe('CLI shard 09 sense run set command', () => {
  it('registers the exact command metadata and ordered option surface', () => {
    const captured = registration();
    expect(captured.command).toEqual([
      'sense-run [kind]',
      'Run one resolved sensor kind or preset; per-kind effect and authority are enforced before execution',
    ]);
    expect(captured.options).toEqual([
      ['--preset <name>', 'Canonical preset: baseline | structural | governed | sweep'],
      ['--round <id>', 'Round id required by the sweep preset'],
      ['--repo-root <path>', 'Repository root (default: .)'],
      ['--input <json>', 'Sensor-specific inputs as a JSON object'],
      ['--dry-run', 'Resolve and display the exact population without executing it'],
      ['--human', 'Human-readable summary'],
    ]);
    expect(captured.actions).toHaveLength(1);
    expect(captured.actions[0]).toBeTypeOf('function');
  });

  it('emits exact dry-run and execution projections with defaults', async () => {
    const [action] = registration().actions;
    if (action === undefined) throw new Error('SENSE_RUN_SET_ACTION_MISSING');
    const resolved = resolveSenseSelection({ kind: 'type_check' });

    const dryRun = await invoke(action, 'type_check', { dryRun: true });
    expect(dryRun).toEqual({
      stdout: `${JSON.stringify({ ok: true, dry_run: true, ...resolved })}\n`,
      stderr: '',
      exit: 0,
    });
    expect(mocks.sensorAdapter).not.toHaveBeenCalled();

    const reading = { sensor: { kind: 'type_check' }, status: 'pass', findings: [] };
    const adapter = vi.fn(async () => reading);
    mocks.sensorAdapter.mockReturnValue(adapter);
    const executed = await invoke(action, 'type_check', {});
    const result = {
      command: 'devai sense run type_check',
      stdout: JSON.stringify(reading),
      stderr: '',
      na: false,
      status: 0,
    };
    const expected = {
      ok: true,
      dry_run: false,
      ...resolved,
      execution_status: 'pass',
      readiness_status: 'pass',
      applicable_count: 1,
      na_count: 0,
      counts: { pass: 1, review: 0, fail: 0, unknown: 0, na: 0, error: 0 },
      exit_code: 0,
      results: [result],
    };
    expect(executed).toEqual({
      stdout: `${JSON.stringify(expected)}\n`,
      stderr: '',
      exit: 0,
    });
    expect(mocks.sensorAdapter).toHaveBeenCalledExactlyOnceWith('type_check');
    expect(adapter).toHaveBeenCalledExactlyOnceWith({ repoRoot: '.' });
  });

  it('keeps optional-dependency and usage diagnostics at exact boundaries', async () => {
    const [action] = registration().actions;
    if (action === undefined) throw new Error('SENSE_RUN_SET_ACTION_MISSING');

    for (const message of [
      'OPTIONAL_DEPENDENCY_MISSING:A',
      'OPTIONAL_DEPENDENCY_MISSING:@scope/pkg_name-1.2',
    ]) {
      mocks.sensorAdapter.mockReturnValue(
        vi.fn(async () => {
          throw new Error(message);
        }),
      );
      await expect(invoke(action, 'type_check', {})).rejects.toThrow(message);
    }

    for (const message of [
      'OPTIONAL_DEPENDENCY_MISSING:',
      'OPTIONAL_DEPENDENCY_MISSING: scope/pkg',
      'prefix OPTIONAL_DEPENDENCY_MISSING:@scope/pkg',
      'OPTIONAL_DEPENDENCY_MISSING:@scope/pkg:unexpected-suffix',
    ]) {
      mocks.sensorAdapter.mockReturnValue(
        vi.fn(async () => {
          throw new Error(message);
        }),
      );
      const result = await invoke(action, 'type_check', {});
      expect(result.stderr).toBe('');
      expect(result.exit).toBe(3);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        execution_status: 'error',
        results: [{ stdout: '', stderr: message, status: null }],
      });
    }

    let syntaxMessage = '';
    try {
      JSON.parse('{');
    } catch (error) {
      syntaxMessage = error instanceof Error ? error.message : String(error);
    }
    const malformed = await invoke(action, 'type_check', { input: '{' });
    expect(malformed).toEqual({
      stdout: '',
      stderr: `devai sense run: ${syntaxMessage}\n`,
      exit: 2,
    });
  });
});
