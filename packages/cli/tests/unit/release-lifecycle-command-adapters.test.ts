import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CAC } from 'cac';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { buildReleasePlanReceipt } from '../../src/services/release-lifecycle.js';
import { builtInReleaseLifecycleLocalProvider } from '../../src/services/release-lifecycle-local-adapters.js';

const { runChecks, declaredRole } = vi.hoisted(() => ({
  runChecks: vi.fn(),
  declaredRole: { value: 'inspector' as 'architect' | 'inspector' },
}));
vi.mock('../../src/services/check-runner/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/check-runner/index.js')>()),
  runCheckTasks: runChecks,
}));

vi.mock('../../src/authority/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/authority/index.js')>()),
  declaredInvocationAuthority: () => ({
    kind: 'human',
    role: declaredRole.value,
    declaration_source: 'cli-flag',
  }),
}));

const {
  installReleaseLifecycleCommandAdapters,
  releaseCertify,
  releasePreflight,
  releasePrepare,
  releaseResume,
} = await import('../../src/commands/release/lifecycle.js');

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  declaredRole.value = 'inspector';
  vi.restoreAllMocks();
});

function captureAction(definition = releasePreflight) {
  let handler: ((options: Record<string, unknown>) => Promise<void>) | undefined;
  const command = {
    option: () => command,
    action: (value: typeof handler) => {
      handler = value;
      return command;
    },
  };
  definition.register({ command: () => command } as unknown as CAC);
  if (handler === undefined) throw new Error(`${definition.name} handler was not registered`);
  return handler;
}

function json(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(String(result.stderr));
  return String(result.stdout).trim();
}

async function withLocalMutationScope<T>(callback: () => Promise<T>): Promise<T> {
  let ordinal = 0;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'release-local-adapter-test',
    issuer_version: '1.0.0',
    invocation_id: 'release-local-adapter-test',
    canonicalSha256,
    randomId: () => `release-local-adapter-test-${String(++ordinal)}`,
    now: () => '2026-09-03T00:00:00.000Z',
    receipt_ttl_ms: 30_000,
  });
  const scope: AuthorityHostEffectScope = {
    action_id: 'release prepare',
    invocation_id: 'release-local-adapter-test',
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (_request, apply) => apply(),
  };
  try {
    return await runWithAuthorityHostEffects(scope, callback);
  } finally {
    issuer.dispose();
  }
}

