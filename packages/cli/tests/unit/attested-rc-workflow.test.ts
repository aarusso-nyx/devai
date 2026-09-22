import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ATTESTED_RC_WORKFLOW_FILE,
  attestedRcVerificationWorkflow,
  buildCiScaffoldPlan,
} from '../../src/services/ci-scaffold/index.js';
import { checkCiEconomy } from '../../src/commands/check/ci-economy.js';
// @ts-expect-error The package-owned verifier intentionally ships native ESM without declarations.
import { canonicalize } from '../../vendor/evidence-verification/src/canonical.js';
// @ts-expect-error The package-owned verifier intentionally ships native ESM without declarations.
import { verifyPreparedBundle } from '../../vendor/evidence-verification/src/publish.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(root: string, path: string, value: unknown): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
}

function project(root: string): void {
  put(root, '.devai/config/project.json', {
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
}

interface VerifierPackagePolicy {
  package: {
    name: string;
    version: string;
    registry: string;
    tarball: string;
    shasum_sha1: string;
    integrity_sri: string;
    release_source: { repository: string; commit: string; tree: string };
  };
  authentication: { secret: string; github_token_fallback: boolean };
  workflow_permissions: Record<string, string>;
  verifier: {
    provenance_sha256: string;
    source_commit: string;
    payload_file_count: number;
    binaries: Record<string, string>;
  };
  external_duplicate: { name: string; required: boolean; sole_trust_root: boolean };
  adopter_fallbacks: unknown[];
}

interface WorkflowStep {
  name?: string;
  id?: string;
  env?: Record<string, string>;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface WorkflowDocument {
  permissions: Record<string, string>;
  jobs: { 'verify-attested-rc': { steps: WorkflowStep[] } };
}

const verifierPolicy = JSON.parse(
  readFileSync(resolve('law/policy/trusted-local-rc-verifier-package.json'), 'utf8'),
) as VerifierPackagePolicy;

function generatedWorkflow(): {
  content: string;
  document: WorkflowDocument;
  packageStep: WorkflowStep;
} {
  const root = mkdtempSync(join(tmpdir(), 'devai-attested-workflow-'));
  roots.push(root);
  project(root);
  const plan = buildCiScaffoldPlan({ targetRoot: root });
  const document = parse(plan.content) as WorkflowDocument;
  const packageStep = document.jobs['verify-attested-rc'].steps.find(
    (step) => step.id === 'verifier-package',
  );
  if (packageStep === undefined) throw new Error('generated verifier-package step is missing');
  return { content: plan.content, document, packageStep };
}

function workflowRun(name: string): string {
  const step = generatedWorkflow().document.jobs['verify-attested-rc'].steps.find(
    (entry) => entry.name === name,
  );
  if (typeof step?.run !== 'string') throw new Error(`generated workflow step is missing: ${name}`);
  return step.run;
}

function filesBelow(root: string, current = root): string[] {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(current, entry.name);
    return entry.isDirectory()
      ? filesBelow(root, absolute)
      : [
          absolute
            .slice(root.length + 1)
            .split('\\')
            .join('/'),
        ];
  });
}

describe('attested RC workflow scaffold', () => {
  it('materializes only the exact authenticated verifier package identity before extraction', () => {
    const { content, document, packageStep } = generatedWorkflow();
    const run = packageStep.run ?? '';
    const steps = document.jobs['verify-attested-rc'].steps;
    const packageIdentity = verifierPolicy.package;

    expect.soft(document.permissions).toEqual(verifierPolicy.workflow_permissions);
    expect.soft(packageStep.env).toMatchObject({
      NODE_AUTH_TOKEN: `\${{ secrets.${verifierPolicy.authentication.secret} }}`,
      VERIFIER_PROVENANCE_SHA256: `\${{ vars.${verifierPolicy.external_duplicate.name} }}`,
    });
    expect.soft(run).toMatch(/test -n "\$NODE_AUTH_TOKEN"/u);
    const tokenGuard = run.indexOf('test -n "$NODE_AUTH_TOKEN"');
    const authenticatedRegistryAccess = run.search(
      /(?:Authorization|_authToken)[^\n]*\$NODE_AUTH_TOKEN/u,
    );
    expect.soft(authenticatedRegistryAccess).toBeGreaterThan(tokenGuard);
    expect.soft(run).not.toContain('${{ github.token }}');
    expect.soft(run).not.toContain('GH_TOKEN');
    expect.soft(verifierPolicy.authentication.github_token_fallback).toBe(false);
    expect
      .soft(
        steps
          .filter((step) => step !== packageStep)
          .some((step) => JSON.stringify(step).includes(verifierPolicy.authentication.secret)),
      )
      .toBe(false);

    for (const expected of [
      packageIdentity.name,
      packageIdentity.version,
      packageIdentity.registry,
      packageIdentity.tarball,
      packageIdentity.shasum_sha1,
      packageIdentity.integrity_sri,
      packageIdentity.release_source.repository,
      packageIdentity.release_source.commit,
      packageIdentity.release_source.tree,
    ]) {
      expect.soft(run).toContain(expected);
    }
    const identityFailures = [
      'DEVAI_VERIFIER_PACKAGE_NAME_INVALID',
      'DEVAI_VERIFIER_PACKAGE_VERSION_INVALID',
      'DEVAI_VERIFIER_PACKAGE_TARBALL_URL_INVALID',
      'DEVAI_VERIFIER_PACKAGE_SHASUM_INVALID',
      'DEVAI_VERIFIER_PACKAGE_INTEGRITY_INVALID',
      'DEVAI_VERIFIER_PACKAGE_RELEASE_COMMIT_INVALID',
      'DEVAI_VERIFIER_PACKAGE_RELEASE_TREE_INVALID',
    ];
    for (const failure of identityFailures) {
      expect.soft(run).toContain(failure);
    }
    const extraction = run.search(/\btar\s+[^\n]*-x/u);
    for (const failure of identityFailures) {
      expect.soft(run.indexOf(failure)).toBeLessThan(extraction);
    }

    expect.soft(content).not.toMatch(/NODE_AUTH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/u);
    expect.soft(content).not.toMatch(/NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/u);
    expect.soft(content).not.toContain('devai-nyx/devai-verifier');
  });

  it('rejects unsafe archives and every verifier population or binary drift before execution', () => {
    const { content, packageStep } = generatedWorkflow();
    const run = packageStep.run ?? '';

    for (const failure of [
      'DEVAI_VERIFIER_ARCHIVE_ABSOLUTE_PATH_INVALID',
      'DEVAI_VERIFIER_ARCHIVE_PATH_TRAVERSAL_INVALID',
      'DEVAI_VERIFIER_ARCHIVE_SYMLINK_INVALID',
      'DEVAI_VERIFIER_ARCHIVE_HARDLINK_INVALID',
      'DEVAI_VERIFIER_ARCHIVE_SPECIAL_FILE_INVALID',
      'DEVAI_VERIFIER_PACKAGE_FILE_MISSING',
      'DEVAI_VERIFIER_PACKAGE_FILE_EXTRA',
      'DEVAI_VERIFIER_PACKAGE_SYMLINK_INVALID',
      'DEVAI_VERIFIER_PACKAGE_SPECIAL_FILE_INVALID',
      'DEVAI_VERIFIER_PACKAGE_FILE_DIGEST_INVALID',
      'DEVAI_VERIFIER_PACKAGE_BIN_INVALID',
    ]) {
      expect.soft(run).toContain(failure);
    }
    const archiveValidation = run.indexOf('DEVAI_VERIFIER_ARCHIVE_ABSOLUTE_PATH_INVALID');
    const extraction = run.search(/\btar\s+[^\n]*-x/u);
    expect.soft(archiveValidation).toBeGreaterThanOrEqual(0);
    expect.soft(extraction).toBeGreaterThan(archiveValidation);
    expect.soft(run).toContain('--no-same-owner');
    expect.soft(run).toContain('--no-same-permissions');
    expect.soft(run).toContain(String(verifierPolicy.verifier.payload_file_count));
    for (const [name, path] of Object.entries(verifierPolicy.verifier.binaries)) {
      expect.soft(run).toContain(name);
      expect.soft(run).toContain(path);
    }
    expect
      .soft(content.indexOf('DEVAI_VERIFIER_PACKAGE_FILE_DIGEST_INVALID'))
      .toBeLessThan(content.indexOf('node "$DEVAI_EVIDENCE_BUNDLE_VERIFY"'));
  });

  it('has no mutable verifier identity, adopter checkout fallback, or lifecycle execution', () => {
    const { content, packageStep } = generatedWorkflow();
    const run = packageStep.run ?? '';

    expect.soft(verifierPolicy.adopter_fallbacks).toEqual([]);
    expect
      .soft(run)
      .toContain(`provenance.sourceCommit !== '${verifierPolicy.verifier.source_commit}'`);
    expect.soft(run).not.toMatch(/\.includes\(provenance\.sourceCommit\)/u);
    expect.soft(run).not.toMatch(/\b(?:latest|next|main|master)\b/u);
    expect.soft(run).not.toMatch(/(?:\^|~|\*|>=|<=)\d+\.\d+/u);
    expect.soft(run).not.toContain('candidate/packages/cli');
    expect.soft(run).not.toContain('packages/cli');
    expect.soft(run).not.toContain('source_root');
    expect.soft(run).not.toContain('cp -R');
    expect.soft(run).not.toMatch(/\b(?:npm|pnpm|yarn|bun)\s+(?:ci|install|run|exec|test)\b/u);
    expect.soft(run).not.toMatch(/\bnode\s+[^\n]*(?:candidate|stynx|packages\/cli)/iu);
    expect.soft(content).not.toMatch(/pnpm (?:run|exec|test)|\bstryker\b/u);
    expect.soft(content).not.toContain('DEVAI_LEDGER_PACKAGE_TGZ_B64');
    expect.soft(content).not.toContain('DEVAI_LEDGER_PACKAGE_SHA256');
  });

  it('requires the protected provenance duplicate in addition to the committed package identity', () => {
    const { content, packageStep } = generatedWorkflow();
    const run = packageStep.run ?? '';

    expect(verifierPolicy.external_duplicate).toEqual({
      name: 'DEVAI_LEDGER_VERIFIER_PROVENANCE_SHA256',
      required: true,
      sole_trust_root: false,
    });
    expect(run).toContain('test "$VERIFIER_PROVENANCE_SHA256" != ""');
    expect(run).toContain('test "${#VERIFIER_PROVENANCE_SHA256}" = 64');
    expect(run).toContain('test "$actual_provenance_sha256" = "$VERIFIER_PROVENANCE_SHA256"');
    expect(run).toContain(verifierPolicy.verifier.provenance_sha256);
    expect(
      content.indexOf('test "$actual_provenance_sha256" = "$VERIFIER_PROVENANCE_SHA256"'),
    ).toBeLessThan(content.indexOf('node "$DEVAI_EVIDENCE_BUNDLE_VERIFY"'));
  });

  it('generates identical workflow bytes in two independent adopter targets', () => {
    const first = mkdtempSync(join(tmpdir(), 'devai-attested-workflow-a-'));
    const second = mkdtempSync(join(tmpdir(), 'devai-attested-workflow-b-'));
    roots.push(first, second);
    project(first);
    project(second);
    const firstPlan = buildCiScaffoldPlan({ targetRoot: first });
    const secondPlan = buildCiScaffoldPlan({ targetRoot: second });

    expect(firstPlan.path).toBe(join(first, '.github/workflows', ATTESTED_RC_WORKFLOW_FILE));
    expect(secondPlan.path).toBe(join(second, '.github/workflows', ATTESTED_RC_WORKFLOW_FILE));
    expect(firstPlan.content).toBe(secondPlan.content);
    expect(firstPlan.content).toBe(attestedRcVerificationWorkflow());
    expect(() => parse(firstPlan.content)).not.toThrow();
  });

  it('keeps the generated workflow bound to the canonical scaffold route', () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-attested-workflow-'));
    roots.push(root);
    project(root);
    const plan = buildCiScaffoldPlan({ targetRoot: root });
    expect(plan.path).toBe(join(root, '.github/workflows', ATTESTED_RC_WORKFLOW_FILE));
    expect(plan.content).toBe(attestedRcVerificationWorkflow());
    expect(() => parse(plan.content)).not.toThrow();
    expect(plan.content).toContain('name: verified-local-rc');
    expect(plan.content).toContain('--binding "${{ steps.identity.outputs.binding }}"');
    expect(plan.content).toContain('control/law/policy/devai-local-rc-trust-store.json');
  });

  it('archives an actions-checkout-shaped proof into inert versioned bytes without hiding ordinary files', () => {
    const materialize = workflowRun('Materialize inert versioned proof payload');
    const buildFixture = (includeUnexpected: boolean) => {
      const root = mkdtempSync(join(tmpdir(), 'devai-proof-payload-'));
      roots.push(root);
      const source = join(root, 'source');
      const checkout = join(root, 'evidence');
      const runnerTemp = join(root, 'runner-temp');
      const githubOutput = join(root, 'github-output');
      mkdirSync(source, { recursive: true });
      mkdirSync(runnerTemp, { recursive: true });
      writeFileSync(githubOutput, '');
      execFileSync('git', ['init', '--quiet'], { cwd: source });
      execFileSync('git', ['config', 'user.name', 'DEVAI fixture'], { cwd: source });
      execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: source });
      const taskPolicy = {
        schemaVersion: '1.1.0',
        repositoryId: 'fixture/repository',
        requiredNodes: [
          {
            nodeId: 'test:rc',
            taskKey: '1'.repeat(64),
            dependencies: [],
            outputContract: { kind: 'files' },
          },
        ],
      };
      const policyDigest = createHash('sha256').update(canonicalize(taskPolicy)).digest('hex');
      const envelope = {};
      const manifest = {
        schemaVersion: '1.1.0',
        repositoryId: 'fixture/repository',
        commit: '2'.repeat(40),
        tree: '3'.repeat(40),
        profile: 'rc',
        signerId: 'fixture-signer',
        taskPolicyDigest: policyDigest,
        envelopeDigest: '4'.repeat(64),
        resultDigests: [],
        artifacts: [],
      };
      writeFileSync(join(source, 'envelope.json'), `${canonicalize(envelope)}\n`);
      writeFileSync(join(source, 'manifest.json'), `${canonicalize(manifest)}\n`);
      writeFileSync(join(source, 'task-policy.json'), `${canonicalize(taskPolicy)}\n`);
      if (includeUnexpected) writeFileSync(join(source, 'unexpected.txt'), 'still versioned\n');
      execFileSync('git', ['add', '.'], { cwd: source });
      execFileSync('git', ['commit', '--quiet', '-m', 'proof'], { cwd: source });
      const proofCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: source,
        encoding: 'utf8',
      }).trim();
      execFileSync('git', ['worktree', 'add', '--quiet', '--detach', checkout, proofCommit], {
        cwd: source,
      });
      expect(existsSync(join(checkout, '.git'))).toBe(true);
      const result = spawnSync(
        'bash',
        ['-c', materialize.replaceAll('${{ steps.identity.outputs.proof_commit }}', proofCommit)],
        {
          cwd: root,
          encoding: 'utf8',
          env: { ...process.env, RUNNER_TEMP: runnerTemp, GITHUB_OUTPUT: githubOutput },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const bundle = join(runnerTemp, 'devai-local-rc/proof');
      expect(existsSync(join(bundle, '.git'))).toBe(false);
      return { bundle, policyDigest, files: filesBelow(bundle).sort() };
    };

    const ordinary = buildFixture(false);
    expect(ordinary.files).toEqual(['envelope.json', 'manifest.json', 'task-policy.json']);
    expect(() =>
      verifyPreparedBundle({
        bundleDir: ordinary.bundle,
        trustStorePath: join(ordinary.bundle, 'unused-trust.json'),
        expectedRepository: 'fixture/repository',
        expectedCommit: '2'.repeat(40),
        expectedTree: '3'.repeat(40),
        expectedPolicyDigest: ordinary.policyDigest,
      }),
    ).toThrow(expect.objectContaining({ code: 'ENVELOPE_DIGEST_MISMATCH' }));

    const unexpected = buildFixture(true);
    expect(unexpected.files).toContain('unexpected.txt');
    expect(() =>
      verifyPreparedBundle({
        bundleDir: unexpected.bundle,
        trustStorePath: join(unexpected.bundle, 'unused-trust.json'),
        expectedRepository: 'fixture/repository',
        expectedCommit: '2'.repeat(40),
        expectedTree: '3'.repeat(40),
        expectedPolicyDigest: unexpected.policyDigest,
      }),
    ).toThrow(expect.objectContaining({ code: 'BUNDLE_POPULATION_MISMATCH' }));
  });

  it('retains a parseable concise diagnostic when verifier JSON is emitted only on stderr', () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-verifier-summary-'));
    roots.push(root);
    const state = join(root, 'devai-local-rc');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'verified.json'), '');
    writeFileSync(
      join(state, 'verifier-error.json'),
      '{"ok":false,"code":"BUNDLE_POPULATION_MISMATCH","message":"population differs"}\n',
    );
    const result = spawnSync('bash', ['-c', workflowRun('Build concise verification artifact')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        RUNNER_TEMP: root,
        VERIFY_OUTCOME: 'failure',
        CANDIDATE_SHA: '5'.repeat(40),
        CANDIDATE_TREE: '6'.repeat(40),
        BINDING: 'exact-tree',
        POLICY_DIGEST: '7'.repeat(64),
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(state, 'verification-summary.json'), 'utf8'))).toEqual({
      schemaVersion: '1.0.0',
      verdict: 'fail',
      signer: null,
      evidenceCommit: null,
      candidateCommit: '5'.repeat(40),
      tree: '6'.repeat(40),
      binding: 'exact-tree',
      policyDigest: '7'.repeat(64),
      rosterCount: 0,
      failureCode: 'BUNDLE_POPULATION_MISMATCH',
      failureMessage: 'population differs',
    });
  });

  it('satisfies the CI-economy protected package-verifier marker after canonical generation', () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-attested-workflow-'));
    roots.push(root);
    project(root);
    const plan = buildCiScaffoldPlan({ targetRoot: root });
    mkdirSync(dirname(plan.path), { recursive: true });
    writeFileSync(plan.path, plan.content);

    const finding = checkCiEconomy({ repoRoot: root }).findings.find(
      (entry) => entry.ruleId === 'ci-economy.evidence-gate-wired',
    );
    expect(finding).toMatchObject({ severity: 'pass' });
  });

  it('fails closed instead of generating from malformed attested-RC policy', () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-attested-workflow-'));
    roots.push(root);
    project(root);
    const configPath = join(root, '.devai/config/project.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      ci_economy: { attested_rc: { failure_mode: string } };
    };
    config.ci_economy.attested_rc.failure_mode = 'fallback';
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    expect(() => buildCiScaffoldPlan({ targetRoot: root })).toThrow(
      /CI_SCAFFOLD_ATTESTED_RC_INVALID/u,
    );
  });
});
