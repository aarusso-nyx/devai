import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from '@devai-nyx/authority';
import { getValidator } from '@devai-nyx/schemas';
import {
  resolveReleaseMutationTaskNodes,
  resolveReleaseTaskNodes,
  resolveReleaseVerification,
  type MutationRosterEntry,
} from '../release-profile.js';
import {
  PREFLIGHT_CAPABILITIES,
  verifyReleasePreflightReceipt,
  type ReleasePreflightReceipt,
} from '../release-preflight.js';
import { CheckCache } from './cache.js';
import { sha256Hex } from './canonical.js';
import { bindReleaseTaskProcessOptions } from './authority-process.js';
import {
  buildTaskPlan,
  currentRepositoryState,
  exactCandidateRepositoryState,
  exactCommitFile,
  exactCommitTree,
  parseTaskDescriptor,
  readTaskDescriptor,
} from './policy.js';
import type {
  CandidateReceipt,
  CheckRunnerOptions,
  CheckRunnerReport,
  ExecutedTask,
  PlannedTask,
  TaskDescriptorNode,
  TaskExecutionResult,
  TaskOutcome,
  TaskResult,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 15 * 60_000;

function descriptorFor(options: CheckRunnerOptions) {
  return options.descriptorDocument === undefined
    ? readTaskDescriptor(
        resolve(options.descriptorPath ?? join(options.repoRoot, 'test-tasks.json')),
      )
    : parseTaskDescriptor(options.descriptorDocument);
}

function commandVersion(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, [...args], { cwd, encoding: 'utf8', timeout: 10_000 });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `CHECK_RUNNER_TOOLCHAIN_MISSING: ${command}: ${result.error?.message ?? String(result.stderr).trim()}`,
    );
  }
  return String(result.stdout).trim();
}

