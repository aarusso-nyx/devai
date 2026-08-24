import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { buildBootstrapPlan, executeBootstrapPlan } from '../../../skills/src/bootstrap/index.js';
import { getValidator } from '../../../schemas/src/index.js';
import { verifyChain } from '../../../evidence/src/evidence/chain.js';
import { executeCheckMember } from '../../src/commands/check/adapters.js';
import type { ResolvedCheckMember } from '../../src/commands/check/contracts.js';
import { doctor } from '../../src/commands/doctor.js';
import { evidenceRecord } from '../../src/commands/evidence/facade.js';
import { initBind } from '../../src/commands/init/index.js';
import { ACTION_REGISTRY } from '../../src/generated/action-registry.js';
import { runWithAuthorityPolicyMaterialization } from '../../src/authority/command-capabilities.js';
import type { CAC } from '../../node_modules/cac/dist/index.d.ts';
import { createRequire } from 'node:module';

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};
const ROOT = resolve(import.meta.dirname, '../../../..');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(prefix = 'devai-adopter-contract-'): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

function put(repo: string, path: string, value: unknown): string {
  const absolute = join(repo, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(
    absolute,
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
  return absolute;
}

function checkMember(serviceId: string): ResolvedCheckMember {
  return {
    id: serviceId,
    source: 'current-selector',
    service_id: serviceId,
    binding: { kind: 'runtime-gate', gate_id: `check-${serviceId}` },
    effect: 'read',
    cost: 'low',
    output: `action-envelope-plus-${serviceId}-report`,
  };
}

async function invoke(definition: { register(cli: CAC): void }, argv: readonly string[]) {
  const cli = cac('devai-adopter-package-contract');
  definition.register(cli);
  const previous = {
    argv: process.argv,
    exit: process.exit,
    exitCode: process.exitCode,
    stdout: process.stdout.write,
    stderr: process.stderr.write,
  };
  let stdout = '';
  let stderr = '';
  try {
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
    cli.parse(process.argv, { run: false });
    try {
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
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('TEST_PROCESS_EXIT:')) throw error;
    }
    await new Promise<void>((done) => setImmediate(done));
    return { exit: process.exitCode ?? 0, stdout, stderr };
  } finally {
    process.argv = previous.argv;
    process.exit = previous.exit;
    process.exitCode = previous.exitCode;
    process.stdout.write = previous.stdout;
    process.stderr.write = previous.stderr;
  }
}

async function runCli(args: readonly string[]) {
  vi.resetModules();
  const previousArgv = process.argv;
  const previousExitCode = process.exitCode;
  const previousStdout = process.stdout.write;
  const previousStderr = process.stderr.write;
  let stdout = '';
  let stderr = '';
  try {
    process.argv = ['node', 'devai', ...args, '--format', 'json'];
    process.exitCode = undefined;
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    await import('../../src/bin.js');
    await new Promise<void>((done) => setImmediate(done));
    return { exit: process.exitCode ?? 0, stdout, stderr };
  } finally {
    process.argv = previousArgv;
    process.exitCode = previousExitCode;
    process.stdout.write = previousStdout;
    process.stderr.write = previousStderr;
  }
}

async function expectCliPass(args: readonly string[]) {
  const result = await runCli(args);
  expect(result.exit, `${args.join(' ')}\n${result.stderr}`).toBe(0);
  return result;
}

async function establishTier3Binding(repo: string): Promise<void> {
  for (const selector of [
    ['--constitution'],
    ['--operational-law'],
    ['--subprocess-effects'],
    [],
  ]) {
    await expectCliPass([
      'init',
      'bind',
      ...selector,
      '--tier',
      'tier3',
      '--target',
      repo,
      '--as-role',
      'architect',
      '--write',
    ]);
  }
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('adopter-safe check and binding contracts', () => {
  it('offers an executable first constitution bind when apply is attempted in a fresh repo', async () => {
    const repo = root('devai-fresh-remediation-');
    const refused = await runCli([
      'init',
      'apply',
      'owner',
      '--target',
      repo,
      '--tier',
      'tier1',
      '--as-role',
      'owner',
      '--write',
    ]);
    expect(refused.exit).toBe(2);
    const response = JSON.parse(refused.stderr) as {
      error?: unknown;
    };
    const envelope = (response.error ?? response) as {
      code: string;
      context: { commands: string[] };
    };
    expect(envelope.code).toBe('AUTHORITY_POLICY_MISSING');
    expect(envelope.context.commands[0]).toContain('--constitution');
    const firstCommand = envelope.context.commands[0]?.split(' ').slice(1) ?? [];
    await expectCliPass(firstCommand);
    expect(existsSync(join(repo, '.devai/pin/constitution.md'))).toBe(true);
  });

  it('bootstraps all four bind segments under one explicit full invocation', async () => {
    const repo = root('devai-full-bind-');
    const result = await expectCliPass([
      'init',
      'bind',
      '--full',
      '--target',
      repo,
      '--tier',
      'tier1',
      '--as-role',
      'architect',
      '--write',
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      result: {
        value: {
          segments: [
            { segment: 'constitution' },
            { segment: 'operational-law' },
            { segment: 'subprocess-effects' },
            { segment: 'authority-policy' },
          ],
        },
      },
    });
    for (const path of [
      '.devai/pin/constitution.md',
      '.devai/config/domains.json',
      '.devai/config/subprocess-effects.json',
      '.devai/config/authority-policy.json',
    ]) {
      expect(existsSync(join(repo, path)), path).toBe(true);
    }
  });

  it('returns the local-closure contract and documentation reference in its refusal', async () => {
    const repo = root('devai-local-root-refusal-');
    await expectCliPass([
      'init',
      'bind',
      '--full',
      '--target',
      repo,
      '--tier',
      'tier1',
      '--as-role',
      'architect',
      '--write',
    ]);
    put(repo, 'test-tasks.json', {
      schemaVersion: '1.0.0',
      descriptorVersion: 'missing-local-root-v1',
      repositoryId: 'example/missing-local-root',
      fallbackNodeId: 'test:project',
      dynamicFallbackSelectors: [],
      tasks: [
        {
          nodeId: 'test:project',
          dependencies: [],
          argv: ['node', '-e', 'process.exit(0)'],
          cwd: '.',
          runner: 'node-v1',
          inputSelectors: [{ kind: 'prefix', pattern: 'src/' }],
          toolchainKeys: ['node'],
          allowlistedEnv: [],
          outputContract: { kind: 'test', requiredResult: 'pass' },
        },
      ],
      profiles: [
        {
          profileId: 'affected',
          mode: 'affected',
          requiredNodes: ['test:project'],
          eligibleNodes: ['test:project'],
        },
        { profileId: 'rc', mode: 'fixed', requiredNodes: ['test:project'] },
      ],
    });
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'DEVAI Test'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'devai@example.invalid'], { cwd: repo });
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: repo });

    const refused = await runCli(['check', '--local', '--task-plan', '--repo-root', repo]);
    expect(refused.exit).toBe(5);
    const response = JSON.parse(refused.stderr) as {
      error: { code: string; message: string; refs: { doc: string } };
    };
    expect(response.error).toMatchObject({
      code: 'CHECK_RUNNER_DESCRIPTOR',
      refs: { doc: 'docs/adopters/test-tasks.md#local-closure-root' },
    });
    expect(response.error.message).toContain('node named test:local-full');
  });

  it('returns structured blueprint findings without source-tree fallback', async () => {
    const repo = root();
    const valid = put(
      repo,
      'valid-blueprint.json',
      JSON.parse(
        readFileSync(
          join(ROOT, 'packages/skills/tests/operations/fixtures/blueprint.json'),
          'utf8',
        ),
      ),
    );
    const invalid = put(repo, 'invalid-blueprint.json', { schemaVersion: '1.0.0' });

    const accepted = await withAuthorityHostTestScope(() =>
      executeCheckMember(checkMember('blueprint'), { repoRoot: repo, file: valid }),
    );
    const rejected = await withAuthorityHostTestScope(() =>
      executeCheckMember(checkMember('blueprint'), { repoRoot: repo, file: invalid }),
    );
    expect(accepted.status).toBe('pass');
    expect(rejected).toMatchObject({ status: 'fail', value: { ok: false } });
    expect((rejected.value as { schema_errors?: unknown[] }).schema_errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/^\//u)]),
    );
  });

  it('selects adopter schema validation without claiming source-canon checks', async () => {
    const repo = root();
    await withAuthorityHostTestScope(() =>
      executeBootstrapPlan(buildBootstrapPlan({ targetRoot: repo, version: '1.2.1' })),
    );
    const result = await withAuthorityHostTestScope(() =>
      executeCheckMember(checkMember('schemas'), { repoRoot: repo }),
    );
    expect(result.status).toBe('pass');
    expect(result.value).toMatchObject({ mode: 'adopter-binding' });
    expect(JSON.stringify(result.value)).not.toContain('generated-marker-integrity');
    expect(JSON.stringify(result.value)).not.toContain('packages/schemas/dist');
  });

  it('binds TEAT documentation fields by deep merge and replays byte-identically', async () => {
    const repo = root();
    await withAuthorityHostTestScope(() =>
      executeBootstrapPlan(buildBootstrapPlan({ targetRoot: repo, version: '1.2.1' })),
    );
    const projectPath = join(repo, '.devai/config/project.json');
    const project = JSON.parse(readFileSync(projectPath, 'utf8')) as Record<string, unknown>;
    put(repo, '.devai/config/project.json', {
      ...project,
      name: 'TEAT',
      feature_flags: { adopter_owned_toggle: true },
      docs: { builder: 'docusaurus', output_dir: 'site/build' },
    });
    put(repo, 'law/policy/adopter-policy.json', {
      schemaVersion: '1.0.0',
      policy_id: 'teat.devai-adoption',
      policy_version: '1.2.1',
      project: {
        docs: {
          builder: 'docusaurus',
          publish_target: 'gh-pages',
          gh_pages_branch: 'gh-pages',
        },
      },
    });
    const argv = [
      'init-bind',
      '--target',
      repo,
      '--adopter-policy',
      'law/policy/adopter-policy.json',
      '--write',
    ];
    const first = await invoke(initBind, argv);
    expect(first.exit, first.stderr).toBe(0);
    const firstBytes = readFileSync(projectPath);
    expect(JSON.parse(firstBytes.toString())).toMatchObject({
      name: 'TEAT',
      feature_flags: { adopter_owned_toggle: true },
      docs: {
        builder: 'docusaurus',
        output_dir: 'site/build',
        publish_target: 'gh-pages',
        gh_pages_branch: 'gh-pages',
      },
    });
    const second = await invoke(initBind, argv);
    expect(second.exit, second.stderr).toBe(0);
    expect(readFileSync(projectPath)).toEqual(firstBytes);
  });

  it('does not rewrite authority or adopter bytes when an identical bound policy is replayed', async () => {
    const repo = root('devai-adopter-authority-idempotence-');
    await establishTier3Binding(repo);
    put(repo, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
    put(repo, 'law/policy/adopter-policy.json', {
      schemaVersion: '1.0.0',
      policy_id: 'teat.devai-adoption',
      policy_version: '1.2.1',
      domains: { client: ['COVERAGE'] },
      thresholds: { coverage: { lines: 91 } },
      project: {
        docs: {
          builder: 'docusaurus',
          publish_target: 'gh-pages',
          gh_pages_branch: 'gh-pages',
        },
      },
    });
    const argv = [
      'init',
      'bind',
      '--adopter-policy',
      'law/policy/adopter-policy.json',
      '--target',
      repo,
      '--as-role',
      'architect',
      '--write',
    ] as const;
    await expectCliPass(argv);

    const relevant = [
      'law/policy/adopter-policy.json',
      'pnpm-lock.yaml',
      '.devai/config/adopter-policy-binding.json',
      '.devai/config/authority-policy.json',
      '.devai/config/domains.json',
      '.devai/config/glob-guards.json',
      '.devai/config/project.json',
      '.devai/config/scorecard-na.json',
      '.devai/config/thresholds.json',
    ] as const;
    const firstBytes = new Map(
      relevant.map((path) => [path, readFileSync(join(repo, path))] as const),
    );
    const firstDigests = new Map(relevant.map((path) => [path, digest(join(repo, path))] as const));
    const firstAuthority = JSON.parse(
      readFileSync(join(repo, '.devai/config/authority-policy.json'), 'utf8'),
    ) as { materialized_at: string; materialization: { invocation_id: string } };

    const replay = await expectCliPass(argv);
    const secondAuthority = JSON.parse(
      readFileSync(join(repo, '.devai/config/authority-policy.json'), 'utf8'),
    ) as { materialized_at: string; materialization: { invocation_id: string } };
    expect.soft(secondAuthority.materialized_at).toBe(firstAuthority.materialized_at);
    expect
      .soft(secondAuthority.materialization.invocation_id)
      .toBe(firstAuthority.materialization.invocation_id);
    expect
      .soft(new Map(relevant.map((path) => [path, readFileSync(join(repo, path))] as const)))
      .toEqual(firstBytes);
    expect
      .soft(new Map(relevant.map((path) => [path, digest(join(repo, path))] as const)))
      .toEqual(firstDigests);
    expect.soft(JSON.parse(replay.stdout)).toMatchObject({
      result: { value: { authority_policy: { operation: 'unchanged' } } },
    });
  }, 30_000);

  it('executes the declared tier3 plan and role-separated apply sequence after binding', async () => {
    const repo = root('devai-tier3-role-sequence-');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    await expectCliPass(['init', 'plan', '--target', repo, '--tier', 'tier3']);
    await establishTier3Binding(repo);
    for (const [segment, role] of [
      ['owner', 'owner'],
      ['architect', 'architect'],
      ['harness', 'architect'],
    ] as const) {
      await expectCliPass([
        'init',
        'apply',
        segment,
        '--tier',
        'tier3',
        '--target',
        repo,
        '--as-role',
        role,
        '--write',
      ]);
    }
    expect(readFileSync(join(repo, 'product/README.md'), 'utf8')).not.toBe('');
    expect(readFileSync(join(repo, 'law/glossary/README.md'), 'utf8')).not.toBe('');
  }, 30_000);

  it('checks mutation from adopter-owned policy and thresholds without rewriting overrides', async () => {
    const repo = root();
    const policy = {
      schemaVersion: '1.0.0',
      id: 'mutation-strength',
      status: 'active',
      adopter_overrides: { required_scenarios: ['critical-teat-path'], survived_max: 0 },
    };
    put(repo, 'law/policy/mutation-strength.json', policy);
    put(repo, 'law/invariants/INV-TEAT-001.json', {
      id: 'INV-TEAT-001',
      verification: { strategy: 'mutation' },
    });
    put(repo, '.devai/config/thresholds.json', {
      mutation: { score_min: 95, survived_max: 0 },
    });
    put(repo, '.devai/state/mutation/current.json', { mutation_score: 100, survived: 0 });
    const before = readFileSync(join(repo, 'law/policy/mutation-strength.json'));
    const result = await withAuthorityHostTestScope(() =>
      executeCheckMember(checkMember('mutation'), { repoRoot: repo }),
    );
    expect(result.status).toBe('pass');
    expect(readFileSync(join(repo, 'law/policy/mutation-strength.json'))).toEqual(before);
  });

  it('collects an exact native local receipt through the bound adopter CLI without a source sibling', async () => {
    const repo = root('devai-installed-local-evidence-');
    expect(repo.startsWith(ROOT)).toBe(false);
    expect(existsSync(join(dirname(repo), 'devai', 'package.json'))).toBe(false);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Inspector Fixture'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'inspector@example.invalid'], { cwd: repo });
    execFileSync(
      'git',
      ['remote', 'add', 'origin', 'https://github.com/example/teat-installed.git'],
      { cwd: repo },
    );
    put(repo, 'package.json', {
      name: 'teat-installed',
      private: true,
      packageManager: 'pnpm@9.15.0',
      engines: { node: '>=24' },
    });
    await establishTier3Binding(repo);
    const projectPath = join(repo, '.devai/config/project.json');
    const project = JSON.parse(readFileSync(projectPath, 'utf8')) as Record<string, unknown>;
    put(repo, '.devai/config/project.json', {
      ...project,
      ci_economy: {
        local_evidence: {
          max_age_hours: 24,
          required_jobs: ['unit', 'api', 'db-postgis', 'browser-e2e', 'mutation', 'coverage'],
          allowed_platforms: ['darwin/arm64'],
        },
      },
    });
    await expectCliPass(['init', 'bind', '--target', repo, '--as-role', 'architect', '--write']);
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'bound installed adopter'], { cwd: repo });
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    const jobs = ['unit', 'api', 'db-postgis', 'browser-e2e', 'mutation', 'coverage'] as const;
    for (const job of jobs) {
      put(
        repo,
        `.artifacts/${job}/metadata.txt`,
        `job=${job}\nplatform=darwin/arm64\nactor=aarusso\nnode=${process.version}\npnpm=9.15.0\n`,
      );
      put(repo, `.artifacts/${job}/result.txt`, 'success\n');
    }

    const contract = ACTION_REGISTRY.find((entry) => entry.action_id === 'evidence collect');
    expect(contract).toMatchObject({
      effect: 'harness-write',
      authority_contract: {
        capabilities: ['fs:f5-state', 'fs:proofs', 'proc:git'],
        subject: {
          kind: 'derived-machine',
          actor: 'harness',
          transition: 'harness-write',
          initiator: { allowed_roles: ['owner', 'architect', 'inspector', 'engineer', 'auditor'] },
        },
        consent: { write: true, allow_publish: false },
      },
    });

    const result = await expectCliPass([
      'evidence',
      'collect',
      '--source',
      'local',
      '--repo-root',
      repo,
      ...jobs.flatMap((job) => ['--job', `${job}:.artifacts/${job}`]),
      '--as-role',
      'inspector',
      '--write',
    ]);
    const envelope = JSON.parse(result.stdout) as {
      result: { value: { output: string } };
    };
    const receipt = JSON.parse(
      readFileSync(join(repo, envelope.result.value.output), 'utf8'),
    ) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      subject: {
        repository: 'example/teat-installed',
        commitSha: commit,
        tree: { value: tree },
      },
      policy: {
        maxAgeHours: 24,
        requiredJobs: jobs,
        allowedPlatforms: ['darwin/arm64'],
      },
      platforms: ['darwin/arm64'],
      jobs: Object.fromEntries(
        jobs.map((job) => [job, { result: 'success', metadata: { job, actor: 'aarusso' } }]),
      ),
    });

    const verifyContract = ACTION_REGISTRY.find((entry) => entry.action_id === 'evidence verify');
    expect(verifyContract).toMatchObject({
      effect: 'read',
      authority_contract: {
        capabilities: ['proc:git'],
        subject: { kind: 'none' },
        consent: { write: false, allow_publish: false },
      },
    });
    put(repo, '.artifacts/changed-files.txt', '');
    const verified = await expectCliPass([
      'evidence',
      'verify',
      '--scope',
      'local',
      '--mode',
      'gate',
      '--repo-root',
      repo,
      '--actor',
      'aarusso',
      '--trusted-actors',
      'aarusso',
      '--event-name',
      'push',
      '--ref',
      'refs/heads/main',
      '--head-message',
      `bound installed adopter\n\nLocal-CI-Evidence: ${envelope.result.value.output}`,
      '--changed-files',
      '.artifacts/changed-files.txt',
    ]);
    expect(JSON.parse(verified.stdout)).toMatchObject({
      action_id: 'evidence verify',
      result: {
        value: {
          scope: 'local',
          mode: 'gate',
          evidenceMode: true,
          outcome: 'evidence-valid',
          manifestPath: envelope.result.value.output,
        },
      },
    });
  }, 30_000);

  it('fails local receipt collection closed when the bound adopter has no origin', async () => {
    const repo = root('devai-local-evidence-no-origin-');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Inspector Fixture'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'inspector@example.invalid'], { cwd: repo });
    await establishTier3Binding(repo);
    const projectPath = join(repo, '.devai/config/project.json');
    const project = JSON.parse(readFileSync(projectPath, 'utf8')) as Record<string, unknown>;
    put(repo, '.devai/config/project.json', {
      ...project,
      ci_economy: {
        local_evidence: {
          required_jobs: ['unit'],
          allowed_platforms: ['darwin/arm64'],
        },
      },
    });
    await expectCliPass(['init', 'bind', '--target', repo, '--as-role', 'architect', '--write']);
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'bound adopter without origin'], { cwd: repo });
    put(repo, '.artifacts/unit/metadata.txt', 'job=unit\nplatform=darwin/arm64\n');
    put(repo, '.artifacts/unit/result.txt', 'success\n');
    const result = await runCli([
      'evidence',
      'collect',
      '--source',
      'local',
      '--repo-root',
      repo,
      '--job',
      'unit:.artifacts/unit',
      '--as-role',
      'inspector',
      '--write',
    ]);
    expect(result.exit).not.toBe(0);
    expect(result.stderr).toMatch(/remote\.origin\.url|repository identity|failed/u);
    expect(existsSync(join(repo, 'record/proofs/work/local-evidence/local-ci.json'))).toBe(false);
  }, 30_000);
});

