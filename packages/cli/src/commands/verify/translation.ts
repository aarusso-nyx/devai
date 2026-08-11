import { createHash } from 'node:crypto';
import { platform } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { CAC } from 'cac';
import {
  appendVerbEvidence,
  buildExpectedDiffManifest,
  classifyTranslationPath,
  dropValidationDatabase,
  evaluateTranslationFrames,
  provisionValidationDatabase,
  recoverValidationLeases,
  resolveRecipeRecordPath,
  runLinuxIsolated,
} from '#runtime-core';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  spawnSync,
  writeFileSync,
} from '@devai-nyx/authority';
import { validators } from '@devai-nyx/schemas';
import { senseTestWeakening } from '@devai-nyx/sensors';
import { EXIT_FAIL, EXIT_PASS } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';

export interface TranslationValidationOptions {
  readonly witness: string;
  readonly repoRoot?: string;
  readonly databaseUrl?: string;
  readonly human?: boolean;
}

interface TestRef {
  readonly suite: string;
  readonly path: string;
  readonly names: readonly string[];
}

interface TranslationWitness {
  readonly id: string;
  readonly task_id: string;
  readonly recipe_name: string;
  readonly recipe_variant: string;
  readonly base_sha: string;
  readonly candidate_sha: string;
  readonly test_overlay_sha?: string;
  readonly strategy:
    'regression' | 'feature-overlay' | 'behavioral-equivalence' | 'structural' | 'semantic-review';
  readonly touched: readonly string[];
  readonly implements: readonly {
    readonly invariant_id: string;
    readonly criteria: readonly {
      readonly demonstrated_by: readonly (
        | { readonly kind: 'test'; readonly test_ref: TestRef }
        | { readonly kind: 'structural'; readonly validator: string }
        | {
            readonly kind: 'behavioral-equivalence';
            readonly baseline_ref: string;
            readonly candidate_ref: string;
          }
        | { readonly kind: 'semantic-review'; readonly rubric_ref: string }
      )[];
    }[];
  }[];
  readonly red_green?: readonly {
    readonly test_ref: TestRef;
  }[];
  readonly frame: {
    readonly authority_role: 'owner' | 'architect' | 'inspector' | 'engineer';
    readonly inventory_delta_confined_to: readonly string[];
    readonly effects_claimed: readonly string[];
  };
}

interface TaskRecord {
  readonly id: string;
  readonly discipline: string;
  readonly target_modules: readonly string[];
  readonly intent_diff?: { readonly planned_files?: readonly string[] };
}

interface TraceTest {
  readonly suite: string;
  readonly path: string;
  readonly names?: readonly string[];
}

interface TraceRecord {
  readonly invariants: readonly {
    readonly id: string;
    readonly tests: readonly TraceTest[];
  }[];
}

interface InvariantRecord {
  readonly id: string;
  readonly lifecycle?: string;
  readonly status: string;
  readonly verification: {
    readonly strategy?: {
      readonly primary?: TranslationWitness['strategy'];
    };
  };
}

interface Execution {
  readonly test_ref: string;
  readonly outcome: 'pass' | 'fail' | 'crash';
  readonly failure_mode:
    'none' | 'assertion' | 'missing-file' | 'load-error' | 'timeout' | 'signal' | 'infrastructure';
}

interface ProcessResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
  readonly isolation_applied?: boolean;
}

interface StateChange {
  readonly path: string;
  readonly operation: 'create' | 'append' | 'retire';
}

const LINUX_IMAGE =
  'node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd';
const EXECUTION_TIMEOUT_MS = 120_000;

function json(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function canonicalRef(ref: TestRef): string {
  return `${ref.suite}:${ref.path}:${ref.names.join(' > ')}`;
}

function sameNames(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every((name, index) => name === right[index])
  );
}

function safeRepoPath(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !path.split('/').some((part) => part === '' || part === '.' || part === '..')
  );
}