function packageVersion(repoRoot: string, packageName: string): string {
  try {
    const value = JSON.parse(
      readFileSync(join(repoRoot, 'node_modules', packageName, 'package.json'), 'utf8'),
    ) as { version?: unknown };
    if (typeof value.version !== 'string' || value.version === '')
      throw new Error('version missing');
    return `${packageName}@${value.version}`;
  } catch (error) {
    throw new Error(
      `CHECK_RUNNER_TOOLCHAIN_MISSING: ${packageName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function resolveRunnerToolchain(
  repoRoot: string,
  requiredKeys: readonly string[],
): Readonly<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const key of [...new Set(requiredKeys)].sort()) {
    if (key === 'node') resolved[key] = process.version;
    else if (key === 'pnpm') resolved[key] = commandVersion('pnpm', ['--version'], repoRoot);
    else if (key === 'git') resolved[key] = commandVersion('git', ['--version'], repoRoot);
    else if (key === 'eslint') resolved[key] = packageVersion(repoRoot, 'eslint');
    else if (key === 'vitest') resolved[key] = packageVersion(repoRoot, 'vitest');
    else if (key === 'typescript') resolved[key] = packageVersion(repoRoot, 'typescript');
    else if (key === 'postgres') {
      resolved[key] = commandVersion('psql', ['--version'], repoRoot);
    } else {
      throw new Error(`CHECK_RUNNER_TOOLCHAIN_MISSING: unsupported key ${key}`);
    }
  }
  return resolved;
}

function defaultExecute(
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
  environment: Readonly<Record<string, string>>,
  releaseBinding?: Parameters<typeof bindReleaseTaskProcessOptions>[1],
): TaskExecutionResult {
  const executionEnvironment: NodeJS.ProcessEnv = {
    ...(process.env.PATH !== undefined && { PATH: process.env.PATH }),
    ...(process.env.HOME !== undefined && { HOME: process.env.HOME }),
    ...(process.env.TMPDIR !== undefined && { TMPDIR: process.env.TMPDIR }),
    CI: '1',
    NO_COLOR: '1',
    ...environment,
  };
  const spawnOptions = {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: executionEnvironment,
    shell: false,
  } as const;
  const result = spawnSync(
    argv[0] ?? '',
    argv.slice(1),
    releaseBinding === undefined
      ? spawnOptions
      : bindReleaseTaskProcessOptions({ ...spawnOptions }, releaseBinding),
  );
  return {
    status: result.status,
    signal: result.signal,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    ...(result.error !== undefined && {
      errorCode:
        'code' in result.error && typeof result.error.code === 'string'
          ? result.error.code
          : result.error.name,
    }),
  };
}

function executionOutcome(result: TaskExecutionResult): TaskOutcome {
  if (result.status === 0 && result.errorCode === undefined && result.signal === null)
    return 'PASS';
  if (result.errorCode === 'ETIMEDOUT') return 'TIMEOUT';
  if (result.signal !== null) return 'KILLED';
  return 'FAIL';
}

function outputDigests(
  repoRoot: string,
  task: PlannedTask,
  execution: TaskExecutionResult,
  readTaskOutput?: (path: string) => Buffer,
  capturedTaskOutputPaths?: (task: PlannedTask) => readonly string[],
): Readonly<Record<string, string>> {
  const digests: Record<string, string> = {
    stdout: sha256Hex(Buffer.from(execution.stdout, 'utf8')),
    stderr: sha256Hex(Buffer.from(execution.stderr, 'utf8')),
  };
  const paths = task.outputContract.paths ?? [];
  if (paths !== undefined) {
    if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string'))
      throw new Error(`CHECK_RUNNER_OUTPUT_CONTRACT: ${task.nodeId} has malformed paths`);
    for (const path of new Set([
      ...(paths as string[]),
      ...(capturedTaskOutputPaths?.(task) ?? []),
    ])) {
      try {
        digests[path] = sha256Hex(
          readTaskOutput === undefined ? readFileSync(join(repoRoot, path)) : readTaskOutput(path),
        );
      } catch {
        throw new Error(`CHECK_RUNNER_OUTPUT_MISSING: ${task.nodeId}: ${path}`);
      }
    }
  }
  return digests;
}

function planWithCache(
  options: CheckRunnerOptions,
  cache: CheckCache,
  toolchain: Readonly<Record<string, string>>,
  environment: Readonly<Record<string, string>>,
) {
  const descriptor = descriptorFor(options);
  const reusableDigests = new Map<string, string>();
  return buildTaskPlan({
    repoRoot: options.repoRoot,
    descriptor,
    target: options.target,
    ...(options.baseCommit !== undefined && { baseCommit: options.baseCommit }),
    ...(options.releaseCandidate !== undefined && { releaseCandidate: options.releaseCandidate }),
    ...(options.releaseRequiredNodes !== undefined && {
      releaseRequiredNodes: options.releaseRequiredNodes,
    }),
    ...(options.releaseAffectedSelection !== undefined && {
      releaseAffectedSelection: options.releaseAffectedSelection,
    }),
    ...(options.releaseTaskBindings !== undefined && {
      releaseTaskBindings: options.releaseTaskBindings,
    }),
    toolchain,
    environment,
    ...(options.resolveExecutable === undefined
      ? {}
      : { resolveExecutable: options.resolveExecutable }),
    ...(options.protectedExecutionIdentity === undefined
      ? {}
      : { protectedExecutionIdentity: options.protectedExecutionIdentity }),
    cacheState(task) {
      const dependencies: Record<string, string> = {};
      for (const dependency of task.dependencies) {
        const digest = reusableDigests.get(dependency);
        if (digest === undefined) {
          return { cacheState: 'execute' as const, reason: 'dependency-not-reusable' };
        }
        dependencies[dependency] = digest;
      }
      const inspection = cache.inspect(task as PlannedTask, dependencies);
      if (inspection.cachedResultDigest !== undefined) {
        reusableDigests.set(task.nodeId, inspection.cachedResultDigest);
      }
      return {
        cacheState: inspection.cacheState,
        reason: inspection.reason,
        ...(inspection.cachedResultDigest !== undefined && {
          cachedResultDigest: inspection.cachedResultDigest,
        }),
      };
    },
  });
}

function requiredTaskNodes(
  options: CheckRunnerOptions,
  releaseScope: 'selected' | 'complete' = 'complete',
): readonly TaskDescriptorNode[] {
  const descriptor = descriptorFor(options);
  if (options.target === 'affected') {
    const profile = descriptor.profiles.find((entry) => entry.profileId === 'affected');
    const eligible = new Set(profile?.eligibleNodes ?? []);
    return descriptor.tasks.filter((task) => eligible.has(task.nodeId));
  }
  const roots =
    options.target === 'release'
      ? releaseScope === 'complete'
        ? (options.releaseAllNodes ?? options.releaseRequiredNodes ?? [])
        : (options.releaseRequiredNodes ?? [])
      : options.target === 'local'
        ? [descriptor.fallbackNodeId]
        : (descriptor.profiles.find((entry) => entry.profileId === 'rc')?.requiredNodes ?? []);
  const byId = new Map(descriptor.tasks.map((task) => [task.nodeId, task]));
  const selected = new Set<string>();
  const pending = roots.filter((nodeId): nodeId is string => nodeId !== null);
  for (let index = 0; index < pending.length; index += 1) {
    const nodeId = pending[index];
    if (nodeId === undefined || selected.has(nodeId)) continue;
    selected.add(nodeId);
    pending.push(...(byId.get(nodeId)?.dependencies ?? []));
  }
  return descriptor.tasks.filter((task) => selected.has(task.nodeId));
}

function requiredToolchainKeys(options: CheckRunnerOptions): readonly string[] {
  return requiredTaskNodes(options).flatMap((task) => task.toolchainKeys);
}

function resolvedRunnerToolchain(options: CheckRunnerOptions): Readonly<Record<string, string>> {
  // A PATH or node_modules resolution is needed to execute a task, but is host
  // state, not portable policy.  Only an explicitly supplied protected
  // executable identity may be included in the task key.
  return resolveRunnerToolchain(options.repoRoot, requiredToolchainKeys(options));
}

function requiredEnvironmentKeys(options: CheckRunnerOptions): readonly string[] {
  return requiredTaskNodes(options, 'selected').flatMap((task) => task.allowlistedEnv);
}

function taskEnvironment(
  task: TaskDescriptorNode,
  environment: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const selected: Record<string, string> = {};
  for (const key of task.allowlistedEnv) {
    const value = environment[key];
    if (value !== undefined) selected[key] = value;
  }
  return selected;
}

function bindReleaseRequest(input: CheckRunnerOptions): Readonly<{
  options: CheckRunnerOptions;
  binding?: Readonly<{
    digest: string;
    profileDigest: string;
    decision: ReturnType<typeof resolveReleaseVerification>;
    base: Readonly<{ commit: string; tree: string }>;
    preflightCapabilityTasks: Readonly<Record<string, readonly string[]>>;
  }>;
}> {
  if (input.releaseIntent === undefined && input.releaseProfile === undefined) {
    return { options: input };
  }
  if (input.releaseIntent === undefined || input.releaseProfile === undefined) {
    throw new Error('CHECK_RELEASE_INTENT_AND_PROFILE_REQUIRED');
  }
  const validateIntent = getValidator('release-intent.schema.json');
  const validateProfile = getValidator('release-verification-profile.schema.json');
  if (!validateIntent(input.releaseIntent)) {
    throw new Error(`CHECK_RELEASE_INTENT_INVALID:${JSON.stringify(validateIntent.errors)}`);
  }
  if (!validateProfile(input.releaseProfile)) {
    throw new Error(`CHECK_RELEASE_PROFILE_INVALID:${JSON.stringify(validateProfile.errors)}`);
  }
  const intent = input.releaseIntent as {
    release_unit: string;
    current_version: string;
    target_version: string;
    support: 'preview' | 'current' | 'lts';
    support_promotion?: boolean;
    change_kind?: 'documentation' | 'metadata' | 'behavioral';
    changed_paths?: string[];
    changed_packages?: string[];
    risks?: string[];
    owner_escalations?: import('../release-profile.js').ReleaseCapability[];
    candidate: { commit: string; tree: string };
    base: { commit: string; tree: string };
  };
  const profile = input.releaseProfile as {
    release_unit: string;
    version_source: string;
    capability_tasks: Record<string, string[]>;
    risk_capabilities: Record<string, import('../release-profile.js').ReleaseCapability[]>;
    mutation_roster: readonly MutationRosterEntry[];
  };
  if (intent.release_unit !== profile.release_unit) {
    throw new Error('CHECK_RELEASE_UNIT_MISMATCH');
  }
  const candidate = exactCandidateRepositoryState(input.repoRoot, intent.candidate);
  if (!candidate.clean) {
    throw new Error('CHECK_RELEASE_CANDIDATE_WORKTREE_MISMATCH');
  }
  if (input.baseCommit === undefined || intent.base.commit !== input.baseCommit) {
    throw new Error('CHECK_RELEASE_INTENT_BASE_MISMATCH');
  }
  if (exactCommitTree(input.repoRoot, intent.base.commit) !== intent.base.tree) {
    throw new Error('CHECK_RELEASE_INTENT_BASE_TREE_MISMATCH');
  }
  const versionAt = (commit: string): string => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(exactCommitFile(input.repoRoot, commit, profile.version_source));
    } catch (error) {
      if (error instanceof Error && error.message === 'CHECK_RELEASE_VERSION_SOURCE_UNREADABLE') {
        throw error;
      }
      throw new Error('CHECK_RELEASE_VERSION_SOURCE_INVALID');
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      typeof (parsed as { version?: unknown }).version !== 'string'
    ) {
      throw new Error('CHECK_RELEASE_VERSION_SOURCE_INVALID');
    }
    return (parsed as { version: string }).version;
  };
  if (versionAt(intent.base.commit) !== intent.current_version) {
    throw new Error('CHECK_RELEASE_CURRENT_VERSION_SOURCE_MISMATCH');
  }
  if (versionAt(intent.candidate.commit) !== intent.target_version) {
    throw new Error('CHECK_RELEASE_TARGET_VERSION_SOURCE_MISMATCH');
  }
  const decision = resolveReleaseVerification({
    currentVersion: intent.current_version,
    targetVersion: intent.target_version,
    support: intent.support,
    riskCapabilities: profile.risk_capabilities,
    mutationRosterSize: profile.mutation_roster.length,
    ...(intent.support_promotion !== undefined && { supportPromotion: intent.support_promotion }),
    ...(intent.change_kind !== undefined && { changeKind: intent.change_kind }),
    ...(intent.risks !== undefined && { risks: intent.risks }),
    ...(intent.owner_escalations !== undefined && { ownerEscalations: intent.owner_escalations }),
  });
  if (decision.verdict !== 'ready') {
    throw new Error(`CHECK_RELEASE_INTENT_BLOCKED:${decision.blockingReasons.join(',')}`);
  }
  const descriptor = descriptorFor(input);
  const allRoots = resolveReleaseTaskNodes(
    decision,
    profile.capability_tasks,
    descriptor.tasks.map((task) => task.nodeId),
  );
  const mutationSelection = resolveReleaseMutationTaskNodes(
    decision,
    profile.mutation_roster,
    intent.changed_packages ?? [],
    intent.changed_paths ?? [],
    intent.risks ?? [],
    descriptor.tasks.map((task) => task.nodeId),
  );
  const selectedRoots = [...new Set([...allRoots, ...mutationSelection.taskNodes])].sort();
  const profileDigest = sha256Hex(input.releaseProfile);
  const mutationTaskBindings = Object.fromEntries(
    mutationSelection.taskNodes.map((nodeId) => [
      nodeId,
      {
        schemaVersion: '1.0.0',
        mutation: decision.mutation,
        profileDigest,
        rosterEntries: profile.mutation_roster
          .filter((entry) => mutationSelection.rosterEntryIds.includes(entry.id))
          .filter((entry) => entry.task_node === nodeId),
      },
    ]),
  );
  const preflightDecision = {
    ...decision,
    capabilities: decision.capabilities.filter((capability) =>
      (PREFLIGHT_CAPABILITIES as readonly string[]).includes(capability),
    ),
  };
  const preflightRoots = resolveReleaseTaskNodes(
    preflightDecision,
    profile.capability_tasks,
    descriptor.tasks.map((task) => task.nodeId),
  );
  const stage = input.releaseStage ?? 'preflight';
  // Exit codes and output digests alone cannot satisfy required mutation. Keep
  // read-only planning and the unconditional preflight floor usable while the
  // protected semantic evidence producer/verifier bridge is being implemented.
  if (stage === 'certify' && input.operation === 'run' && decision.mutation !== 'none')
    throw new Error('CHECK_RELEASE_MUTATION_EVIDENCE_UNAVAILABLE');
  return {
    options: {
      ...input,
      target: 'release',
      releaseStage: stage,
      releaseCandidate: intent.candidate,
      releaseRequiredNodes: stage === 'preflight' ? preflightRoots : selectedRoots,
      releaseAllNodes: selectedRoots,
      releaseTaskBindings: stage === 'preflight' ? {} : mutationTaskBindings,
      releaseAffectedSelection:
        stage === 'certify' && decision.capabilities.includes('affected-checks'),
    },
    binding: {
      digest: sha256Hex(input.releaseIntent),
      profileDigest,
      decision,
      base: intent.base,
      preflightCapabilityTasks: Object.fromEntries(
        PREFLIGHT_CAPABILITIES.map((capability) => [
          capability,
          profile.capability_tasks[capability] ?? [],
        ]),
      ),
    },
  };
}

export function runCheckTasks(inputOptions: CheckRunnerOptions): CheckRunnerReport {
  const request = bindReleaseRequest(inputOptions);
  const options = request.options;
  const protectedOutputCapture =
    options.protectedExecutionIdentity !== undefined &&
    options.readTaskOutput !== undefined &&
    options.capturedTaskOutputPaths !== undefined;
  const requiredEnvironment = requiredEnvironmentKeys(options);
  // Protected execution binds the complete selected DAG, including dependencies, but does
  // not require credentials or tools belonging only to unselected task nodes. Refuse before
  // ambient environment/toolchain resolution; those values are not protected host inputs.
  if (
    options.protectedExecutionIdentity !== undefined &&
    requiredTaskNodes(options, 'selected').some(
      (task) =>
        task.allowlistedEnv.some((key) => options.environment?.[key] === undefined) ||
        task.toolchainKeys.some((key) => options.toolchain?.[key] === undefined),
    )
  ) {
    throw new Error('release-certification-environment-unbound');
  }
  const configuredDbTests = options.environment?.['DEVAI_DB_TESTS'] ?? process.env.DEVAI_DB_TESTS;
  if (
    (options.target === 'rc' || options.target === 'release') &&
    requiredEnvironment.includes('DEVAI_DB_TESTS') &&
    configuredDbTests !== '1'
  ) {
    throw new Error(
      'CHECK_RC_DB_TESTS_REQUIRED: RC and release profiles require DEVAI_DB_TESTS=1 when database tasks are selected so cases cannot silently skip',
    );
  }
  const cacheRoot = resolve(
    options.cacheRoot ?? join(options.repoRoot, '.devai/state/check-cache/v1'),
  );
  const cache = new CheckCache(options.repoRoot, cacheRoot);
  const toolchain = options.toolchain ?? resolvedRunnerToolchain(options);
  const environment: Record<string, string> = { ...(options.environment ?? {}) };
  const authorityDigestKey = 'DEVAI_AUTHORITY_POLICY_SHA256';
  if (requiredEnvironment.includes(authorityDigestKey)) {
    const authorityPolicyPath = join(options.repoRoot, '.devai/config/authority-policy.json');
    if (!existsSync(authorityPolicyPath)) {
      throw new Error(
        'CHECK_AUTHORITY_POLICY_REQUIRED: materialize .devai/config/authority-policy.json before planning release evidence',
      );
    }
    const authorityDigest = sha256Hex(readFileSync(authorityPolicyPath));
    if (
      options.protectedExecutionIdentity !== undefined &&
      environment[authorityDigestKey] !== authorityDigest
    )
      throw new Error('release-certification-environment-unbound');
    environment[authorityDigestKey] = authorityDigest;
  }
  for (const key of requiredEnvironment) {
    const inheritedValue = process.env[key];
    if (environment[key] === undefined && inheritedValue !== undefined) {
      environment[key] = inheritedValue;
    }
  }
  const rawPlan = planWithCache(options, cache, toolchain, environment);
  const releaseBinding = request.binding;
  if (releaseBinding !== undefined) {
    const intent = inputOptions.releaseIntent as { changed_paths?: string[] };
    const declared = [...(intent.changed_paths ?? [])].sort();
    if (JSON.stringify(declared) !== JSON.stringify(rawPlan.changedPaths)) {
      throw new Error('CHECK_RELEASE_INTENT_CHANGED_PATHS_MISMATCH');
    }
  }
  const plan =
    releaseBinding === undefined
      ? rawPlan
      : {
          ...rawPlan,
          releaseIntentDigest: releaseBinding.digest,
          releaseProfileDigest: releaseBinding.profileDigest,
          toolchainDigest: sha256Hex(toolchain),
          releaseDecision: releaseBinding.decision,
        };
  if (options.target === 'release' && options.releaseStage === 'certify') {
    if (options.preflightReceipt === undefined || releaseBinding === undefined) {
      throw new Error('CHECK_RELEASE_PREFLIGHT_REQUIRED');
    }
    const knownNodes = descriptorFor(options).tasks.map((task) => task.nodeId);
    const preflightPlan = planWithCache(
      {
        ...options,
        releaseStage: 'preflight',
        releaseAffectedSelection: false,
        releaseTaskBindings: {},
        releaseRequiredNodes: resolveReleaseTaskNodes(
          {
            ...releaseBinding.decision,
            capabilities: releaseBinding.decision.capabilities.filter((capability) =>
              (PREFLIGHT_CAPABILITIES as readonly string[]).includes(capability),
            ),
          },
          releaseBinding.preflightCapabilityTasks,
          knownNodes,
        ),
      },
      cache,
      toolchain,
      environment,
    );
    verifyReleasePreflightReceipt(options.preflightReceipt, {
      repository: plan.repository,
      base: releaseBinding.base,
      releaseIntentDigest: releaseBinding.digest,
      releaseProfileDigest: releaseBinding.profileDigest,
      taskPolicyDigest: preflightPlan.taskPolicyDigest,
      toolchainDigest: sha256Hex(toolchain),
    });
  }
  if (options.operation !== 'run') {
    return { schemaVersion: '1.0.0', operation: options.operation, plan, exitCode: 0 };
  }

  const descriptor = descriptorFor(options);
  const descriptorById = new Map(descriptor.tasks.map((task) => [task.nodeId, task]));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('CHECK_RUNNER_TIMEOUT: timeout must be a positive integer');
  }
  const now = options.now ?? (() => new Date().toISOString());
  const repositoryState = (): Readonly<{ commit: string; tree: string; clean: boolean }> =>
    options.target === 'release' && options.releaseCandidate !== undefined
      ? exactCandidateRepositoryState(options.repoRoot, options.releaseCandidate)
      : currentRepositoryState(options.repoRoot);
  const initialState = repositoryState();
  const resultDigests = new Map<string, string>();
  const execution: ExecutedTask[] = [];

  for (const task of plan.tasks) {
    const dependencyResultDigests: Record<string, string> = {};
    let dependencyMissing = false;
    for (const dependency of task.dependencies) {
      const digest = resultDigests.get(dependency);
      if (digest === undefined) dependencyMissing = true;
      else dependencyResultDigests[dependency] = digest;
    }
    if (dependencyMissing) {
      const at = now();
      cache.writeAttempt(task.nodeId, task.taskKey, 'ABORTED', at);
      execution.push({
        nodeId: task.nodeId,
        taskKey: task.taskKey,
        disposition: 'aborted',
        outcome: 'ABORTED',
        reason: 'dependency-not-pass',
        durationMs: 0,
      });
      continue;
    }
    const cached = cache.inspect(task, dependencyResultDigests);
    if (cached.cacheState === 'reusable' && cached.cachedResultDigest !== undefined) {
      resultDigests.set(task.nodeId, cached.cachedResultDigest);
      execution.push({
        nodeId: task.nodeId,
        taskKey: task.taskKey,
        disposition: 'reused',
        outcome: 'PASS',
        reason: cached.reason,
        durationMs: 0,
        resultDigest: cached.cachedResultDigest,
      });
      continue;
    }

    const startedAt = now();
    const started = Date.now();
    const descriptorTask = descriptorById.get(task.nodeId);
    if (descriptorTask === undefined) {
      throw new Error(`CHECK_RUNNER_INTERNAL: planned task ${task.nodeId} is not declared`);
    }
    const taskCwd = realpathSync(resolve(options.repoRoot, task.cwd));
    const taskEnv = taskEnvironment(descriptorTask, environment);
    const result =
      options.executeTask === undefined
        ? defaultExecute(
            [task.executable.path, ...task.argv.slice(1)],
            taskCwd,
            timeoutMs,
            taskEnv,
            options.target === 'release'
              ? {
                  candidate: {
                    commit: plan.repository.commit,
                    tree: plan.repository.tree,
                  },
                  descriptor_digest: plan.descriptorDigest,
                  task_policy_digest: plan.taskPolicyDigest,
                  node_id: task.nodeId,
                  executable: task.executable,
                  argv: task.argv,
                  cwd: task.cwd,
                }
              : undefined,
          )
        : options.executeTask(task.argv, taskCwd, timeoutMs, taskEnv);
    const durationMs = Math.max(0, Date.now() - started);
    const finishedAt = now();
    const outcome = executionOutcome(result);
    if (outcome !== 'PASS') {
      const reason =
        result.errorCode !== undefined
          ? `process-${result.errorCode}`
          : result.signal !== null
            ? `process-signal-${result.signal}`
            : `process-exit-${String(result.status)}`;
      const diagnosticPath = cache.writeFailureDiagnostic(
        task,
        outcome,
        finishedAt,
        reason,
        result,
      );
      cache.writeAttempt(task.nodeId, task.taskKey, outcome, finishedAt);
      execution.push({
        nodeId: task.nodeId,
        taskKey: task.taskKey,
        disposition: 'executed',
        outcome,
        reason,
        durationMs,
        ...(result.status !== null && { exitCode: result.status }),
        ...(result.signal !== null && { signal: result.signal }),
        diagnosticPath,
      });
      continue;
    }

    let taskResult: TaskResult;
    try {
      taskResult = {
        schemaVersion: '1.0.0',
        nodeId: task.nodeId,
        taskKey: task.taskKey,
        status: 'PASS',
        inputDigest: task.inputDigest,
        dependencyResultDigests,
        outputDigests: outputDigests(
          options.repoRoot,
          task,
          result,
          options.readTaskOutput,
          options.capturedTaskOutputPaths,
        ),
        startedAt,
        finishedAt,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const diagnosticPath = cache.writeFailureDiagnostic(task, 'FAIL', finishedAt, reason, result);
      cache.writeAttempt(task.nodeId, task.taskKey, 'FAIL', finishedAt);
      execution.push({
        nodeId: task.nodeId,
        taskKey: task.taskKey,
        disposition: 'executed',
        outcome: 'FAIL',
        reason,
        durationMs,
        diagnosticPath,
      });
      continue;
    }
    const resultDigest = cache.writeResult(taskResult);
    cache.writeAttempt(task.nodeId, task.taskKey, 'PASS', finishedAt, resultDigest);
    resultDigests.set(task.nodeId, resultDigest);
    execution.push({
      nodeId: task.nodeId,
      taskKey: task.taskKey,
      disposition: 'executed',
      outcome: 'PASS',
      reason:
        task.outputContract.generated_namespaces !== undefined && !protectedOutputCapture
          ? 'executed;protected-namespace-closure-unproven'
          : cached.reason,
      durationMs,
      resultDigest,
      exitCode: 0,
    });
  }

  let receipt: CheckRunnerReport['receipt'];
  let preflightReceipt: CheckRunnerReport['preflightReceipt'];
  let receiptRefusal: string | undefined;
  const allPass = execution.every((task) => task.outcome === 'PASS');
  const finalState = repositoryState();
  if (
    !protectedOutputCapture &&
    plan.tasks.some((task) => task.outputContract.generated_namespaces !== undefined)
  )
    receiptRefusal = 'protected-namespace-closure-unproven';
  else if (options.target === 'local') receiptRefusal = 'local-target-not-attestable';
  else if (!plan.clean || !initialState.clean) receiptRefusal = 'dirty-start';
  else if (!allPass) receiptRefusal = 'task-population-not-pass';
  else if (
    !finalState.clean ||
    finalState.commit !== initialState.commit ||
    finalState.tree !== initialState.tree ||
    finalState.commit !== plan.repository.commit ||
    finalState.tree !== plan.repository.tree
  ) {
    receiptRefusal = 'repository-changed-during-run';
  } else if (
    options.target === 'release' &&
    options.releaseStage === 'preflight' &&
    releaseBinding !== undefined
  ) {
    const checks = PREFLIGHT_CAPABILITIES.map((capability) => {
      const nodes = releaseBinding.preflightCapabilityTasks[capability] ?? [];
      const digests = nodes.map((nodeId) => {
        const digest = resultDigests.get(nodeId);
        if (digest === undefined)
          throw new Error(`CHECK_RELEASE_PREFLIGHT_RESULT_MISSING:${nodeId}`);
        return { nodeId, digest };
      });
      const reused = nodes.every((nodeId) =>
        execution.some((entry) => entry.nodeId === nodeId && entry.disposition === 'reused'),
      );
      return {
        capability,
        status: reused ? ('reused' as const) : ('executed' as const),
        reasonCode: 'required-floor',
        resultDigest: sha256Hex(digests),
      };
    });
    const value: ReleasePreflightReceipt = {
      schemaVersion: '1.0.0',
      repository: plan.repository,
      base: releaseBinding.base,
      releaseIntentDigest: releaseBinding.digest,
      releaseProfileDigest: releaseBinding.profileDigest,
      taskPolicyDigest: plan.taskPolicyDigest,
      toolchainDigest: sha256Hex(toolchain),
      checks,
      verdict: 'pass',
      blockingReasons: [],
      createdAt: now(),
    };
    verifyReleasePreflightReceipt(value, {
      repository: plan.repository,
      base: releaseBinding.base,
      releaseIntentDigest: releaseBinding.digest,
      releaseProfileDigest: releaseBinding.profileDigest,
      taskPolicyDigest: plan.taskPolicyDigest,
      toolchainDigest: sha256Hex(toolchain),
    });
    const written = cache.writePreflightReceipt(value);
    preflightReceipt = { ...written, value };
    receiptRefusal = 'release-preflight-only';
  } else {
    const candidateReceipt: CandidateReceipt = {
      schemaVersion: '1.1.0',
      repository: plan.repository,
      profile: options.target === 'release' ? 'rc' : options.target,
      taskPolicyDigest: plan.taskPolicyDigest,
      createdAt: now(),
      tasks: plan.tasks.map((task) => {
        const resultDigest = resultDigests.get(task.nodeId);
        if (resultDigest === undefined)
          throw new Error('CHECK_RUNNER_INTERNAL: missing task result');
        return { nodeId: task.nodeId, taskKey: task.taskKey, resultDigest };
      }),
    };
    const written = cache.writeReceipt(candidateReceipt);
    receipt = { ...written, value: candidateReceipt };
  }
  return {
    schemaVersion: '1.0.0',
    operation: options.operation,
    plan,
    execution,
    ...(receipt !== undefined && { receipt }),
    ...(preflightReceipt !== undefined && { preflightReceipt }),
    ...(options.target === 'release' && {
      releaseVerification: descriptorFor(options).tasks.map((task) => {
        const result = execution.find((entry) => entry.nodeId === task.nodeId);
        if (result === undefined) {
          return {
            nodeId: task.nodeId,
            status: 'not-required' as const,
            reasonCode: 'capability-not-selected',
          };
        }
        const status =
          result.outcome === 'PASS'
            ? result.disposition === 'reused'
              ? ('reused' as const)
              : ('executed' as const)
            : result.disposition === 'aborted'
              ? ('blocked' as const)
              : result.outcome === 'FAIL'
                ? ('failed' as const)
                : ('unknown' as const);
        return {
          nodeId: task.nodeId,
          status,
          reasonCode: result.reason,
          ...(['failed', 'blocked', 'unknown'].includes(status) && {
            failureClass:
              status === 'failed'
                ? ('product-regression' as const)
                : status === 'blocked'
                  ? ('environment-drift' as const)
                  : ('unknown' as const),
          }),
          ...(result.resultDigest !== undefined && { resultDigest: result.resultDigest }),
        };
      }),
    }),
    ...(receiptRefusal !== undefined && { receiptRefusal }),
    exitCode: allPass ? 0 : 1,
  };
}