describe('stable scorecard facade contract', () => {
  it('is deterministic, read-only, schema-valid, and bound to exact current HEAD', async () => {
    const repo = root('devai-scorecard-contract-');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Inspector Fixture'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'inspector@example.invalid'], { cwd: repo });
    put(repo, 'README.md', '# adopter\n');
    put(repo, '.devai/config/scorecard-na.json', { schemaVersion: '1.0.0', cells: [] });
    put(repo, '.devai/config/thresholds.json', {
      schemaVersion: '1.0.0',
      freshness: { default_max_age_hours: 24, scorecard_failure_max_age_hours: 24 },
    });
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repo });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

    const first = await runCli(['audit', 'scorecard', '--repo-root', repo, '--at', head]);
    const second = await runCli(['audit', 'scorecard', '--repo-root', repo, '--at', head]);
    expect(first.exit, first.stderr).toBe(0);
    expect(second).toEqual(first);
    const envelope = JSON.parse(first.stdout) as { action_id: string; result: { value: unknown } };
    expect(envelope.action_id).toBe('audit scorecard');
    const validate = getValidator('scorecard.schema.json');
    expect(validate(envelope.result.value), JSON.stringify(validate.errors)).toBe(true);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })).toBe(
      '',
    );
    expect(existsSync(join(repo, '.devai/state/scorecards/latest.json'))).toBe(false);
  }, 30_000);
});

