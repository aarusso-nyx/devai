import { resolve } from 'node:path';
import type { CAC } from 'cac';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXIT_FAIL, EXIT_PASS } from '@devai-nyx/utils';

const runtime = vi.hoisted(() => ({
  build: vi.fn(),
  persist: vi.fn(),
}));

const authority = vi.hoisted(() => ({ write: vi.fn() }));

vi.mock('#runtime-core', () => ({
  buildRtdManifest: runtime.build,
  persistRtdManifest: runtime.persist,
}));

vi.mock('@devai-nyx/authority', () => ({ writeFileSync: authority.write }));

import { rtdBundle } from '../../src/commands/rtd/index.js';

interface BundleOptions {
  readonly repoRoot?: string;
  readonly output?: string;
  readonly strict?: boolean;
  readonly noGit?: boolean;
  readonly human?: boolean;
}

interface CommandChain {
  option(flag: string, description?: string): CommandChain;
  action(callback: (options: BundleOptions) => void): CommandChain;
}

const READY_MANIFEST = {
  id: 'rtd-fixture',
  manifest_hash: 'abcdef1234567890'.padEnd(64, '0'),
  readiness: {
    ok: true,
    sub_verdicts: [{ component: 'invariants', ok: true }],
  },
};

const NOT_READY_MANIFEST = {
  ...READY_MANIFEST,
  readiness: {
    ok: false,
    sub_verdicts: [
      { component: 'invariants', ok: true },
      { component: 'trace', ok: false, error_count: 2 },
    ],
  },
};

const originalStdout = process.stdout.write;
const originalStderr = process.stderr.write;
const originalExit = process.exit;
const originalExitCode = process.exitCode;

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit:${String(code)}`);
  }
}

function register(): {
  readonly options: readonly string[];
  readonly action: (options: BundleOptions) => void;
} {
  const options: string[] = [];
  let callback: ((value: BundleOptions) => void) | undefined;
  const chain: CommandChain = {
    option(flag) {
      options.push(flag);
      return chain;
    },
    action(value) {
      callback = value;
      return chain;
    },
  };
  const command = vi.fn(() => chain);
  rtdBundle.register({ command } as unknown as CAC);
  expect(command).toHaveBeenCalledWith('rtd-bundle', 'Build an RTD manifest aggregate');
  if (callback === undefined) throw new Error('rtd bundle action was not registered');
  return { options, action: callback };
}

function invoke(options: BundleOptions): {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | undefined;
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
  const { action } = register();
  action(options);
  return {
    stdout,
    stderr,
    exitCode: typeof process.exitCode === 'number' ? process.exitCode : undefined,
  };
}

afterEach(() => {
  runtime.build.mockReset();
  runtime.persist.mockReset();
  authority.write.mockReset();
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
  process.exit = originalExit;
  process.exitCode = originalExitCode;
});

describe('RTD bundle command public boundary', () => {
  it('registers every supported public option', () => {
    expect(register().options).toEqual([
      '--repo-root <path>',
      '--output <path>',
      '--no-git',
      '--strict',
      '--human',
    ]);
  });

  it('builds and persists the resolved no-git manifest, writes the requested copy, and emits JSON', () => {
    runtime.build.mockReturnValue(READY_MANIFEST);
    runtime.persist.mockReturnValue('/fixture/repo/.devai/state/rtd-manifests/rtd-fixture.json');

    const output = invoke({
      repoRoot: '/fixture/project/../repo',
      output: '/fixture/result.json',
      noGit: true,
    });

    expect(runtime.build).toHaveBeenCalledWith({
      repoRoot: resolve('/fixture/project/../repo'),
      integrationHead: '0'.repeat(40),
    });
    expect(runtime.persist).toHaveBeenCalledWith(READY_MANIFEST, '/fixture/repo');
    expect(authority.write).toHaveBeenCalledWith(
      '/fixture/result.json',
      `${JSON.stringify(READY_MANIFEST, null, 2)}\n`,
    );
    expect(output).toEqual({
      stdout: `${JSON.stringify(READY_MANIFEST)}\n`,
      stderr: '',
      exitCode: EXIT_PASS,
    });
  });

  it.each([undefined, false] as const)(
    'does not invent an integration head or output side effect when noGit is %s',
    (noGit) => {
      runtime.build.mockReturnValue(READY_MANIFEST);
      runtime.persist.mockReturnValue('/fixture/persisted.json');
      invoke({ repoRoot: '/fixture/repo', noGit });

      expect(runtime.build).toHaveBeenCalledWith({ repoRoot: '/fixture/repo' });
      expect(authority.write).not.toHaveBeenCalled();
    },
  );

  it('renders exact human readiness, hash, sub-verdict, error-count, and persistence lines', () => {
    runtime.build.mockReturnValue(NOT_READY_MANIFEST);
    runtime.persist.mockReturnValue('/fixture/persisted.json');

    const output = invoke({ repoRoot: '/fixture/repo', human: true });

    expect(output).toEqual({
      stdout: [
        'rtd bundle: rtd-fixture  readiness=FAIL  hash=abcdef123456…',
        '  ✓ invariants',
        '  ✗ trace (2 error(s))',
        '  persisted: /fixture/persisted.json',
        '',
      ].join('\n'),
      stderr: '',
      exitCode: EXIT_PASS,
    });
  });

  it.each([
    ['strict failed readiness', true, NOT_READY_MANIFEST, EXIT_FAIL],
    ['non-strict failed readiness', false, NOT_READY_MANIFEST, EXIT_PASS],
    ['strict successful readiness', true, READY_MANIFEST, EXIT_PASS],
  ] as const)('selects the documented exit for %s', (_description, strict, manifest, exitCode) => {
    runtime.build.mockReturnValue(manifest);
    runtime.persist.mockReturnValue('/fixture/persisted.json');

    expect(invoke({ repoRoot: '/fixture/repo', strict }).exitCode).toBe(exitCode);
  });

  it.each([
    ['an Error', new Error('fixture failure'), 'fixture failure'],
    ['a non-Error', 'fixture refusal', 'fixture refusal'],
  ] as const)(
    'fails closed and reports %s from manifest construction',
    (_description, thrown, message) => {
      runtime.build.mockImplementation(() => {
        throw thrown;
      });
      process.exit = ((code?: string | number | null) => {
        throw new ExitSignal(typeof code === 'number' ? code : 0);
      }) as typeof process.exit;

      let stderr = '';
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
      }) as typeof process.stderr.write;
      expect(() => register().action({ repoRoot: '/fixture/repo' })).toThrowError(
        new ExitSignal(EXIT_FAIL),
      );
      expect(stderr).toBe(`devai evidence record --kind rtd: ${message}\n`);
      expect(runtime.persist).not.toHaveBeenCalled();
      expect(authority.write).not.toHaveBeenCalled();
    },
  );
});
