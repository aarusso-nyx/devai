// ADR-CHK-0001, Inspector Adversarial Acceptance IA-001: an extrinsic preflight
// probe failure yields BLOCKED for the probe node and blocked-environment for
// every dependent, the dependent never executes, and no FAIL is written to the
// cache. An intrinsic probe failure yields FAIL and is cached as FAIL, and a
// failing ordinary node beside a passing preflight node still yields FAIL.
//
// Red today: validateDescriptor in packages/cli/src/services/check-runner/policy.ts
// requires a non-empty argv on every node, so a `preflight-v1` node (probes, no
// argv) is refused with CHECK_RUNNER_DESCRIPTOR: malformed task preflight, and
// the TaskOutcome union has no BLOCKED member.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runCheckTasks,
  type CheckRunnerOptions,
  type TaskExecutionResult,
} from '../../src/services/check-runner/index.js';

const TOOLCHAIN = { node: 'v-test' } as const;
const UNREACHABLE_REGISTRY = 'http://127.0.0.1:9/';
const REGISTRY_REMEDIATION = 'Restore network access to the fixture registry at 127.0.0.1:9.';
const PREFLIGHT = 'preflight';
const DEPENDENT = 'test:local-full';
const CACHE_ROOT = '.devai/state/check-cache/v1';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

let invocationOrdinal = 0;
function withRunnerScope<T>(callback: () => T): T {
  invocationOrdinal += 1;
  const invocationId = `check-runner-preflight-blocked-test-${String(invocationOrdinal)}`;
  let receiptOrdinal = 0;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'check-runner-preflight-blocked-test',
    issuer_version: '1.0.0',
    invocation_id: invocationId,
    canonicalSha256: () => 'c'.repeat(64),
    randomId: () => `${invocationId}-${String(++receiptOrdinal)}`,
    now: () => '2026-09-26T00:00:00.000Z',
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

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content, 'utf8');
}

type Probe = Readonly<Record<string, unknown>>;

function registryProbe(): Probe {
  return {
    id: 'registry-reachable',
    class: 'extrinsic',
    probe: { kind: 'registry', url: UNREACHABLE_REGISTRY },
    expected: `registry ${UNREACHABLE_REGISTRY} is reachable`,
    observed: null,
    status: 'pass',
    remediation: REGISTRY_REMEDIATION,
    depends_on: [],
  };
}

function intrinsicCommandProbe(): Probe {
  return {
    id: 'candidate-command',
    class: 'intrinsic',
    probe: { kind: 'command', argv: ['node', '-e', 'process.exit(1)'], expected_exit: 0 },
    expected: 'the candidate command exits 0',
    observed: null,
    status: 'pass',
    remediation: 'Fix the candidate so the command exits 0.',
    depends_on: [],
  };
}

function passingFileProbe(): Probe {
  return {
    id: 'descriptor-present',
    class: 'intrinsic',
    probe: { kind: 'file', path: 'test-tasks.json', must_exist: true },
    expected: 'test-tasks.json is present',
    observed: null,
    status: 'pass',
    remediation: 'Commit test-tasks.json.',
    depends_on: [],
  };
}

function preflightNode(probes: readonly Probe[]) {
  return {
    nodeId: PREFLIGHT,
    dependencies: [],
    cwd: '.',
    runner: 'preflight-v1',
    probes,
    inputSelectors: [{ kind: 'exact', pattern: 'test-tasks.json' }],
    toolchainKeys: ['node'],
    allowlistedEnv: [],
    outputContract: { kind: 'probes', requiredStatus: 'pass' },
  };
}

function ordinaryNode(nodeId: string, runner: string, argv: readonly string[], deps: string[]) {
  return {
    nodeId,
    dependencies: deps,
    argv,
    cwd: '.',
    runner,
    inputSelectors: [{ kind: 'glob', pattern: '**' }],
    toolchainKeys: ['node'],
    allowlistedEnv: [],
    outputContract: { kind: 'marker', value: nodeId },
  };
}

function descriptor(tasks: readonly unknown[]) {
  return {
    schemaVersion: '1.0.0',
    descriptorVersion: 'preflight-blocked-fixture',
    repositoryId: 'fixture/preflight',
    fallbackNodeId: DEPENDENT,
    dynamicFallbackSelectors: [],
    tasks,
    profiles: [{ profileId: 'affected', mode: 'affected', requiredNodes: [], eligibleNodes: [] }],
  };
}

function repository(tasks: readonly unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-preflight-blocked-'));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Fixture']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  put(root, '.gitignore', '.devai/state/*\n');
  put(root, 'test-tasks.json', `${JSON.stringify(descriptor(tasks), null, 2)}\n`);
  put(root, 'src/app.ts', 'export const value = 1;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  return root;
}

/** Executes declared argv for real and records every node identity it was asked to run. */
function recordingExecutor(executed: string[]): NonNullable<CheckRunnerOptions['executeTask']> {
  return (argv, cwd, timeoutMs, _environment, identity): TaskExecutionResult => {
    executed.push(identity.nodeId);
    const result = spawnSync(argv[0] ?? '', argv.slice(1), {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      env: { PATH: process.env.PATH ?? '' },
    });
    return {
      status: result.status,
      signal: result.signal,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
    };
  };
}

