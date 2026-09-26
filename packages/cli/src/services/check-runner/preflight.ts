import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readCheckPolicyGitSync, spawnSync } from '@devai-nyx/authority';
import { probeCredential, redactDiagnosticText } from '../credential-probe.js';
import type {
  PreflightProbe,
  PreflightProbeObservation,
  PreflightProbeStatus,
  TaskDescriptorNode,
  TaskExecutionResult,
} from './types.js';

/** Runner kind of a descriptor node that declares probes instead of argv (ADR-CHK-0001). */
export const PREFLIGHT_RUNNER = 'preflight-v1';
/** Adopter-owned probe list the `--preflight` target plans as a synthetic root node. */
export const ADOPTER_PREFLIGHT_PROBES_PATH = '.devai/config/preflight-probes.json';
export const ADOPTER_PREFLIGHT_NODE_ID = 'preflight';
/** Placeholder a command probe argument carries for the exact base commit. */
export const BASE_PLACEHOLDER = '{base}';

const REGISTRY_TIMEOUT_MS = 10_000;
const GIT_TIMEOUT_MS = 30_000;

/** Masks every token-shaped value and secret-named assignment in text. */
export { redactDiagnosticText };

const PROBE_ID = /^[a-z][a-z0-9-]*$/u;
const BARE_EXECUTABLE = /^[A-Za-z0-9._-]+$/u;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function exactKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validProbeKind(value: unknown): boolean {
  const probe = record(value);
  if (probe === undefined) return false;
  const text = (key: string) => typeof probe[key] === 'string' && probe[key] !== '';
  switch (probe.kind) {
    case 'environment':
      return (
        exactKeys(probe, ['kind', 'name', 'expected']) &&
        /^[A-Z][A-Z0-9_]*$/u.test(String(probe.name)) &&
        (probe.expected === undefined || typeof probe.expected === 'string')
      );
    case 'file':
      return (
        exactKeys(probe, ['kind', 'path', 'must_exist', 'expected_sha256']) &&
        text('path') &&
        typeof probe.must_exist === 'boolean' &&
        (probe.expected_sha256 === undefined ||
          /^[0-9a-f]{64}$/u.test(String(probe.expected_sha256)))
      );
    case 'command':
      return (
        exactKeys(probe, ['kind', 'argv', 'expected_exit']) &&
        Array.isArray(probe.argv) &&
        probe.argv.length > 0 &&
        probe.argv.every((argument) => typeof argument === 'string') &&
        BARE_EXECUTABLE.test(String(probe.argv[0])) &&
        Number.isInteger(probe.expected_exit) &&
        Number(probe.expected_exit) >= 0 &&
        Number(probe.expected_exit) <= 255
      );
    case 'git':
      return (
        exactKeys(probe, ['kind', 'check', 'base']) &&
        ['base-up-to-date', 'clean-tree', 'commit-range'].includes(String(probe.check)) &&
        (probe.base === undefined || text('base'))
      );
    case 'registry':
      return (
        exactKeys(probe, ['kind', 'url', 'expected_version']) &&
        text('url') &&
        URL.canParse(String(probe.url)) &&
        (probe.expected_version === undefined || typeof probe.expected_version === 'string')
      );
    case 'toolchain':
      return exactKeys(probe, ['kind', 'manifest_path']) && text('manifest_path');
    case 'credential':
      return exactKeys(probe, ['kind', 'manifest_id']) && text('manifest_id');
    default:
      return false;
  }
}

/**
 * Structural validation of a probe list against law/schemas/preflight-probe.schema.json,
 * plus the node-level rules: unique ids and known, acyclic dependencies.
 */
