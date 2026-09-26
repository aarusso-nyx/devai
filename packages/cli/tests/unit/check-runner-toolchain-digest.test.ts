// ADR-CHK-0002, Inspector Adversarial Acceptance IA-003: the task-key
// toolchain digest must derive from the toolchain manifest bytes, so that
// editing the manifest invalidates every cached result — even a field a
// given task never names in toolchainKeys. Today buildTaskPlan only hashes
// the resolved values a task explicitly declares in toolchainKeys
// (packages/cli/src/services/check-runner/policy.ts), never the manifest
// file as a whole, so this is the smallest integration-style reproduction:
// two manifests differing only in an unrelated field (constants) resolve to
// the same declared toolchainKeys ('node'), and today's runner therefore
// plans the same task key for both.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { afterEach, expect, it } from 'vitest';
import { sha256Hex } from '../../src/services/check-runner/index.js';
import { buildTaskPlan } from '../../src/services/check-runner/policy.js';
import type { TaskDescriptor } from '../../src/services/check-runner/types.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

let invocationOrdinal = 0;
function withRunnerScope<T>(callback: () => T): T {
  invocationOrdinal += 1;
  const invocationId = `check-runner-toolchain-digest-test-${String(invocationOrdinal)}`;
  let receiptOrdinal = 0;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'check-runner-toolchain-digest-test',
    issuer_version: '1.0.0',
    invocation_id: invocationId,
    canonicalSha256: () => 'c'.repeat(64),
    randomId: () => `${invocationId}-${String(++receiptOrdinal)}`,
    now: () => '2026-08-10T00:00:00.000Z',
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

function git(root: string, args: readonly string[]): void {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-toolchain-digest-'));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Fixture']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(root, 'file.txt'), 'content\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  return root;
}

function descriptorFixture(): TaskDescriptor {
  return {
    schemaVersion: '1.0.0',
    descriptorVersion: 'toolchain-digest-fixture',
    repositoryId: 'fixture/repo',
    fallbackNodeId: null,
    dynamicFallbackSelectors: [],
    tasks: [
      {
        nodeId: 'check',
        dependencies: [],
        argv: ['node'],
        cwd: '.',
        runner: 'node-v1',
        inputSelectors: [{ kind: 'glob', pattern: '**' }],
        toolchainKeys: ['node'],
        allowlistedEnv: [],
        outputContract: { kind: 'marker', value: 'check' },
      },
    ],
    profiles: [{ profileId: 'rc', mode: 'fixed', requiredNodes: ['check'] }],
  };
}

interface ManifestFixture {
  readonly schemaVersion: '1.0.0';
  readonly runtimes: { readonly node: string; readonly pnpm: string; readonly git: string };
  readonly actions: Record<string, never>;
  readonly verifier: {
    readonly package: string;
    readonly version: string;
    readonly policy: string;
  };
  readonly constants: {
    readonly expected_action_count: number;
    readonly ledger_environment: string;
  };
}

function manifestFixture(overrides: { expectedActionCount?: number } = {}): ManifestFixture {
  return {
    schemaVersion: '1.0.0',
    runtimes: { node: '24.20.0', pnpm: '9.15.0', git: '2.47.3' },
    actions: {},
    verifier: {
      package: '@aarusso-nyx/devai',
      version: '1.5.4',
      policy: 'law/policy/trusted-local-rc-verifier-package.json',
    },
    constants: {
      expected_action_count: overrides.expectedActionCount ?? 57,
      ledger_environment: 'devai-ledger-verification',
    },
  };
}

function taskKeyFor(root: string, toolchain: Readonly<Record<string, string>>): string {
  const plan = withRunnerScope(() =>
    buildTaskPlan({
      repoRoot: root,
      descriptor: descriptorFixture(),
      target: 'rc',
      toolchain,
      environment: {},
      cacheState: () => ({ cacheState: 'execute' as const, reason: 'fixture' }),
    }),
  );
  const task = plan.tasks.find((entry) => entry.nodeId === 'check');
  if (task === undefined) throw new Error('CHECK_RUNNER_TOOLCHAIN_DIGEST_TEST: task not planned');
  return task.taskKey;
}

it('changes the toolchain digest and task key when the manifest bytes change, even when the declared node version is unchanged', () => {
  const root = initRepo();
  const manifestA = manifestFixture();
  const manifestB = manifestFixture({ expectedActionCount: 58 });
  // Sanity: only the manifest bytes differ (an unrelated constants field).
  // The 'node' runtime a task actually declares in toolchainKeys is the same
  // in both, which is exactly the gap IA-003 calls out.
  expect(manifestA.runtimes).toEqual(manifestB.runtimes);
  const bytesA = Buffer.from(JSON.stringify(manifestA));
  const bytesB = Buffer.from(JSON.stringify(manifestB));
  expect(sha256Hex(bytesA)).not.toBe(sha256Hex(bytesB));

  const keyA = taskKeyFor(root, { node: manifestA.runtimes.node });
  const keyB = taskKeyFor(root, { node: manifestB.runtimes.node });

  // RED until the runner folds the manifest bytes into the toolchain digest
  // bound into every task key (ADR-CHK-0002, IA-003). Today buildTaskPlan
  // hashes only the resolved values a task names in toolchainKeys, so a
  // manifest edit outside those keys leaves every cached task key unchanged
  // and every previously cached node reusable instead of forced to execute.
  expect(keyA).not.toBe(keyB);
});

it('keeps the toolchain digest and task key equal when the manifest bytes are identical', () => {
  const root = initRepo();
  const manifestA = manifestFixture();
  const manifestB = manifestFixture();
  expect(sha256Hex(Buffer.from(JSON.stringify(manifestA)))).toBe(
    sha256Hex(Buffer.from(JSON.stringify(manifestB))),
  );

  const keyA = taskKeyFor(root, { node: manifestA.runtimes.node });
  const keyB = taskKeyFor(root, { node: manifestB.runtimes.node });

  expect(keyA).toBe(keyB);
});