function isTestPath(path: string): boolean {
  return classifyTranslationPath('inspector', path).effect === 'fs:tests';
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function fileDigest(path: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return `symlink:${readlinkSync(path)}`;
  if (!stat.isFile()) return `other:${String(stat.mode)}`;
  return `file:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

function git(repoRoot: string, args: readonly string[]): ProcessResult {
  const result = spawnSync('git', [...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: EXECUTION_TIMEOUT_MS,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

function requireGit(repoRoot: string, args: readonly string[], code: string): string {
  const result = git(repoRoot, args);
  if (result.status !== 0) {
    throw new Error(`${code}: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

function gitBlob(repoRoot: string, commit: string, path: string, code: string): Buffer {
  const result = spawnSync('git', ['cat-file', 'blob', `${commit}:${path}`], {
    cwd: repoRoot,
    timeout: EXECUTION_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    throw new Error(`${code}: ${String(result.stderr ?? '').trim()}`);
  }
  return Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.from(result.stdout === null ? '' : String(result.stdout));
}

function jsonAtCommit(repoRoot: string, commit: string, path: string, code: string): unknown {
  try {
    return JSON.parse(gitBlob(repoRoot, commit, path, code).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${code}:`)) throw error;
    throw new Error(`${code}: invalid JSON`);
  }
}

function snapshotValidationState(repoRoot: string): ReadonlyMap<string, string> {
  const snapshot = new Map<string, string>();
  const stateRoot = resolve(repoRoot, '.devai/state');
  const walk = (absoluteDirectory: string, relativeDirectory: string): void => {
    if (!existsSync(absoluteDirectory)) return;
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const relativePath =
        relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
      const absolutePath = resolve(absoluteDirectory, entry.name);
      if (entry.isDirectory()) walk(absolutePath, relativePath);
      else snapshot.set(`.devai/state/${relativePath}`, fileDigest(absolutePath));
    }
  };
  walk(stateRoot, '');

  const tracked = requireGit(
    repoRoot,
    ['ls-files', '-z'],
    'VALIDATION_TRACKED_STATE_SNAPSHOT_FAILED',
  )
    .split('\0')
    .filter((path) => path.length > 0);
  for (const path of tracked) {
    if (!safeRepoPath(path) || snapshot.has(path)) continue;
    const absolutePath = resolve(repoRoot, path);
    snapshot.set(path, existsSync(absolutePath) ? fileDigest(absolutePath) : 'absent');
  }
  return snapshot;
}

function stateChanges(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): readonly StateChange[] {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes: StateChange[] = [];
  for (const path of paths) {
    const oldDigest = before.get(path);
    const newDigest = after.get(path);
    if (oldDigest === newDigest) continue;
    if (oldDigest === undefined || oldDigest === 'absent')
      changes.push({ path, operation: 'create' });
    else if (newDigest === undefined || newDigest === 'absent')
      changes.push({ path, operation: 'retire' });
    else changes.push({ path, operation: 'append' });
  }
  return changes;
}

function uniqueStateChanges(changes: readonly StateChange[]): readonly StateChange[] {
  const byKey = new Map<string, StateChange>();
  for (const change of changes) byKey.set(`${change.operation}:${change.path}`, change);
  return [...byKey.values()].sort((left, right) => {
    const a = `${left.path}:${left.operation}`;
    const b = `${right.path}:${right.operation}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function testArgv(repoRoot: string, ref: TestRef): readonly string[] {
  if (!safeRepoPath(ref.path) || ref.names.length === 0) {
    throw new Error('TEST_REF_INVALID');
  }
  const pattern = ref.names.at(-1);
  if (pattern === undefined || pattern.length === 0) throw new Error('TEST_REF_INVALID');
  const extension = extname(ref.path);
  if (['.js', '.mjs', '.cjs'].includes(extension)) {
    return ['node', '--test', '--test-name-pattern', pattern, ref.path];
  }
  if (['.ts', '.tsx', '.mts', '.cts'].includes(extension)) {
    const vitest = join(repoRoot, 'node_modules/vitest/vitest.mjs');
    if (!existsSync(vitest)) throw new Error('REGISTERED_TEST_RUNNER_MISSING');
    return ['node', 'node_modules/vitest/vitest.mjs', 'run', ref.path, '-t', pattern];
  }
  throw new Error('REGISTERED_TEST_RUNNER_UNSUPPORTED');
}

function classify(result: ProcessResult): Execution['failure_mode'] {
  if (result.status === 0) return 'none';
  const output = `${result.stdout}\n${result.stderr}\n${result.error?.message ?? ''}`;
  if (result.error !== undefined && 'code' in result.error && result.error.code === 'ETIMEDOUT') {
    return 'timeout';
  }
  if (result.signal !== null) return 'signal';
  if (/ENOENT|Cannot find module|Could not find|no such file/i.test(output)) return 'missing-file';
  if (/SyntaxError|ERR_MODULE_NOT_FOUND|failed to load/i.test(output)) return 'load-error';
  if (/AssertionError|ERR_ASSERTION|Assertion failed/i.test(output)) return 'assertion';
  return 'infrastructure';
}

function executionFrom(ref: TestRef, result: ProcessResult): Execution {
  const failureMode = classify(result);
  return {
    test_ref: canonicalRef(ref),
    outcome: result.status === 0 ? 'pass' : failureMode === 'assertion' ? 'fail' : 'crash',
    failure_mode: failureMode,
  };
}

function runMacOs(worktree: string, argv: readonly string[]): ProcessResult {
  const escapedWorktree = worktree.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const result = spawnSync(
    'sandbox-exec',
    [
      '-p',
      `(version 1)(deny network*)(deny file-write* (subpath "${escapedWorktree}"))(allow default)`,
      ...argv,
    ],
    {
      cwd: worktree,
      encoding: 'utf8',
      timeout: EXECUTION_TIMEOUT_MS,
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        HOME: process.env['HOME'] ?? '/tmp',
        TMPDIR: process.env['TMPDIR'] ?? '/tmp',
        DEVAI_VALIDATION_ISOLATED: '1',
      },
    },
  );
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

async function runIsolated(
  repoRoot: string,
  worktree: string,
  argv: readonly string[],
): Promise<ProcessResult> {
  if (platform() === 'linux') {
    const result = await runLinuxIsolated({
      repo_root: worktree,
      dependencies_root: repoRoot,
      image: LINUX_IMAGE,
      argv,
      timeout_ms: EXECUTION_TIMEOUT_MS,
      prepare_dependency_mount_point: (path) => mkdirSync(path, { recursive: true }),
      remove_dependency_mount_point: (path) => rmSync(path, { recursive: true, force: true }),
      spawn: (command, args, options) =>
        spawnSync(command, [...args], options) as ReturnType<typeof spawnSync>,
    });
    return {
      status: result.exit_code,
      signal: null,
      stdout: result.stdout,
      stderr: result.stderr,
      isolation_applied: result.isolation_applied,
    };
  }
  if (platform() !== 'darwin') {
    return {
      status: 1,
      signal: null,
      stdout: '',
      stderr: `unsupported validation platform: ${platform()}`,
    };
  }
  return runMacOs(worktree, argv);
}

function inferEffects(
  paths: readonly string[],
  role: TranslationWitness['frame']['authority_role'],
): readonly string[] {
  return [...new Set(paths.map((path) => classifyTranslationPath(role, path).effect))].sort();
}

function registeredTraceRef(
  trace: TraceRecord,
  implemented: ReadonlySet<string>,
  ref: TestRef,
): boolean {
  return trace.invariants.some(
    (invariant) =>
      implemented.has(invariant.id) &&
      invariant.tests.some(
        (test) =>
          test.suite === ref.suite && test.path === ref.path && sameNames(test.names, ref.names),
      ),
  );
}

function resolveStrategyCoverage(input: {
  readonly repoRoot: string;
  readonly candidateSha: string;
  readonly witness: TranslationWitness;
  readonly trace: TraceRecord;
  readonly refs: readonly TestRef[];
}): { readonly status: 'pass' | 'fail'; readonly finding?: string } {
  if (input.witness.implements.length === 0) {
    return { status: 'fail', finding: 'STRATEGY_POPULATION_ZERO' };
  }
  const expectedKind =
    input.witness.strategy === 'regression' || input.witness.strategy === 'feature-overlay'
      ? 'test'
      : input.witness.strategy;
  const implemented = new Set(input.witness.implements.map((entry) => entry.invariant_id));
  const citedRefs = new Set(input.refs.map(canonicalRef));
  for (const implementation of input.witness.implements) {
    let rawInvariant: unknown;
    try {
      rawInvariant = jsonAtCommit(
        input.repoRoot,
        input.candidateSha,
        `law/invariants/${implementation.invariant_id}.json`,
        'STRATEGY_INVARIANT_MISSING',
      );
    } catch {
      return {
        status: 'fail',
        finding: `${implementation.invariant_id}: STRATEGY_INVARIANT_MISSING`,
      };
    }
    if (!validators.invariant(rawInvariant)) {
      return {
        status: 'fail',
        finding: `${implementation.invariant_id}: STRATEGY_INVARIANT_INVALID`,
      };
    }
    const invariant = rawInvariant as InvariantRecord;
    if (
      invariant.id !== implementation.invariant_id ||
      (invariant.lifecycle !== undefined && invariant.lifecycle !== 'supported') ||
      invariant.status !== 'active'
    ) {
      return {
        status: 'fail',
        finding: `${implementation.invariant_id}: STRATEGY_INVARIANT_INELIGIBLE`,
      };
    }
    if (invariant.verification.strategy?.primary !== input.witness.strategy) {
      return {
        status: 'fail',
        finding: `${implementation.invariant_id}: STRATEGY_PRIMARY_MISMATCH`,
      };
    }
    for (const criterion of implementation.criteria) {
      const demonstrations = criterion.demonstrated_by.filter(
        (demonstration) => demonstration.kind === expectedKind,
      );
      if (demonstrations.length === 0) {
        return {
          status: 'fail',
          finding: `${implementation.invariant_id}: STRATEGY_DEMONSTRATION_MISSING`,
        };
      }
      if (expectedKind === 'test') {
        for (const demonstration of demonstrations) {
          if (demonstration.kind !== 'test') continue;
          if (
            !citedRefs.has(canonicalRef(demonstration.test_ref)) ||
            !registeredTraceRef(input.trace, implemented, demonstration.test_ref)
          ) {
            return {
              status: 'fail',
              finding: `${implementation.invariant_id}: STRATEGY_TEST_UNREGISTERED`,
            };
          }
        }
      }
    }
  }
  return { status: 'pass' };
}

function removeWorktree(repoRoot: string, relativePath: string): void {
  if (!/^\.devai\/worktrees\/WT-TV-[a-f0-9]{16}$/u.test(relativePath)) {
    throw new Error('VALIDATION_WORKTREE_PATH_INVALID');
  }
  const absolute = resolve(repoRoot, relativePath);
  if (existsSync(absolute)) {
    const removed = git(repoRoot, ['worktree', 'remove', '--force', absolute]);
    if (removed.status !== 0) {
      throw new Error(`VALIDATION_WORKTREE_REMOVE_FAILED: ${removed.stderr.trim()}`);
    }
  }
  requireGit(repoRoot, ['worktree', 'prune'], 'VALIDATION_WORKTREE_PRUNE_FAILED');
  if (existsSync(absolute)) throw new Error('VALIDATION_WORKTREE_ORPHAN');
}

function readLeases(
  repoRoot: string,
): readonly { readonly path: string; readonly value: unknown }[] {
  const directory = resolve(repoRoot, '.devai/state/translation-validation/leases');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({
      path: resolve(directory, name),
      value: (() => {
        try {
          return json(resolve(directory, name));
        } catch {
          return { invalid_lease_file: name };
        }
      })(),
    }));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function executeTranslationValidation(
  options: TranslationValidationOptions,
): Promise<Record<string, unknown>> {
  const startedAt = new Date().toISOString();
  const repoRoot = resolve(options.repoRoot ?? '.');
  if (options.databaseUrl === undefined || options.databaseUrl.length === 0) {
    throw new Error('DATABASE_URL_REQUIRED');
  }
  const witnessPath = resolve(repoRoot, options.witness);
  const witnessRelative = relative(repoRoot, witnessPath);
  if (witnessRelative.startsWith('..') || isAbsolute(witnessRelative)) {
    throw new Error('WITNESS_PATH_OUTSIDE_REPOSITORY');
  }
  const rawWitness = json(witnessPath);
  if (!validators.translationWitness(rawWitness)) {
    throw new Error(
      `TRANSLATION_WITNESS_INVALID: ${JSON.stringify(validators.translationWitness.errors ?? [])}`,
    );
  }
  const witness = rawWitness as TranslationWitness;
  const taskPath = resolve(repoRoot, `.devai/state/tasks/${witness.task_id}.json`);
  const rawTask = json(taskPath);
  if (!validators.task(rawTask)) throw new Error('TRANSLATION_TASK_INVALID');
  const task = rawTask as TaskRecord;
  if (task.id !== witness.task_id || task.discipline !== witness.frame.authority_role) {
    throw new Error('TRANSLATION_TASK_AUTHORITY_MISMATCH');
  }
  const taskScope = task.intent_diff?.planned_files ?? [];
  if (taskScope.length === 0) throw new Error('TRANSLATION_TASK_SCOPE_MISSING');

  const rawTrace = jsonAtCommit(
    repoRoot,
    witness.candidate_sha,
    'law/trace.json',
    'TRANSLATION_TRACE_OBJECT_INVALID',
  );
  if (!validators.trace(rawTrace)) throw new Error('TRANSLATION_TRACE_INVALID');
  const trace = rawTrace as TraceRecord;
  const refs = witness.red_green?.map((entry) => entry.test_ref) ?? [];
  const testBacked = witness.strategy === 'regression' || witness.strategy === 'feature-overlay';
  if (testBacked && refs.length === 0) throw new Error('TRANSLATION_TEST_REFS_MISSING');
  if (!testBacked && refs.length > 0) throw new Error('TRANSLATION_TEST_REFS_UNEXPECTED');
  const implemented = new Set(witness.implements.map((entry) => entry.invariant_id));
  for (const ref of refs) {
    const registered = registeredTraceRef(trace, implemented, ref);
    if (!registered) throw new Error(`TRANSLATION_TEST_REF_UNREGISTERED: ${canonicalRef(ref)}`);
  }
  const strategyCoverage = resolveStrategyCoverage({
    repoRoot,
    candidateSha: witness.candidate_sha,
    witness,
    trace,
    refs,
  });
  const recipeRecordPath = resolveRecipeRecordPath({
    repo_root: repoRoot,
    recipe_name: witness.recipe_name,
    recipe_variant: witness.recipe_variant,
    witness_id: witness.id,
  });
  const recipeRecord = json(resolve(repoRoot, recipeRecordPath)) as {
    readonly evidence?: { readonly translation_witness?: unknown };
  };
  if (!isDeepStrictEqual(recipeRecord.evidence?.translation_witness, rawWitness)) {
    throw new Error('TRANSLATION_RECIPE_RECORD_WITNESS_MISMATCH');
  }
  requireGit(repoRoot, ['cat-file', '-e', `${witness.base_sha}^{commit}`], 'BASE_OBJECT_INVALID');
  requireGit(
    repoRoot,
    ['cat-file', '-e', `${witness.candidate_sha}^{commit}`],
    'CANDIDATE_OBJECT_INVALID',
  );
  if (witness.strategy === 'feature-overlay') {
    if (witness.test_overlay_sha === undefined) throw new Error('TEST_OVERLAY_OBJECT_MISSING');
    requireGit(
      repoRoot,
      ['cat-file', '-e', `${witness.test_overlay_sha}^{commit}`],
      'TEST_OVERLAY_OBJECT_INVALID',
    );
    const parents = requireGit(
      repoRoot,
      ['rev-list', '--parents', '-n', '1', witness.test_overlay_sha],
      'TEST_OVERLAY_PARENT_INVALID',
    )
      .split(' ')
      .filter((parent) => parent.length > 0)
      .slice(1);
    if (parents.length !== 1 || parents[0] !== witness.base_sha) {
      throw new Error('TEST_OVERLAY_PARENT_MISMATCH');
    }
    const ancestry = git(repoRoot, [
      'merge-base',
      '--is-ancestor',
      witness.test_overlay_sha,
      witness.candidate_sha,
    ]);
    if (ancestry.status !== 0) throw new Error('CANDIDATE_NOT_DESCENDANT_OF_TEST_OVERLAY');
  } else {
    const ancestry = git(repoRoot, [
      'merge-base',
      '--is-ancestor',
      witness.base_sha,
      witness.candidate_sha,
    ]);
    if (ancestry.status !== 0) throw new Error('CANDIDATE_NOT_DESCENDANT_OF_BASE');
  }
  const diffBase =
    witness.strategy === 'feature-overlay'
      ? (witness.test_overlay_sha as string)
      : witness.base_sha;
  const diffPaths = requireGit(
    repoRoot,
    ['diff', '--name-only', diffBase, witness.candidate_sha, '--'],
    'VALIDATION_DIFF_FAILED',
  )
    .split('\n')
    .filter((path) => path.length > 0);
  let overlayPaths: readonly string[] = [];
  if (witness.strategy === 'feature-overlay') {
    const overlaySha = witness.test_overlay_sha as string;
    overlayPaths = requireGit(
      repoRoot,
      ['diff', '--name-only', witness.base_sha, overlaySha, '--'],
      'TEST_OVERLAY_DIFF_FAILED',
    )
      .split('\n')
      .filter((path) => path.length > 0);
    const citedPaths = new Set(refs.map((ref) => ref.path));
    const registeredPaths = new Set(
      trace.invariants
        .filter((invariant) => implemented.has(invariant.id))
        .flatMap((invariant) => invariant.tests.map((test) => test.path)),
    );
    if (
      overlayPaths.length === 0 ||
      overlayPaths.some((path) => !isTestPath(path) || !registeredPaths.has(path)) ||
      [...citedPaths].some((path) => !overlayPaths.includes(path))
    ) {
      throw new Error('TEST_OVERLAY_SCOPE_INVALID');
    }
    const deleted = requireGit(
      repoRoot,
      ['diff', '--name-only', '--diff-filter=D', witness.base_sha, overlaySha, '--'],
      'TEST_OVERLAY_DELETE_CHECK_FAILED',
    );
    if (deleted.length > 0) throw new Error('TEST_OVERLAY_DELETES_TEST');
    const rawDiff = requireGit(
      repoRoot,
      ['diff', '--raw', '--no-abbrev', witness.base_sha, overlaySha, '--'],
      'TEST_OVERLAY_MODE_CHECK_FAILED',
    );
    for (const line of rawDiff.split('\n').filter((entry) => entry.length > 0)) {
      const modes = /^:\d{6} (\d{6}) [a-f0-9]{40} [a-f0-9]{40} [A-Z]\t/u.exec(line);
      if (modes === null || !['100644', '100755'].includes(modes[1] ?? '')) {
        throw new Error('TEST_OVERLAY_FILE_MODE_INVALID');
      }
    }
  }
  const stateBefore = snapshotValidationState(repoRoot);

  const suffix = sha256({ witness: witness.id, started_at: startedAt, pid: process.pid }).slice(
    0,
    16,
  );
  const validationId = `VR-${suffix}`;
  const leaseId = `TVL-${suffix}`;
  const worktreeRelative = `.devai/worktrees/WT-TV-${suffix}`;
  const worktree = resolve(repoRoot, worktreeRelative);
  const database = `devai_task_TV_${suffix}`;
  const leasePath = resolve(repoRoot, `.devai/state/translation-validation/leases/${leaseId}.json`);
  const priorLeases = readLeases(repoRoot);
  const recovery = await recoverValidationLeases({
    leases: priorLeases.map((entry) => entry.value),
    host: {
      remove_worktree: async (path) => removeWorktree(repoRoot, path),
      drop_database: async (name) => {
        const dropped = await dropValidationDatabase({
          database_url: options.databaseUrl as string,
          database: name,
        });
        if (!dropped.ok) throw new Error(dropped.error ?? 'VALIDATION_DATABASE_DROP_FAILED');
      },
    },
  });
  if (recovery.status !== 'pass') {
    throw new Error(`VALIDATION_RECOVERY_FAILED: ${recovery.findings.join('; ')}`);
  }
  for (const entry of priorLeases) rmSync(entry.path, { force: true });

  writeJson(leasePath, {
    schemaVersion: '1.0.0',
    id: leaseId,
    task_id: witness.task_id,
    worktree_id: `WT-TV-${suffix}`,
    worktree_path: worktreeRelative,
    database,
    base_sha: witness.base_sha,
    created_at: startedAt,
  });
  const lifecycleEvents: StateChange[] = [
    { path: relative(repoRoot, leasePath), operation: 'create' },
    { path: recipeRecordPath, operation: 'append' },
  ];

  let databaseCreated = false;
  let worktreeCreated = false;
  let worktreeWasCreated = false;
  let databaseRemoved = false;
  let worktreeRemoved = false;
  let infrastructureFinding: string | undefined;
  let isolationAttempts = 0;
  let isolationProofs = 0;
  let weakeningClean = !testBacked;
  const baseExecutions: Execution[] = [];
  const candidateExecutions: Execution[] = [];
  try {
    const provisioned = await provisionValidationDatabase({
      database_url: options.databaseUrl,
      validation_id: validationId,
    });
    if (!provisioned.ok || provisioned.database !== database) {
      infrastructureFinding = provisioned.error ?? 'VALIDATION_DATABASE_PROVISION_FAILED';
    } else {
      databaseCreated = true;
      mkdirSync(dirname(worktree), { recursive: true });

      const phases = testBacked
        ? [
            {
              sha: witness.base_sha,
              output: baseExecutions,
              overlay:
                witness.strategy === 'feature-overlay'
                  ? (witness.test_overlay_sha as string)
                  : undefined,
            },
            {
              sha: witness.candidate_sha,
              output: candidateExecutions,
              overlay: undefined,
            },
          ]
        : [];
      for (const phase of phases) {
        const added = git(repoRoot, ['worktree', 'add', '--detach', worktree, phase.sha]);
        if (added.status !== 0) {
          throw new Error(`VALIDATION_WORKTREE_ADD_FAILED: ${added.stderr.trim()}`);
        }
        worktreeCreated = true;
        worktreeWasCreated = true;
        try {
          if (phase.overlay !== undefined) {
            for (const path of overlayPaths) {
              if (!safeRepoPath(path)) throw new Error('TEST_OVERLAY_PATH_INVALID');
              const target = resolve(worktree, path);
              mkdirSync(dirname(target), { recursive: true });
              writeFileSync(
                target,
                gitBlob(repoRoot, phase.overlay, path, 'TEST_OVERLAY_BLOB_READ_FAILED'),
              );
            }
          }
          for (const ref of refs) {
            const argv = testArgv(repoRoot, ref);
            isolationAttempts += 1;
            const result = await runIsolated(repoRoot, worktree, argv);
            if (result.isolation_applied === true) isolationProofs += 1;
            if (
              platform() === 'linux' &&
              result.isolation_applied !== true &&
              infrastructureFinding === undefined
            ) {
              infrastructureFinding = 'LINUX_ISOLATION_NOT_APPLIED';
            }
            phase.output.push(executionFrom(ref, result));
          }
          if (phase.sha === witness.candidate_sha) {
            const changedTestPaths = diffPaths.filter(isTestPath);
            weakeningClean =
              changedTestPaths.length === 0 ||
              senseTestWeakening({
                cwd: worktree,
                baseRef: witness.base_sha,
                files: changedTestPaths,
              }).status === 'pass';
          }
        } finally {
          removeWorktree(repoRoot, worktreeRelative);
          worktreeCreated = false;
        }
      }
    }
  } catch (error) {
    infrastructureFinding = error instanceof Error ? error.message : String(error);
  } finally {
    if (worktreeCreated || existsSync(worktree)) {
      try {
        removeWorktree(repoRoot, worktreeRelative);
        worktreeRemoved = true;
      } catch {
        worktreeRemoved = false;
      }
    } else {
      worktreeRemoved = true;
    }
    if (databaseCreated) {
      const dropped = await dropValidationDatabase({
        database_url: options.databaseUrl,
        database,
      });
      databaseRemoved = dropped.ok;
    }
  }
  const worktreeCleanup = worktreeRemoved && !existsSync(worktree);
  const databaseCleanup = databaseCreated ? databaseRemoved : true;

  const registeredRefs = refs.map(canonicalRef);
  const infrastructureExecutions = [...baseExecutions, ...candidateExecutions].filter(
    (execution) => execution.failure_mode === 'infrastructure',
  );
  const effectiveInfrastructureFinding =
    infrastructureFinding ??
    (infrastructureExecutions.length === 0
      ? undefined
      : `REGISTERED_EXECUTION_INFRASTRUCTURE_FAILURE:${infrastructureExecutions.map((execution) => execution.test_ref).join(',')}`);
  const networkDenialProven =
    platform() === 'linux' && isolationProofs > 0 && effectiveInfrastructureFinding === undefined;
  const expected = uniqueStateChanges([
    ...buildExpectedDiffManifest({
      validation_id: validationId,
      witness_id: witness.id,
      lease_id: leaseId,
      recipe_name: witness.recipe_name,
      recipe_variant: witness.recipe_variant,
      recipe_record_path: recipeRecordPath,
    }),
    ...recovery.recovered.map((recoveredLeaseId) => ({
      path: `.devai/state/translation-validation/leases/${recoveredLeaseId}.json`,
      operation: 'retire' as const,
    })),
  ]);
  if (worktreeCleanup && databaseCleanup) {
    rmSync(leasePath, { force: true });
    if (!existsSync(leasePath)) {
      lifecycleEvents.push({ path: relative(repoRoot, leasePath), operation: 'retire' });
    }
  }
  writeJson(
    resolve(repoRoot, `.devai/state/translation-validation/witnesses/${witness.id}.json`),
    rawWitness,
  );
  const witnessStatePath = `.devai/state/translation-validation/witnesses/${witness.id}.json`;
  if (existsSync(resolve(repoRoot, witnessStatePath))) {
    lifecycleEvents.push({ path: witnessStatePath, operation: 'create' });
  }
  const snapshotObserved = stateChanges(stateBefore, snapshotValidationState(repoRoot));
  const resultStatePath = `.devai/state/translation-validation/results/${validationId}.json`;
  const provisionalObserved = uniqueStateChanges([
    ...snapshotObserved,
    ...lifecycleEvents,
    { path: resultStatePath, operation: 'create' },
    { path: 'record/proofs/chain.json', operation: 'append' },
  ]);
  const preliminaryFrames = evaluateTranslationFrames({
    witness: {
      strategy: witness.strategy,
      touched: witness.touched,
      frame: witness.frame,
      red_green: refs.map((ref) => ({ test_ref: canonicalRef(ref) })),
    },
    registered_test_refs: registeredRefs,
    task_scope: taskScope,
    diff_paths: diffPaths,
    base_executions: baseExecutions,
    candidate_executions: candidateExecutions,
    weakening_clean: weakeningClean,
    inventory_delta_modules: diffPaths.length > 0 ? task.target_modules : [],
    inferred_effects: inferEffects(diffPaths, witness.frame.authority_role),
    expected_state_changes: expected,
    observed_state_changes: provisionalObserved,
    strategy_coverage: strategyCoverage,
  });
  const extraFrames = [
    effectiveInfrastructureFinding === undefined
      ? { name: 'infrastructure', status: 'PASS' as const, evidence_refs: [] }
      : {
          name: 'infrastructure',
          status: 'FAIL' as const,
          evidence_refs: [],
          finding: `Validation infrastructure failed: ${effectiveInfrastructureFinding}`,
        },
    networkDenialProven
      ? { name: 'network-egress', status: 'PASS' as const, evidence_refs: [] }
      : {
          name: 'network-egress',
          status: 'REVIEW' as const,
          evidence_refs: [],
          finding:
            platform() !== 'linux'
              ? 'Native isolation is best-effort; network denial is not proven.'
              : isolationAttempts === 0
                ? 'Registered execution did not reach the Linux isolation boundary.'
                : 'Linux isolation proof is unavailable because validation infrastructure failed.',
        },
    worktreeCleanup && databaseCleanup
      ? { name: 'cleanup', status: 'PASS' as const, evidence_refs: [] }
      : {
          name: 'cleanup',
          status: 'FAIL' as const,
          evidence_refs: [],
          finding: 'Exact worktree or database cleanup could not be verified.',
        },
  ];
  const preliminaryFrameSet = [...preliminaryFrames.frames, ...extraFrames];
  const preliminaryVerdict = preliminaryFrameSet.some((frame) => frame.status === 'FAIL')
    ? 'FAIL'
    : preliminaryFrameSet.some((frame) => frame.status === 'REVIEW')
      ? 'REVIEW'
      : 'PASS';
  const evidence = appendVerbEvidence({
    repoRoot,
    action: 'verify.translation',
    status: preliminaryVerdict === 'FAIL' ? 'failed' : 'completed',
    artifacts: [
      {
        path: `.devai/state/translation-validation/results/${validationId}.json`,
        sha256: null,
        kind: 'validation-result',
      },
    ],
    notes: [
      `witness=${witness.id}`,
      `verdict=${preliminaryVerdict}`,
      'report_only=true',
      'readiness_eligible=false',
    ],
  });
  if (!evidence.ok || evidence.id === undefined) {
    throw new Error(evidence.error ?? 'VALIDATION_EVIDENCE_APPEND_FAILED');
  }
  const evidenceRef = evidence.id;
  const observed = uniqueStateChanges([
    ...stateChanges(stateBefore, snapshotValidationState(repoRoot)),
    ...lifecycleEvents,
    { path: resultStatePath, operation: 'create' },
  ]);
  const frameEvaluation = evaluateTranslationFrames({
    witness: {
      strategy: witness.strategy,
      touched: witness.touched,
      frame: witness.frame,
      red_green: refs.map((ref) => ({ test_ref: canonicalRef(ref) })),
    },
    registered_test_refs: registeredRefs,
    task_scope: taskScope,
    diff_paths: diffPaths,
    base_executions: baseExecutions,
    candidate_executions: candidateExecutions,
    weakening_clean: weakeningClean,
    inventory_delta_modules: diffPaths.length > 0 ? task.target_modules : [],
    inferred_effects: inferEffects(diffPaths, witness.frame.authority_role),
    expected_state_changes: expected,
    observed_state_changes: observed,
    strategy_coverage: strategyCoverage,
  });
  const frames = [...frameEvaluation.frames, ...extraFrames];
  const verdict = frames.some((frame) => frame.status === 'FAIL')
    ? 'FAIL'
    : frames.some((frame) => frame.status === 'REVIEW')
      ? 'REVIEW'
      : 'PASS';
  const expectedKeys = new Set(expected.map((change) => `${change.operation}:${change.path}`));
  const unexpected = observed.filter(
    (change) => !expectedKeys.has(`${change.operation}:${change.path}`),
  );
  const withEvidence = frames.map((frame) => ({ ...frame, evidence_refs: [evidenceRef] }));
  const manifestDigest = sha256(expected);
  const completedAt = new Date().toISOString();
  const result: Record<string, unknown> = {
    schemaVersion: '1.0.0',
    id: validationId,
    witness_id: witness.id,
    task_id: witness.task_id,
    recipe_name: witness.recipe_name,
    recipe_variant: witness.recipe_variant,
    base_sha: witness.base_sha,
    candidate_sha: witness.candidate_sha,
    ...(witness.test_overlay_sha === undefined
      ? {}
      : { test_overlay_sha: witness.test_overlay_sha }),
    strategy: witness.strategy,
    environment_digest_sha256: sha256({
      platform: platform(),
      node: process.version,
      image: platform() === 'linux' ? LINUX_IMAGE : null,
      refs: registeredRefs,
    }),
    started_at: startedAt,
    completed_at: completedAt,
    isolation: {
      mode: platform() === 'linux' ? 'linux-container-no-network' : 'macos-best-effort',
      network_egress: networkDenialProven ? 'denied' : 'not-proven',
      database: 'per-task-database',
      readiness_eligible: networkDenialProven,
    },
    executions: [
      ...baseExecutions.map((execution) => ({
        phase: witness.strategy === 'feature-overlay' ? 'test-overlay' : 'base',
        ...execution,
        evidence_ref: evidenceRef,
      })),
      ...candidateExecutions.map((execution) => ({
        phase: 'candidate',
        ...execution,
        evidence_ref: evidenceRef,
      })),
    ],
    frames: withEvidence,
    expected_diff: {
      manifest_digest_sha256: manifestDigest,
      expected,
      observed,
      unexpected,
    },
    cleanup: {
      lease_id: leaseId,
      worktree: worktreeCleanup ? (worktreeWasCreated ? 'removed' : 'not-created') : 'orphan-fail',
      database: databaseCleanup ? (databaseCreated ? 'removed' : 'not-created') : 'orphan-fail',
      recovery_scan: recovery.recovered.length > 0 ? 'recovered' : 'clean',
      ...(recovery.recovered.length > 0 ? { recovered_lease_ids: recovery.recovered } : {}),
    },
    verdict,
    report_only: true,
    readiness_eligible: false,
    evidence_chain_refs: [evidenceRef],
  };
  if (!validators.validationResult(result)) {
    throw new Error(
      `VALIDATION_RESULT_INVALID: ${JSON.stringify(validators.validationResult.errors ?? [])}`,
    );
  }
  writeJson(resolve(repoRoot, resultStatePath), result);
  return result;
}

export const verifyTranslation = defineCommand({
  name: 'verify translation',
  description: 'Independently validate an untrusted translation witness (report-only)',
  authority: 'sensor',
  lifecycle: 'experimental',
  lifecycle_reason: 'Report-only validation that cannot promote readiness.',
  promotion_criteria: [],
  register(cli: CAC): void {
    cli
      .command('verify-translation', 'Independently validate an untrusted translation witness')
      .option('--witness <path>', 'Translation witness JSON')
      .option('--repo-root <path>', 'Repository root (default: current directory)')
      .option('--database-url <url>', 'Postgres administrative URL for per-validation isolation')
      .option('--human', 'Emit a human-readable summary instead of JSON')
      .action(async (options: TranslationValidationOptions) => {
        try {
          const result = await executeTranslationValidation(options);
          if (options.human === true) {
            process.stdout.write(
              `verify translation: ${String(result['verdict'])} (report-only; readiness ineligible)\n`,
            );
          } else {
            process.stdout.write(`${JSON.stringify(result)}\n`);
          }
          process.exitCode = result['verdict'] === 'FAIL' ? EXIT_FAIL : EXIT_PASS;
        } catch (error) {
          process.stderr.write(
            `devai verify translation: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          process.exitCode = EXIT_FAIL;
        }
      });
  },
});