export function validatePreflightProbes(value: unknown, where: string): readonly PreflightProbe[] {
  const invalid = (detail: string) =>
    new Error(`CHECK_RUNNER_DESCRIPTOR: malformed preflight probes for ${where}: ${detail}`);
  if (!Array.isArray(value) || value.length === 0) throw invalid('a non-empty array is required');
  const ids = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const probe = record(entry);
    if (
      probe === undefined ||
      !exactKeys(probe, [
        'id',
        'class',
        'probe',
        'expected',
        'observed',
        'status',
        'remediation',
        'depends_on',
      ]) ||
      typeof probe.id !== 'string' ||
      !PROBE_ID.test(probe.id) ||
      (probe.class !== 'extrinsic' && probe.class !== 'intrinsic') ||
      !validProbeKind(probe.probe) ||
      typeof probe.expected !== 'string' ||
      probe.expected === '' ||
      (probe.observed !== null && typeof probe.observed !== 'string') ||
      !['pass', 'fail', 'blocked', 'skipped'].includes(String(probe.status)) ||
      typeof probe.remediation !== 'string' ||
      probe.remediation === '' ||
      !Array.isArray(probe.depends_on) ||
      probe.depends_on.some((id) => typeof id !== 'string' || !PROBE_ID.test(id)) ||
      new Set(probe.depends_on).size !== probe.depends_on.length
    ) {
      throw invalid(`probe ${String(index)}`);
    }
    if (ids.has(probe.id)) throw invalid(`duplicate probe ${probe.id}`);
    ids.add(probe.id);
  }
  const probes = value as readonly PreflightProbe[];
  for (const probe of probes) {
    const unknown = probe.depends_on.find((id) => !ids.has(id));
    if (unknown !== undefined) throw invalid(`probe ${probe.id} depends on unknown ${unknown}`);
  }
  orderedProbes(probes, where);
  return probes;
}

function orderedProbes(
  probes: readonly PreflightProbe[],
  where: string,
): readonly PreflightProbe[] {
  const byId = new Map(probes.map((probe) => [probe.id, probe]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: PreflightProbe[] = [];
  const visit = (probe: PreflightProbe): void => {
    if (visited.has(probe.id)) return;
    if (visiting.has(probe.id)) {
      throw new Error(`CHECK_RUNNER_DESCRIPTOR: preflight probe cycle at ${probe.id} in ${where}`);
    }
    visiting.add(probe.id);
    for (const id of probe.depends_on) {
      const dependency = byId.get(id);
      if (dependency !== undefined) visit(dependency);
    }
    visiting.delete(probe.id);
    visited.add(probe.id);
    ordered.push(probe);
  };
  probes.forEach(visit);
  return ordered;
}

/**
 * The adopter-owned probe list, or undefined when the repository declares none.
 * It is planned only by the `--preflight` target and stays outside the task policy.
 */
export function loadAdopterPreflightProbes(
  repoRoot: string,
): readonly PreflightProbe[] | undefined {
  const path = join(repoRoot, ADOPTER_PREFLIGHT_PROBES_PATH);
  if (!existsSync(path)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `CHECK_RUNNER_DESCRIPTOR: ${ADOPTER_PREFLIGHT_PROBES_PATH}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validatePreflightProbes(value, ADOPTER_PREFLIGHT_PROBES_PATH);
}

/** The synthetic root node that carries the adopter probe list. */
export function adopterPreflightNode(probes: readonly PreflightProbe[]): TaskDescriptorNode {
  return {
    nodeId: ADOPTER_PREFLIGHT_NODE_ID,
    dependencies: [],
    argv: [],
    probes,
    cwd: '.',
    runner: PREFLIGHT_RUNNER,
    inputSelectors: [{ kind: 'exact', pattern: ADOPTER_PREFLIGHT_PROBES_PATH }],
    toolchainKeys: ['node'],
    allowlistedEnv: [],
    outputContract: { kind: 'probes', requiredStatus: 'pass' },
  };
}

/** Read-only Git through the closed check-policy grammar; never a task process. */
function policyGit(repoRoot: string, args: readonly string[]): string | undefined {
  try {
    return readCheckPolicyGitSync(repoRoot, args).toString('utf8');
  } catch {
    return undefined;
  }
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
