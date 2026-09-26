// ADR-CHK-0001, Inspector Adversarial Acceptance IA-002: a BLOCKED result is
// never reusable on a later plan, even when the task key is unchanged. Re-plan
// with identical inputs and the probe node must execute again.
//
// Red today: the runner refuses a `preflight-v1` node (no argv) with
// CHECK_RUNNER_DESCRIPTOR: malformed task preflight, and CheckCache.inspect
// does not know the BLOCKED outcome, so a BLOCKED index is classified as a
// malformed (stale) entry instead of an entry that must execute again.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { afterEach, describe, expect, it } from 'vitest';
import { CheckCache } from '../../src/services/check-runner/cache.js';
import { sha256Hex } from '../../src/services/check-runner/canonical.js';
import {
  runCheckTasks,
  type TaskExecutionResult,
  type TaskOperation,
} from '../../src/services/check-runner/index.js';
import type { PlannedTask, TaskResult } from '../../src/services/check-runner/types.js';

const TOOLCHAIN = { node: 'v-test' } as const;
const PREFLIGHT = 'preflight';
const DEPENDENT = 'test:local-full';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

let invocationOrdinal = 0;
function withRunnerScope<T>(callback: () => T): T {
  invocationOrdinal += 1;
  const invocationId = `check-cache-blocked-test-${String(invocationOrdinal)}`;
  let receiptOrdinal = 0;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'check-cache-blocked-test',
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

function descriptor() {
  return {
    schemaVersion: '1.0.0',
    descriptorVersion: 'blocked-never-reusable-fixture',
    repositoryId: 'fixture/preflight',
    fallbackNodeId: DEPENDENT,
    dynamicFallbackSelectors: [],
    tasks: [
      {
        nodeId: PREFLIGHT,
        dependencies: [],
        cwd: '.',
        runner: 'preflight-v1',
        probes: [
          {
            id: 'registry-reachable',
            class: 'extrinsic',
            probe: { kind: 'registry', url: 'http://127.0.0.1:9/' },
            expected: 'registry http://127.0.0.1:9/ is reachable',
            observed: null,
            status: 'pass',
            remediation: 'Restore network access to the fixture registry.',
            depends_on: [],
          },
        ],
        inputSelectors: [{ kind: 'exact', pattern: 'test-tasks.json' }],
        toolchainKeys: ['node'],
        allowlistedEnv: [],
        outputContract: { kind: 'probes', requiredStatus: 'pass' },
      },
      {
        nodeId: DEPENDENT,
        dependencies: [PREFLIGHT],
        argv: ['node', '-e', 'process.exit(0)'],
        cwd: '.',
        runner: 'vitest-v1',
        inputSelectors: [{ kind: 'glob', pattern: '**' }],
        toolchainKeys: ['node'],
        allowlistedEnv: [],
        outputContract: { kind: 'marker', value: DEPENDENT },
      },
    ],
    profiles: [{ profileId: 'affected', mode: 'affected', requiredNodes: [], eligibleNodes: [] }],
  };
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-blocked-never-reusable-'));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Fixture']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  put(root, '.gitignore', '.devai/state/*\n');
  put(root, 'test-tasks.json', `${JSON.stringify(descriptor(), null, 2)}\n`);
  put(root, 'src/app.ts', 'export const value = 1;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  return root;
}

function check(root: string, operation: TaskOperation) {
  return withRunnerScope(() =>
    runCheckTasks({
      repoRoot: root,
      target: 'local',
      operation,
      toolchain: TOOLCHAIN,
      environment: {},
      executeTask: (): TaskExecutionResult => ({ status: 0, signal: null, stdout: '', stderr: '' }),
      now: () => '2026-09-26T00:00:00.000Z',
    }),
  );
}

describe('a BLOCKED result is never reusable (ADR-CHK-0001 IA-002)', () => {
  it('plans the probe node as execute after a BLOCKED run with identical inputs', () => {
    const root = repository();
    const first = check(root, 'run');
    const firstProbe = first.execution?.find((entry) => entry.nodeId === PREFLIGHT);
    expect(firstProbe?.outcome, 'the first run blocks').toBe('BLOCKED');

    const second = check(root, 'plan');
    const planned = second.plan.tasks.find((task) => task.nodeId === PREFLIGHT);
    expect(planned?.taskKey, 'identical inputs keep the task key').toBe(firstProbe?.taskKey);
    expect(planned?.cacheState, 'a BLOCKED probe is never reusable').toBe('execute');
    expect(planned?.cachedResultDigest).toBeUndefined();
  });

  it('executes the probe again on a second run instead of reusing the BLOCKED outcome', () => {
    const root = repository();
    check(root, 'run');
    const second = check(root, 'run');
    const probe = second.execution?.find((entry) => entry.nodeId === PREFLIGHT);
    expect(probe?.disposition, 'the probe is re-executed').toBe('executed');
    expect(probe?.outcome).toBe('BLOCKED');
  });

  it('inspects a BLOCKED index as execute even when it names a valid PASS result', () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-blocked-index-'));
    roots.push(root);
    const cacheRoot = join(root, 'cache');
    const task: PlannedTask = {
      nodeId: PREFLIGHT,
      taskKey: 'a'.repeat(64),
      dependencies: [],
      outputContract: {},
      argv: [],
      executable: { path: '/unused', sha256: 'b'.repeat(64) },
      cwd: '.',
      inputDigest: 'c'.repeat(64),
      inputPaths: [],
      matchedChangedPaths: [],
      cacheState: 'execute',
      reason: 'fixture',
    };
    const result: TaskResult = {
      schemaVersion: '1.0.0',
      nodeId: task.nodeId,
      taskKey: task.taskKey,
      status: 'PASS',
      inputDigest: task.inputDigest,
      dependencyResultDigests: {},
      outputDigests: {},
      startedAt: '2026-09-26T00:00:00.000Z',
      finishedAt: '2026-09-26T00:00:00.000Z',
    };
    const cache = new CheckCache(root, cacheRoot);
    const resultDigest = withRunnerScope(() => cache.writeResult(result));
    expect(resultDigest).toBe(sha256Hex(result));
    // Written as raw JSON: the outcome is BLOCKED, which a PASS-only reuse path must refuse.
    put(
      cacheRoot,
      `nodes/${Buffer.from(task.nodeId).toString('base64url')}.json`,
      JSON.stringify({
        schemaVersion: '1.0.0',
        nodeId: task.nodeId,
        taskKey: task.taskKey,
        outcome: 'BLOCKED',
        updatedAt: '2026-09-26T00:00:00.000Z',
        resultDigest,
      }),
    );
    expect(cache.inspect(task, {})).toEqual({
      cacheState: 'execute',
      reason: 'previous-blocked',
    });
  });
});
