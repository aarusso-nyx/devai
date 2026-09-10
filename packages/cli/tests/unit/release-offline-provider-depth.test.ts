import { createHash } from 'node:crypto';
import { canonicalSha256 } from '@devai-nyx/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const collaborators = vi.hoisted(() => ({
  context: vi.fn(() => ({ plan_receipts: [{ receipt_id: 'plan-1' }] })),
  mutationCheck: vi.fn(() => ({
    check_id: 'mutation-semantics',
    status: 'not-applicable',
    result_digest_sha256: 'a'.repeat(64),
  })),
  artifactProjection: vi.fn(() => [{ artifact_id: 'artifact-1' }]),
  unitProjection: vi.fn(() => [{ release_unit: 'unit-a', version: '1.5.0' }]),
  archive: vi.fn(() => [
    { path: 'package/index.js', bytes: Buffer.from('entry'), sha256: 'unused' },
  ]),
  carrier: vi.fn(() => ({
    task_policy: Buffer.from('{"rule":"strict"}'),
    task_results: [Buffer.from('task-result')],
    candidate_receipt: Buffer.from('{"receipt":"candidate"}'),
    census: { files: 1 },
  })),
  resultSet: vi.fn(),
  signature: vi.fn(async () => ({ trusted: true, signer_id: 'signer-1' })),
  content: vi.fn(async () => ({ safe: true })),
}));

vi.mock('../../src/services/release-lifecycle-execution.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/services/release-lifecycle-execution.js')>();
  return {
    ...actual,
    readVerifiedReleaseOfflineContext: collaborators.context,
    createVerifiedReleaseMutationCheck: collaborators.mutationCheck,
    offlineArtifactProjection: collaborators.artifactProjection,
    offlineReleaseUnitsProjection: collaborators.unitProjection,
  };
});
vi.mock('../../src/services/release-prepare-kernel.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/release-prepare-kernel.js')>()),
  verifyPreparedPackageArchive: collaborators.archive,
}));
vi.mock('../../src/services/release-certified-evidence-carrier.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../src/services/release-certified-evidence-carrier.js')
  >()),
  readCertifiedEvidenceCarrier: collaborators.carrier,
}));
vi.mock('../../src/services/release-export-transcript-v3.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/release-export-transcript-v3.js')>()),
  verifyReleaseExportProviderResultSetV3: collaborators.resultSet,
}));
vi.mock('../../src/services/mutation-evidence-v21.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/mutation-evidence-v21.js')>()),
  verifyPinnedDetachedSignature: collaborators.signature,
  verifyPinnedArtifactContent: collaborators.content,
}));

import {
  createReleaseOfflineVerifierProvider,
  type ReleaseOfflineProviderControls,
} from '../../src/services/release-offline-provider.js';
import type {
  ReleaseLifecycleRequest,
  ReleaseLifecycleStateV2,
} from '../../src/services/release-lifecycle-execution.js';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function required<T>(value: T | undefined, message = 'missing fixture value'): T {
  if (value === undefined) throw new Error(message);
  return value;
}
function packageRecord(state: ReleaseLifecycleStateV2) {
  return required(required(state.release_units[0]).packages[0]);
}
function mutablePolicies(controls: ReleaseOfflineProviderControls) {
  return controls.task_policies as {
    release_unit: string;
    policy: Readonly<Record<string, unknown>>;
  }[];
}
const trust = {
  trust_root_id: 'root-1',
  trust_store_digest_sha256: 'b'.repeat(64),
  key_id: 'key-1',
  signature_algorithm: 'ed25519',
};
const transcript = JSON.stringify({
  trust,
  binding: {
    repository: { id: 'fixture/repo' },
    candidate: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
  },
});
const signature = Buffer.alloc(64).toString('base64');

function identity(handle: string, bytes: Buffer) {
  return {
    sink_id: 'sink-1',
    opaque_handle: handle,
    size_bytes: bytes.length,
    sha256: sha(bytes),
  };
}

