import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from '@devai-nyx/authority';
import { readPreflightGitText } from './policy.js';
import { probeCredential, redactDiagnosticText } from '../credential-probe.js';
import type {
  PreflightProbe,
  PreflightProbeObservation,
  PreflightProbeStatus,
  TaskExecutionResult,
} from './types.js';
import { record, orderedProbes } from './preflight-probes.js';
export {
  validatePreflightProbes,
  loadAdopterPreflightProbes,
  adopterPreflightNode,
  ADOPTER_PREFLIGHT_PROBES_PATH,
  ADOPTER_PREFLIGHT_NODE_ID,
  PREFLIGHT_RUNNER,
} from './preflight-probes.js';
/** Placeholder a command probe argument carries for the exact base commit. */
export const BASE_PLACEHOLDER = '{base}';

const REGISTRY_TIMEOUT_MS = 10_000;
const GIT_TIMEOUT_MS = 30_000;

/** Masks every token-shaped value and secret-named assignment in text. */
export { redactDiagnosticText };

/** Read-only Git through the closed check-policy grammar; never a task process. */
function policyGit(repoRoot: string, args: readonly string[]): string | undefined {
  return readPreflightGitText(repoRoot, args);
}

/** A host process whose refusal or failure is an unobservable fact, never a crash. */
function hostProcess(
  command: string,
  args: readonly string[],
  options: Readonly<{ cwd?: string; timeout: number; env?: NodeJS.ProcessEnv }>,
): Readonly<{ status: number | null; stdout: string; stderr: string; error?: string }> {
  try {
    const result = spawnSync(command, [...args], {
      ...options,
      encoding: 'utf8',
      shell: false,
    });
    return {
      status: result.status,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
      ...(result.error !== undefined && { error: result.error.message }),
    };
  } catch (error) {
    return {
      status: null,
      stdout: '',
      stderr: '',
      error: error instanceof Error ? error.message : 'refused',
    };
  }
}

/**
 * Resolves a base reference to its exact commit. An exact object id is returned
 * unchanged; a named reference is resolved once, so the planned node set is the
 * same for `--base origin/main` and `--base <sha>` of the same commit.
 */
export function resolveBaseCommit(repoRoot: string, reference: string): string {
  if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(reference)) return reference;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@~^-]*$/u.test(reference) || reference.includes('..')) {
    throw new Error(`CHECK_RUNNER_BASE: unsupported base reference ${reference}`);
  }
  const result = hostProcess(
    'git',
    ['rev-parse', '--verify', '--quiet', '--end-of-options', `${reference}^{commit}`],
    { cwd: repoRoot, timeout: GIT_TIMEOUT_MS },
  );
  const commit = result.stdout.trim();
  if (result.status !== 0 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit)) {
    throw new Error(`CHECK_RUNNER_BASE: ${reference} does not resolve to a commit; fetch it first`);
  }
  return commit;
}

export interface PreflightContext {
  readonly repoRoot: string;
  readonly baseCommit?: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface PreflightEvaluation {
  readonly outcome: 'PASS' | 'FAIL' | 'BLOCKED';
  readonly observations: readonly PreflightProbeObservation[];
  readonly reason: string;
  readonly remediation: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
}

interface Observation {
  readonly matched: boolean;
  readonly observed: string | null;
  /** The observation could not be made at all: always blocked, never fail. */
  readonly unobservable?: boolean;
  readonly skipped?: boolean;
}

function inCheckout(repoRoot: string, path: string): string | undefined {
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((part) => part === '..' || part === '')
  ) {
    return undefined;
  }
  return resolve(repoRoot, path);
}

function versionCore(value: string): string | undefined {
  return /(\d+\.\d+\.\d+)/u.exec(value)?.[1];
}

function majorOf(value: string | undefined): string | undefined {
  return value?.split('.')[0];
}

function toolchainObservation(repoRoot: string, manifestPath: string): Observation {
  const path = inCheckout(repoRoot, manifestPath);
  if (path === undefined || !existsSync(path)) {
    return { matched: false, observed: `manifest ${manifestPath} absent`, unobservable: true };
  }
  let runtimes: Readonly<Record<string, unknown>>;
  try {
    runtimes = record(record(JSON.parse(readFileSync(path, 'utf8')))?.runtimes) ?? {};
  } catch {
    return { matched: false, observed: `manifest ${manifestPath} unreadable`, unobservable: true };
  }
  const observe = (command: string): string | undefined => {
    const result = hostProcess(command, ['--version'], { cwd: repoRoot, timeout: GIT_TIMEOUT_MS });
    return result.error === undefined && result.status === 0
      ? versionCore(result.stdout)
      : undefined;
  };
  const observed = {
    node: versionCore(process.version),
    pnpm: observe('pnpm'),
    git: observe('git'),
  };
  const text = `node ${observed.node ?? 'missing'}, pnpm ${observed.pnpm ?? 'missing'}, git ${observed.git ?? 'missing'}`;
  if (observed.node === undefined || observed.pnpm === undefined || observed.git === undefined) {
    return { matched: false, observed: text, unobservable: true };
  }
  // The manifest pins exact versions; the lane installs node by major, pnpm
  // exactly (packageManager), and git from the runner image by major.
  const matched =
    majorOf(observed.node) === majorOf(String(runtimes.node)) &&
    observed.pnpm === String(runtimes.pnpm) &&
    majorOf(observed.git) === majorOf(String(runtimes.git));
  return { matched, observed: text };
}

