import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  runWithAuthorityHostEffects,
  type AuthorityHostEffectRequest,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { createAuthorityBoundaryRuntime } from '@devai-nyx/authority';
import {
  createAuthorityDecisionIssuer,
  loadAuthorityPolicy,
  resolveAuthorityDeclaration,
  resolveAuthorityPolicy,
} from '@devai-nyx/authority';
import {
  CONSENT,
  actionDocument,
  canonicalSha256,
  declarationDependencies,
  exactSubject,
  expectSuccess,
  makePolicyPlant,
  policyBindingFromPlant,
  type AuthorityDecisionIssuer,
} from './authority-runtime-testkit.js';
import { ruleForTarget } from './authority-boundary-testkit.js';

type JsonRecord = Record<string, unknown>;

const READ_PROCESS_VERBS: Readonly<Record<string, readonly string[]>> = {
  command: ['-v'],
  git: [
    'config',
    'diff',
    'diff-tree',
    'hash-object',
    'log',
    'ls-files',
    'merge-base',
    'rev-list',
    'rev-parse',
    'status',
  ],
  sh: ['-lc'],
};

export function processIsReadOnlyForTest(request: AuthorityHostEffectRequest): boolean {
  const executable = request.arguments[0];
  const args = request.arguments[1];
  if (typeof executable !== 'string' || !Array.isArray(args)) return false;
  if (
    executable === 'git' &&
    args.length === 3 &&
    args[0] === 'worktree' &&
    args[1] === 'list' &&
    args[2] === '--porcelain'
  ) {
    return true;
  }
  if (args.length === 1 && args[0] === '--version') return true;
  if (
    (executable === 'node' || executable === process.execPath) &&
    args.length === 2 &&
    args[0] === '-e' &&
    ['process.exit(0)', '', "console.log('Mutation score: 100.0%')"].includes(String(args[1]))
  ) {
    return true;
  }
  if (
    executable === process.execPath &&
    typeof args[0] === 'string' &&
    args[0].endsWith('/packages/cli/dist/runtime/index/bin.js') &&
    (args[1] === 'spec-validate-action-coverage' ||
      (args[1] === 'spec' && args[2] === 'validate-all'))
  ) {
    return true;
  }
  if (
    executable === 'pnpm' &&
    ((args.length === 1 &&
      [
        'test',
        'test:coverage',
        'test:integration',
        'test:mutation',
        'test:regression',
        'test:e2e',
      ].includes(String(args[0]))) ||
      (args.length === 2 &&
        args[0] === 'run' &&
        ['build', 'test', 'test:t1', 'test:t3', 'test:t4', 'test:t5'].includes(String(args[1]))) ||
      (args.length === 2 && args[0] === '-r' && args[1] === 'build') ||
      (args[0] === 'vitest' &&
        args[1] === 'run' &&
        (args.length === 2 ||
          (args.length === 4 &&
            args[2] === '--config' &&
            [
              'tests/config/t1.unit.config.ts',
              'tests/config/t2.contract.config.ts',
              'tests/config/t3.integration.config.ts',
              'tests/config/t4.regression.config.ts',
              'tests/config/t5.e2e.config.ts',
              'tests/config/t6.containment.config.ts',
            ].includes(String(args[3]))))))
  ) {
    return true;
  }
  if (
    executable === 'npx' &&
    ((args[0] === 'tsc' && args[1] === '--noEmit') ||
      (args[0] === 'eslint' && args[1] === '--format=json' && !args.includes('--fix')))
  ) {
    return true;
  }
  if (executable === 'sh' && args[0] === '-lc') {
    return typeof args[1] === 'string' && /^command -v (claude|codex)$/u.test(args[1]);
  }
  return READ_PROCESS_VERBS[executable]?.includes(String(args[0])) === true;
}

function requestPath(request: AuthorityHostEffectRequest): unknown {
  if (['copyFileSync', 'cpSync', 'symlinkSync'].includes(request.symbol)) {
    return request.arguments[1];
  }
  return request.arguments[0];
}

function absolutePath(value: unknown): string {
  if (typeof value !== 'string') throw new Error('AUTHORITY_TEST_FS_TARGET_INVALID');
  return isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value);
}

function existingRealpath(path: string): string {
  let cursor = path;
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return path;
    suffix.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...suffix);
}

function repositoryRootFor(path: string): string {
  let cursor = dirname(path);
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error('AUTHORITY_TEST_FS_ROOT_UNAVAILABLE');
    cursor = parent;
  }
  return realpathSync(cursor);
}

function snapshot(root: string, path: string): unknown {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) return undefined;
  const stat = lstatSync(absolute);
  return {
    kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file',
    mode: stat.mode,
    size: stat.size,
    mtime_ms: stat.mtimeMs,
  };
}

