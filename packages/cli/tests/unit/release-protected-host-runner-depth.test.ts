import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapters: undefined as Record<string, (...args: unknown[]) => unknown> | undefined,
  invoke: vi.fn(),
  preflight: vi.fn(),
  certify: vi.fn(),
  readPolicies: vi.fn(),
  artifactReader: { read: vi.fn() },
  exportProvider: vi.fn(),
  offlineProvider: vi.fn(),
  offlineClosures: vi.fn(),
  evidenceProvider: vi.fn(),
  publishProvider: vi.fn(),
  evidenceAuthorization: vi.fn(),
  publicationAuthorization: vi.fn(),
  offlineReceiptVerifier: vi.fn(),
  publicationControls: vi.fn(),
}));

vi.mock('../../src/cli-runtime.js', () => ({
  assertCliInvocationIdle: vi.fn(),
  invokeDevaiCli: mocks.invoke,
}));
vi.mock('../../src/commands/release/lifecycle.js', () => ({
  installReleaseLifecycleCommandAdapters: (value: typeof mocks.adapters) => {
    mocks.adapters = value;
  },
}));
vi.mock('../../src/services/release-host-package-binding.js', () => ({
  assertBoundReleaseHostPackageSnapshot: vi.fn(),
}));
vi.mock('../../src/services/release-candidate-snapshot.js', () => ({
  isVerifiedReleaseCandidateSnapshot: () => true,
}));
vi.mock('@devai-nyx/authority', () => ({
  createProtectedReleaseRepositoryContext: (value: unknown) => value,
  withProtectedReleaseRepositoryContext: (_context: unknown, operation: () => unknown) =>
    operation(),
}));
vi.mock('../../src/services/release-policy-resolution.js', () => ({
  resolveReleasePolicySnapshot: () => ({
    release_unit: '@aarusso-nyx/devai',
    readInput: (name: string) => ({ name }),
  }),
  createResolvedReleasePlanInputResolver: () => vi.fn(),
}));
vi.mock('../../src/services/release-lifecycle.js', () => ({
  buildResolvedReleasePlanReceipt: () => ({
    verdict: 'pass',
    receipt_id: `RPL-${'a'.repeat(16)}`,
    receipt_digest_sha256: 'b'.repeat(64),
    candidate: { release_unit: '@aarusso-nyx/devai', version: '1.5.0' },
  }),
}));
vi.mock('../../src/services/release-policy-closure.js', () => ({
  createReleasePolicyClosure: () => ({ schemaVersion: 'test-policy-closure' }),
}));
vi.mock('../../src/services/release-policy-closure-transport.js', () => ({
  encodeReleasePolicyClosure: () => Buffer.from('closure'),
}));
vi.mock('../../src/services/release-certification-provider.js', () => ({
  createContainerReleasePreflightProvider: () => mocks.preflight,
  createContainerReleaseCertificationAdapters: () => ({
    preflight_provider: mocks.preflight,
    certification_provider: mocks.certify,
    read_task_policies: mocks.readPolicies,
  }),
}));
vi.mock('../../src/services/release-evidence-store.js', () => ({
  createReleaseCertificationEvidenceStore: () => ({
    unit_mutation_maximum_bytes: 1024,
    readUnitMutationEvidenceClosure: vi.fn(),
    readUnitMutationEvidenceReceipt: vi.fn(),
    readUnitMutationEvidenceBlob: vi.fn(),
    readCertificationEvidenceReceipt: vi.fn(),
    readCertificationOutputClosure: vi.fn(),
    readGeneratedBlob: vi.fn(),
  }),
}));
vi.mock('../../src/services/release-artifact-store.js', () => ({
  createReleaseArtifactStore: () => mocks.artifactReader,
}));
vi.mock('../../src/services/release-export-provider.js', () => ({
  createReleaseExportProvider: () => ({
    provider: mocks.exportProvider,
    reader: mocks.artifactReader,
  }),
}));
vi.mock('../../src/services/release-mutation-inputs.js', () => ({
  buildReleaseMutationInputPlanV21: () => ({
    packages: [],
    grants: { execution: false, certification: false, reuse: false },
    readProof: vi.fn(),
  }),
}));
vi.mock('../../src/services/release-prepare-kernel.js', () => ({
  RELEASE_PACK_SPEC_DIGEST: 'c'.repeat(64),
}));
vi.mock('../../src/services/release-lifecycle-execution.js', () => ({
  validateReleaseLifecycleRequest: (value: unknown) => value,
}));

