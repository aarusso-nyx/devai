// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CAC } from 'cac';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  docs: vi.fn(),
}));

vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawnSync: mocks.spawnSync,
}));

vi.mock('../../src/commands/check/docs-governance.js', () => ({
  checkDocsGovernance: mocks.docs,
}));

const { withAuthorityHostTestScope } =
  await import('../../../skills/tests/unit/authority-host-test-scope.js');
const { doctor } = await import('../../src/commands/doctor.js');
const { runWithAuthorityPolicyMaterialization } =
  await import('../../src/authority/command-capabilities.js');

interface DoctorInvocation {
  readonly repoRoot?: string;
  readonly human?: boolean;
  readonly probe?: string;
  readonly skip?: string;
}

const roots: string[] = [];
const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};
const originalArgv = process.argv;
const originalExit = process.exit;
const originalExitCode = process.exitCode;
const originalStdout = process.stdout.write;
const originalStderr = process.stderr.write;

afterEach(() => {
  process.argv = originalArgv;
  process.exit = originalExit;
  process.exitCode = originalExitCode;
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
  mocks.spawnSync.mockReset();
  mocks.docs.mockReset();
});

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const repo = mkdtempSync(join(tmpdir(), 'devai-doctor-probes-'));
  roots.push(repo);
  const config = join(repo, '.devai/config/project.json');
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, `${JSON.stringify({ schemaVersion: '1.0.0', profile: 'tier1' })}\n`);
  return repo;
}

async function run(options: DoctorInvocation): Promise<{
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const cli = cac('devai-doctor-probes-and-docs');
  doctor.register(cli);
  let stdout = '';
  let stderr = '';
  const argv = ['doctor'];
  if (options.repoRoot !== undefined) argv.push('--repo-root', options.repoRoot);
  if (options.human === true) argv.push('--human');
  if (options.probe !== undefined) argv.push('--probe', options.probe);
  if (options.skip !== undefined) argv.push('--skip', options.skip);
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
  process.exit = ((code?: string | number | null) => {
    process.exitCode = typeof code === 'number' ? code : 0;
    throw new Error(`TEST_PROCESS_EXIT:${String(process.exitCode)}`);
  }) as typeof process.exit;

  try {
    cli.parse(process.argv, { run: false });
    await withAuthorityHostTestScope(() =>
      runWithAuthorityPolicyMaterialization(
        () => ({
          path: '.devai/config/authority-policy.json',
          operation: 'unchanged',
          digest_sha256: 'a'.repeat(64),
        }),
        () => cli.runMatchedCommand(),
      ),
    );
    throw new Error('doctor returned without an exit');
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('TEST_PROCESS_EXIT:')) throw error;
    await new Promise<void>((done) => setImmediate(done));
    return { exit: process.exitCode ?? 0, stdout, stderr };
  }
}

describe('Doctor bounded CLI probes', () => {
  it('reports both unavailable bridges without attempting their version commands', async () => {
    mocks.spawnSync.mockReturnValue({ status: 1, stdout: '' });
    const result = await run({ repoRoot: root(), probe: 'llm' });
    const report = JSON.parse(result.stdout) as {
      checks: Array<{ info: { bridges: Array<Record<string, unknown>> } }>;
    };
    expect(result.exit).toBe(0);
    expect(mocks.spawnSync).toHaveBeenCalledTimes(2);
    expect(mocks.spawnSync).toHaveBeenNthCalledWith(1, 'sh', ['-lc', 'command -v claude'], {
      encoding: 'utf8',
    });
    expect(mocks.spawnSync).toHaveBeenNthCalledWith(2, 'sh', ['-lc', 'command -v codex'], {
      encoding: 'utf8',
    });
    expect(report.checks[0]?.info.bridges).toEqual([
      {
        family: 'claude-cli',
        cli: 'claude',
        on_path: false,
        version: null,
        usable: false,
        hint: 'Install the claude CLI and ensure it is on PATH; then re-run `devai doctor`.',
      },
      {
        family: 'codex-cli',
        cli: 'codex',
        on_path: false,
        version: null,
        usable: false,
        hint: 'Install the codex CLI and ensure it is on PATH; then re-run `devai doctor`.',
      },
    ]);
  });

  it('reports first-line versions, empty versions, and nonzero usability separately', async () => {
    mocks.spawnSync
      .mockReturnValueOnce({ status: 0, stdout: '/tools/claude\n' })
      .mockReturnValueOnce({ status: 0, stdout: 'claude 9.1\nextra\n' })
      .mockReturnValueOnce({ status: 0, stdout: '/tools/codex\n' })
      .mockReturnValueOnce({ status: 3, stdout: '' });
    const result = await run({ repoRoot: root(), probe: 'llm', human: true });
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain('[✓] claude-cli (claude 9.1)');
    expect(result.stdout).toContain('[!] codex-cli');
    expect(mocks.spawnSync).toHaveBeenNthCalledWith(2, 'claude', ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(mocks.spawnSync).toHaveBeenNthCalledWith(4, 'codex', ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
  });
});

describe('Doctor docs-governance translation', () => {
  it('preserves failing rule identity and optional remediation in the report', async () => {
    mocks.spawnSync.mockReturnValue({ status: 1, stdout: '' });
    mocks.docs.mockReturnValue({
      verdict: 'fail',
      fail_count: 2,
      warn_count: 1,
      findings: [
        { severity: 'fail', ruleId: 'DOC-1', message: 'missing index', remediation: 'add it' },
        { severity: 'fail', ruleId: 'DOC-2', message: 'broken link' },
        { severity: 'warn', ruleId: 'DOC-3', message: 'advisory' },
      ],
    });
    const result = await run({ repoRoot: root() });
    const report = JSON.parse(result.stdout) as {
      checks: Array<{
        name: string;
        ok: boolean;
        advisory?: boolean;
        info?: Record<string, unknown>;
        errors?: string[];
      }>;
    };
    const docs = report.checks.find((candidate) => candidate.name === 'docs-governance');
    expect(mocks.docs).toHaveBeenCalledWith({
      repoRoot: expect.stringContaining('devai-doctor-probes-'),
      noPublishCheck: true,
    });
    expect(docs).toEqual({
      name: 'docs-governance',
      ok: false,
      advisory: true,
      info: { verdict: 'fail', fail_count: 2, warn_count: 1 },
      errors: ['[DOC-1] missing index — add it', '[DOC-2] broken link'],
    });
  });

  it('fails closed when the delegated docs check throws a non-Error value', async () => {
    mocks.spawnSync.mockReturnValue({ status: 1, stdout: '' });
    mocks.docs.mockImplementation(() => {
      throw 'opaque docs failure';
    });
    const result = await run({ repoRoot: root() });
    const report = JSON.parse(result.stdout) as {
      checks: Array<{ name: string; ok: boolean; errors?: string[] }>;
    };
    expect(report.checks.find((candidate) => candidate.name === 'docs-governance')).toEqual({
      name: 'docs-governance',
      ok: false,
      errors: ['docs-governance check threw: opaque docs failure'],
      advisory: true,
    });
  });
});
