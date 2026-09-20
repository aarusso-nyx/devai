// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CAC } from 'cac';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { runWithAuthorityPolicyMaterialization } from '../../src/authority/command-capabilities.js';
import { doctor, checkTrustedLocalRcBoundary } from '../../src/commands/doctor.js';
import { buildCiScaffoldPlan } from '../../src/services/ci-scaffold/index.js';

interface DoctorInvocation {
  readonly repoRoot?: string;
  readonly chain?: string;
  readonly human?: boolean;
  readonly probe?: string;
  readonly skip?: string;
}

interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly advisory?: boolean;
  readonly info?: Record<string, unknown>;
  readonly errors?: readonly string[];
}

interface DoctorReport {
  readonly ok: boolean;
  readonly profile: string;
  readonly checks: readonly DoctorCheck[];
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
});

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'devai-doctor-boundaries-'));
  roots.push(path);
  return path;
}

function put(repo: string, path: string, value: unknown): void {
  const absolute = join(repo, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(
    absolute,
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
}

async function run(options: DoctorInvocation): Promise<{
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const cli = cac('devai-doctor-observable-boundaries');
  doctor.register(cli);
  let stdout = '';
  let stderr = '';
  const argv = ['doctor'];
  if (options.repoRoot !== undefined) argv.push('--repo-root', options.repoRoot);
  if (options.chain !== undefined) argv.push('--chain', options.chain);
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

async function report(repo: string, options: Omit<DoctorInvocation, 'repoRoot'> = {}) {
  const result = await run({ repoRoot: repo, skip: ' docs-governance, unrelated ', ...options });
  return { result, report: JSON.parse(result.stdout) as DoctorReport };
}

function check(value: DoctorReport, name: string): DoctorCheck {
  const found = value.checks.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`missing Doctor check: ${name}`);
  return found;
}

describe('Doctor observable filesystem boundaries', () => {
  it('reports every binding floor independently for an empty tier3 repository', async () => {
    const repo = root();
    const chain = join(repo, 'missing-parent', 'chain.json');
    const { result, report: value } = await report(repo, { chain });

    expect(result.exit).toBe(1);
    expect(result.stderr).toBe('');
    expect(value).toMatchObject({ ok: false, profile: 'tier3' });
    expect(check(value, 'f1-paths-present')).toMatchObject({
      ok: false,
      info: { missing: expect.arrayContaining(['product', 'docs/dev/security']) },
    });
    expect(check(value, 'constitution-symlink').errors).toEqual([
      `missing: ${join(repo, '.devai/constitution.md')}`,
    ]);
    expect(check(value, 'devai-version-match').errors).toEqual([
      `missing: ${join(repo, '.devai/config/project.json')}`,
    ]);
    expect(check(value, 'agents-claude-sync').errors).toEqual([
      'CLAUDE.md or AGENTS.md missing at repo root',
    ]);
    expect(check(value, 'chain-dir-writable')).toMatchObject({ ok: false });
    expect(check(value, 'evidence-chain-valid').errors).toEqual([`chain file missing: ${chain}`]);
    expect(check(value, 'governance-tracking-binding')).toMatchObject({
      ok: true,
      info: { mode: 'disabled', opt_out: true, network_calls: 0 },
    });
    expect(check(value, 'docs-governance')).toMatchObject({
      ok: true,
      info: { skipped: true, reason: '--skip docs-governance flag set' },
    });
    expect(check(value, 'trusted-local-rc-boundary')).toMatchObject({
      ok: true,
      info: { configured: false },
    });
  });

  it('rejects malformed project, pointer, evidence, and non-directory chain inputs', async () => {
    const repo = root();
    put(repo, '.devai/config/project.json', '{broken-json\n');
    put(repo, '.devai/constitution.md', 'not a pointer\n');
    put(repo, 'record', 'regular file\n');
    put(repo, 'invalid-chain.json', '{broken-json\n');

    const { report: value } = await report(repo, {
      chain: join(repo, 'invalid-chain.json'),
    });
    expect(check(value, 'constitution-symlink')).toMatchObject({
      ok: false,
      info: { shape: 'plain-file-malformed', first_line: 'not a pointer' },
    });
    expect(check(value, 'devai-version-match').errors?.join('\n')).toContain('cannot parse');
    expect(check(value, 'evidence-chain-valid')).toMatchObject({ ok: false });

    const second = await report(repo, { chain: join(repo, 'record', 'chain.json') });
    expect(check(second.report, 'chain-dir-writable').errors).toEqual([
      `${join(repo, 'record')} is not a directory`,
    ]);
  });

  it('distinguishes valid and invalid symlink constitution pointers', async () => {
    const valid = root();
    put(valid, 'installed/constitution.md', '# Constitution\n');
    mkdirSync(join(valid, '.devai'), { recursive: true });
    symlinkSync('../installed/constitution.md', join(valid, '.devai/constitution.md'));
    expect(check((await report(valid)).report, 'constitution-symlink')).toMatchObject({
      ok: true,
      info: { shape: 'symlink', target: '../installed/constitution.md' },
    });

    const invalid = root();
    put(invalid, 'installed/not-constitution.md', '# Wrong contract\n');
    mkdirSync(join(invalid, '.devai'), { recursive: true });
    symlinkSync('../installed/not-constitution.md', join(invalid, '.devai/constitution.md'));
    expect(check((await report(invalid)).report, 'constitution-symlink')).toMatchObject({
      ok: false,
      info: { shape: 'symlink-invalid' },
    });
  });

  it.each([
    ['unresolved', '# See <unresolved>\n', 'pointer-file-unresolved'],
    ['wrong-name', '# See ../installed/contract.md\n', 'pointer-file-target-wrong-name'],
    ['missing', '# See ../installed/constitution.md\n', 'pointer-file-target-missing'],
  ])('classifies a %s plain-file pointer', async (_name, pointer, shape) => {
    const repo = root();
    put(repo, '.devai/constitution.md', pointer);
    expect(check((await report(repo)).report, 'constitution-symlink')).toMatchObject({
      ok: false,
      info: { shape },
    });
  });

  it('accepts a resolvable plain-file pointer and annotates its distinct tier3 role', async () => {
    const repo = root();
    put(repo, 'installed/constitution.md', '# Constitution\n');
    put(repo, '.devai/constitution.md', '# See ../installed/constitution.md\n');
    const { result, report: value } = await report(repo);
    expect(result.exit).toBe(1);
    expect(check(value, 'constitution-symlink')).toMatchObject({
      ok: true,
      info: {
        shape: 'pointer-file',
        tier3_note:
          'pointer resolvability is distinct from the tier3 vendored-copy and digest-pin binding requirement',
      },
    });

    const human = await run({
      repoRoot: repo,
      skip: 'docs-governance',
      human: true,
    });
    expect(human.stdout).toContain('devai doctor [profile=tier3]: FAIL');
    expect(human.stdout).toContain('note: pointer resolvability is distinct');
    expect(human.stdout).toMatch(/\[[✓!·]\] claude-cli/u);
    expect(human.stdout).toMatch(/\[[✓!·]\] codex-cli/u);
  });

  it('distinguishes an absent, missing, and mismatched installed version pin', async () => {
    const noField = root();
    put(noField, '.devai/config/project.json', { schemaVersion: '1.0.0', profile: 'tier1' });
    expect(check((await report(noField)).report, 'devai-version-match')).toMatchObject({
      ok: false,
      errors: ['project.json carries no devai_version field'],
    });

    const mismatch = root();
    put(mismatch, '.devai/config/project.json', {
      schemaVersion: '1.0.0',
      profile: 'tier1',
      devai_version: '0.0.0',
    });
    const version = check((await report(mismatch)).report, 'devai-version-match');
    expect(version).toMatchObject({
      ok: false,
      info: { pinned: '0.0.0', running: '1.5.1' },
    });
    expect(version.errors?.join('\n')).toContain('does not match');
  });

  it('reports exact AGENTS and CLAUDE omissions and accepts the complete reading contract', async () => {
    const repo = root();
    put(repo, '.devai/config/project.json', {
      schemaVersion: '1.0.0',
      profile: 'tier1',
      docs: { ia: { path_overrides: { 'dev/operations': 'runbooks' } } },
    });
    put(repo, 'CLAUDE.md', '# Empty\n');
    put(repo, 'AGENTS.md', '# Empty\n');

    let value = (await report(repo)).report;
    const missing = check(value, 'agents-claude-sync');
    expect(missing.ok).toBe(false);
    expect(missing.errors).toEqual(
      expect.arrayContaining([
        'CLAUDE.md: missing Constitution Article 6 reference',
        "CLAUDE.md: missing role 'Owner'",
        "AGENTS.md: missing role 'Auditor'",
        "AGENTS.md: missing reading-order source 'law/constitution.md'",
      ]),
    );
    expect(check(value, 'f1-paths-present').info).toMatchObject({
      paths: expect.arrayContaining(['docs/runbooks']),
      path_overrides: { 'dev/operations': 'runbooks' },
    });

    const complete = [
      'Article 6',
      'Owner Architect Inspector Engineer Auditor',
      'README.md',
      'law/constitution.md',
      'law/adr',
      'law/schemas',
    ].join('\n');
    put(repo, 'CLAUDE.md', complete);
    put(repo, 'AGENTS.md', complete);
    value = (await report(repo)).report;
    expect(check(value, 'agents-claude-sync')).toEqual({
      name: 'agents-claude-sync',
      ok: true,
      advisory: true,
    });
  });

  it('rejects an authority policy that does not satisfy the public schema', async () => {
    const repo = root();
    put(repo, '.devai/config/project.json', {
      schemaVersion: '1.0.0',
      profile: 'tier3',
      devai_version: '1.5.0',
      authority_enforcement: { mode: 'cli-only' },
    });
    put(repo, '.devai/config/authority-policy.json', {});
    expect(check((await report(repo)).report, 'authority-enforcement')).toEqual({
      name: 'authority-enforcement',
      ok: false,
      errors: ['authority-policy.json does not validate against authority-policy.schema.json'],
    });
  });

  it('rejects any diagnostic probe outside the bounded llm probe', async () => {
    const result = await run({ repoRoot: root(), probe: 'network' });
    expect(result).toEqual({
      exit: 2,
      stdout: '',
      stderr: "devai doctor: --probe must be llm (got 'network')\n",
    });
  });

  it('returns only the bounded bridge inventory for the llm probe', async () => {
    const repo = root();
    put(repo, '.devai/config/project.json', { schemaVersion: '1.0.0', profile: 'tier1' });
    const result = await run({ repoRoot: repo, probe: 'llm' });
    const value = JSON.parse(result.stdout) as DoctorReport;
    expect(result.exit).toBe(0);
    expect(value).toMatchObject({
      ok: true,
      profile: 'tier1',
      checks: [{ name: 'llm-bridges', ok: true }],
    });
    expect(value.checks).toHaveLength(1);
    expect(value.checks[0]?.info?.['bridges'] as unknown[] | undefined).toHaveLength(2);
  });
});

describe('Doctor trusted local RC failure matrix', () => {
  function configuredFixture(): string {
    const repo = root();
    put(repo, '.devai/config/project.json', {
      ci_economy: {
        attested_rc: {
          profile: 'rc',
          transport: 'protected-tag-v1',
          tag_prefix: 'devai-local-evidence/',
          binding: 'exact-tree',
          required_check: 'verified-local-rc',
          failure_mode: 'fail-closed',
          local_only_nodes: ['test:mutation'],
        },
      },
    });
    put(repo, 'test-tasks.json', {
      tasks: [{ nodeId: 'test:mutation', argv: ['pnpm', 'run', 'test:mutation'] }],
    });
    return repo;
  }

  it('aggregates missing workflow, scripts, controls, and signer trust', () => {
    const repo = configuredFixture();
    put(repo, 'package.json', '{broken-json\n');
    put(repo, 'law/policy/devai-local-rc-trust-store.json', '{broken-json\n');
    const result = checkTrustedLocalRcBoundary(repo);
    expect(result).toMatchObject({
      ok: false,
      info: {
        configured: true,
        local_rc_execution_configured: false,
        remote_receipt_verification_configured: false,
        proof_transport_configured: false,
        exact_tree_binding_configured: false,
        signer_trust_configured: false,
        approved_non_revoked_signers: 0,
      },
    });
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'devai:rc:prepare and devai:rc:publish are not both configured',
        'generated trusted local RC verifier workflow is missing or stale',
        'protected local RC toolchain or environment control is missing',
        'approved non-revoked local RC signer trust is missing',
      ]),
    );
  });

  it('does not count revoked or malformed public-key entries as trusted controls', () => {
    const repo = configuredFixture();
    put(repo, 'package.json', {
      scripts: {
        'test:mutation': 'pnpm -r stryker',
        'devai:rc:prepare': 'node tools/devai-rc.mjs prepare',
        'devai:rc:publish': 'node tools/devai-rc.mjs publish',
      },
    });
    const keys = generateKeyPairSync('ed25519');
    put(repo, 'law/policy/devai-local-rc-trust-store.json', {
      schemaVersion: '1.0.0',
      trustedSigners: [
        {
          signerId: 'revoked',
          publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        },
        { signerId: 'malformed', publicKeyPem: '-----BEGIN PRIVATE KEY-----' },
      ],
      revokedSignerIds: ['revoked'],
    });
    put(repo, 'law/policy/devai-local-rc-toolchain.json', {});
    put(repo, 'law/policy/devai-local-rc-environment.json', {});
    const workflow = buildCiScaffoldPlan({ targetRoot: repo });
    put(repo, '.github/workflows/verified-local-rc.yml', workflow.content);

    const result = checkTrustedLocalRcBoundary(repo);
    expect(result.ok).toBe(false);
    expect(result.info).toMatchObject({
      approved_non_revoked_signers: 1,
      signer_trust_configured: false,
      remote_receipt_verification_configured: false,
    });
    expect(result.errors).toContain('approved non-revoked local RC signer trust is missing');
  });
});
