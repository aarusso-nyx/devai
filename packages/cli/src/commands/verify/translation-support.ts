import { createHash } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { classifyTranslationPath } from '#runtime-core';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  spawnSync,
  writeFileSync,
} from '@devai-nyx/authority';
import { validators } from '@devai-nyx/schemas';

export interface TranslationValidationOptions {
  readonly witness: string;
  readonly repoRoot?: string;
  readonly databaseUrl?: string;
  readonly human?: boolean;
}

export interface TestRef {
  readonly suite: string;
  readonly path: string;
  readonly names: readonly string[];
}

export interface TranslationWitness {
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

export interface TaskRecord {
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

export interface TraceRecord {
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

export interface Execution {
  readonly test_ref: string;
  readonly outcome: 'pass' | 'fail' | 'crash';
  readonly failure_mode:
    'none' | 'assertion' | 'missing-file' | 'load-error' | 'timeout' | 'signal' | 'infrastructure';
}

export interface ProcessResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
  readonly isolation_applied?: boolean;
}

export interface StateChange {
  readonly path: string;
  readonly operation: 'create' | 'append' | 'retire';
}
export const EXECUTION_TIMEOUT_MS = 120_000;

export function json(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

export function canonicalRef(ref: TestRef): string {
  return `${ref.suite}:${ref.path}:${ref.names.join(' > ')}`;
}

function sameNames(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every((name, index) => name === right[index])
  );
}

export function safeRepoPath(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !path.split('/').some((part) => part === '' || part === '.' || part === '..')
  );
}

export function isTestPath(path: string): boolean {
  return classifyTranslationPath('inspector', path).effect === 'fs:tests';
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function fileDigest(path: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return `symlink:${readlinkSync(path)}`;
  if (!stat.isFile()) return `other:${String(stat.mode)}`;
  return `file:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

export function git(repoRoot: string, args: readonly string[]): ProcessResult {
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

export function requireGit(repoRoot: string, args: readonly string[], code: string): string {
  const result = git(repoRoot, args);
  if (result.status !== 0) {
    throw new Error(`${code}: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

export function gitBlob(repoRoot: string, commit: string, path: string, code: string): Buffer {
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

export function jsonAtCommit(
  repoRoot: string,
  commit: string,
  path: string,
  code: string,
): unknown {
  try {
    return JSON.parse(gitBlob(repoRoot, commit, path, code).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${code}:`)) throw error;
    throw new Error(`${code}: invalid JSON`);
  }
}

export function inferEffects(
  paths: readonly string[],
  role: TranslationWitness['frame']['authority_role'],
): readonly string[] {
  return [...new Set(paths.map((path) => classifyTranslationPath(role, path).effect))].sort();
}

export function registeredTraceRef(
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

export function resolveStrategyCoverage(input: {
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

export function removeWorktree(repoRoot: string, relativePath: string): void {
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

export function readLeases(
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

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
