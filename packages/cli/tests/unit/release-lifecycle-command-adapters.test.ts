import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CAC } from 'cac';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAuthorityDecisionIssuer,
  protectedReleaseHostEffect,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { withReleasePrepareAuthorityFixture } from '../helpers/release-prepare-authority-fixture.js';
import { declaredInvocationAuthority } from '../../src/authority/index.js';
import { finalizeCertificationManifest } from '../../src/services/release-prepare-kernel.js';
import { verifyResolvedReleasePlanReceipt } from '../../src/services/release-lifecycle.js';
import {
  executeReleaseLifecycleAction,
  ReleaseLifecycleFileStore,
  validateReleaseLifecycleRequest,
} from '../../src/services/release-lifecycle-execution.js';
import { builtInReleaseLifecycleLocalProvider } from '../../src/services/release-lifecycle-local-adapters.js';
import { createContainerReleaseCertificationAdapters } from '../../src/services/release-certification-provider.js';
import { createResolvedReleasePlanInputResolver } from '../../src/services/release-policy-resolution.js';
import { createFilesystemLifecyclePolicyFixture } from '../helpers/release-policy-resolution-fixture.js';
import type {
  ArtifactSinkObject,
  ArtifactSinkObjectReceipt,
  CertificationOutputClosureBinding,
} from '../../src/services/release-prepare-kernel.js';

const { runChecks, declaredRole } = vi.hoisted(() => ({
  runChecks: vi.fn(),
  declaredRole: { value: 'inspector' as 'architect' | 'inspector' },
}));
vi.mock('../../src/services/release-certification-container.js', () => ({
  ProtectedCertificationContainer: class {
    readonly identity = { protocol: 'test-protected-container-boundary' };
    runBound<T>(_binding: unknown, operation: () => T): T {
      return operation();
    }
    verifyRuntime(): void {}
  },
}));
vi.mock('../../src/services/check-runner/runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/check-runner/runner.js')>()),
  runCheckTasks: runChecks,
}));

vi.mock('../../src/authority/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/authority/index.js')>()),
  declaredInvocationAuthority: () => ({
    actor: {
      kind: 'human',
      role: declaredRole.value,
      declaration_source: 'cli-flag',
    },
    consent: {
      write: true,
      allow_publish: false,
      experimental: false,
    },
  }),
}));

const {
  installReleaseLifecycleCommandAdapters,
  releaseCertify,
  releaseExport,
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

async function withProtectedPreflightScope<T>(
  binding: {
    readonly repository: { readonly id: string; readonly commit: string; readonly tree: string };
    readonly task_policy_digest_sha256: string;
    readonly plan_receipt_digest_sha256: string;
    readonly state_root: string;
  },
  callback: () => T | Promise<T>,
): Promise<T> {
  let ordinal = 0;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'release-preflight-adapter-test',
    issuer_version: '1.0.0',
    invocation_id: 'release-preflight-adapter-test',
    canonicalSha256,
    randomId: () => `release-preflight-adapter-${String(++ordinal)}`,
    now: () => '2026-09-03T00:00:00.000Z',
    receipt_ttl_ms: 30_000,
  });
  const stateRoot = resolve(binding.state_root);
  const descriptors = new Set<number>();
  const statePath = (value: unknown): boolean => {
    if (typeof value !== 'string' || !isAbsolute(value)) return false;
    const path = relative(stateRoot, resolve(value));
    return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  };
  const scope: AuthorityHostEffectScope = {
    action_id: 'release preflight',
    invocation_id: 'release-preflight-adapter-test',
    effect: 'harness-write',
    receipt_store: issuer,
    apply_effect: (request, apply) => {
      const operation = protectedReleaseHostEffect(request);
      if (operation !== undefined) {
        if (
          operation.kind !== 'provider' ||
          operation.binding.action_id !== 'release preflight' ||
          canonicalJson(operation.binding.repository) !== canonicalJson(binding.repository) ||
          operation.binding.task_policy_digest_sha256 !== binding.task_policy_digest_sha256 ||
          operation.binding.plan_receipt_digest_sha256 !== binding.plan_receipt_digest_sha256
        ) {
          throw new Error('TEST_PROTECTED_PREFLIGHT_OPERATION_REQUIRED');
        }
        return apply();
      }
      if (
        request.kind !== 'filesystem' ||
        ![
          'mkdirSync',
          'openSync',
          'readFileSync',
          'writeSync',
          'fsyncSync',
          'closeSync',
          'lstatSync',
          'readdirSync',
          'renameSync',
          'unlinkSync',
        ].includes(request.symbol)
      )
        throw new Error('TEST_PROTECTED_PREFLIGHT_OPERATION_REQUIRED');
      const target = request.arguments[0];
      if (request.symbol === 'renameSync') {
        if (!statePath(target) || !statePath(request.arguments[1]))
          throw new Error('TEST_PROTECTED_PREFLIGHT_OPERATION_REQUIRED:path:renameSync');
        return apply();
      }
      if (typeof target === 'number') {
        if (!descriptors.has(target))
          throw new Error('TEST_PROTECTED_PREFLIGHT_OPERATION_REQUIRED');
        const result = apply();
        if (request.symbol === 'closeSync') descriptors.delete(target);
        return result;
      }
      if (!statePath(target)) throw new Error('TEST_PROTECTED_PREFLIGHT_OPERATION_REQUIRED');
      const result = apply();
      if (request.symbol === 'openSync' && typeof result === 'number') descriptors.add(result);
      return result;
    },
  };
  try {
    return await runWithAuthorityHostEffects(scope, callback);
  } finally {
    issuer.dispose();
  }
}