function fixture() {
  const bytes = new Map<string, Buffer>([
    ['manifest', Buffer.from('manifest')],
    ['tarball', Buffer.from('tarball')],
    ['sbom', Buffer.from('sbom')],
    ['evidence', Buffer.from('evidence')],
    ['provider', Buffer.from(JSON.stringify({ transcript, signature }))],
  ]);
  const artifact = (name: string) => identity(name, required(bytes.get(name)));
  const state = {
    schemaVersion: '2.1.0',
    state: 'exported',
    state_id: 'state-1',
    record_digest_sha256: 'c'.repeat(64),
    repository: { id: 'fixture/repo' },
    candidate: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    artifact_sink: { sink_id: 'sink-1', commit_id: 'sink-commit-1' },
    release_units: [
      {
        release_unit: 'unit-a',
        version: '1.5.0',
        packages: [
          {
            package_id: 'pkg-a',
            package_manifest: artifact('manifest'),
            package_tarball: artifact('tarball'),
            package_sbom: artifact('sbom'),
            evidence_manifest: artifact('evidence'),
            provider_result: artifact('provider'),
          },
        ],
      },
    ],
  } as unknown as ReleaseLifecycleStateV2;
  const request = { destination: { trust } } as unknown as ReleaseLifecycleRequest;
  const reader = {
    readArtifact: vi.fn(async ({ opaque_handle }: { readonly opaque_handle: string }) =>
      Buffer.from(bytes.get(opaque_handle) ?? Buffer.from('missing')),
    ),
  };
  const dag = {
    identity: { source_commit: 'd'.repeat(40), archive_sha256: 'e'.repeat(64) },
    verify: vi.fn(async (_input: unknown) => ({ ok: true, verification: 'candidate-receipt-dag' })),
  };
  const controls: ReleaseOfflineProviderControls = {
    candidate: {
      repository_id: 'fixture/repo',
      commit: 'a'.repeat(40),
      tree: 'b'.repeat(40),
    },
    reader,
    dag,
    task_policies: [{ release_unit: 'unit-a', policy: { rule: 'strict' } }],
    trust_store: { roots: ['root-1'] },
    signer_id: 'signer-1',
    verifier: {
      package_name: '@fixture/verifier',
      package_version: '1.0.0',
      registry: 'https://registry.invalid',
      integrity_sri: 'sha512-AA==',
      provenance_sha256: 'f'.repeat(64),
      source_commit: '0'.repeat(40),
    },
    limits: {
      maximum_packages: 2,
      maximum_provider_result_bytes: 4096,
      maximum_transcript_bytes: 4096,
    },
    maximum_archive_bytes: 4096,
    maximum_total_bytes: 16384,
  };
  return { bytes, state, request, reader, dag, controls };
}

