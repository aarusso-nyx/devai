import type { CAC } from 'cac';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_USAGE } from '@devai-nyx/utils';
import { actionsList } from '../../src/commands/actions-list.js';

interface CommandOptions {
  readonly authority?: string;
  readonly human?: boolean;
}
interface CommandChain {
  option(flag: string, description?: string): CommandChain;
  action(callback: (options: CommandOptions) => void): CommandChain;
}

let invoke: ((options: CommandOptions) => void) | undefined;

function registerAction(): void {
  const command: CommandChain = {
    option: () => command,
    action: (callback) => {
      invoke = callback;
      return command;
    },
  };
  actionsList.register({ command: () => command } as unknown as CAC);
}

function run(options: CommandOptions): void {
  registerAction();
  if (invoke === undefined) throw new Error('catalog-actions callback was not registered');
  invoke(options);
}

const originalWrite = process.stdout.write;
const originalError = process.stderr.write;
const originalExit = process.exit;
const originalExitCode = process.exitCode;

function capture<T>(callback: () => T): {
  readonly value: T;
  readonly stdout: string;
  readonly stderr: string;
} {
  let stdout = '';
  let stderr = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: callback(), stdout, stderr };
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalError;
    process.exit = originalExit;
    process.exitCode = originalExitCode;
  }
}

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${String(code)}`);
  }
}

afterEach(() => {
  invoke = undefined;
  process.stdout.write = originalWrite;
  process.stderr.write = originalError;
  process.exit = originalExit;
  process.exitCode = originalExitCode;
});

describe('catalog actions command boundaries', () => {
  it('emits the complete governed catalog as schema-shaped JSON', () => {
    const captured = capture(() => run({}));
    const actions = JSON.parse(captured.stdout) as Array<Record<string, unknown>>;
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((action) => typeof action.name === 'string')).toBe(true);
    expect(actions.every((action) => typeof action.authority === 'string')).toBe(true);
    expect(actions.some((action) => action.name === 'sense run')).toBe(true);
    expect(captured.stderr).toBe('');
  });

  it('filters JSON output to the requested known authority', () => {
    const captured = capture(() => run({ authority: 'sensor' }));
    const actions = JSON.parse(captured.stdout) as Array<Record<string, unknown>>;
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((action) => action.authority === 'sensor')).toBe(true);
  });

  it('rejects an unknown authority with usage exit and an actionable error', () => {
    const captured = capture(() => {
      process.exit = ((code?: number) => {
        throw new ExitSignal(code ?? EXIT_USAGE);
      }) as typeof process.exit;
      expect(() => run({ authority: 'not-a-governed-authority' })).toThrowError(
        new ExitSignal(EXIT_USAGE),
      );
    });
    expect(captured.stderr).toContain("unknown --authority 'not-a-governed-authority'");
    expect(captured.stderr).toContain(
      'expected one of mesh_controller, specifier, constructor, sensor, policy_firewall, release_controller, agent_runtime, host_tooling',
    );
    expect(captured.stdout).toBe('');
  });

  it('renders human output with a stable header and one row per filtered action', () => {
    const captured = capture(() => run({ authority: 'sensor', human: true }));
    const lines = captured.stdout.trimEnd().split('\n');
    expect(lines[0]?.trim().split(/\s+/)).toEqual([
      'COMMAND',
      'LIFECYCLE',
      'EFFECTS',
      'DESCRIPTION',
    ]);
    const json = capture(() => run({ authority: 'sensor' }));
    const actions = JSON.parse(json.stdout) as Array<{ name: string }>;
    expect(lines.length).toBe(actions.length + 1);
    expect(lines.slice(1).map((line) => line.slice(0, 46).trim())).toEqual(
      actions.map((action) => action.name),
    );
    expect(lines.slice(1).every((line) => line.trim().length > 0)).toBe(true);
  });
});
