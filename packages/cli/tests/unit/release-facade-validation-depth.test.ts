import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CAC } from 'cac';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EXIT_FAIL, EXIT_PASS, EXIT_USAGE } from '@devai-nyx/utils';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import {
  releaseCheck,
  releaseDrift,
  releaseStatus,
  releaseVerify,
  type ReleaseCheckOptions,
  type ReleaseDriftOptions,
  type ReleaseStatusOptions,
  type ReleaseVerifyOptions,
} from '../../src/commands/release/facade.js';

type Invoke<T> = (options: T) => void | Promise<void>;

interface CommandCapture<T> {
  option(): CommandCapture<T>;
  action(callback: Invoke<T>): CommandCapture<T>;
}

const roots: string[] = [];
const originalExitCode = process.exitCode;
const originalStdout = process.stdout.write;
const originalStderr = process.stderr.write;
let check: Invoke<ReleaseCheckOptions>;
let drift: Invoke<ReleaseDriftOptions>;
let status: Invoke<ReleaseStatusOptions>;
let verify: Invoke<ReleaseVerifyOptions>;

function capture<T>(register: (cli: CAC) => void): Invoke<T> {
  let invoke: Invoke<T> | undefined;
  const command: CommandCapture<T> = {
    option(): CommandCapture<T> {
      return command;
    },
    action(callback: Invoke<T>): CommandCapture<T> {
      invoke = callback;
      return command;
    },
  };
  register({ command: () => command } as unknown as CAC);
  if (invoke === undefined) throw new Error('release facade command did not register an action');
  return invoke;
}

beforeAll(() => {
  check = capture((cli) => releaseCheck.register(cli));
  drift = capture((cli) => releaseDrift.register(cli));
  status = capture((cli) => releaseStatus.register(cli));
  verify = capture((cli) => releaseVerify.register(cli));
});

afterEach(() => {
  process.exitCode = originalExitCode;
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function run<T>(invoke: Invoke<T>, options: T) {
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
    await withAuthorityHostTestScope(() => invoke(options));
    return { stdout, stderr, exit: process.exitCode ?? 0 };
  } finally {
    process.exitCode = originalExitCode;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

describe('release facade public validation boundaries', () => {
  it('rejects unknown environments before evaluating release state', async () => {
    for (const [invoke, options, action] of [
      [check, { environment: 'production' }, 'release check'],
      [
        verify,
        { artifact: 'sha256:artifact', auditChainHead: 'a', environment: 'production' },
        'release verify',
      ],
      [drift, { environment: 'production' }, 'release drift'],
    ] as const) {
      const result = await run(invoke as Invoke<typeof options>, options);
      expect(result).toEqual({
        stdout: '',
        stderr: expect.stringContaining(`devai ${action}: --environment must be one of`),
        exit: EXIT_USAGE,
      });
    }
  });

  it('reports an empty release ledger and validates the kind filter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-release-facade-'));
    roots.push(root);
    const empty = await run(status, { repoRoot: root });
    expect(empty.stderr).toBe('');
    expect(empty.exit).toBe(EXIT_PASS);
    expect(JSON.parse(empty.stdout)).toEqual({ count: 0, releases: [] });

    const invalid = await run(status, { repoRoot: root, kind: 'publication' });
    expect(invalid.stdout).toBe('');
    expect(invalid.exit).toBe(EXIT_USAGE);
    expect(invalid.stderr).toContain(
      '--kind must be one of gate, postdeploy-verify, runtime-drift',
    );
  });

  it('requires an artifact and exactly one postdeploy verification mode', async () => {
    const missingArtifact = await run(verify, {});
    expect(missingArtifact).toMatchObject({ stdout: '', exit: EXIT_USAGE });
    expect(missingArtifact.stderr).toContain('--artifact is required');

    const missingMode = await run(verify, { artifact: 'sha256:artifact' });
    expect(missingMode.exit).toBe(EXIT_USAGE);
    expect(missingMode.stderr).toContain(
      'either --runtime-charter or --audit-chain-head is required',
    );

    const bothModes = await run(verify, {
      artifact: 'sha256:artifact',
      auditChainHead: 'a'.repeat(64),
      runtimeCharter: '/unused/charter.json',
    });
    expect(bothModes.exit).toBe(EXIT_USAGE);
    expect(bothModes.stderr).toContain(
      '--runtime-charter and --audit-chain-head are mutually exclusive',
    );

    const missingArtifactHead = await run(verify, {
      artifact: 'sha256:artifact',
      auditChainHead: 'a'.repeat(64),
    });
    expect(missingArtifactHead.exit).toBe(EXIT_USAGE);
    expect(missingArtifactHead.stderr).toContain(
      '--artifact-chain-head is required in record mode',
    );
  });

  it('rejects mixed drift modes and malformed record observations', async () => {
    const mixed = await run(drift, {
      runtimeCharter: '/unused/charter.json',
      observation: 'runtime=changed',
    });
    expect(mixed.exit).toBe(EXIT_USAGE);
    expect(mixed.stderr).toContain('--runtime-charter and --observation are mutually exclusive');

    const malformed = await run(drift, { observation: ['database=changed', 'missing-separator'] });
    expect(malformed.stdout).toBe('');
    expect(malformed.exit).toBe(EXIT_FAIL);
    expect(malformed.stderr).toContain("--observation expects 'surface=delta'");
  });
});
