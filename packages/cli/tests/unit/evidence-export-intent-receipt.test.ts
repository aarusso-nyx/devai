/**
 * ADR-REL-0031 inspector acceptance (IA-001..IA-005): the vendored evidence exporter the
 * CLI package ships exports the certify receipt of a release-intent run by reconstructing
 * its task policy from the pinned intent, and refuses every drift with its own code.
 *
 * The run is a real release-intent preflight and certify run of the check runner over the
 * fixture in tests/fixtures/export-intent (see its README). The exporter is then driven
 * only through its CLI, so every refusal is the `{ ok: false, code, message }` line it
 * writes on stderr. Signing keys are throwaway Ed25519 keys generated per test.
 */
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import {
  cpSync,
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
import { pathToFileURL } from 'node:url';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runCheckTasks,
  sha256Hex,
  type CheckRunnerOptions,
  type CheckRunnerReport,
  type TaskExecutionResult,
} from '../../src/services/check-runner/index.js';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../../..');
const FIXTURE = join(REPOSITORY_ROOT, 'tests/fixtures/export-intent');
const VERIFIER = join(REPOSITORY_ROOT, 'packages/cli/vendor/evidence-verification');
const EXPORT_CLI = join(VERIFIER, 'src/export-cli.js');
const SENTINEL = 'export-ran-a-task';
const SIGNER = 'local-rc-signer';
const PASS: TaskExecutionResult = { status: 0, signal: null, stdout: 'ok\n', stderr: '' };

type Json = Record<string, unknown>;

interface ExportState {
  readonly root: string;
  readonly repo: string;
  readonly genesis: Readonly<{ commit: string; tree: string }>;
  readonly base: Readonly<{ commit: string; tree: string }>;
  readonly candidate: Readonly<{ commit: string; tree: string }>;
  readonly resultsDir: string;
  readonly outputDir: string;
  readonly paths: Readonly<Record<string, string>>;
  readonly intent: Json;
  readonly releaseProfile: Json;
  readonly preflight: Json;
  readonly receipt: Json;
  readonly certify: CheckRunnerReport;
  readonly executions: () => number;
}

const roots: string[] = [];
let invocationOrdinal = 0;

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true });
});

function withRunnerScope<T>(callback: () => T): T {
  invocationOrdinal += 1;
  const invocationId = `export-intent-test-${String(invocationOrdinal)}`;
  let receiptOrdinal = 0;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'export-intent-test',
    issuer_version: '1.0.0',
    invocation_id: invocationId,
    canonicalSha256: () => 'c'.repeat(64),
    randomId: () => `${invocationId}-${String(++receiptOrdinal)}`,
    now: () => '2026-10-01T00:00:00.000Z',
    receipt_ttl_ms: 30_000,
  });
  const scope: AuthorityHostEffectScope = {
    action_id: 'check',
    invocation_id: invocationId,
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (_request, apply) => apply(),
  };
  try {
    return runWithAuthorityHostEffects(scope, callback);
  } finally {
    issuer.dispose();
  }
}

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(String(result.stderr));
  return String(result.stdout).trim();
}

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function fixtureJson(name: string): Json {
  return JSON.parse(readFileSync(join(FIXTURE, name), 'utf8')) as Json;
}

function commitAll(repo: string, message: string): Readonly<{ commit: string; tree: string }> {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', message]);
  return {
    commit: git(repo, ['rev-parse', 'HEAD']),
    tree: git(repo, ['rev-parse', 'HEAD^{tree}']),
  };
}