const REGISTRY_SCRIPT = [
  'const [url, expected] = process.argv.slice(1);',
  `fetch(url, { signal: AbortSignal.timeout(${String(REGISTRY_TIMEOUT_MS)}) })`,
  '  .then(async (response) => {',
  "    if (!expected) { process.stdout.write('reachable HTTP ' + response.status); return; }",
  '    const body = await response.json();',
  "    const version = body.version ?? body['dist-tags']?.latest;",
  "    process.stdout.write('version ' + String(version));",
  '    process.exitCode = version === expected ? 0 : 3;',
  '  })',
  '  .catch((error) => {',
  "    process.stdout.write('unreachable ' + String(error?.cause?.code ?? error?.name ?? 'error'));",
  '    process.exitCode = 2;',
  '  });',
].join('\n');

function registryObservation(url: string, expectedVersion: string | undefined): Observation {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  const result = hostProcess(
    process.execPath,
    ['-e', REGISTRY_SCRIPT, url, expectedVersion ?? ''],
    {
      timeout: REGISTRY_TIMEOUT_MS + 5_000,
      env: environment,
    },
  );
  const observed = result.stdout.trim() || 'unreachable';
  if (result.error !== undefined || result.status === 2 || result.status === null) {
    return { matched: false, observed, unobservable: true };
  }
  if (result.status === 3) return { matched: false, observed };
  return { matched: result.status === 0, observed, unobservable: result.status !== 0 };
}

const CREDENTIAL_TIMEOUT_MS = 15_000;

/**
 * ADR-SEC-0001: the same probe doctor uses, over the runner's host-process
 * rules. A refused or failed spawn is an unobservable fact (blocked), never a
 * crash; only the manifest id, status, and a fixed reason word are observed.
 */