function run(root: string, executed: string[]) {
  return withRunnerScope(() =>
    runCheckTasks({
      repoRoot: root,
      target: 'local',
      operation: 'run',
      toolchain: TOOLCHAIN,
      environment: {},
      executeTask: recordingExecutor(executed),
      now: () => '2026-09-26T00:00:00.000Z',
    }),
  );
}

/** Every JSON document the runner wrote under the cache root, keyed by relative path. */
function cacheDocuments(root: string): ReadonlyMap<string, Record<string, unknown>> {
  const cacheRoot = join(root, CACHE_ROOT);
  const documents = new Map<string, Record<string, unknown>>();
  if (!existsSync(cacheRoot)) return documents;
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.json')) {
        documents.set(
          path.slice(cacheRoot.length + 1),
          JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>,
        );
      }
    }
  };
  walk(cacheRoot);
  return documents;
}

function nodeIndex(root: string, nodeId: string): Record<string, unknown> | undefined {
  const path = join(root, CACHE_ROOT, 'nodes', `${Buffer.from(nodeId).toString('base64url')}.json`);
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
    : undefined;
}

describe('preflight-v1 BLOCKED semantics (ADR-CHK-0001 IA-001)', () => {
  it('blocks an unreachable extrinsic registry probe and never runs or fails the dependent', () => {
    const root = repository([
      preflightNode([registryProbe()]),
      ordinaryNode(DEPENDENT, 'vitest-v1', ['node', '-e', 'process.exit(0)'], [PREFLIGHT]),
    ]);
    const executed: string[] = [];
    const report = run(root, executed);

    const probe = report.execution?.find((entry) => entry.nodeId === PREFLIGHT);
    const dependent = report.execution?.find((entry) => entry.nodeId === DEPENDENT);
    expect(probe?.outcome, 'the extrinsic probe node outcome').toBe('BLOCKED');
    expect(dependent, 'the dependent is reported').toBeDefined();
    expect(JSON.stringify(dependent), 'the dependent is marked blocked-environment').toContain(
      'blocked-environment',
    );
    expect(dependent?.disposition, 'the dependent is not executed').not.toBe('executed');
    expect(['PASS', 'FAIL']).not.toContain(dependent?.outcome);
    expect(executed, 'the executor never receives the dependent').not.toContain(DEPENDENT);
    expect(report.exitCode, 'a blocked plan is not a passing plan').not.toBe(0);
    expect(JSON.stringify(report), 'the report names the probe remediation').toContain(
      REGISTRY_REMEDIATION,
    );

    const documents = cacheDocuments(root);
    const failures = [...documents].filter(
      ([, document]) => document.outcome === 'FAIL' || document.status === 'FAIL',
    );
    expect(
      failures.map(([path]) => path),
      'no FAIL entry is written under the cache root',
    ).toEqual([]);
    const reusable = [...documents].filter(
      ([path, document]) => path.startsWith('results/') && document.nodeId === PREFLIGHT,
    );
    expect(
      reusable.map(([path]) => path),
      'no reusable result is written for BLOCKED',
    ).toEqual([]);
    expect(nodeIndex(root, PREFLIGHT)?.outcome).not.toBe('PASS');
  });

  it('fails an intrinsic command probe whose exit differs from expected_exit and caches FAIL', () => {
    const root = repository([
      preflightNode([intrinsicCommandProbe()]),
      ordinaryNode(DEPENDENT, 'vitest-v1', ['node', '-e', 'process.exit(0)'], [PREFLIGHT]),
    ]);
    const executed: string[] = [];
    const report = run(root, executed);

    const probe = report.execution?.find((entry) => entry.nodeId === PREFLIGHT);
    expect(probe?.outcome, 'the intrinsic probe node outcome').toBe('FAIL');
    expect(executed, 'the executor never receives the dependent').not.toContain(DEPENDENT);
    expect(report.exitCode).not.toBe(0);
    expect(nodeIndex(root, PREFLIGHT)?.outcome, 'the FAIL is cached').toBe('FAIL');
  });

  it('keeps a failing ordinary node FAIL and cached beside a passing preflight node', () => {
    const root = repository([
      preflightNode([passingFileProbe()]),
      ordinaryNode('lint', 'node-v1', ['node', '-e', 'process.exit(1)'], [PREFLIGHT]),
      ordinaryNode(DEPENDENT, 'vitest-v1', ['node', '-e', 'process.exit(0)'], [PREFLIGHT, 'lint']),
    ]);
    const executed: string[] = [];
    const report = run(root, executed);

    expect(report.execution?.find((entry) => entry.nodeId === PREFLIGHT)?.outcome).toBe('PASS');
    expect(report.execution?.find((entry) => entry.nodeId === 'lint')?.outcome).toBe('FAIL');
    expect(nodeIndex(root, 'lint')?.outcome, 'the lint FAIL is cached').toBe('FAIL');
    expect(executed).toContain('lint');
  });
});