/** Candidate repository: genesis, then base 1.0.0, then candidate 1.0.1 changing src/. */
function candidateRepository(root: string) {
  const repo = join(root, 'candidate');
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Export Intent Test']);
  git(repo, ['config', 'user.email', 'export-intent@example.invalid']);
  put(join(repo, '.gitignore'), '.devai/state/\n');
  put(join(repo, 'docs/notes.md'), '# Notes\n');
  const genesis = commitAll(repo, 'genesis');
  put(join(repo, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  put(join(repo, 'src/a.js'), 'export const value = 1;\n');
  put(join(repo, 'test-tasks.json'), readFileSync(join(FIXTURE, 'test-tasks.json'), 'utf8'));
  const base = commitAll(repo, 'base');
  put(join(repo, 'package.json'), '{"name":"fixture","version":"1.0.1"}\n');
  put(join(repo, 'src/a.js'), 'export const value = 2;\n');
  const candidate = commitAll(repo, 'candidate');
  return { repo, genesis, base, candidate };
}

function keyMaterial(root: string) {
  const keys = generateKeyPairSync('ed25519');
  const paths = {
    privateKey: join(root, 'private.pem'),
    publicKey: join(root, 'public.pem'),
    trustStore: join(root, 'trust-store.json'),
  };
  put(paths.privateKey, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  put(paths.publicKey, keys.publicKey.export({ type: 'spki', format: 'pem' }).toString());
  put(
    paths.trustStore,
    JSON.stringify({
      schemaVersion: '1.0.0',
      trustedSigners: [
        {
          signerId: SIGNER,
          publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        },
      ],
      revokedSignerIds: [],
    }),
  );
  return paths;
}

function runChecks(repo: string, count: () => void, overrides: Partial<CheckRunnerOptions>) {
  return withRunnerScope(() =>
    runCheckTasks({
      repoRoot: repo,
      target: 'affected',
      operation: 'run',
      toolchain: fixtureJson('toolchain.json') as Record<string, string>,
      environment: {},
      executeTask: () => {
        count();
        return PASS;
      },
      now: () => '2026-10-01T00:00:00.000Z',
      ...overrides,
    }),
  );
}

function resultsOf(repo: string): string {
  return join(repo, '.devai/state/check-cache/v1/results');
}

/** Writes the external inputs; `repin` moves the preflight pins onto the current values. */
function writeInputs(state: ExportState, { repin = false } = {}): void {
  if (repin) {
    state.preflight.releaseIntentDigest = sha256Hex(state.intent);
    state.preflight.releaseProfileDigest = sha256Hex(state.releaseProfile);
  }
  put(state.paths.intent ?? '', `${JSON.stringify(state.intent, null, 2)}\n`);
  put(state.paths.releaseProfile ?? '', `${JSON.stringify(state.releaseProfile, null, 2)}\n`);
  put(state.paths.preflightReceipt ?? '', `${JSON.stringify(state.preflight)}\n`);
  put(state.paths.receipt ?? '', `${JSON.stringify(state.receipt)}\n`);
}

/** A release-intent preflight run, then its certify run, over the fixture candidate. */
function releaseIntentRun(): ExportState {
  const root = mkdtempSync(join(tmpdir(), 'devai-export-intent-'));
  roots.push(root);
  const { repo, genesis, base, candidate } = candidateRepository(root);
  const intent: Json = {
    schemaVersion: '1.0.0',
    release_unit: 'fixture/repository',
    current_version: '1.0.0',
    target_version: '1.0.1',
    support: 'current',
    changed_paths: ['package.json', 'src/a.js'],
    changed_packages: [],
    candidate: { ...candidate },
    base: { ...base },
  };
  const releaseProfile = fixtureJson('release-profile.json');
  let executions = 0;
  const count = () => {
    executions += 1;
  };
  const preflightRun = runChecks(repo, count, {
    baseCommit: base.commit,
    releaseIntent: intent,
    releaseProfile,
  });
  const preflight = preflightRun.preflightReceipt?.value as Json | undefined;
  if (preflight === undefined) throw new Error('release preflight produced no receipt');
  const certify = runChecks(repo, count, {
    baseCommit: base.commit,
    releaseIntent: intent,
    releaseProfile,
    releaseStage: 'certify',
    preflightReceipt: preflight,
  });
  const receipt = certify.receipt?.value as unknown as Json | undefined;
  if (receipt === undefined) throw new Error('release certify produced no receipt');

  // Every exporter input lives outside the candidate repository.
  const resultsDir = join(root, 'runner-results');
  cpSync(resultsOf(repo), resultsDir, { recursive: true });
  const paths = {
    intent: join(root, 'release-intent.json'),
    releaseProfile: join(root, 'release-profile.json'),
    preflightReceipt: join(root, 'release-preflight-receipt.json'),
    receipt: join(root, 'candidate-receipt.json'),
    toolchain: join(root, 'toolchain.json'),
    environment: join(root, 'environment.json'),
    ...keyMaterial(root),
  };
  cpSync(join(FIXTURE, 'toolchain.json'), paths.toolchain);
  cpSync(join(FIXTURE, 'environment.json'), paths.environment);
  const state: ExportState = {
    root,
    repo,
    genesis,
    base,
    candidate,
    resultsDir,
    outputDir: join(root, 'exported'),
    paths,
    intent,
    releaseProfile,
    preflight,
    receipt,
    certify,
    executions: () => executions,
  };
  writeInputs(state);
  return state;
}

function intentArguments(
  state: ExportState,
  overrides: Readonly<Record<string, string | undefined>> = {},
): string[] {
  const values: Record<string, string | undefined> = {
    repo: state.repo,
    receipt: state.paths.receipt,
    'results-dir': state.resultsDir,
    'release-intent': state.paths.intent,
    'release-profile': state.paths.releaseProfile,
    'release-stage': 'certify',
    'preflight-receipt': state.paths.preflightReceipt,
    base: state.base.commit,
    commit: state.candidate.commit,
    tree: state.candidate.tree,
    toolchain: state.paths.toolchain,
    environment: state.paths.environment,
    'private-key': state.paths.privateKey,
    'public-key': state.paths.publicKey,
    'signer-id': SIGNER,
    'output-dir': state.outputDir,
    ...overrides,
  };
  return Object.entries(values).flatMap(([name, value]) =>
    value === undefined ? [] : [`--${name}`, value],
  );
}

function exportCli(cwd: string, args: readonly string[]) {
  return spawnSync(process.execPath, [EXPORT_CLI, ...args], { cwd, encoding: 'utf8' });
}

function expectNothingExported(state: Pick<ExportState, 'root' | 'outputDir'>): void {
  expect(existsSync(state.outputDir)).toBe(false);
  expect(
    readdirSync(state.root).filter((name) => name.startsWith('.devai-evidence-export-')),
  ).toEqual([]);
  expect(existsSync(join(state.root, SENTINEL))).toBe(false);
}

function expectRefusal(
  state: ExportState,
  code: string,
  overrides: Readonly<Record<string, string | undefined>> = {},
): { code: string; message: string } {
  const run = exportCli(state.root, intentArguments(state, overrides));
  expect(run.stdout).toBe('');
  expect(run.stderr, `${code}: a coded refusal line is required`).not.toBe('');
  const refusal = JSON.parse(run.stderr) as { ok: boolean; code: string; message: string };
  expect(refusal.ok).toBe(false);
  expect(refusal.code, run.stderr).toBe(code);
  expect(run.status).toBe(code === 'USAGE' ? 64 : 2);
  expectNothingExported(state);
  return refusal;
}

describe('release-intent certify receipt export (ADR-REL-0031)', () => {
  it('IA-001: exports the certify receipt without a second execution and keeps its pinned digest', async () => {
    const state = releaseIntentRun();
    expect(state.certify.plan.taskPolicy.schemaVersion).toBe('1.2.0');
    expect(state.receipt.taskPolicyDigest).toBe(state.certify.plan.taskPolicyDigest);
    expect(state.receipt.profile).toBe('rc');

    // The release policy the run pinned is the fixed-profile policy of the same node set,
    // re-versioned with the input projection: the premise of the canonical verifier tests.
    const { buildExpectedTaskPolicy } = (await import(
      pathToFileURL(join(VERIFIER, 'src/policy-builder.js')).href
    )) as {
      buildExpectedTaskPolicy: (options: Json) => { taskPolicy: Json };
    };
    const fixed = buildExpectedTaskPolicy({
      repo: state.repo,
      descriptor: fixtureJson('test-tasks.json'),
      profileId: 'rc',
      candidateCommit: state.candidate.commit,
      expectedTree: state.candidate.tree,
      toolchain: fixtureJson('toolchain.json'),
      environment: {},
      policySchemaVersion: '1.1.0',
    });
    expect({
      ...fixed.taskPolicy,
      schemaVersion: '1.2.0',
      inputProjection: state.certify.plan.taskPolicy.inputProjection,
    }).toEqual(state.certify.plan.taskPolicy);
    const floor = buildExpectedTaskPolicy({
      repo: state.repo,
      descriptor: fixtureJson('test-tasks.json'),
      profileId: 'preflight-floor',
      candidateCommit: state.candidate.commit,
      expectedTree: state.candidate.tree,
      toolchain: fixtureJson('toolchain.json'),
      environment: {},
      policySchemaVersion: '1.1.0',
    });
    expect(state.preflight.taskPolicyDigest).toBe(
      sha256Hex({
        ...floor.taskPolicy,
        schemaVersion: '1.2.0',
        inputProjection: state.certify.plan.taskPolicy.inputProjection,
      }),
    );
    expect(state.preflight.toolchainDigest).toBe(sha256Hex(fixtureJson('toolchain.json')));
    expect(state.preflight.releaseIntentDigest).toBe(sha256Hex(state.intent));
    expect(state.preflight.releaseProfileDigest).toBe(sha256Hex(state.releaseProfile));

    const executionsBeforeExport = state.executions();
    const cacheBefore = readdirSync(resultsOf(state.repo)).sort();
    const run = exportCli(state.root, intentArguments(state));
    expect(run.status, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout) as Json;
    expect(result.ok).toBe(true);
    expect(result.taskPolicyDigest).toBe(state.receipt.taskPolicyDigest);
    expect(result.taskPolicyDigest).toBe(state.certify.plan.taskPolicyDigest);
    expect(result.verifiedNodes).toEqual(['prepare', 'unit']);
    expect(JSON.parse(readFileSync(join(state.outputDir, 'task-policy.json'), 'utf8'))).toEqual(
      state.certify.plan.taskPolicy,
    );
    expect(readdirSync(join(state.outputDir, 'results')).sort()).toEqual(
      (state.receipt.tasks as { resultDigest: string }[])
        .map((task) => `${task.resultDigest}.json`)
        .sort(),
    );
    // No second run: the runner was not invoked, no task wrote its sentinel, the check
    // cache gained no result, and the candidate is still clean.
    expect(state.executions()).toBe(executionsBeforeExport);
    expect(existsSync(join(state.root, SENTINEL))).toBe(false);
    expect(readdirSync(resultsOf(state.repo)).sort()).toEqual(cacheBefore);
    expect(git(state.repo, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('');

    const { loadAndVerify } = (await import(
      pathToFileURL(join(VERIFIER, 'src/verify.js')).href
    )) as {
      loadAndVerify: (options: Json) => { ok: boolean };
    };
    expect(
      loadAndVerify({
        envelopePath: join(state.outputDir, 'envelope.json'),
        resultsDir: join(state.outputDir, 'results'),
        taskPolicyPath: join(state.outputDir, 'task-policy.json'),
        trustStorePath: state.paths.trustStore,
        expectedRepository: 'fixture/repository',
        expectedCommit: state.candidate.commit,
        expectedTree: state.candidate.tree,
        expectedPolicyDigest: state.certify.plan.taskPolicyDigest,
      }).ok,
    ).toBe(true);
  });

  it('IA-002: refuses an intent altered after the run and an intent whose decision is not ready', () => {
    const altered = releaseIntentRun();
    altered.intent.changed_packages = ['@fixture/extra'];
    writeInputs(altered);
    expectRefusal(altered, 'INTENT_DIGEST_MISMATCH');

    const blocked = releaseIntentRun();
    blocked.intent.channel = 'beta';
    writeInputs(blocked, { repin: true });
    expect(expectRefusal(blocked, 'INTENT_DECISION_BLOCKED').message).toMatch(/channel-mismatch/u);
  });

  it('IA-003: refuses a wrong stage and a stale policy', () => {
    const state = releaseIntentRun();
    expectRefusal(state, 'INTENT_STAGE_MISMATCH', { 'release-stage': 'preflight' });
    expectRefusal(state, 'INTENT_STAGE_MISMATCH', { receipt: state.paths.preflightReceipt });

    const stalePolicy = releaseIntentRun();
    stalePolicy.releaseProfile.policy_version = '1.0.1';
    writeInputs(stalePolicy);
    expectRefusal(stalePolicy, 'INTENT_POLICY_STALE');

    const staleReceipt = releaseIntentRun();
    staleReceipt.receipt.taskPolicyDigest = 'f'.repeat(64);
    writeInputs(staleReceipt);
    expectRefusal(staleReceipt, 'POLICY_DIGEST_MISMATCH');
  });

  it('IA-004: refuses a foreign base, a foreign candidate, and an incomplete population', () => {
    const state = releaseIntentRun();
    expectRefusal(state, 'INTENT_BASE_MISMATCH', { base: state.genesis.commit });

    const foreignCandidate = releaseIntentRun();
    foreignCandidate.preflight.repository = { id: 'fixture/repository', ...foreignCandidate.base };
    writeInputs(foreignCandidate);
    expectRefusal(foreignCandidate, 'INTENT_CANDIDATE_MISMATCH');

    const subset = releaseIntentRun();
    subset.receipt.tasks = (subset.receipt.tasks as { nodeId: string }[]).filter(
      (task) => task.nodeId !== 'unit',
    );
    writeInputs(subset);
    expectRefusal(subset, 'INTENT_POPULATION_INCOMPLETE');
  });

  it('IA-005: tells a path from an unknown profile id and keeps the profile path unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-export-profile-'));
    roots.push(root);
    const { repo, candidate } = candidateRepository(root);
    const rc = runChecks(repo, () => undefined, { target: 'rc' });
    expect(rc.receipt?.value.profile).toBe('rc');
    const receiptPath = join(root, 'candidate-receipt.json');
    put(receiptPath, `${JSON.stringify(rc.receipt?.value)}\n`);
    const resultsDir = join(root, 'runner-results');
    cpSync(resultsOf(repo), resultsDir, { recursive: true });
    cpSync(join(FIXTURE, 'toolchain.json'), join(root, 'toolchain.json'));
    cpSync(join(FIXTURE, 'environment.json'), join(root, 'environment.json'));
    const keys = keyMaterial(root);
    const outputDir = join(root, 'exported');
    const profileArguments = (profile: string) => [
      '--repo',
      repo,
      '--receipt',
      receiptPath,
      '--results-dir',
      resultsDir,
      '--profile',
      profile,
      '--commit',
      candidate.commit,
      '--tree',
      candidate.tree,
      '--toolchain',
      join(root, 'toolchain.json'),
      '--environment',
      join(root, 'environment.json'),
      '--private-key',
      keys.privateKey,
      '--public-key',
      keys.publicKey,
      '--signer-id',
      SIGNER,
      '--output-dir',
      outputDir,
    ];
    const refused = (profile: string) => {
      const run = exportCli(root, profileArguments(profile));
      expect(run.status, run.stderr).toBe(2);
      expect(run.stdout).toBe('');
      expectNothingExported({ root, outputDir });
      return (JSON.parse(run.stderr) as { code: string }).code;
    };
    expect(refused(join(FIXTURE, 'test-tasks.json'))).toBe('PROFILE_ID_INVALID');
    expect(refused('profiles/rc')).toBe('PROFILE_ID_INVALID');
    expect(refused('toolchain.json')).toBe('PROFILE_ID_INVALID');
    expect(refused('not-declared')).toBe('PROFILE_UNKNOWN');

    // Mixing the two paths is a usage error decided before any input is read.
    const mixed = exportCli(root, [
      ...profileArguments('rc'),
      '--release-intent',
      join(root, 'release-intent.json'),
    ]);
    expect(mixed.status).toBe(64);
    expect((JSON.parse(mixed.stderr) as { code: string }).code).toBe('USAGE');
    expectNothingExported({ root, outputDir });

    const exported = exportCli(root, profileArguments('rc'));
    expect(exported.status, exported.stderr).toBe(0);
    const result = JSON.parse(exported.stdout) as Json;
    expect(result.profile).toBe('rc');
    expect(result.taskPolicyDigest).toBe(rc.plan.taskPolicyDigest);
    expect(JSON.parse(readFileSync(join(outputDir, 'task-policy.json'), 'utf8'))).toEqual(
      rc.plan.taskPolicy,
    );
  });

  it('refuses an incomplete intent path selection as usage', () => {
    const state = releaseIntentRun();
    for (const omitted of [
      'release-intent',
      'release-profile',
      'release-stage',
      'preflight-receipt',
    ]) {
      expectRefusal(state, 'USAGE', { [omitted]: undefined });
    }
  });
});
