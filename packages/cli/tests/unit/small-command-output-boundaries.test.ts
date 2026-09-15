// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
// Public-boundary acceptance: small read commands retain their exact help and
// output framing so shell callers and human operators see stable contracts.
import { resolve } from 'node:path';
import type { CAC } from 'cac';
import { afterEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  build: vi.fn(),
  persist: vi.fn(),
}));

vi.mock('#runtime-core', () => ({
  buildRtdManifest: runtime.build,
  persistRtdManifest: runtime.persist,
}));

vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  writeFileSync: vi.fn(),
}));

import { actionsList } from '../../src/commands/actions-list.js';
import { rtdBundle } from '../../src/commands/rtd/index.js';

interface CommandChain<T> {
  option(flag: string, description?: string): CommandChain<T>;
  action(callback: (options: T) => void): CommandChain<T>;
}

interface RtdOptions {
  readonly repoRoot?: string;
  readonly output?: string;
  readonly strict?: boolean;
  readonly noGit?: boolean;
  readonly human?: boolean;
}

interface ActionsOptions {
  readonly authority?: string;
  readonly human?: boolean;
}

const originalStdout = process.stdout.write;
const originalStderr = process.stderr.write;
const originalExitCode = process.exitCode;

function register<T>(subject: { register(cli: CAC): void }): {
  readonly command: readonly [string, string];
  readonly options: readonly (readonly [string, string | undefined])[];
  readonly action: (options: T) => void;
} {
  let command: readonly [string, string] | undefined;
  const options: Array<readonly [string, string | undefined]> = [];
  let action: ((value: T) => void) | undefined;
  const chain: CommandChain<T> = {
    option(flag, description) {
      options.push([flag, description]);
      return chain;
    },
    action(callback) {
      action = callback;
      return chain;
    },
  };
  subject.register({
    command(name: string, description: string) {
      command = [name, description];
      return chain;
    },
  } as unknown as CAC);
  if (command === undefined || action === undefined) throw new Error('command was not registered');
  return { command, options, action };
}

function capture(callback: () => void): { readonly stdout: string; readonly stderr: string } {
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
  callback();
  return { stdout, stderr };
}

afterEach(() => {
  runtime.build.mockReset();
  runtime.persist.mockReset();
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
  process.exitCode = originalExitCode;
});

describe('small command output boundaries', () => {
  it('pins the complete RTD option help contract', () => {
    const registered = register<RtdOptions>(rtdBundle);

    expect(registered.command).toEqual(['rtd-bundle', 'Build an RTD manifest aggregate']);
    expect(registered.options).toEqual([
      ['--repo-root <path>', `Repo root (default: ${process.cwd()})`],
      [
        '--output <path>',
        'Write the manifest JSON to this path in addition to .devai/state/rtd-manifests/',
      ],
      [
        '--no-git',
        'Use the 40-char zero sentinel as integration_head instead of `git rev-parse HEAD`',
      ],
      ['--strict', 'Exit non-zero when readiness.ok is false (default: always exit 0)'],
      ['--human', 'Human-readable summary'],
    ]);
  });

  it('renders the exact ready RTD human summary', () => {
    const manifest = {
      id: 'rtd-ready',
      manifest_hash: '1234567890abcdef'.padEnd(64, '0'),
      readiness: { ok: true, sub_verdicts: [{ component: 'invariants', ok: true }] },
    };
    runtime.build.mockReturnValue(manifest);
    runtime.persist.mockReturnValue('/fixture/rtd-ready.json');

    const output = capture(() =>
      register<RtdOptions>(rtdBundle).action({ repoRoot: resolve('/fixture/repo'), human: true }),
    );

    expect(output).toEqual({
      stdout:
        'rtd bundle: rtd-ready  readiness=ok  hash=1234567890ab…\n' +
        '  ✓ invariants\n' +
        '  persisted: /fixture/rtd-ready.json\n',
      stderr: '',
    });
  });

  it('retains the exact action table header spacing', () => {
    const output = capture(() => register<ActionsOptions>(actionsList).action({ human: true }));

    expect(output.stderr).toBe('');
    expect(output.stdout.split('\n')[0]).toBe(
      `COMMAND${' '.repeat(39)} LIFECYCLE    EFFECTS       DESCRIPTION`,
    );
  });

  it('terminates machine action output with exactly one newline', () => {
    const output = capture(() => register<ActionsOptions>(actionsList).action({}));
    const parsed = JSON.parse(output.stdout) as unknown;

    expect(output.stderr).toBe('');
    expect(output.stdout).toBe(`${JSON.stringify(parsed)}\n`);
  });
});