function targetFor(
  request: AuthorityHostEffectRequest,
  descriptors: ReadonlyMap<number, Readonly<{ target: JsonRecord; repositoryRoot: string }>>,
): Readonly<{ target: JsonRecord; repositoryRoot: string }> {
  if (['writeSync', 'fsyncSync', 'closeSync'].includes(request.symbol)) {
    const descriptor = request.arguments[0];
    const bound = typeof descriptor === 'number' ? descriptors.get(descriptor) : undefined;
    if (!bound) throw new Error('AUTHORITY_TEST_FS_DESCRIPTOR_UNKNOWN');
    return { ...bound, target: { ...bound.target, operation: 'update' } };
  }
  const absolute = absolutePath(requestPath(request));
  const canonical = existingRealpath(absolute);
  const repositoryRoot = repositoryRootFor(absolute);
  const path = relative(repositoryRoot, canonical).split(sep).join('/');
  if (path.length === 0 || path.startsWith('../') || isAbsolute(path)) {
    throw new Error('AUTHORITY_TEST_FS_TARGET_INVALID');
  }
  return {
    repositoryRoot,
    target: {
      kind: 'fs',
      id: `fs:${path}`,
      repository_id: 'devai-test-scope',
      canonical_relative_path: path,
      operation: ['rmSync', 'unlinkSync'].includes(request.symbol)
        ? 'delete'
        : ['mkdirSync', 'mkdtempSync', 'openSync', 'symlinkSync'].includes(request.symbol) ||
            !existsSync(absolute)
          ? 'create'
          : 'update',
    },
  };
}

/**
 * Explicit production-composition wrapper for legacy core mutation tests.
 * There is no environment/test bypass: every filesystem effect receives a
 * real declaration/context, policy allow, issuer receipt, exact plan, prepare,
 * final re-verification, and one-shot apply.
 */
export async function withAuthorityHostTestScope<T>(callback: () => T | Promise<T>): Promise<T> {
  let ordinal = 0;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'legacy-core-test-authority',
    issuer_version: '1.0.0',
    invocation_id: 'invocation-1',
    canonicalSha256,
    randomId: () => `legacy-core-authority-${String(++ordinal)}`,
    now: () => '2026-07-15T12:00:00.000Z',
    receipt_ttl_ms: 30_000,
  }) as unknown as AuthorityDecisionIssuer;
  const descriptors = new Map<number, Readonly<{ target: JsonRecord; repositoryRoot: string }>>();
  const scope: AuthorityHostEffectScope = {
    action_id: 'test mutate',
    invocation_id: 'invocation-1',
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (request, apply) => {
      if (request.kind === 'process') {
        if (!processIsReadOnlyForTest(request)) {
          throw new Error('AUTHORITY_TEST_PROCESS_NOT_READ_ONLY');
        }
        return apply();
      }
      const { target, repositoryRoot } = targetFor(request, descriptors);
      const plant = makePolicyPlant({ additiveRules: [ruleForTarget(target)] });
      const declaration = expectSuccess<{ context_receipt: unknown }>(
        resolveAuthorityDeclaration(
          {
            action_id: 'test mutate',
            invocation_id: 'invocation-1',
            dry_run: false,
            declaration: { as_role: 'engineer' },
            consent: CONSENT,
          },
          declarationDependencies(
            issuer,
            actionDocument(),
            undefined,
            policyBindingFromPlant(plant),
          ),
        ),
      );
      const policy = expectSuccess(loadAuthorityPolicy({ document: plant.document }, plant.deps));
      const resolution = resolveAuthorityPolicy(
        policy,
        {
          action_id: 'test mutate',
          context_receipt: declaration.context_receipt,
          consent: CONSENT,
          resource: target,
          operation: target.operation,
        },
        { receiptStore: issuer },
      );
      const subject = exactSubject([target], plant);
      const decision = issuer.issueAllow({
        resolutions: [resolution],
        subject,
        context_receipt: declaration.context_receipt,
        invocation_id: 'invocation-1',
        boundary_adapter_id: 'fs-authority-boundary',
      }) as JsonRecord;
      if (decision.issued !== true) throw new Error(String(decision.code));
      let result: unknown;
      const boundary = createAuthorityBoundaryRuntime({
        receiptStore: issuer,
        invocation_id: 'invocation-1',
        canonicalSha256,
        repository_root: repositoryRoot,
        fs: {
          realpath: (path: string) => existingRealpath(resolve(repositoryRoot, path)),
          lstat: (path: string) => snapshot(repositoryRoot, path),
          writeAtomic: () => {
            result = apply();
            return 'legacy-core-test-effect';
          },
          renameAtomic: () => {
            result = apply();
            return 'legacy-core-test-effect';
          },
        },
        git: {},
        db: {},
        remote: {},
      }) as JsonRecord;
      const planHandle = expectSuccess<JsonRecord>(
        (boundary.plannerRegistry as JsonRecord).registerPlan
          ? ((boundary.plannerRegistry as JsonRecord).registerPlan as (value: unknown) => unknown)({
              subject,
              invocation_id: 'invocation-1',
            })
          : undefined,
      );
      const prepared = expectSuccess<JsonRecord>(
        (boundary.prepare as (value: unknown) => unknown)({
          target,
          subject,
          context_receipt: declaration.context_receipt,
          decision_receipt: decision.receipt,
          plan_handle: planHandle,
          adapter_id: 'fs-authority-boundary',
        }),
      );
      expectSuccess((boundary.apply as (value: unknown) => unknown)({ prepared }));
      if (request.symbol === 'openSync' && typeof result === 'number')
        descriptors.set(result, { target, repositoryRoot });
      if (request.symbol === 'closeSync' && typeof request.arguments[0] === 'number') {
        descriptors.delete(request.arguments[0]);
      }
      return result;
    },
  };
  try {
    return await runWithAuthorityHostEffects(scope, callback);
  } finally {
    issuer.dispose();
  }
}
