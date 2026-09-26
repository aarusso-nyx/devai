// ADR-CHK-0002, Inspector Adversarial Acceptance IA-003: the runner's
// toolchain digest derives from the toolchain manifest bytes, so editing the
// manifest changes the digest bound into plans and preflight receipts even for
// a field no task names in toolchainKeys. Per-task keys deliberately stay
// manifest-independent: the vendored evidence verifier
// (packages/cli/vendor/evidence-verification/src/policy-builder.js) rebuilds
// task keys without a manifest field, and ledger verification compares the
// two byte for byte. Folding the manifest into task keys is a verifier release
// decision recorded as a backlog follow-up, not a silent divergence here.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { afterEach, expect, it } from 'vitest';
import { buildTaskPlan, runnerToolchainDigest } from '../../src/services/check-runner/policy.js';
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
        inputSelectors: [{ kind: 'exact', pattern: 'file.txt' }],
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

function writeManifest(root: string, manifest: ManifestFixture): void {
  mkdirSync(join(root, '.devai/config'), { recursive: true });
  writeFileSync(
    join(root, '.devai/config/toolchain.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
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

it('changes the toolchain digest when the manifest bytes change while task keys stay verifier-compatible', () => {
  const root = initRepo();
  const manifestA = manifestFixture();
  const manifestB = manifestFixture({ expectedActionCount: 58 });
  expect(manifestA.runtimes).toEqual(manifestB.runtimes);
  const toolchain = { node: manifestA.runtimes.node };

  writeManifest(root, manifestA);
  const digestA = runnerToolchainDigest(root, toolchain);
  const keyA = taskKeyFor(root, toolchain);
  writeManifest(root, manifestB);
  const digestB = runnerToolchainDigest(root, toolchain);
  const keyB = taskKeyFor(root, toolchain);

  expect(digestA).not.toBe(digestB);
  expect(keyA).toBe(keyB);
});

it('keeps the toolchain digest and task key equal when the manifest bytes are identical', () => {
  const root = initRepo();
  const toolchain = { node: manifestFixture().runtimes.node };
  writeManifest(root, manifestFixture());
  const digestA = runnerToolchainDigest(root, toolchain);
  const keyA = taskKeyFor(root, toolchain);
  writeManifest(root, manifestFixture());
  const digestB = runnerToolchainDigest(root, toolchain);
  const keyB = taskKeyFor(root, toolchain);

  expect(digestA).toBe(digestB);
  expect(keyA).toBe(keyB);
});