function credentialObservation(context: PreflightContext, id: string): Observation {
  const result = probeCredential({
    repoRoot: context.repoRoot,
    id,
    environment: { ...process.env, ...context.environment },
    run: (argv) => {
      const [command = '', ...args] = argv;
      const spawned = hostProcess(command, args, {
        cwd: context.repoRoot,
        timeout: CREDENTIAL_TIMEOUT_MS,
      });
      if (spawned.error !== undefined) throw new Error('refused');
      return { status: spawned.status, stdout: spawned.stdout, stderr: spawned.stderr };
    },
  });
  const observed = `${result.id} ${result.status}${result.reason === undefined ? '' : ` (${result.reason})`}`;
  return {
    matched: result.status === 'present',
    observed,
    ...((result.reason === 'probe-refused' || result.reason === 'probe-unavailable') && {
      unobservable: true,
    }),
  };
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Executes the probes of one `preflight-v1` node in `depends_on` order. Command
 * probes are yielded as argument vectors so the caller runs them through the
 * same shell-free executor as every other task; all other kinds observe
 * directly. Every observation, reason, and stream is redacted before return.
 */
export function* evaluatePreflightProbes(
  probes: readonly PreflightProbe[],
  context: PreflightContext,
): Generator<readonly string[], PreflightEvaluation, TaskExecutionResult> {
  const statuses = new Map<string, PreflightProbeStatus>();
  const observations: PreflightProbeObservation[] = [];
  let stdout = '';
  let stderr = '';
  const runCommand = function* (
    id: string,
    argv: readonly string[],
  ): Generator<readonly string[], TaskExecutionResult, TaskExecutionResult> {
    const result = yield argv;
    stdout += `[${id}]\n${result.stdout}\n`;
    stderr += `[${id}]\n${result.stderr}\n`;
    return result;
  };
  for (const probe of orderedProbes(probes, 'node')) {
    const dependencyStatuses = probe.depends_on.map((id) => statuses.get(id));
    let observation: Observation;
    if (dependencyStatuses.includes('blocked')) {
      observation = { matched: false, observed: 'blocked-environment', unobservable: true };
    } else if (dependencyStatuses.some((status) => status !== 'pass')) {
      observation = { matched: false, observed: null, skipped: true };
    } else {
      const kind = probe.probe;
      switch (kind.kind) {
        case 'environment': {
          const value = context.environment[kind.name] ?? process.env[kind.name];
          observation =
            value === undefined
              ? { matched: false, observed: `${kind.name} unset` }
              : kind.expected === undefined || value === kind.expected
                ? { matched: true, observed: `${kind.name} set` }
                : { matched: false, observed: `${kind.name} set to a different value` };
          break;
        }
        case 'file': {
          const path = inCheckout(context.repoRoot, kind.path);
          if (path === undefined) {
            observation = {
              matched: false,
              observed: 'path escapes the checkout',
              unobservable: true,
            };
            break;
          }
          const exists = existsSync(path);
          if (!kind.must_exist) {
            observation = { matched: !exists, observed: exists ? 'present' : 'absent' };
          } else if (!exists) {
            observation = { matched: false, observed: 'absent' };
          } else if (kind.expected_sha256 === undefined) {
            observation = { matched: true, observed: 'present' };
          } else {
            const digest = sha256File(path);
            observation = {
              matched: digest === kind.expected_sha256,
              observed: `sha256:${digest}`,
            };
          }
          break;
        }
        case 'command': {
          const needsBase = kind.argv.some((argument) => argument.includes(BASE_PLACEHOLDER));
          if (needsBase && context.baseCommit === undefined) {
            observation = { matched: false, observed: 'no --base supplied', unobservable: true };
            break;
          }
          const argv = kind.argv.map((argument) =>
            argument.replaceAll(BASE_PLACEHOLDER, context.baseCommit ?? ''),
          );
          const result = yield* runCommand(probe.id, argv);
          if (result.errorCode !== undefined) {
            observation = {
              matched: false,
              observed: `process-${result.errorCode}`,
              unobservable: true,
            };
          } else if (result.signal !== null) {
            observation = {
              matched: false,
              observed: `signal ${result.signal}`,
              unobservable: true,
            };
          } else {
            observation = {
              matched: result.status === kind.expected_exit,
              observed: `exit ${String(result.status)}`,
            };
          }
          break;
        }
        case 'git': {
          if (kind.check === 'clean-tree') {
            const status = policyGit(context.repoRoot, [
              'status',
              '--porcelain=v1',
              '--untracked-files=all',
            ]);
            const pending = (status ?? '').split('\n').filter((line) => line !== '').length;
            observation =
              status === undefined
                ? { matched: false, observed: 'git status failed', unobservable: true }
                : { matched: pending === 0, observed: `${String(pending)} pending change(s)` };
            break;
          }
          const reference = kind.base ?? context.baseCommit;
          if (reference === undefined) {
            observation = { matched: false, observed: 'no base supplied', unobservable: true };
            break;
          }
          let base: string;
          try {
            base = resolveBaseCommit(context.repoRoot, reference);
          } catch {
            observation = {
              matched: false,
              observed: `base ${reference} does not resolve`,
              unobservable: true,
            };
            break;
          }
          if (kind.check === 'commit-range') {
            const result = yield* runCommand(probe.id, [
              'node',
              'scripts/check-commit-range.mjs',
              base,
              'HEAD',
            ]);
            observation =
              result.errorCode === undefined && result.signal === null
                ? { matched: result.status === 0, observed: `exit ${String(result.status)}` }
                : { matched: false, observed: 'commit range unobservable', unobservable: true };
            break;
          }
          const head = policyGit(context.repoRoot, [
            'rev-parse',
            '--verify',
            'HEAD^{commit}',
          ])?.trim();
          const mergeBase =
            head === undefined
              ? undefined
              : policyGit(context.repoRoot, ['merge-base', base, head])?.trim();
          observation =
            mergeBase === undefined
              ? { matched: false, observed: 'no merge-base with the base', unobservable: true }
              : {
                  matched: mergeBase === base,
                  observed: `merge-base ${mergeBase.slice(0, 12)} for base ${base.slice(0, 12)}`,
                };
          break;
        }
        case 'registry':
          observation = registryObservation(kind.url, kind.expected_version);
          break;
        case 'toolchain':
          observation = toolchainObservation(context.repoRoot, kind.manifest_path);
          break;
        case 'credential':
          observation = credentialObservation(context, kind.manifest_id);
          break;
      }
    }
    const status: PreflightProbeStatus = observation.skipped
      ? 'skipped'
      : observation.matched
        ? 'pass'
        : observation.unobservable === true || probe.class === 'extrinsic'
          ? 'blocked'
          : 'fail';
    statuses.set(probe.id, status);
    observations.push({
      id: probe.id,
      class: probe.class,
      kind: probe.probe.kind,
      status,
      expected: redactDiagnosticText(probe.expected),
      observed: observation.observed === null ? null : redactDiagnosticText(observation.observed),
      remediation: probe.remediation,
    });
  }
  const failing = observations.filter(
    (entry) => entry.status === 'blocked' || entry.status === 'fail',
  );
  const outcome = failing.some((entry) => entry.status === 'blocked')
    ? 'BLOCKED'
    : failing.length > 0
      ? 'FAIL'
      : 'PASS';
  return {
    outcome,
    observations,
    reason:
      outcome === 'PASS'
        ? 'probes-pass'
        : redactDiagnosticText(
            failing
              .map(
                (entry) =>
                  `probe ${entry.id} ${entry.status}: expected ${entry.expected}; observed ${entry.observed ?? 'nothing'}`,
              )
              .join('; '),
          ),
    remediation: failing.map((entry) => entry.remediation),
    stdout: redactDiagnosticText(stdout),
    stderr: redactDiagnosticText(stderr),
  };
}