describe('fresh canonical evidence epoch', () => {
  it('creates genesis, appends, verifies, and is accepted by doctor at record/proofs/chain.json', async () => {
    const repo = root('devai-fresh-chain-contract-');
    await withAuthorityHostTestScope(() =>
      executeBootstrapPlan(buildBootstrapPlan({ targetRoot: repo, version: '1.2.1' })),
    );
    const chainPath = join(repo, 'record/proofs/chain.json');
    expect(JSON.parse(readFileSync(chainPath, 'utf8'))).toEqual({ head: null, records: [] });
    for (const ordinal of [1, 2]) {
      const result = await invoke(evidenceRecord, [
        'evidence-record',
        '--kind',
        'generic',
        '--round',
        'R-0013',
        '--repo-root',
        repo,
        '--payload',
        JSON.stringify({ ordinal }),
      ]);
      expect(result.exit, result.stderr).toBe(0);
    }
    const chain = JSON.parse(readFileSync(chainPath, 'utf8')) as {
      head: string | null;
      records: Array<{ sequence: number; previous_hash: string }>;
    };
    expect(chain.records).toHaveLength(2);
    expect(chain.records.map((record) => record.sequence)).toEqual([1, 2]);
    expect(chain.records[0]?.previous_hash).toBe('GENESIS');
    expect(chain.records[1]?.previous_hash).toBeTruthy();
    expect(verifyChain(chainPath)).toMatchObject({ valid: true });

    const diagnosis = await invoke(doctor, [
      'doctor',
      '--repo-root',
      repo,
      '--skip',
      'docs-governance',
    ]);
    const report = JSON.parse(diagnosis.stdout) as { checks: Array<{ name: string; ok: boolean }> };
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: 'evidence-chain-valid', ok: true }),
    );
    expect(existsSync(join(repo, '.devai/state/evidence-chain.json'))).toBe(false);
  }, 30_000);
});