describe('release lifecycle command adapter composition', () => {
  it('wires only the protected preflight factory before continuing the public lifecycle', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-release-command-')));
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
    let manifestBytes = `${canonicalJson({
      name: '@aarusso-nyx/devai',
      version: '1.4.5',
      files: ['bin'],
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
    git(root, ['commit', '-qm', 'base']);
    const baseCommit = git(root, ['rev-parse', 'HEAD']);
    const baseTree = git(root, ['rev-parse', 'HEAD^{tree}']);
    manifestBytes = `${canonicalJson({
      name: '@aarusso-nyx/devai',
      version: '1.5.0',
      files: ['bin'],
      bin: { 'mode-fixture': 'bin/mode-fixture.mjs' },
    })}\n`;
    writeFileSync(join(root, 'packages/cli/package.json'), manifestBytes);
    writeFileSync(
      join(root, 'packages/cli/bin/mode-fixture.mjs'),
      '#!/usr/bin/env node\n// candidate\n',
    );
    const fixture = createFilesystemLifecyclePolicyFixture({
      root,
      base: { commit: baseCommit, tree: baseTree },
      git: (args) => git(root, args),
      readGitObject: (type, object_id) => {
        const result = spawnSync('git', ['-C', root, 'cat-file', type, object_id]);
        if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
          throw new Error('missing fixture Git object');
        }
        return result.stdout;
      },
      package_manifest: Buffer.from(manifestBytes),
    });
    const { commit, tree } = fixture.candidate.repository;
    expect(
      verifyResolvedReleasePlanReceipt({
        resolution: fixture.resolution,
        receipt: fixture.receipt,
      }),
    ).toBe(true);
    writeFileSync(
      join(root, '.git/info/exclude'),
      '.devai/\nreceipts/\nrelease-intent.json\nrequest.json\nresume-request.json\ncertify-request.json\nprepare-request.json\nexport-request.json\nunsafe-request.json\n',
    );
    mkdirSync(join(root, '.devai/state'), { recursive: true });
    const intent = fixture.intent;
    writeFileSync(join(root, 'release-intent.json'), `${canonicalJson(intent)}\n`);
    const receipt = fixture.receipt;
    writeFileSync(join(root, 'receipts/plan.json'), `${canonicalJson(receipt)}\n`);
    expect(
      verifyResolvedReleasePlanReceipt({
        resolution: fixture.resolution,
        receipt: json(join(root, 'receipts/plan.json')),
      }),
    ).toBe(true);
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
    const policyResolution = vi.fn(
      (_input: {
        readonly repository_id: string;
        readonly candidate: { readonly commit: string; readonly tree: string };
        readonly release_unit: string;
      }) => fixture.resolution,
    );
    const requestPath = join(root, 'request.json');
    writeFileSync(requestPath, `${canonicalJson(request)}\n`);
    expect(() => validateReleaseLifecycleRequest(request, 'release preflight')).not.toThrow();
    const persistedRequest = validateReleaseLifecycleRequest(
      json(requestPath),
      'release preflight',
    );
    expect(
      () => new ReleaseLifecycleFileStore(join(root, 'state'), persistedRequest),
    ).not.toThrow();
    expect(() => createResolvedReleasePlanInputResolver(fixture.resolution)).not.toThrow();
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
    const direct = await executeReleaseLifecycleAction({
      request: persistedRequest,
      action: 'release preflight',
      store: new ReleaseLifecycleFileStore(join(root, 'direct-state'), persistedRequest),
      provider,
      authority: {
        actor: { kind: 'human', role: 'inspector', declaration_source: 'cli-flag' },
        consent: { write: true, allow_publish: false, experimental: false },
      },
      resolveReceipt: () => receipt,
      resolvePlanInput: fixture.resolve_plan_input,
      recorded_at: '2026-09-03T00:00:00.000Z',
    });
    expect(direct).toMatchObject({ ok: false, code: 'release-certification-provider-unavailable' });
    const protectedPlan = {
      descriptorDigest: canonicalSha256(json(join(root, 'test-tasks.json'))),
      taskPolicyDigest: 'a'.repeat(64),
      toolchainDigest: 'b'.repeat(64),
      taskPolicy: { nodes: ['format'] },
      tasks: [
        {
          nodeId: 'format',
          taskKey: 'format',
          argv: ['node', '-e', 'process.exit(0)'],
          cwd: '.',
          executable: { path: '/usr/local/bin/node', sha256: 'f'.repeat(64) },
          outputContract: { kind: 'tracked-files', paths: [] },
        },
      ],
    };
    runChecks.mockReturnValue({
      schemaVersion: '1.0.0',
      operation: 'run',
      plan: protectedPlan,
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
    const protectedAdapters = createContainerReleaseCertificationAdapters({
      repository_root: root,
      repository_id: 'aarusso-nyx/devai',
      plans: [
        {
          receipt,
          resolution: fixture.resolution,
          intent_path: 'release-intent.json',
          intent,
          release_verification_profile: fixture.resolution.readInput(
            'release-verification-profile',
          ),
          release_lifecycle_policy: fixture.resolution.readInput('release-lifecycle-policy'),
          action_registry: fixture.resolution.readInput('action-registry-policy'),
          packages: [
            {
              package_id: '@aarusso-nyx/devai',
              source_entries: ['packages/cli/package.json'],
              generated_entries: [],
            },
          ],
        },
      ],
      controls: {
        docker_binary: '/test/docker',
        docker_binary_sha256: '1'.repeat(64),
        docker_config_directory: '/test/config',
        engine_socket: 'unix:///test/docker.sock',
        engine_version: 'test-engine',
        image: `test/node@sha256:${'2'.repeat(64)}`,
        node_version: 'v24.0.0',
        executables: { node: { path: '/usr/local/bin/node', sha256: 'f'.repeat(64) } },
        memory_bytes: 64 * 1024 * 1024,
        cpus: 1,
        pids_limit: 2,
        maximum_archive_bytes: 1024 * 1024,
      },
      environment: {},
      toolchain: { node: 'v24.0.0' },
      timeout_ms: 1_000,
      content_source: {
        readGitObject: ({ type, object_id }) => {
          const result = spawnSync('git', ['-C', root, 'cat-file', type, object_id]);
          if (result.status !== 0 || !Buffer.isBuffer(result.stdout))
            throw new Error('missing git object');
          return result.stdout;
        },
        readGitBlob: ({ object_id }) => {
          const result = spawnSync('git', ['-C', root, 'cat-file', 'blob', object_id]);
          if (result.status !== 0 || !Buffer.isBuffer(result.stdout))
            throw new Error('missing blob');
          return result.stdout;
        },
      },
      evidence_sink: {
        kind: 'certification-evidence-sink-v3',
        protocol: 'two-phase-content-addressed',
        begin: () => undefined as never,
        readCertificationEvidenceReceipt: () => {
          throw new Error('no generated outputs');
        },
        readCertificationOutputClosure: (binding) => ({ ...binding, outputs: [] }),
        readGeneratedBlob: () => {
          throw new Error('no generated outputs');
        },
      },
    });
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errorOutput = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(declaredInvocationAuthority()).toEqual({
      actor: { kind: 'human', role: 'inspector', declaration_source: 'cli-flag' },
      consent: { write: true, allow_publish: false, experimental: false },
    });
    expect(provider).not.toHaveBeenCalled();
    output.mockClear();
    errorOutput.mockClear();
    const preflightHook = vi.fn(() => protectedAdapters.preflight_provider);
    const uninstallPreflight = installReleaseLifecycleCommandAdapters({
      policy_resolution: policyResolution,
      preflight_provider: preflightHook,
      provider: () => undefined,
      offline_verification_provider: () => undefined,
      authorization: () => undefined,
      offline_receipt_verifier: () => undefined,
      publication_controls: () => undefined,
    });
    cleanups.push(uninstallPreflight);
    await withProtectedPreflightScope(
      {
        repository: request.repository_locator,
        task_policy_digest_sha256: protectedPlan.taskPolicyDigest,
        plan_receipt_digest_sha256: receipt.receipt_digest_sha256,
        state_root: join(root, 'stock-state'),
      },
      () =>
        captureAction()({
          request: requestPath,
          repoRoot: root,
          stateRoot: join(root, 'stock-state'),
        }),
    );
    expect(preflightHook).toHaveBeenCalledWith(request);
    expect(policyResolution).toHaveBeenCalledWith({
      repository_id: 'aarusso-nyx/devai',
      candidate: { commit, tree },
      release_unit: '@aarusso-nyx/devai',
    });
    expect(errorOutput.mock.calls).toEqual([]);
    expect(errorOutput.mock.calls, JSON.stringify(errorOutput.mock.calls)).toEqual([]);
    expect(output).toHaveBeenCalledWith(expect.stringContaining('"state":"preflight_passed"'));

    const failedPreflightRoot = join(root, 'failed-preflight-state');
    runChecks.mockImplementationOnce(() => {
      throw new Error(`native runner fixture path ${root}`);
    });
    output.mockClear();
    errorOutput.mockClear();
    await withProtectedPreflightScope(
      {
        repository: request.repository_locator,
        task_policy_digest_sha256: protectedPlan.taskPolicyDigest,
        plan_receipt_digest_sha256: receipt.receipt_digest_sha256,
        state_root: failedPreflightRoot,
      },
      () =>
        captureAction()({
          request: requestPath,
          repoRoot: root,
          stateRoot: failedPreflightRoot,
        }),
    );
    const failedPreflightStore = new ReleaseLifecycleFileStore(failedPreflightRoot, request);
    expect(failedPreflightStore.readStateRecords()).toEqual([]);
    expect(failedPreflightStore.readStoreRecords()).toMatchObject([
      { record_kind: 'attempt' },
      { record_kind: 'failure', failure: { code: 'release-certification-task-failed' } },
    ]);
    expect(output).not.toHaveBeenCalled();
    expect(errorOutput).toHaveBeenCalledWith(
      expect.stringContaining('release-certification-task-failed'),
    );
    expect(errorOutput.mock.calls.flat().join('')).not.toContain(root);
    output.mockClear();
    errorOutput.mockClear();

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
    const resumeReceiptsPath = join(root, 'resume-receipts.json');
    writeFileSync(resumeReceiptsPath, `${canonicalJson([receipt])}\n`);
    expect(() =>
      validateReleaseLifecycleRequest(json(resumeRequestPath), 'release resume'),
    ).not.toThrow();
    output.mockClear();
    await withAuthorityHostTestScope(() =>
      captureAction(releaseResume)({
        request: resumeRequestPath,
        repoRoot: root,
        stateRoot: join(root, 'stock-state'),
        receipts: resumeReceiptsPath,
      }),
    );
    expect(errorOutput.mock.calls).toEqual([]);
    expect(output).toHaveBeenCalledWith(expect.stringContaining('"next_action":"release certify"'));

    const stockStore = new ReleaseLifecycleFileStore(join(root, 'stock-state'), request);
    const stateChainPath = join(root, 'resume-states.json');
    const storeRecordsPath = join(root, 'resume-store-records.json');
    const storeHeadPath = join(root, 'resume-store-head.json');
    writeFileSync(stateChainPath, `${canonicalJson(stockStore.readStateRecords())}\n`);
    writeFileSync(storeRecordsPath, `${canonicalJson(stockStore.readStoreRecords())}\n`);
    writeFileSync(storeHeadPath, `${canonicalJson(stockStore.readHead())}\n`);
    for (const [name, foreignRequest, refusal] of [
      [
        'foreign-repository',
        {
          schemaVersion: '1.0.0',
          request_kind: 'release-lifecycle-request',
          action_id: 'release resume',
          repository_locator: { id: 'fixture/foreign', commit, tree },
          candidate_locator: request.candidate_locator,
        },
        'rpl-policy-resolution-mismatch',
      ],
      [
        'foreign-candidate',
        {
          schemaVersion: '1.0.0',
          request_kind: 'release-lifecycle-request',
          action_id: 'release resume',
          repository_locator: request.repository_locator,
          candidate_locator: {
            ...request.candidate_locator,
            commit: 'c'.repeat(40),
            tree: 'd'.repeat(40),
          },
        },
        'release-request-identity-mismatch',
      ],
    ] as const) {
      const foreignRequestPath = join(root, `${name}-resume-request.json`);
      writeFileSync(foreignRequestPath, `${canonicalJson(foreignRequest)}\n`);
      output.mockClear();
      errorOutput.mockClear();
      await withAuthorityHostTestScope(() =>
        captureAction(releaseResume)({
          request: foreignRequestPath,
          repoRoot: root,
          stateChain: stateChainPath,
          storeRecords: storeRecordsPath,
          storeHead: storeHeadPath,
          receipts: resumeReceiptsPath,
        }),
      );
      expect(output).not.toHaveBeenCalled();
      expect(errorOutput).toHaveBeenCalledWith(
        expect.stringContaining(`RELEASE_RESUME_FAILED: ${refusal}`),
      );
    }
    uninstallPreflight();

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
    const certificationPolicy = { nodes: ['certify'] };
    const certificationPolicyDigest = canonicalSha256(certificationPolicy);
    const uninstallCertify = installReleaseLifecycleCommandAdapters({
      policy_resolution: policyResolution,
      certification_provider: (certifyRequest) => ({
        provider: {
          kind: 'protected-certification-provider-v3',
          certify: () => ({
            outcome: 'success',
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
                        size_bytes: Buffer.byteLength(manifestBytes),
                      },
                      tarball: null,
                      sbom: null,
                      evidence_manifest: null,
                      provider_result: null,
                      trust: null,
                      certification_manifest: finalizeCertificationManifest({
                        candidate: {
                          commit: certifyRequest.candidate_locator.commit,
                          tree: certifyRequest.candidate_locator.tree,
                        },
                        task_policy_digest_sha256: certificationPolicyDigest,
                        package_id: '@aarusso-nyx/devai',
                        package_version: '1.5.0',
                        entry_order: 'ascending-utf-8-byte-collation-by-path;duplicates-refuse',
                        manifest_digest_contract: {
                          domain: 'DEVAI-CERTIFIED-PACKAGE-ENTRY-MANIFEST-V1\0',
                          payload:
                            'utf-8-rfc8785-jcs-of-the-entire-manifest-with-manifest_digest_sha256-omitted;framed-as-domain-utf8-bytes-plus-payload-utf8-bytes',
                          canonicalization: 'rfc8785-jcs',
                          algorithm: 'sha256',
                        },
                        entries: [
                          {
                            path: 'package.json',
                            mode: '100644',
                            size_bytes: Buffer.byteLength(manifestBytes),
                            sha256: manifestDigest,
                            immutable_blob_locator: {
                              kind: 'git-object',
                              repository: certifyRequest.repository_locator.id,
                              commit: certifyRequest.candidate_locator.commit,
                              tree: certifyRequest.candidate_locator.tree,
                              object_format: 'sha1',
                              path: 'packages/cli/package.json',
                              mode: '100644',
                              object_id: git(root, ['rev-parse', 'HEAD:packages/cli/package.json']),
                              size_bytes: Buffer.byteLength(manifestBytes),
                              content_digest_sha256: manifestDigest,
                            },
                          },
                        ],
                      }),
                    },
                  ],
                },
              ],
              inputs: [
                {
                  kind: 'task-policy',
                  path: 'host/certify-policy.json',
                  sha256: certificationPolicyDigest,
                },
              ],
              evidence: {
                manifest_digest_sha256: manifestDigest,
                receipt_digests: [],
                independently_checkable: true,
              },
              artifacts: [],
            },
          }),
        },
        evidence_sink: {
          kind: 'certification-evidence-sink-v3',
          protocol: 'two-phase-content-addressed',
          begin: () => undefined as never,
          readCertificationEvidenceReceipt: () => {
            throw new Error('no generated outputs');
          },
          readCertificationOutputClosure: (binding) => ({ ...binding, outputs: [] }),
          readGeneratedBlob: () => {
            throw new Error('no generated outputs');
          },
        },
        content_source: {
          readGitObject: ({ type, object_id }) => {
            const result = spawnSync('git', ['-C', root, 'cat-file', type, object_id]);
            if (result.status !== 0 || !Buffer.isBuffer(result.stdout))
              throw new Error('missing git object');
            return result.stdout;
          },
          readGitBlob: ({ object_id }) => {
            const result = spawnSync('git', ['-C', root, 'cat-file', 'blob', object_id]);
            if (result.status !== 0 || !Buffer.isBuffer(result.stdout))
              throw new Error('missing git blob');
            return result.stdout;
          },
        },
        task_policies: [
          {
            release_unit: '@aarusso-nyx/devai',
            task_policy_digest_sha256: certificationPolicyDigest,
            document: certificationPolicy,
          },
        ],
      }),
      provider: () => undefined,
      offline_verification_provider: () => undefined,
      authorization: () => undefined,
      offline_receipt_verifier: () => undefined,
      publication_controls: () => undefined,
    });
    cleanups.push(uninstallCertify);
    await withAuthorityHostTestScope(() =>
      captureAction(releaseCertify)({
        request: certifyRequestPath,
        repoRoot: root,
        stateRoot: join(root, 'stock-state'),
      }),
    );
    expect(output.mock.calls, JSON.stringify(errorOutput.mock.calls)).toContainEqual([
      expect.stringContaining('"state":"certified"'),
    ]);

    const prepareRequestPath = join(root, 'prepare-request.json');
    const prepareRequest = { ...request, action_id: 'release prepare' } as const;
    writeFileSync(prepareRequestPath, `${canonicalJson(prepareRequest)}\n`);
    declaredRole.value = 'architect';
    output.mockClear();
    errorOutput.mockClear();
    await withReleasePrepareAuthorityFixture(prepareRequest, () =>
      captureAction(releasePrepare)({
        request: prepareRequestPath,
        repoRoot: root,
        stateRoot: join(root, 'stock-state'),
      }),
    );
    expect(output).not.toHaveBeenCalled();
    expect(errorOutput).toHaveBeenCalledWith(
      expect.stringContaining('RELEASE_ARTIFACT_SINK_UNAVAILABLE'),
    );
    expect(
      builtInReleaseLifecycleLocalProvider(
        {
          repo_root: root,
          resolve_receipt: () => receipt,
          resolve_plan_input: fixture.resolve_plan_input,
          read_contained_bytes: (path) => readFileSync(join(root, path)),
        },
        'release prepare',
      ),
    ).toBeUndefined();
    uninstallCertify();

    const sinkBytes = new Map<string, Buffer>();
    const sinkCommit = vi.fn((manifest: ArtifactSinkObjectReceipt) => ({
      committed: true as const,
      sink_id: 'public-cli-sink',
      transaction_handle: 'public-cli-transaction',
      committed_manifest_handle: manifest.opaque_handle,
      committed_manifest_sha256: manifest.sha256,
      committed_manifest_size_bytes: manifest.size_bytes,
      commit_protocol: 'devai.artifact-sink.two-phase.v1' as const,
    }));
    const sinkAbort = vi.fn();
    const sinkBegin = vi.fn(() => ({
      sink_id: 'public-cli-sink',
      transaction_handle: 'public-cli-transaction',
      put: (artifact: ArtifactSinkObject) => {
        const opaque_handle = `object-${artifact.sha256}`;
        sinkBytes.set(opaque_handle, Buffer.from(artifact.bytes));
        return {
          sink_id: 'public-cli-sink',
          transaction_handle: 'public-cli-transaction',
          opaque_handle,
          kind: artifact.kind,
          logical_name: artifact.logical_name,
          sha256: artifact.sha256,
          size_bytes: artifact.size_bytes,
          pack_spec_id: artifact.pack_spec_id,
          pack_spec_digest_sha256: artifact.pack_spec_digest_sha256,
        };
      },
      readArtifact: ({ opaque_handle }: { readonly opaque_handle: string }) =>
        sinkBytes.get(opaque_handle) ?? Buffer.alloc(0),
      commit: sinkCommit,
      abort: sinkAbort,
    }));
    const uninstallPrepare = installReleaseLifecycleCommandAdapters({
      policy_resolution: policyResolution,
      provider: () => undefined,
      offline_verification_provider: () => undefined,
      authorization: () => undefined,
      offline_receipt_verifier: () => undefined,
      publication_controls: () => undefined,
      prepare_content_source: () => ({
        readGitObject: ({ type, object_id }) => {
          const result = spawnSync('git', ['-C', root, 'cat-file', type, object_id]);
          if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
            throw new Error('missing git object');
          }
          return result.stdout;
        },
        readGitBlob: ({ object_id }) => {
          const result = spawnSync('git', ['-C', root, 'cat-file', 'blob', object_id]);
          if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
            throw new Error('missing blob');
          }
          return result.stdout;
        },
        readCertificationEvidenceReceipt: () => {
          throw new Error('unexpected certification receipt');
        },
        readCertificationOutputClosure: (binding: CertificationOutputClosureBinding) => ({
          ...binding,
          outputs: [],
        }),
        readGeneratedBlob: () => {
          throw new Error('unexpected generated blob');
        },
      }),
      artifact_sink: () => ({ begin: sinkBegin }),
    });
    cleanups.push(uninstallPrepare);
    output.mockClear();
    errorOutput.mockClear();
    await withReleasePrepareAuthorityFixture(prepareRequest, () =>
      captureAction(releasePrepare)({
        request: prepareRequestPath,
        repoRoot: root,
        stateRoot: join(root, 'stock-state'),
      }),
    );
    expect(errorOutput.mock.calls).toEqual([]);
    expect(output).toHaveBeenCalledWith(expect.stringContaining('"state":"prepared"'));
    expect(sinkBegin).toHaveBeenCalledOnce();
    expect(sinkCommit).toHaveBeenCalledOnce();
    expect(sinkAbort).not.toHaveBeenCalled();
    expect(sinkBytes.size).toBe(4);
    uninstallPrepare();

    const exportRequestPath = join(root, 'export-request.json');
    writeFileSync(
      exportRequestPath,
      `${canonicalJson({
        ...request,
        action_id: 'release export',
        provider: { kind: 'evidence-export', provider_id: 'canonical-verifier' },
        destination: {
          kind: 'evidence-destination',
          exact_identifier: 'external/devai-1.5.0',
        },
      })}\n`,
    );
    const exportProvider = vi.fn(() => ({ outcome: 'unknown' as const }));
    const uninstallExport = installReleaseLifecycleCommandAdapters({
      policy_resolution: policyResolution,
      provider: () => exportProvider,
      offline_verification_provider: () => undefined,
      authorization: () => undefined,
      offline_receipt_verifier: () => undefined,
      publication_controls: () => undefined,
    });
    cleanups.push(uninstallExport);
    errorOutput.mockClear();
    await withAuthorityHostTestScope(() =>
      captureAction(releaseExport)({
        request: exportRequestPath,
        repoRoot: root,
        stateRoot: join(root, 'stock-state'),
      }),
    );
    expect(exportProvider).not.toHaveBeenCalled();
    expect(errorOutput).toHaveBeenCalledWith(
      expect.stringContaining('RELEASE_ACTION_PROVIDER_UNAVAILABLE'),
    );
    uninstallExport();
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
        policy_resolution: policyResolution,
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