describe('release lifecycle command adapter composition', () => {
  it('executes the public preflight through the installed local provider', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-release-command-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'law/policy'), { recursive: true });
    mkdirSync(join(root, 'receipts'), { recursive: true });
    for (const name of [
      'release-verification.json',
      'release-lifecycle.json',
      'action-registry.json',
    ]) {
      cpSync(join(process.cwd(), 'law/policy', name), join(root, 'law/policy', name));
    }
    const manifestBytes = `${canonicalJson({
      name: '@aarusso-nyx/devai',
      version: '1.5.0',
      bin: { 'mode-fixture': 'bin/mode-fixture.mjs' },
    })}\n`;
    mkdirSync(join(root, 'packages/cli'), { recursive: true });
    writeFileSync(join(root, 'packages/cli/package.json'), manifestBytes);
    mkdirSync(join(root, 'packages/cli/bin'), { recursive: true });
    writeFileSync(join(root, 'packages/cli/bin/mode-fixture.mjs'), '#!/usr/bin/env node\n');
    chmodSync(join(root, 'packages/cli/bin/mode-fixture.mjs'), 0o755);
    writeFileSync(
      join(root, 'test-tasks.json'),
      `${canonicalJson({
        schemaVersion: '1.0.0',
        descriptorVersion: 'release-test-v1',
        repositoryId: 'aarusso-nyx/devai',
        fallbackNodeId: 'format',
        dynamicFallbackSelectors: [],
        tasks: [
          {
            nodeId: 'format',
            dependencies: [],
            argv: ['node', '-e', 'process.exit(0)'],
            cwd: '.',
            runner: 'node-v1',
            inputSelectors: [{ kind: 'glob', pattern: '**' }],
            toolchainKeys: ['node'],
            allowlistedEnv: [],
            outputContract: { kind: 'test', requiredResult: 'pass' },
          },
        ],
        profiles: [
          {
            profileId: 'affected',
            mode: 'affected',
            requiredNodes: ['format'],
            eligibleNodes: ['format'],
          },
          { profileId: 'rc', mode: 'fixed', requiredNodes: ['format'] },
        ],
      })}\n`,
    );
    git(root, ['init', '-q']);
    git(root, ['config', 'user.name', 'Release Test']);
    git(root, ['config', 'user.email', 'release@example.invalid']);
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'candidate']);
    const commit = git(root, ['rev-parse', 'HEAD']);
    const tree = git(root, ['rev-parse', 'HEAD^{tree}']);
    mkdirSync(join(root, '.devai/state'), { recursive: true });
    const intent = {
      schemaVersion: '1.0.0',
      release_unit: '@aarusso-nyx/devai',
      current_version: '1.4.5',
      target_version: '1.5.0',
      support: 'current',
      change_kind: 'behavioral',
      changed_paths: ['packages/cli/src/services/release-lifecycle-execution.ts'],
      changed_packages: ['@aarusso-nyx/devai'],
      candidate: { commit, tree },
      base: { commit: '7'.repeat(40), tree: '8'.repeat(40) },
    };
    writeFileSync(join(root, 'release-intent.json'), `${canonicalJson(intent)}\n`);
    const receipt = buildReleasePlanReceipt({
      repository_id: 'aarusso-nyx/devai',
      intent_path: 'release-intent.json',
      intent,
      release_verification_profile: json(join(root, 'law/policy/release-verification.json')),
      release_lifecycle_policy: json(join(root, 'law/policy/release-lifecycle.json')),
      action_registry: json(join(root, 'law/policy/action-registry.json')),
    });
    writeFileSync(join(root, 'receipts/plan.json'), `${canonicalJson(receipt)}\n`);
    const manifestDigest = createHash('sha256').update(manifestBytes).digest('hex');
    const request = {
      schemaVersion: '1.0.0',
      request_kind: 'release-lifecycle-request',
      action_id: 'release preflight',
      repository_locator: { id: 'aarusso-nyx/devai', commit, tree },
      candidate_locator: {
        commit,
        tree,
        release_units: [
          {
            release_unit: '@aarusso-nyx/devai',
            version: '1.5.0',
            package_roster: [
              {
                package_id: '@aarusso-nyx/devai',
                manifest_path: 'packages/cli/package.json',
                manifest_digest_sha256: manifestDigest,
              },
            ],
          },
        ],
      },
      receipt_locators: [
        {
          kind: 'release-plan-receipt',
          receipt_id: receipt.receipt_id,
          receipt_digest_sha256: receipt.receipt_digest_sha256,
          path: 'receipts/plan.json',
        },
      ],
    } as const;
    const requestPath = join(root, 'request.json');
    writeFileSync(requestPath, `${canonicalJson(request)}\n`);
    const provider = vi.fn(() => ({
      outcome: 'success' as const,
      material: {
        release_units: [
          {
            release_unit: '@aarusso-nyx/devai',
            version: '1.5.0',
            packages: [
              {
                package_id: '@aarusso-nyx/devai',
                manifest: {
                  path: 'packages/cli/package.json',
                  sha256: manifestDigest,
                  size_bytes: 1,
                },
                tarball: null,
                sbom: null,
                evidence_manifest: null,
                provider_result: null,
                trust: null,
              },
            ],
          },
        ],
        inputs: [
          {
            kind: 'release-lifecycle-policy',
            path: 'law/policy/release-lifecycle.json',
            sha256: canonicalSha256(json(join(root, 'law/policy/release-lifecycle.json'))),
          },
        ],
        evidence: {
          manifest_digest_sha256: 'b'.repeat(64),
          receipt_digests: [receipt.receipt_digest_sha256],
          independently_checkable: true as const,
        },
        artifacts: [],
      },
    }));
    const uninstall = installReleaseLifecycleCommandAdapters({
      provider: () => provider,
      offline_verification_provider: () => undefined,
      authorization: () => undefined,
      offline_receipt_verifier: () => undefined,
      publication_controls: () => undefined,
    });
    cleanups.push(uninstall);
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await withAuthorityHostTestScope(() =>
      captureAction()({ request: requestPath, repoRoot: root, stateRoot: join(root, 'state') }),
    );
    expect(provider).toHaveBeenCalledOnce();
    expect(output).toHaveBeenCalledWith(expect.stringContaining('"state":"preflight_passed"'));

    uninstall();
    output.mockClear();
    const errorOutput = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    runChecks.mockReturnValue({
      schemaVersion: '1.0.0',
      operation: 'run',
      plan: {
        descriptorDigest: canonicalSha256(json(join(root, 'test-tasks.json'))),
        taskPolicyDigest: 'a'.repeat(64),
        toolchainDigest: 'b'.repeat(64),
      },
      execution: [
        {
          nodeId: 'format',
          taskKey: 'format',
          disposition: 'executed',
          outcome: 'PASS',
          reason: 'required-floor',
          durationMs: 1,
        },
      ],
      preflightReceipt: {
        digest: 'd'.repeat(64),
        path: '.devai/cache/preflight-receipts/test.json',
        value: {},
      },
      exitCode: 0,
    });
    await withAuthorityHostTestScope(() =>
      captureAction()({
        request: requestPath,
        repoRoot: root,
        stateRoot: join(root, 'stock-state'),
      }),
    );
    expect(runChecks).toHaveBeenCalledOnce();
    expect(errorOutput.mock.calls, JSON.stringify(errorOutput.mock.calls)).toEqual([]);
    expect(output).toHaveBeenCalledWith(expect.stringContaining('"state":"preflight_passed"'));

    const resumeRequestPath = join(root, 'resume-request.json');
    writeFileSync(
      resumeRequestPath,
      `${canonicalJson({
        schemaVersion: '1.0.0',
        request_kind: 'release-lifecycle-request',
        action_id: 'release resume',
        repository_locator: request.repository_locator,
        candidate_locator: request.candidate_locator,
      })}\n`,
    );
    output.mockClear();
    await captureAction(releaseResume)({
      request: resumeRequestPath,
      repoRoot: root,
      stateRoot: join(root, 'stock-state'),
    });
    expect(output).toHaveBeenCalledWith(expect.stringContaining('"next_action":"release certify"'));

    const certifyRequestPath = join(root, 'certify-request.json');
    writeFileSync(
      certifyRequestPath,
      `${canonicalJson({ ...request, action_id: 'release certify' })}\n`,
    );
    runChecks
      .mockReturnValueOnce({
        schemaVersion: '1.0.0',
        operation: 'run',
        plan: {
          descriptorDigest: canonicalSha256(json(join(root, 'test-tasks.json'))),
          taskPolicyDigest: 'c'.repeat(64),
          toolchainDigest: 'd'.repeat(64),
        },
        execution: [
          {
            nodeId: 'format',
            taskKey: 'format',
            disposition: 'reused',
            outcome: 'PASS',
            reason: 'required-floor',
            durationMs: 0,
          },
        ],
        preflightReceipt: {
          digest: 'e'.repeat(64),
          path: '.devai/cache/preflight-receipts/certify.json',
          value: {},
        },
        exitCode: 0,
      })
      .mockReturnValueOnce({
        schemaVersion: '1.0.0',
        operation: 'run',
        plan: {
          descriptorDigest: canonicalSha256(json(join(root, 'test-tasks.json'))),
          taskPolicyDigest: 'e'.repeat(64),
          toolchainDigest: 'f'.repeat(64),
        },
        execution: [
          {
            nodeId: 'test',
            taskKey: 'test',
            disposition: 'executed',
            outcome: 'PASS',
            reason: 'selected',
            durationMs: 1,
          },
        ],
        receipt: {
          digest: 'f'.repeat(64),
          path: '.devai/cache/receipts/certify.json',
          value: {},
        },
        exitCode: 0,
      });
    output.mockClear();
    await withAuthorityHostTestScope(() =>
      captureAction(releaseCertify)({
        request: certifyRequestPath,
        repoRoot: root,
        stateRoot: join(root, 'stock-state'),
      }),
    );
    expect(output).toHaveBeenCalledWith(expect.stringContaining('"state":"certified"'));

    const prepareRequestPath = join(root, 'prepare-request.json');
    writeFileSync(
      prepareRequestPath,
      `${canonicalJson({
        ...request,
        action_id: 'release prepare',
        destination: {
          kind: 'local-staging',
          exact_identifier: '.devai/state/release-staging',
        },
      })}\n`,
    );
    writeFileSync(
      join(root, 'packages/cli/package.json'),
      `${canonicalJson({
        name: '@aarusso-nyx/devai',
        version: '1.5.0',
        private_live_mutation: true,
      })}\n`,
    );
    chmodSync(join(root, 'packages/cli/bin/mode-fixture.mjs'), 0o644);
    declaredRole.value = 'architect';
    output.mockClear();
    await withLocalMutationScope(() =>
      captureAction(releasePrepare)({
        request: prepareRequestPath,
        repoRoot: root,
        stateRoot: join(root, 'stock-state'),
      }),
    );
    expect(output.mock.calls, JSON.stringify(errorOutput.mock.calls)).toContainEqual([
      expect.stringContaining('"state":"prepared"'),
    ]);
    expect(
      readFileSync(join(root, '.devai/state/release-staging/aarusso-nyx-devai-1.5.0.cdx.json')),
    ).toBeInstanceOf(Buffer);
    const tarballPath = join(root, '.devai/state/release-staging/aarusso-nyx-devai-1.5.0.tgz');
    const packedManifest = spawnSync('tar', ['-xOf', tarballPath, 'package/package.json'], {
      encoding: 'utf8',
    });
    expect(packedManifest.status).toBe(0);
    expect(packedManifest.stdout).toBe(manifestBytes);
    const packedModes = spawnSync('tar', ['-tvzf', tarballPath], { encoding: 'utf8' });
    expect(packedModes.status).toBe(0);
    expect(packedModes.stdout).toMatch(/^-rwxr-xr-x .* package\/bin\/mode-fixture\.mjs$/mu);
    expect(
      readdirSync(join(root, '.devai/state')).filter((name) =>
        name.startsWith('.devai-release-prepare-'),
      ),
    ).toEqual([]);

    symlinkSync('state', join(root, '.devai/linked-state'));
    const directPrepare = builtInReleaseLifecycleLocalProvider(
      {
        repo_root: root,
        resolve_receipt: () => receipt,
        resolve_plan_input: (input) => json(join(root, String(input['path']))),
        read_contained_bytes: (path) => readFileSync(join(root, path)),
      },
      'release prepare',
    );
    if (directPrepare === undefined) throw new Error('stock prepare adapter missing');
    const unsafePreparation = await directPrepare({
      ...request,
      action_id: 'release prepare',
      destination: { kind: 'local-staging', exact_identifier: '.devai/linked-state/escape' },
    });
    expect(unsafePreparation).toMatchObject({
      outcome: 'failure',
      code: 'release-destination-path-unsafe',
    });
    expect(readdirSync(join(root, '.devai/state'))).not.toContain('escape');

    const adversarial = await withLocalMutationScope(async () =>
      directPrepare({
        ...request,
        action_id: 'release prepare',
        destination: {
          kind: 'local-staging',
          exact_identifier: '.devai/state/adversarial-release',
        },
      }),
    );
    expect(adversarial).toMatchObject({ outcome: 'success' });
    if (adversarial.outcome !== 'success' || adversarial.transaction === undefined) {
      throw new Error('adversarial prepare transaction missing');
    }
    const stageName = readdirSync(join(root, '.devai/state')).find((name) =>
      name.startsWith('.devai-release-prepare-'),
    );
    if (stageName === undefined) throw new Error('private prepare stage missing');
    const stagedTarball = join(
      root,
      '.devai/state',
      stageName,
      'publish/aarusso-nyx-devai-1.5.0.tgz',
    );
    const hostileLink = join(root, '.devai/state/hostile-hardlink.tgz');
    linkSync(stagedTarball, hostileLink);
    await expect(
      withLocalMutationScope(async () => adversarial.transaction?.commit()),
    ).rejects.toThrow('release-staging-file-identity-invalid');
    await withLocalMutationScope(async () => adversarial.transaction?.dispose());
    unlinkSync(hostileLink);
    expect(existsSync(join(root, '.devai/state/adversarial-release'))).toBe(false);
    expect(
      readdirSync(join(root, '.devai/state')).filter((name) =>
        name.startsWith('.devai-release-prepare-'),
      ),
    ).toEqual([]);
    declaredRole.value = 'inspector';

    output.mockClear();
    errorOutput.mockClear();
    symlinkSync('plan.json', join(root, 'receipts/plan-link.json'));
    const unsafeRequestPath = join(root, 'unsafe-request.json');
    writeFileSync(
      unsafeRequestPath,
      `${canonicalJson({
        ...request,
        receipt_locators: [{ ...request.receipt_locators[0], path: 'receipts/plan-link.json' }],
      })}\n`,
    );
    const unsafeProvider = vi.fn(() => ({ outcome: 'failure' as const }));
    cleanups.push(
      installReleaseLifecycleCommandAdapters({
        provider: () => unsafeProvider,
        offline_verification_provider: () => undefined,
        authorization: () => undefined,
        offline_receipt_verifier: () => undefined,
        publication_controls: () => undefined,
      }),
    );
    await withAuthorityHostTestScope(() =>
      captureAction()({
        request: unsafeRequestPath,
        repoRoot: root,
        stateRoot: join(root, 'unsafe-state'),
      }),
    );
    expect(unsafeProvider).not.toHaveBeenCalled();
    expect(errorOutput).toHaveBeenCalledWith(
      expect.stringContaining('release-receipt-path-unsafe'),
    );
  });
});