function portableResult() {
  return {
    certification_evidence: {
      release_unit: 'unit-a',
      bytes_base64: Buffer.from('carrier').toString('base64'),
      sha256: sha(Buffer.from('carrier')),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  collaborators.context.mockReturnValue({ plan_receipts: [{ receipt_id: 'plan-1' }] });
  collaborators.mutationCheck.mockReturnValue({
    check_id: 'mutation-semantics',
    status: 'not-applicable',
    result_digest_sha256: 'a'.repeat(64),
  });
  collaborators.artifactProjection.mockReturnValue([{ artifact_id: 'artifact-1' }]);
  collaborators.unitProjection.mockReturnValue([{ release_unit: 'unit-a', version: '1.5.0' }]);
  collaborators.archive.mockReturnValue([
    { path: 'package/index.js', bytes: Buffer.from('entry'), sha256: 'unused' },
  ]);
  collaborators.carrier.mockReturnValue({
    task_policy: Buffer.from('{"rule":"strict"}'),
    task_results: [Buffer.from('task-result')],
    candidate_receipt: Buffer.from('{"receipt":"candidate"}'),
    census: { files: 1 },
  });
  collaborators.resultSet.mockReturnValue([portableResult()]);
  collaborators.signature.mockResolvedValue({ trusted: true, signer_id: 'signer-1' });
  collaborators.content.mockResolvedValue({ safe: true });
});

describe('release offline provider verification depth', () => {
  it('constructs a bound receipt only after reading, hashing, safety-checking, and verifying every closure', async () => {
    const value = fixture();
    const receipt = (await createReleaseOfflineVerifierProvider(value.controls)(
      value.request,
      value.state,
      {} as never,
    )) as Record<string, unknown>;

    expect(receipt).toMatchObject({
      schemaVersion: '2.1.0',
      receipt_kind: 'release-offline-verification-receipt',
      verdict: 'pass',
      state_observed: 'offline_verified',
      network_access: false,
      verifier: value.controls.verifier,
    });
    expect(receipt['receipt_id']).toMatch(/^ROV-[a-f0-9]{16}$/u);
    expect(receipt['receipt_digest_sha256']).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt).toMatchObject({
      canonicalization: {
        kernel_id: 'devai.kernel.release-offline-verification-receipt-canonicalization.v3',
      },
      verification_kernel: { kernel_id: 'devai.kernel.offline-verification-receipt.v3' },
      emitted_by: { action_id: 'release offline-verify', effect: 'read' },
      grants: { authority: false, publication_authority: false },
      determinism: { deterministic: true, contains_wall_clock_time: false },
      verified_state: {
        state: 'exported',
        state_id: 'state-1',
        record_digest_sha256: 'c'.repeat(64),
      },
    });
    const control = value.controls.dag.identity;
    const dagResult = { ok: true, verification: 'candidate-receipt-dag' };
    const dags = [
      {
        release_unit: 'unit-a',
        control,
        result: dagResult,
        carrier_sha256: portableResult().certification_evidence.sha256,
      },
    ];
    const observed = ['manifest', 'tarball', 'sbom', 'evidence', 'provider'].map((name) =>
      identity(name, required(value.bytes.get(name))),
    );
    const packageSafety = [
      {
        package_id: 'pkg-a',
        entries: [{ path: 'package/index.js', sha256: 'unused', size_bytes: 5 }],
      },
    ];
    const check = (check_id: string, evidence: unknown) => ({
      check_id,
      status: 'pass',
      result_digest_sha256: canonicalSha256({ check_id, evidence }),
    });
    expect(receipt['checks']).toEqual([
      check('candidate-tree-identity', {
        repository: value.state.repository,
        candidate: value.state.candidate,
        dags,
      }),
      check('receipt-envelope-canonicality', {
        transcript_sha256: sha(Buffer.from(transcript)),
        provider_results: [sha(required(value.bytes.get('provider')))],
      }),
      check('signer-trust', {
        result: { trusted: true, signer_id: 'signer-1' },
        signature_sha256: sha(Buffer.alloc(64)),
        trust,
      }),
      check('policy-identity', {
        plans: [{ receipt_id: 'plan-1' }],
        policies: value.controls.task_policies,
      }),
      check('result-dag-integrity', dags),
      check('artifact-population', {
        artifacts: [{ artifact_id: 'artifact-1' }],
        sink: value.state.artifact_sink,
      }),
      check('artifact-digests', observed),
      check('artifact-safety', packageSafety),
      {
        check_id: 'mutation-semantics',
        status: 'not-applicable',
        result_digest_sha256: 'a'.repeat(64),
      },
    ]);
    const { receipt_id: receiptId, receipt_digest_sha256: receiptDigest, ...projection } = receipt;
    expect(receiptDigest).toBe(canonicalSha256(projection));
    expect(receiptId).toBe(`ROV-${String(receiptDigest).slice(0, 16)}`);
    expect(value.reader.readArtifact).toHaveBeenCalledTimes(5);
    expect(collaborators.content).toHaveBeenCalledTimes(5);
    expect(value.dag.verify).toHaveBeenCalledOnce();
    const dagInput = required(required(value.dag.verify.mock.calls[0])[0]) as {
      expectedRepository: string;
      expectedCommit: string;
      expectedTree: string;
      expectedReleaseUnit: string;
      readEvidenceFile(kind: string, identity: string): Buffer;
    };
    expect(dagInput).toMatchObject({
      expectedRepository: 'fixture/repo',
      expectedCommit: 'a'.repeat(40),
      expectedTree: 'b'.repeat(40),
      expectedReleaseUnit: 'unit-a',
    });
    expect(dagInput.readEvidenceFile('result', sha(Buffer.from('task-result')))).toEqual(
      Buffer.from('task-result'),
    );
    expect(() => dagInput.readEvidenceFile('artifact', sha(Buffer.from('task-result')))).toThrow(
      'release-offline-verifier-failed',
    );
    expect(() => dagInput.readEvidenceFile('artifact', 'missing')).toThrow(
      'release-offline-verifier-failed',
    );
    expect(collaborators.archive).toHaveBeenCalledWith({
      package: packageRecord(value.state),
      release_unit: 'unit-a',
      version: '1.5.0',
      candidate: value.state.candidate,
      manifest: Buffer.from('manifest'),
      tarball: Buffer.from('tarball'),
      sbom: Buffer.from('sbom'),
      maximum_archive_bytes: 4096,
    });
    expect(collaborators.content.mock.calls).toEqual([
      [{ path: 'manifest.json', bytes: Buffer.from('manifest') }],
      [{ path: 'sbom.json', bytes: Buffer.from('sbom') }],
      [{ path: 'evidence.json', bytes: Buffer.from('evidence') }],
      [{ path: 'provider.json', bytes: required(value.bytes.get('provider')) }],
      [{ path: 'package/index.js', bytes: Buffer.from('entry') }],
    ]);
    expect(collaborators.signature).toHaveBeenCalledWith({
      trustStore: value.controls.trust_store,
      algorithm: 'ed25519',
      expectedSignerId: 'signer-1',
      expectedTrustRootId: 'root-1',
      expectedTrustStoreDigest: 'b'.repeat(64),
      expectedKeyId: 'key-1',
      payloadBytes: Buffer.from(transcript),
      signatureBytes: Buffer.alloc(64),
    });
    expect(collaborators.resultSet).toHaveBeenCalledWith(
      [required(value.bytes.get('provider'))],
      { transcript: Buffer.from(transcript), signature },
      value.controls.limits,
    );
    expect(collaborators.carrier).toHaveBeenCalledWith(Buffer.from('carrier'), 4096);
  });

  it('accepts exact inclusive archive, provider-result, and cumulative byte limits', async () => {
    const value = fixture();
    Object.assign(value.controls.limits, {
      maximum_provider_result_bytes: required(value.bytes.get('provider')).length,
    });
    Object.assign(value.controls, {
      maximum_archive_bytes: required(value.bytes.get('tarball')).length,
      maximum_total_bytes: [...value.bytes.values()].reduce(
        (total, item) => total + item.length,
        0,
      ),
    });
    await expect(
      createReleaseOfflineVerifierProvider(value.controls)(value.request, value.state, {} as never),
    ).resolves.toMatchObject({ verdict: 'pass' });
  });

  it.each([
    [
      'missing reader',
      (value: ReturnType<typeof fixture>) => Object.assign(value.controls, { reader: undefined }),
    ],
    [
      'missing DAG verifier',
      (value: ReturnType<typeof fixture>) =>
        Object.assign(value.controls.dag, { verify: undefined }),
    ],
    [
      'source commit prefix',
      (value: ReturnType<typeof fixture>) =>
        Object.assign(value.controls.dag.identity, { source_commit: `x${'d'.repeat(40)}` }),
    ],
    [
      'source commit suffix',
      (value: ReturnType<typeof fixture>) =>
        Object.assign(value.controls.dag.identity, { source_commit: `${'d'.repeat(40)}x` }),
    ],
    [
      'archive digest prefix',
      (value: ReturnType<typeof fixture>) =>
        Object.assign(value.controls.dag.identity, { archive_sha256: `x${'e'.repeat(64)}` }),
    ],
    [
      'archive digest suffix',
      (value: ReturnType<typeof fixture>) =>
        Object.assign(value.controls.dag.identity, { archive_sha256: `${'e'.repeat(64)}x` }),
    ],
  ])('rejects an invalid installed control at construction: %s', (_label, change) => {
    const value = fixture();
    change(value);
    expect(() => createReleaseOfflineVerifierProvider(value.controls)).toThrow(
      'release-offline-verifier-failed',
    );
  });

  it('accepts multiple distinct policy controls at construction', () => {
    const value = fixture();
    mutablePolicies(value.controls).push({ release_unit: 'unit-b', policy: { rule: 'strict' } });
    expect(createReleaseOfflineVerifierProvider(value.controls)).toBeTypeOf('function');
  });

  it.each([
    [
      'wrong lifecycle schema',
      (value: ReturnType<typeof fixture>) => Object.assign(value.state, { schemaVersion: '2.0.0' }),
    ],
    [
      'wrong lifecycle state',
      (value: ReturnType<typeof fixture>) => Object.assign(value.state, { state: 'prepared' }),
    ],
    [
      'candidate mismatch',
      (value: ReturnType<typeof fixture>) =>
        Object.assign(value.controls.candidate, { tree: '9'.repeat(40) }),
    ],
    [
      'policy population mismatch',
      (value: ReturnType<typeof fixture>) => mutablePolicies(value.controls).splice(0),
    ],
  ])('fails closed before artifact reads for %s', async (_label, change) => {
    const value = fixture();
    change(value);
    const provider = createReleaseOfflineVerifierProvider(value.controls);
    await expect(provider(value.request, value.state, {} as never)).rejects.toThrow(
      'release-offline-verifier-failed',
    );
    expect(value.reader.readArtifact).not.toHaveBeenCalled();
  });

  it.each([
    [
      'wrong sink',
      (value: ReturnType<typeof fixture>) => Object.assign(packageRecord(value.state) as never, {}),
    ],
    [
      'negative size',
      (value: ReturnType<typeof fixture>) =>
        Object.assign(packageRecord(value.state).package_manifest as never, {
          size_bytes: -1,
        }),
    ],
    [
      'oversized provider',
      (value: ReturnType<typeof fixture>) =>
        Object.assign(packageRecord(value.state).provider_result as never, {
          size_bytes: 4097,
        }),
    ],
    [
      'oversized archive',
      (value: ReturnType<typeof fixture>) =>
        Object.assign(packageRecord(value.state).package_tarball as never, {
          size_bytes: 4097,
        }),
    ],
  ])('rejects invalid artifact declarations for %s', async (label, change) => {
    const value = fixture();
    if (label === 'wrong sink') {
      Object.assign(packageRecord(value.state).package_manifest as never, {
        sink_id: 'other-sink',
      });
    } else change(value);
    await expect(
      createReleaseOfflineVerifierProvider(value.controls)(value.request, value.state, {} as never),
    ).rejects.toThrow('release-offline-verifier-failed');
    if (label === 'negative size') expect(value.reader.readArtifact).not.toHaveBeenCalled();
  });

  it.each([
    [
      'missing sink',
      (value: ReturnType<typeof fixture>) =>
        Object.assign(value.state, { artifact_sink: undefined }),
    ],
    [
      'missing provider result',
      (value: ReturnType<typeof fixture>) =>
        Object.assign(packageRecord(value.state), { provider_result: undefined }),
    ],
    [
      'missing package archive',
      (value: ReturnType<typeof fixture>) =>
        Object.assign(packageRecord(value.state), { package_tarball: undefined }),
    ],
  ])('uses the closed provider error for %s', async (_label, change) => {
    const value = fixture();
    change(value);
    await expect(
      createReleaseOfflineVerifierProvider(value.controls)(value.request, value.state, {} as never),
    ).rejects.toThrow(/^release-offline-verifier-failed$/u);
  });

  it('sorts both policy and state populations before comparing them', async () => {
    const value = fixture();
    mutablePolicies(value.controls).push({ release_unit: 'unit-b', policy: { rule: 'strict' } });
    const unitA = required(value.state.release_units[0]);
    Object.assign(value.state as never, {
      release_units: [{ release_unit: 'unit-b', version: '1.5.0', packages: [] }, unitA],
    });
    await expect(
      createReleaseOfflineVerifierProvider(value.controls)(value.request, value.state, {} as never),
    ).rejects.toThrow('release-offline-verifier-failed');
    expect(value.reader.readArtifact).toHaveBeenCalledTimes(5);
  });

  it('rejects cumulative limits and independently verifies returned bytes against declared size and digest', async () => {
    const tooMany = fixture();
    Object.assign(tooMany.controls, { maximum_total_bytes: 1 });
    await expect(
      createReleaseOfflineVerifierProvider(tooMany.controls)(
        tooMany.request,
        tooMany.state,
        {} as never,
      ),
    ).rejects.toThrow('release-offline-verifier-failed');

    const wrongLength = fixture();
    const differentLength = Buffer.from('different-length');
    wrongLength.reader.readArtifact.mockResolvedValue(differentLength);
    Object.assign(packageRecord(wrongLength.state).package_manifest as never, {
      sha256: sha(differentLength),
    });
    await expect(
      createReleaseOfflineVerifierProvider(wrongLength.controls)(
        wrongLength.request,
        wrongLength.state,
        {} as never,
      ),
    ).rejects.toThrow('release-offline-verifier-failed');

    const wrongDigest = fixture();
    const manifest = packageRecord(wrongDigest.state).package_manifest;
    Object.assign(manifest as never, { sha256: '0'.repeat(64) });
    await expect(
      createReleaseOfflineVerifierProvider(wrongDigest.controls)(
        wrongDigest.request,
        wrongDigest.state,
        {} as never,
      ),
    ).rejects.toThrow('release-offline-verifier-failed');
  });

  it.each([
    ['missing destination', undefined],
    ['missing trust', {}],
  ])('rejects %s with the closed provider error', async (_label, destination) => {
    const value = fixture();
    value.request = { destination } as never;
    await expect(
      createReleaseOfflineVerifierProvider(value.controls)(value.request, value.state, {} as never),
    ).rejects.toThrow(/^release-offline-verifier-failed$/u);
  });

  it('rejects a non-ed25519 trust declaration before invoking signer verification', async () => {
    const value = fixture();
    const incompatibleTrust = { ...trust, signature_algorithm: 'rsa-pss' };
    const parsed = JSON.parse(transcript) as Record<string, unknown>;
    parsed['trust'] = incompatibleTrust;
    const changedTranscript = JSON.stringify(parsed);
    value.bytes.set(
      'provider',
      Buffer.from(JSON.stringify({ transcript: changedTranscript, signature })),
    );
    Object.assign(
      packageRecord(value.state).provider_result as never,
      identity('provider', required(value.bytes.get('provider'))),
    );
    value.request = { destination: { trust: incompatibleTrust } } as never;
    await expect(
      createReleaseOfflineVerifierProvider(value.controls)(value.request, value.state, {} as never),
    ).rejects.toThrow('release-offline-verifier-failed');
    expect(collaborators.signature).not.toHaveBeenCalled();
  });

  it.each([
    ['missing transcript', { signature }],
    ['non-string signature', { transcript, signature: 7 }],
  ])('rejects malformed provider envelopes: %s', async (_label, envelope) => {
    const value = fixture();
    value.bytes.set('provider', Buffer.from(JSON.stringify(envelope)));
    const ref = packageRecord(value.state).provider_result;
    Object.assign(ref as never, identity('provider', required(value.bytes.get('provider'))));
    await expect(
      createReleaseOfflineVerifierProvider(value.controls)(value.request, value.state, {} as never),
    ).rejects.toThrow('release-offline-verifier-failed');
  });

  it.each([
    [
      'trust',
      (_value: ReturnType<typeof fixture>) =>
        collaborators.resultSet.mockReturnValue([portableResult()]),
      { ...trust, key_id: 'other' },
    ],
    [
      'repository',
      (_value: ReturnType<typeof fixture>) =>
        collaborators.resultSet.mockReturnValue([portableResult()]),
      trust,
    ],
  ])('rejects transcript %s binding drift', async (label, configure, requestTrust) => {
    const value = fixture();
    configure(value);
    const parsed = JSON.parse(transcript) as Record<string, unknown>;
    if (label === 'repository') {
      parsed['binding'] = { repository: { id: 'other/repo' }, candidate: value.state.candidate };
    }
    const changedTranscript = label === 'repository' ? JSON.stringify(parsed) : transcript;
    value.bytes.set(
      'provider',
      Buffer.from(JSON.stringify({ transcript: changedTranscript, signature })),
    );
    Object.assign(
      packageRecord(value.state).provider_result as never,
      identity('provider', required(value.bytes.get('provider'))),
    );
    value.request = { destination: { trust: requestTrust } } as never;
    await expect(
      createReleaseOfflineVerifierProvider(value.controls)(value.request, value.state, {} as never),
    ).rejects.toThrow('release-offline-verifier-failed');
  });

  it.each([
    ['non-canonical signature', `${signature}\n`],
    ['wrong signature length', Buffer.alloc(63).toString('base64')],
  ])('rejects %s before invoking signer verification', async (_label, signatureText) => {
    const value = fixture();
    value.bytes.set(
      'provider',
      Buffer.from(JSON.stringify({ transcript, signature: signatureText })),
    );
    Object.assign(
      packageRecord(value.state).provider_result as never,
      identity('provider', required(value.bytes.get('provider'))),
    );
    await expect(
      createReleaseOfflineVerifierProvider(value.controls)(value.request, value.state, {} as never),
    ).rejects.toThrow('release-offline-verifier-failed');
    expect(collaborators.signature).not.toHaveBeenCalled();
  });

  it.each([
    [
      'wrong policy',
      () =>
        collaborators.carrier.mockReturnValue({
          ...collaborators.carrier(),
          task_policy: Buffer.from('{"rule":"relaxed"}'),
        }),
    ],
    [
      'unknown release unit',
      () =>
        collaborators.resultSet.mockReturnValue([
          {
            certification_evidence: {
              ...portableResult().certification_evidence,
              release_unit: 'unit-b',
            },
          },
        ]),
    ],
    ['failed DAG', () => undefined],
    ['wrong DAG result kind', () => undefined],
    [
      'missing portable evidence',
      () => collaborators.resultSet.mockReturnValue([{ certification_evidence: null }]),
    ],
  ])('rejects incomplete or invalid certification closure: %s', async (label, configure) => {
    const value = fixture();
    if (label === 'failed DAG')
      value.dag.verify.mockResolvedValue({ ok: false, verification: 'candidate-receipt-dag' });
    else if (label === 'wrong DAG result kind')
      value.dag.verify.mockResolvedValue({ ok: true, verification: 'other' });
    else configure();
    await expect(
      createReleaseOfflineVerifierProvider(value.controls)(value.request, value.state, {} as never),
    ).rejects.toThrow('release-offline-verifier-failed');
  });

  it('uses the closed provider refusal when the installed DAG control is absent', () => {
    const value = fixture();
    Object.assign(value.controls, { dag: undefined });

    expect(() => createReleaseOfflineVerifierProvider(value.controls)).toThrow(
      /^release-offline-verifier-failed$/u,
    );
  });

  it.each([
    ['null', () => null],
    [
      'array carrying successful-looking properties',
      () => Object.assign([], { ok: true, verification: 'candidate-receipt-dag' }),
    ],
    [
      'callable carrying successful-looking properties',
      () => Object.assign(() => undefined, { ok: true, verification: 'candidate-receipt-dag' }),
    ],
  ])('rejects a non-record installed DAG result: %s', async (_label, createResult) => {
    const value = fixture();
    value.dag.verify.mockResolvedValue(createResult() as never);

    await expect(
      createReleaseOfflineVerifierProvider(value.controls)(value.request, value.state, {} as never),
    ).rejects.toThrow(/^release-offline-verifier-failed$/u);
    expect(value.dag.verify).toHaveBeenCalledOnce();
  });
});