describe('package-only acceptance and obsolete verifier rejection', () => {
  it('keeps installed smoke coverage for every TEAT adopter obligation', () => {
    const smoke = readFileSync(
      join(ROOT, 'packages/cli/scripts/installed-tarball-smoke.mjs'),
      'utf8',
    );
    for (const marker of [
      "'blueprint'",
      "'schemas'",
      'mutation-strength.json',
      "'mutation'",
      "'audit', 'scorecard'",
      "'evidence', 'record'",
      'record/proofs/chain.json',
      'gh_pages_branch',
    ]) {
      expect(smoke, `installed smoke missing ${marker}`).toContain(marker);
    }
    expect(smoke).toMatch(/workspace.*(?:reject|forbid|missing)|SOURCE_BOUNDARY/u);
  });

  it('contains no live legacy verifier dependency in current execution surfaces', () => {
    const paths = [
      '.github/workflows/devai-ledger-verify.yml',
      '.github/workflows/release.yml',
      'packages/cli/src/services/ci-scaffold/index.ts',
      'packages/cli/src/commands/check/ci-economy.ts',
      'scripts/check-workflows.mjs',
      'scripts/create-release-manifest.mjs',
      'docs/dev/operations/release-discipline.md',
      'docs/adopters/ci-economy.md',
    ];
    const findings = paths.filter((path) =>
      readFileSync(join(ROOT, path), 'utf8').includes('devai-nyx/devai-verifier'),
    );
    expect(findings).toEqual([]);
  });
});

describe('targeted dependency security floor', () => {
  it('resolves reviewed compatible transitive versions', () => {
    const lock = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
    const resolvedPackages = lock.slice(lock.indexOf('\npackages:\n'));
    expect(resolvedPackages).not.toMatch(/^ {2}fast-uri@3\.1\.[0-4]:/mu);
    expect(resolvedPackages).not.toMatch(/^ {2}brace-expansion@2\.1\.[0-3]:/mu);
    expect(resolvedPackages).toMatch(/^ {2}fast-uri@3\.1\.5:/mu);
    expect(resolvedPackages).toMatch(/^ {2}brace-expansion@1\.1\.18:/mu);
    expect(resolvedPackages).toMatch(/^ {2}brace-expansion@2\.1\.4:/mu);
    expect(resolvedPackages).toMatch(/^ {2}brace-expansion@5\.0\.9:/mu);
    expect(resolvedPackages).toMatch(/^ {2}js-yaml@4\.3\.1:/mu);
    expect(resolvedPackages).toMatch(/^ {2}nanoid@3\.3\.18:/mu);
    expect(resolvedPackages).toMatch(/^ {2}postcss@8\.5\.23:/mu);
  });
});