import { createProtectedReleaseHostRunner } from '../../src/services/release-protected-host-runner.js';
import type { ImmutableReleaseContentSource } from '../../src/services/release-prepare-kernel.js';

const roots: string[] = [];
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function temporary(name: string): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), `devai-host-depth-${name}-`)));
  roots.push(value);
  return value;
}

function inputFile(root: string, name: string, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  const path = join(root, name);
  writeFileSync(path, bytes);
  return { path, sha256: sha256(bytes) };
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('protected release host runner direct orchestration', () => {
  it('validates selected controls and routes bound inputs through installed adapters', async () => {
    const repositoryRoot = temporary('repo');
    const evidenceRoot = temporary('evidence');
    const artifactRoot = temporary('artifacts');
    mkdirSync(join(repositoryRoot, '.devai/state/release-lifecycle'), { recursive: true });
    const repository = {
      id: 'aarusso-nyx/devai',
      commit: '1'.repeat(40),
      tree: '2'.repeat(40),
    };
    const manifest = Buffer.from(JSON.stringify({ name: '@aarusso-nyx/devai', version: '1.5.0' }));
    const blobId = '3'.repeat(40);
    const proof = new Map([
      [repository.commit, { type: 'commit' as const, bytes: Buffer.from('commit') }],
      [repository.tree, { type: 'tree' as const, bytes: Buffer.from('tree') }],
      [blobId, { type: 'blob' as const, bytes: Buffer.from(manifest) }],
    ]);
    const candidate = {
      repository,
      paths: ['packages/cli/package.json'],
      read: (path: string) => {
        if (path !== 'packages/cli/package.json') throw new Error(`unexpected path:${path}`);
        return Buffer.from(manifest);
      },
      readProof: () => proof,
    };
    const intent = { release_unit: '@aarusso-nyx/devai', target_version: '1.5.0' };
    const controls = {
      candidate,
      expected: { repository },
      repository_root: repositoryRoot,
      repository_identity: {
        authority_repository_id: 'devai',
        read_expected_release_repository_id: () => repository.id,
      },
      state_root: join(repositoryRoot, '.devai/state/release-lifecycle'),
      maximum_input_bytes: 1024 * 1024,
      unit: {
        intent,
        packages: [
          {
            manifest_path: 'packages/cli/package.json',
            source_entries: ['package.json'],
            generated_entries: [],
          },
        ],
      },
      execution: {
        controls: { image: 'fixture' },
        environment: { CI: '1' },
        toolchain: { node: 'v24.15.0' },
        timeout_ms: 1000,
      },
      installed_package: { identity: { digest: 'installed' } },
      certification_store: {
        root: evidenceRoot,
        evidence_sink_id: 'evidence',
        repository_roots: [repositoryRoot],
        max_blob_bytes: 1024,
      },
      artifact_store: {
        root: artifactRoot,
        sink_id: 'artifacts',
        repository_roots: [repositoryRoot],
        max_blob_bytes: 1024,
      },
      publication_signature_verifier: vi.fn(() => false),
      later_stages: {
        export: {
          provider: vi.fn(),
          destination: { id: 'fixture-destination' },
          trust: { id: 'fixture-trust' },
          signer: { sign: vi.fn(), verify: vi.fn() },
          closure_limits: { maximum: 1024 },
          transport_limits: { maximum: 1024 },
          transcript_limits: { maximum: 1024 },
        },
        offline_verify: {
          provider: mocks.offlineProvider,
          policy_closures: mocks.offlineClosures,
        },
        evidence_publish: {
          provider: mocks.evidenceProvider,
          authorization: mocks.evidenceAuthorization,
          offline_receipt_verifier: mocks.offlineReceiptVerifier,
        },
        publish: {
          provider: mocks.publishProvider,
          authorization: mocks.publicationAuthorization,
          publication_controls: mocks.publicationControls,
        },
      },
    };

    for (const invalid of [
      { ...controls, maximum_input_bytes: 0 },
      { ...controls, maximum_input_bytes: Number.MAX_SAFE_INTEGER + 1 },
      { ...controls, state_root: artifactRoot },
      { ...controls, later_stages: { export: 'unavailable' } },
      { ...controls, publication_signature_verifier: true },
      { ...controls, unexpected: true },
      { ...controls, unit: { ...controls.unit, packages: [] } },
      { ...controls, unit: { ...controls.unit, packages: null } },
      {
        ...controls,
        unit: {
          ...controls.unit,
          packages: [{ ...controls.unit.packages[0], manifest_path: 'manifest.json' }],
        },
      },
      {
        ...controls,
        unit: {
          ...controls.unit,
          packages: [{ ...controls.unit.packages[0], source_entries: [] }],
        },
      },
      {
        ...controls,
        unit: {
          ...controls.unit,
          packages: [
            { ...controls.unit.packages[0], source_entries: ['package.json', 'package.json'] },
          ],
        },
      },
      {
        ...controls,
        unit: {
          ...controls.unit,
          packages: [
            {
              ...controls.unit.packages[0],
              generated_entries: [{ path: '../escape', task_node: 'task:one' }],
            },
          ],
        },
      },
      {
        ...controls,
        unit: {
          ...controls.unit,
          packages: [
            {
              ...controls.unit.packages[0],
              generated_entries: [{ path: 'dist/output.json', task_node: 'bad task' }],
            },
          ],
        },
      },
      {
        ...controls,
        candidate: {
          ...candidate,
          read: () => Buffer.from(JSON.stringify({ name: 7, version: '1.5.0' })),
        },
      },
      {
        ...controls,
        candidate: {
          ...candidate,
          read: () => Buffer.from(JSON.stringify({ name: '@aarusso-nyx/devai', version: '1.4.5' })),
        },
      },
      {
        ...controls,
        later_stages: {
          ...controls.later_stages,
          offline_verify: { provider: true, policy_closures: mocks.offlineClosures },
        },
      },
      {
        ...controls,
        later_stages: {
          ...controls.later_stages,
          publish: { ...controls.later_stages.publish, unexpected: vi.fn() },
        },
      },
      {
        ...controls,
        later_stages: {
          ...controls.later_stages,
          export: {
            ...controls.later_stages.export,
            signer: { sign: true, verify: vi.fn() },
          },
        },
      },
      {
        ...controls,
        artifact_store: { ...controls.artifact_store, root: evidenceRoot },
      },
      {
        ...controls,
        certification_store: { ...controls.certification_store, repository_roots: [] },
      },
    ]) {
      expect(() => createProtectedReleaseHostRunner(invalid as never)).toThrow(
        'release-host-controls-invalid',
      );
    }

    let contentSource: ImmutableReleaseContentSource | undefined;
    mocks.preflight.mockResolvedValue({ outcome: 'success' });
    mocks.invoke.mockImplementation(async (args: string[]) => {
      const action = args.slice(0, 2).join(' ');
      if (action === 'release plan') return { exit_code: 0, stdout: 'plan', stderr: '' };
      const request = JSON.parse(
        readFileSync(args[args.indexOf('--request') + 1] as string, 'utf8'),
      );
      mocks.adapters?.policy_resolution?.({
        repository_id: request.repository_locator.id,
        candidate: {
          commit: request.candidate_locator.commit,
          tree: request.candidate_locator.tree,
        },
        release_unit: '@aarusso-nyx/devai',
      });
      if (action === 'release preflight') {
        const provider = mocks.adapters?.preflight_provider?.(request);
        if (typeof provider !== 'function') throw new Error('preflight provider missing');
        await provider(request);
      }
      if (action === 'release certify') mocks.adapters?.certification_provider?.(request);
      if (action === 'release prepare') {
        contentSource = mocks.adapters?.prepare_content_source?.(
          request,
        ) as ImmutableReleaseContentSource;
        mocks.adapters?.artifact_sink?.(request);
        mocks.adapters?.artifact_reader?.(request);
        const verifier = mocks.adapters?.publication_signature_verifier?.(request);
        if (typeof verifier !== 'function') throw new Error('signature verifier missing');
        verifier('signature', 'payload');
      }
      if (action === 'release export') {
        const provider = mocks.adapters?.provider?.(action, request);
        if (typeof provider !== 'function') throw new Error('export provider missing');
        provider(request);
        mocks.adapters?.export_limits?.(request);
      }
      if (action === 'release offline-verify') {
        const provider = mocks.adapters?.offline_verification_provider?.(request);
        if (typeof provider !== 'function') throw new Error('offline provider missing');
        provider(request);
        mocks.adapters?.offline_policy_closures?.(request);
      }
      if (action === 'release evidence-publish') {
        const provider = mocks.adapters?.provider?.(action, request);
        if (typeof provider !== 'function') throw new Error('evidence provider missing');
        provider(request);
        mocks.adapters?.authorization?.(request);
        mocks.adapters?.offline_receipt_verifier?.(request);
      }
      if (action === 'release publish') {
        const provider = mocks.adapters?.provider?.(action, request);
        if (typeof provider !== 'function') throw new Error('publication provider missing');
        provider(request);
        mocks.adapters?.authorization?.(request);
        mocks.adapters?.publication_controls?.(request);
      }
      return { exit_code: 0, stdout: action, stderr: '' };
    });

    const runner = createProtectedReleaseHostRunner(controls as never);
    expect(runner.readPlan()).toMatchObject({ verdict: 'pass', candidate: { version: '1.5.0' } });
    expect(runner.readPolicyClosure()).toEqual({ schemaVersion: 'test-policy-closure' });
    expect(() => runner.readFixturePlan()).toThrow('release-host-fixture-unavailable');
    expect(() => runner.readMutationInputPlan()).toThrow('mutation-offloaded-to-bedel');

    const candidateLocator = {
      commit: repository.commit,
      tree: repository.tree,
      release_units: [
        {
          release_unit: '@aarusso-nyx/devai',
          version: '1.5.0',
          package_roster: [
            {
              package_id: '@aarusso-nyx/devai',
              manifest_path: 'packages/cli/package.json',
              manifest_digest_sha256: sha256(manifest),
            },
          ],
        },
      ],
    };
    const request = {
      action_id: 'release preflight',
      repository_locator: repository,
      candidate_locator: candidateLocator,
      receipt_locators: [
        {
          kind: 'release-plan-receipt',
          receipt_id: `RPL-${'a'.repeat(16)}`,
          receipt_digest_sha256: 'b'.repeat(64),
          path: 'receipts/plan.json',
        },
      ],
    };
    const requestFile = inputFile(repositoryRoot, 'request.json', request);
    await expect(
      runner.invoke({
        action: 'release preflight',
        as_role: 'inspector',
        write: true,
        request: requestFile,
      }),
    ).resolves.toMatchObject({ exit_code: 0, stdout: 'release preflight' });
    expect(mocks.preflight).toHaveBeenCalledTimes(1);

    const intentFile = inputFile(repositoryRoot, 'intent.json', intent);
    await expect(
      runner.invoke({
        action: 'release plan',
        intent: inputFile(repositoryRoot, 'mismatched-intent.json', {
          ...intent,
          target_version: '1.5.1',
        }),
      }),
    ).rejects.toThrow('release-host-input-mismatch');
    await expect(
      runner.invoke({ action: 'release plan', intent: intentFile }),
    ).resolves.toMatchObject({ exit_code: 0, stdout: 'plan' });
    for (const action of ['release certify', 'release prepare', 'release export'] as const) {
      const actionRequest = { ...request, action_id: action };
      await expect(
        runner.invoke({
          action,
          as_role: action === 'release export' ? 'owner' : 'inspector',
          write: true,
          request: inputFile(repositoryRoot, `${action.replace(' ', '-')}.json`, actionRequest),
        }),
      ).resolves.toMatchObject({ exit_code: 0, stdout: action });
    }
    expect(
      contentSource?.readGitObject({
        repository,
        object_format: 'sha1',
        object_id: repository.commit,
        type: 'commit',
      }),
    ).toEqual(Buffer.from('commit'));
    const blobRequest = {
      repository,
      candidate: candidateLocator,
      object_format: 'sha1' as const,
      object_id: blobId,
      type: 'blob' as const,
      locator: {
        kind: 'git-object' as const,
        mode: '100644' as const,
        repository: repository.id,
        commit: repository.commit,
        tree: repository.tree,
        object_format: 'sha1' as const,
        object_id: blobId,
        path: 'packages/cli/package.json',
        size_bytes: manifest.length,
        content_digest_sha256: sha256(manifest),
      },
    };
    expect(contentSource?.readGitBlob(blobRequest)).toEqual(manifest);
    expect(() =>
      contentSource?.readGitObject({
        repository: { ...repository, tree: '0'.repeat(40) },
        object_format: 'sha1',
        object_id: repository.commit,
        type: 'commit',
      }),
    ).toThrow('release-host-input-mismatch');
    for (const invalid of [
      {
        ...blobRequest,
        locator: { ...blobRequest.locator, object_format: 'sha256' as const },
      },
      { ...blobRequest, locator: { ...blobRequest.locator, size_bytes: manifest.length + 1 } },
      {
        ...blobRequest,
        locator: { ...blobRequest.locator, content_digest_sha256: '0'.repeat(64) },
      },
    ]) {
      expect(() => contentSource?.readGitBlob(invalid)).toThrow('release-host-input-mismatch');
    }
    const offlineRequest = { ...request, action_id: 'release offline-verify' };
    await expect(
      runner.invoke({
        action: 'release offline-verify',
        request: inputFile(repositoryRoot, 'offline-request.json', offlineRequest),
        exported_state: inputFile(repositoryRoot, 'exported-state.json', { state: 'sealed' }),
      }),
    ).resolves.toMatchObject({ exit_code: 0, stdout: 'release offline-verify' });
    for (const action of ['release evidence-publish', 'release publish'] as const) {
      const actionRequest = { ...request, action_id: action };
      await expect(
        runner.invoke({
          action,
          as_role: 'owner',
          write: true,
          allow_publish: action === 'release publish',
          request: inputFile(repositoryRoot, `${action.replace(' ', '-')}.json`, actionRequest),
        }),
      ).resolves.toMatchObject({ exit_code: 0, stdout: action });
    }
    const resumeRequest = {
      ...request,
      action_id: 'release resume',
      receipt_locators: undefined,
    };
    const planReceipt = runner.readPlan();
    for (const [name, receipts] of [
      ['not-an-array', { receipt: planReceipt }],
      ['missing-plan', [{ ...planReceipt, receipt_digest_sha256: '0'.repeat(64) }]],
    ] as const) {
      await expect(
        runner.invoke({
          action: 'release resume',
          request: inputFile(repositoryRoot, `resume-${name}-request.json`, resumeRequest),
          receipts: inputFile(repositoryRoot, `resume-${name}-receipts.json`, receipts),
        }),
      ).rejects.toThrow('release-host-input-mismatch');
    }
    await expect(
      runner.invoke({
        action: 'release resume',
        request: inputFile(repositoryRoot, 'resume-request.json', resumeRequest),
        receipts: inputFile(repositoryRoot, 'resume-receipts.json', [planReceipt]),
        publication_receipt: inputFile(repositoryRoot, 'publication-receipt.json', {
          status: 'pending',
        }),
      }),
    ).resolves.toMatchObject({ exit_code: 0, stdout: 'release resume' });
    await expect(
      runner.invoke({
        action: 'release nope' as never,
        as_role: 'owner',
        write: true,
        request: requestFile,
      }),
    ).rejects.toThrow('release-host-stage-unavailable');
    await expect(
      runner.invoke({
        action: 'release preflight',
        as_role: 'inspector',
        write: true,
        request: { ...requestFile, sha256: '0'.repeat(64) },
      }),
    ).rejects.toThrow('release-host-input-mismatch');
    const invocations = mocks.invoke.mock.calls.map(([args]) => args as string[]);
    expect(invocations.map((args) => args.slice(0, 2).join(' '))).toEqual([
      'release preflight',
      'release plan',
      'release certify',
      'release prepare',
      'release export',
      'release offline-verify',
      'release evidence-publish',
      'release publish',
      'release resume',
    ]);
    for (const args of invocations) {
      expect(args.slice(args.indexOf('--repo-root'), args.indexOf('--repo-root') + 2)).toEqual([
        '--repo-root',
        repositoryRoot,
      ]);
    }
    expect(invocations[0]).toEqual([
      'release',
      'preflight',
      '--repo-root',
      repositoryRoot,
      '--as-role',
      'inspector',
      '--write',
      '--request',
      requestFile.path,
      '--state-root',
      controls.state_root,
    ]);
    expect(invocations[1]).toEqual([
      'release',
      'plan',
      '--repo-root',
      repositoryRoot,
      '--intent',
      intentFile.path,
      '--repository',
      repository.id,
    ]);
    expect(invocations[5]).toContain('--exported-state');
    expect(invocations[5]).not.toContain('--state-root');
    expect(invocations[6]).not.toContain('--allow-publish');
    expect(invocations[7]).toContain('--allow-publish');
    expect(invocations[8]).toContain('--receipts');
    expect(invocations[8]).toContain('--publication-receipt');
    await expect(
      runner.invoke({
        action: 'release preflight',
        as_role: 'invalid' as never,
        write: true,
        request: requestFile,
      }),
    ).rejects.toThrow('release-host-controls-invalid');
    expect(() => createProtectedReleaseHostRunner(controls as never)).toThrow(
      'release-host-runner-already-installed',
    );
    expect(mocks.certify).toHaveBeenCalledTimes(1);
    expect(mocks.exportProvider).toHaveBeenCalledTimes(1);
    expect(mocks.offlineProvider).toHaveBeenCalledTimes(1);
    expect(mocks.evidenceProvider).toHaveBeenCalledTimes(1);
    expect(mocks.publishProvider).toHaveBeenCalledTimes(1);
    expect(mocks.offlineClosures).toHaveBeenCalledTimes(1);
    expect(mocks.evidenceAuthorization).toHaveBeenCalledTimes(1);
    expect(mocks.publicationAuthorization).toHaveBeenCalledTimes(1);
  });
});
