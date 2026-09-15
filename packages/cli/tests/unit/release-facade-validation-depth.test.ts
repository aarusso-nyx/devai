import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CAC } from 'cac';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function ownedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-release-facade-'));
  roots.push(root);
  return root;
}

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
    const root = ownedRoot();
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

  it('runs a release check and preserves strict failure semantics', async () => {
    const result = await run(check, { repoRoot: ownedRoot(), strict: true });
    expect(result.stderr).toBe('');
    expect(result.exit).toBe(EXIT_FAIL);
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: 'REL-0001',
      kind: 'gate',
      verdict: 'block',
      reasons: ['invariants directory missing', 'no sensor readings'],
    });
  });

  it('filters persisted releases by their exact kind', async () => {
    const root = ownedRoot();
    const chainHead = 'a'.repeat(64);
    expect(
      await run(verify, {
        repoRoot: root,
        artifact: 'sha256:artifact',
        artifactChainHead: chainHead,
        auditChainHead: chainHead,
      }),
    ).toMatchObject({ stderr: '', exit: EXIT_PASS });
    expect(await run(drift, { repoRoot: root, observation: 'database=changed' })).toMatchObject({
      stderr: '',
      exit: EXIT_PASS,
    });

    const filtered = await run(status, { repoRoot: root, kind: 'postdeploy-verify' });
    expect(filtered.stderr).toBe('');
    expect(filtered.exit).toBe(EXIT_PASS);
    expect(JSON.parse(filtered.stdout)).toMatchObject({
      count: 1,
      releases: [{ id: 'REL-0001', kind: 'postdeploy-verify', verdict: 'pass' }],
    });
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

  it('carries an optional artifact chain head through detector verification', async () => {
    const root = ownedRoot();
    const charterPath = join(root, 'runtime-charter.json');
    writeFileSync(
      charterPath,
      JSON.stringify({
        schemaVersion: '1.0.0',
        id: 'RPC-facade',
        kind: 'api',
        mission: 'verify the release facade detector path',
        target: { base_url: 'http://example.test/' },
        probes: [
          {
            pid: 'P1',
            name: 'GET /health',
            method: 'GET',
            path: '/health',
            expect: { status: 200, contains: ['ok'] },
          },
        ],
      }),
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{"status":"ok"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await run(verify, {
      repoRoot: root,
      artifact: 'sha256:artifact',
      artifactChainHead: 'b'.repeat(64),
      runtimeCharter: charterPath,
    });
    expect(result.stderr).toBe('');
    expect(result.exit).toBe(EXIT_PASS);
    expect(JSON.parse(result.stdout)).toMatchObject({
      kind: 'postdeploy-verify',
      verdict: 'pass',
      inputs: { artifact_chain_head: 'b'.repeat(64) },
    });
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

    const missingSurface = await run(drift, { observation: '=changed' });
    expect(missingSurface.stdout).toBe('');
    expect(missingSurface.exit).toBe(EXIT_FAIL);
    expect(missingSurface.stderr).toContain("--observation expects 'surface=delta'");
  });

  it('keeps a strict drift check successful when no drift is observed', async () => {
    const result = await run(drift, { repoRoot: ownedRoot(), strict: true });
    expect(result.stderr).toBe('');
    expect(result.exit).toBe(EXIT_PASS);
    expect(JSON.parse(result.stdout)).toMatchObject({
      kind: 'runtime-drift',
      verdict: 'pass',
      drift_observations: [],
    });
  });
});
