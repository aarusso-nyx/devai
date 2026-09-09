/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion --
 * Protocol-boundary tests deliberately construct malformed runtime values and inspect typed mocks.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '@devai-nyx/utils';

const mocks = vi.hoisted(() => ({
  prepared: {} as Record<string, unknown>,
  mutationError: undefined as Error | undefined,
  certificationError: undefined as Error | undefined,
  closureError: undefined as Error | undefined,
  transcriptAfterSigning: undefined as Buffer | undefined,
  verifySignature: true,
  abortError: false,
  putError: false,
  receiptFault: undefined as string | undefined,
  observedFault: undefined as 'non-buffer' | 'mismatch' | undefined,
  commitFault: false,
  puts: [] as Array<Record<string, unknown>>,
  preserved: 0,
  aborted: 0,
  committed: 0,
  createMutation: vi.fn(),
  createCertification: vi.fn(),
  verifyClosure: vi.fn(),
  createStore: vi.fn(),
}));

vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  createProtectedExportSignerAdapter: () => ({
    invokeSigner: <T>(operation: () => T): T => operation(),
  }),
}));

vi.mock('../../src/services/release-lifecycle-execution.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/release-lifecycle-execution.js')>()),
  assertReleaseProviderInvocationContext: (_request: unknown, context: unknown) => context,
  verifyReleaseStateIdentity: () => mocks.prepared,
}));

vi.mock('../../src/services/release-export-mutation-evidence.js', () => ({
  createReleaseExportMutationEvidence: (...args: unknown[]) => {
    mocks.createMutation(...args);
    if (mocks.mutationError !== undefined) throw mocks.mutationError;
    return Buffer.from('mutation-carrier');
  },
  readReleaseExportMutationEvidence: () => ({
    mutation_units: [
      { release_unit: '@fixture/decoy', mutation_evidence: null },
      {
        release_unit: '@fixture/unit',
        mutation_evidence: { carrier_package_id: '@fixture/a' },
      },
    ],
    portable_units: [
      { release_unit: '@fixture/decoy', mutation_evidence: null },
      {
        release_unit: '@fixture/unit',
        mutation_evidence: { version: 'fixture-mutation', bytes_base64: 'bXV0YXRpb24=' },
      },
    ],
  }),
}));

vi.mock('../../src/services/release-export-certification-evidence.js', () => ({
  createReleaseExportCertificationEvidence: (...args: unknown[]) => {
    mocks.createCertification(...args);
    if (mocks.certificationError !== undefined) throw mocks.certificationError;
    return Buffer.from('certification-carrier');
  },
  readReleaseExportCertificationEvidence: () => ({
    certification_units: [
      {
        release_unit: '@fixture/decoy',
        carrier_package_id: '@fixture/decoy',
        carrier: { sha256: '0'.repeat(64), size_bytes: 1 },
      },
      {
        release_unit: '@fixture/unit',
        carrier_package_id: '@fixture/b',
        carrier: { sha256: 'c'.repeat(64), size_bytes: 21 },
      },
    ],
    portable_units: [
      { release_unit: '@fixture/decoy', carrier_bytes_base64: 'MA==' },
      { release_unit: '@fixture/unit', carrier_bytes_base64: 'Y2VydGlmaWNhdGlvbg==' },
    ],
  }),
}));

vi.mock('../../src/services/release-policy-closure-transport.js', () => ({
  decodeReleasePolicyClosure: (bytes: Buffer) => ({ decoded: bytes.toString('utf8') }),
}));

vi.mock('../../src/services/release-policy-closure.js', () => ({
  verifyReleasePolicyClosure: (...args: unknown[]) => {
    mocks.verifyClosure(...args);
    if (mocks.closureError !== undefined) throw mocks.closureError;
    return { resolution: { fixture: 'verified' } };
  },
}));

vi.mock('../../src/services/release-export-transcript-v3.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/release-export-transcript-v3.js')>()),
  encodeReleaseExportTranscriptV3: (value: unknown) => Buffer.from(canonicalJson(value)),
  encodeReleaseExportProviderResultV3: (value: unknown) => Buffer.from(canonicalJson(value)),
}));

vi.mock('../../src/services/release-export-artifact-store.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/services/release-export-artifact-store.js')>();
  return {
    ...actual,
    createReleaseExportArtifactStore: async (...args: unknown[]) => {
      mocks.createStore(...args);
      const objects = new Map<string, Buffer>();
      const transcript = Buffer.from(canonicalJson({ kind: 'fixture-export-transcript' }));
      const put = async (object: Record<string, unknown>) => {
        if (mocks.putError) throw new Error('put failed');
        mocks.puts.push(object);
        const bytes = Buffer.from(object['bytes'] as Buffer);
        const handle = `object-${String(mocks.puts.length).padStart(2, '0')}`;
        objects.set(handle, bytes);
        const receipt = {
          kind: object['kind'],
          package_id: object['package_id'],
          sink_id: 'fixture-sink',
          transaction_handle: 'fixture-transaction',
          opaque_handle: handle,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size_bytes: bytes.length,
          export_spec_digest_sha256:
            '245fba3823b7f80a55b73e8721ac5871a40b90cce8789aa49b87228b8d03ac44',
        };
        if (mocks.receiptFault !== undefined) {
          (receipt as Record<string, unknown>)[mocks.receiptFault] =
            mocks.receiptFault === 'size_bytes' ? bytes.length + 1 : 'wrong';
        }
        return receipt;
      };
      const transaction = {
        sink_id: 'fixture-sink',
        transaction_handle: 'fixture-transaction',
        put,
        readArtifact: async ({ opaque_handle }: { opaque_handle: string }) => {
          if (mocks.observedFault === 'non-buffer') return 'not-bytes';
          if (mocks.observedFault === 'mismatch') return Buffer.from('wrong-bytes');
          return Buffer.from(objects.get(opaque_handle) ?? Buffer.alloc(0));
        },
        readTranscript: async () => Buffer.from(transcript),
        markSigningStarted: async () => Buffer.from(mocks.transcriptAfterSigning ?? transcript),
        readCommitManifest: async () => Buffer.from('committed-manifest'),
        commit: async (receipt: Record<string, unknown>) => {
          mocks.committed += 1;
          const committed = {
            committed: true,
            sink_id: 'fixture-sink',
            transaction_handle: 'fixture-transaction',
            committed_manifest_handle: receipt['opaque_handle'],
            committed_manifest_sha256: receipt['sha256'],
            committed_manifest_size_bytes: receipt['size_bytes'],
            commit_protocol: 'devai.artifact-sink.two-phase.v1',
          };
          return mocks.commitFault ? { ...committed, committed: false } : committed;
        },
        abort: async () => {
          mocks.aborted += 1;
          if (mocks.abortError) throw new Error('abort failed');
        },
        preserve: () => {
          mocks.preserved += 1;
        },
      };
      return {
        begin: async () => transaction,
        readArtifact: async (locator: { opaque_handle: string }) =>
          Buffer.from(objects.get(locator.opaque_handle) ?? Buffer.alloc(0)),
      };
    },
  };
});

import { createReleaseExportProvider } from '../../src/services/release-export-provider.js';
import type { ReleaseLifecycleRequest } from '../../src/services/release-lifecycle-execution.js';

const INVALID = 'release-export-artifact-sink-protocol-invalid';
const UNKNOWN = 'release-provider-result-unknown';
const PLAN = 'd'.repeat(64);

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function options(overrides: Record<string, unknown> = {}) {
  const closureA = Buffer.from('closure-a');
  const closureB = Buffer.from('closure-b');
  return {
    store: {
      root: '/private/tmp/release-export-provider-depth',
      sink_id: 'fixture-sink',
      repository_roots: [],
      max_blob_bytes: 64 * 1024,
      closure_limits: {
        maximum_archive_bytes: 64 * 1024,
        maximum_unpacked_bytes: 64 * 1024,
        maximum_git_bytes: 64 * 1024,
        maximum_git_entries: 100,
      },
      transport_limits: {
        maximum_transport_bytes: 64 * 1024,
        maximum_decoded_bytes: 64 * 1024,
        maximum_entries: 100,
      },
      transcript_limits: {
        maximum_transcript_bytes: 64 * 1024,
        maximum_provider_result_bytes: 32 * 1024,
        maximum_packages: 10,
      },
      implementation: { fixture: 'implementation' },
      closures: [
        {
          package_id: '@fixture/a',
          bytes: closureA,
          expected: {
            release_unit: '@fixture/unit',
            installed_package: { name: '@fixture/a', version: '1.0.0' },
          },
        },
        {
          package_id: '@fixture/b',
          bytes: closureB,
          expected: {
            release_unit: '@fixture/unit',
            installed_package: { name: '@fixture/b', version: '1.0.0' },
          },
        },
      ],
      parent_reader: { readArtifact: vi.fn(async () => Buffer.from('parent')) },
    },
    plan: {
      resolve_receipt: vi.fn(),
      resolve_plan_input: vi.fn(),
    },
    mutation_source: {
      unit_mutation_maximum_bytes: 4096,
      readUnitMutationEvidenceClosure: vi.fn(),
      readUnitMutationEvidenceReceipt: vi.fn(),
      readUnitMutationEvidenceBlob: vi.fn(),
    },
    certification_source: {
      certified_evidence_carrier_maximum_bytes: 4096,
      readCertifiedEvidenceCarrier: vi.fn(),
    },
    provider: { kind: 'evidence-export', provider_id: 'fixture-provider' },
    destination: { kind: 'evidence-destination', exact_identifier: 'fixture/destination' },
    trust: {
      trust_root_id: 'fixture-root',
      trust_store_digest_sha256: 'e'.repeat(64),
      key_id: 'fixture-key',
      signature_algorithm: 'ed25519',
    },
    signer: {
      sign: vi.fn(() => Buffer.from('signature')),
      verify: vi.fn(async () => mocks.verifySignature),
    },
    ...overrides,
  } as never;
}

function request(): ReleaseLifecycleRequest {
  return {
    action_id: 'release export',
    repository_locator: { id: 'fixture/repository', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    candidate_locator: {
      commit: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      release_units: [],
    },
    provider: { kind: 'evidence-export', provider_id: 'fixture-provider' },
    destination: {
      kind: 'evidence-destination',
      exact_identifier: 'fixture/destination',
      trust: {
        trust_root_id: 'fixture-root',
        trust_store_digest_sha256: 'e'.repeat(64),
        key_id: 'fixture-key',
        signature_algorithm: 'ed25519',
      },
    },
    receipt_locators: [
      {
        kind: 'release-plan-receipt',
        receipt_id: 'RCP-fixture',
        receipt_digest_sha256: PLAN,
        path: 'receipts/plan.json',
      },
    ],
  } as ReleaseLifecycleRequest;
}

function context() {
  return {
    action_id: 'release export',
    request_digest_sha256: 'f'.repeat(64),
    attempt_id: 'RLA-fixture',
    attempt_record: { sequence: 1, record_id: 'RLA-fixture', record_digest_sha256: '1'.repeat(64) },
    prior_state: mocks.prepared,
  } as never;
}

function resetPrepared(): void {
  mocks.prepared = {
    state: 'prepared',
    artifact_sink: { sink_id: 'parent-sink', transaction_handle: 'parent-transaction' },
    release_units: [
      {
        release_unit: '@fixture/unit',
        version: '1.0.0',
        packages: [
          { package_id: '@fixture/b', manifest: {}, tarball: null, sbom: null },
          { package_id: '@fixture/a', manifest: {}, tarball: null, sbom: null },
        ],
      },
    ],
    inputs: [{ kind: 'task-policy', path: 'policy.json', sha256: PLAN }],
    evidence: { manifest_digest_sha256: '2'.repeat(64), receipt_digests: [PLAN] },
    artifacts: [
      {
        kind: 'package-manifest',
        sink_id: 'parent-sink',
        opaque_handle: 'z-parent',
        sha256: '3'.repeat(64),
        size_bytes: 7,
      },
    ],
  };
}

describe('release export provider depth', () => {
  beforeEach(() => {
    mocks.mutationError = undefined;
    mocks.certificationError = undefined;
    mocks.closureError = undefined;
    mocks.transcriptAfterSigning = undefined;
    mocks.verifySignature = true;
    mocks.abortError = false;
    mocks.putError = false;
    mocks.receiptFault = undefined;
    mocks.observedFault = undefined;
    mocks.commitFault = false;
    mocks.puts.length = 0;
    mocks.preserved = 0;
    mocks.aborted = 0;
    mocks.committed = 0;
    mocks.createMutation.mockClear();
    mocks.createCertification.mockClear();
    mocks.verifyClosure.mockClear();
    mocks.createStore.mockClear();
  });

  it('exports exact closures and provider results, then commits and switches readers', async () => {
    resetPrepared();
    const input = options();
    const created = createReleaseExportProvider(input);
    await expect(
      created.reader.readArtifact({ sink_id: 'parent-sink', opaque_handle: 'parent-object' }),
    ).resolves.toEqual(Buffer.from('parent'));
    expect((input as any).store.parent_reader.readArtifact).toHaveBeenCalledWith({
      sink_id: 'parent-sink',
      opaque_handle: 'parent-object',
    });
    const result = await created.provider(request(), context());

    expect(result.outcome).toBe('success');
    expect(result.dispatch_status).toBe('dispatched');
    expect(result.provider_handle).toBe('fixture-transaction');
    expect(mocks.puts.map((row) => [row['kind'], row['package_id']])).toEqual([
      ['evidence-manifest', '@fixture/a'],
      ['evidence-manifest', '@fixture/b'],
      ['provider-result', '@fixture/a'],
      ['provider-result', '@fixture/b'],
      ['committed-manifest', null],
    ]);
    expect(mocks.puts.every((row) => row['sha256'] === digest(row['bytes'] as Buffer))).toBe(true);
    const providerResults = mocks.puts
      .filter((row) => row['kind'] === 'provider-result')
      .map((row) => JSON.parse(Buffer.from(row['bytes'] as Buffer).toString('utf8')));
    expect(providerResults).toEqual([
      expect.objectContaining({
        package_id: '@fixture/a',
        mutation_evidence: expect.objectContaining({ version: 'fixture-mutation' }),
        certification_evidence: null,
      }),
      expect.objectContaining({
        package_id: '@fixture/b',
        mutation_evidence: null,
        certification_evidence: expect.objectContaining({
          version: 'devai.release-certified-evidence-portable-json.v1',
          release_unit: '@fixture/unit',
          sha256: 'c'.repeat(64),
          size_bytes: 21,
        }),
      }),
    ]);
    const material = result.material!;
    expect(material.release_units[0]?.packages.map((pkg) => pkg.package_id)).toEqual([
      '@fixture/b',
      '@fixture/a',
    ]);
    expect(
      material.release_units[0]?.packages.every((pkg) => pkg.trust?.key_id === 'fixture-key'),
    ).toBe(true);
    expect(
      material.release_units[0]?.packages.map((pkg) => [
        pkg.package_id,
        pkg.evidence_manifest?.opaque_handle,
        pkg.provider_result?.opaque_handle,
      ]),
    ).toEqual([
      ['@fixture/b', 'object-02', 'object-04'],
      ['@fixture/a', 'object-01', 'object-03'],
    ]);
    expect(material.artifacts.map((entry) => entry.kind)).toEqual([
      'evidence-manifest',
      'evidence-manifest',
      'package-manifest',
      'provider-result',
      'provider-result',
    ]);
    expect(material.evidence.manifest_digest_sha256).toBe(
      digest(Buffer.from('committed-manifest')),
    );
    expect(mocks.createMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ action_id: 'release export' }),
        material: {
          release_units: mocks.prepared['release_units'],
          inputs: mocks.prepared['inputs'],
        },
        maximum_provider_result_bytes: 32 * 1024,
      }),
    );
    expect(mocks.createCertification).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ action_id: 'release export' }),
        material: { release_units: mocks.prepared['release_units'] },
        maximum_provider_result_bytes: 32 * 1024,
      }),
    );
    const mutationInput = mocks.createMutation.mock.calls[0]![0] as any;
    expect(Object.keys(mutationInput.plan).sort()).toEqual([
      'resolve_plan_input',
      'resolve_receipt',
    ]);
    expect(Object.keys(mutationInput.source).sort()).toEqual([
      'readUnitMutationEvidenceBlob',
      'readUnitMutationEvidenceClosure',
      'readUnitMutationEvidenceReceipt',
      'unit_mutation_maximum_bytes',
    ]);
    mutationInput.plan.resolve_receipt('receipt');
    mutationInput.plan.resolve_plan_input('input');
    mutationInput.source.readUnitMutationEvidenceClosure('closure');
    mutationInput.source.readUnitMutationEvidenceReceipt('receipt');
    mutationInput.source.readUnitMutationEvidenceBlob('blob');
    expect((input as any).plan.resolve_receipt).toHaveBeenCalledWith('receipt');
    expect((input as any).plan.resolve_plan_input).toHaveBeenCalledWith('input');
    expect((input as any).mutation_source.readUnitMutationEvidenceClosure).toHaveBeenCalledWith(
      'closure',
    );
    expect((input as any).mutation_source.readUnitMutationEvidenceReceipt).toHaveBeenCalledWith(
      'receipt',
    );
    expect((input as any).mutation_source.readUnitMutationEvidenceBlob).toHaveBeenCalledWith(
      'blob',
    );
    const certificationInput = mocks.createCertification.mock.calls[0]![0] as any;
    expect(certificationInput.source.certified_evidence_carrier_maximum_bytes).toBe(4096);
    certificationInput.source.readCertifiedEvidenceCarrier('carrier');
    expect((input as any).certification_source.readCertifiedEvidenceCarrier).toHaveBeenCalledWith(
      'carrier',
    );
    const storeInput = mocks.createStore.mock.calls[0]![0] as any;
    expect(storeInput.binding).toMatchObject({
      action_id: 'release export',
      repository: request().repository_locator,
      candidate: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
      plan_receipt_digest_sha256: PLAN,
      sink_id: 'fixture-sink',
      attempt_id: 'RLA-fixture',
      export_spec_digest_sha256: '245fba3823b7f80a55b73e8721ac5871a40b90cce8789aa49b87228b8d03ac44',
    });
    expect(storeInput.binding.closure_inputs).toEqual([
      expect.objectContaining({
        package_id: '@fixture/a',
        release_unit: '@fixture/unit',
        sha256: digest(Buffer.from('closure-a')),
        size_bytes: 9,
      }),
      expect.objectContaining({
        package_id: '@fixture/b',
        release_unit: '@fixture/unit',
        sha256: digest(Buffer.from('closure-b')),
        size_bytes: 9,
      }),
    ]);

    const manifest = material.artifact_sink!;
    await result.transaction!.commit();
    expect(mocks.committed).toBe(1);
    await expect(
      created.reader.readArtifact({
        sink_id: manifest.sink_id,
        opaque_handle: manifest.committed_manifest_handle,
      }),
    ).resolves.toEqual(Buffer.from('committed-manifest'));
    await expect(result.transaction!.commit()).rejects.toThrow(INVALID);
  });

  it.each([0, 0.5, 0x80000000])(
    'rejects invalid maximum blob budget %s at construction',
    (maximum) => {
      expect(() =>
        createReleaseExportProvider(
          options({ store: { ...(options() as any).store, max_blob_bytes: maximum } }),
        ),
      ).toThrow(INVALID);
    },
  );

  it('honors the inclusive numeric construction boundaries', () => {
    const base = options() as any;
    expect(() =>
      createReleaseExportProvider({
        ...base,
        store: { ...base.store, max_blob_bytes: 1 },
      }),
    ).toThrow('release-export-transcript-invalid');
    expect(() =>
      createReleaseExportProvider({
        ...base,
        store: { ...base.store, max_blob_bytes: 0x7fffffff },
      }),
    ).not.toThrow();
  });

  it('preserves absence of optional plan and evidence readers', async () => {
    resetPrepared();
    const base = options() as any;
    const { provider } = createReleaseExportProvider({
      ...base,
      plan: {},
      mutation_source: { unit_mutation_maximum_bytes: 4096 },
      certification_source: {},
    });
    await expect(provider(request(), context())).resolves.toMatchObject({ outcome: 'success' });
    const mutationInput = mocks.createMutation.mock.calls[0]![0] as any;
    expect(mutationInput.plan).toEqual({});
    expect(mutationInput.source).toEqual({ unit_mutation_maximum_bytes: 4096 });
    const certificationInput = mocks.createCertification.mock.calls[0]![0] as any;
    expect(certificationInput.source).toEqual({});
  });

  it('copies closure bytes and rejects proxies and archives beyond the exact budget', () => {
    const base = options() as any;
    const bytes = Buffer.alloc(8192, 1);
    const provider = createReleaseExportProvider({
      ...base,
      store: {
        ...base.store,
        max_blob_bytes: 8192,
        closures: [{ ...base.store.closures[0], bytes }],
      },
    });
    bytes.fill(9);
    expect(provider).toBeDefined();

    for (const candidate of [Buffer.alloc(8193), new Proxy(Buffer.alloc(1), {})]) {
      expect(() =>
        createReleaseExportProvider({
          ...base,
          store: {
            ...base.store,
            max_blob_bytes: 8192,
            closures: [{ ...base.store.closures[0], bytes: candidate }],
          },
        }),
      ).toThrow(INVALID);
    }
  });

  it.each([
    ['mutation source', () => (mocks.mutationError = new Error('source failed')), INVALID],
    [
      'certification source',
      () => (mocks.certificationError = new Error('source failed')),
      INVALID,
    ],
    ['unsafe closure', () => (mocks.closureError = new Error('unsafe archive')), INVALID],
  ])('fails closed before signing for %s errors', async (_name, arrange, code) => {
    resetPrepared();
    arrange();
    const { provider } = createReleaseExportProvider(options());
    await expect(provider(request(), context())).resolves.toEqual({
      outcome: 'failure',
      dispatch_status: 'failed-before-dispatch',
      code,
    });
  });

  it.each([
    ['request action', (req: any) => (req.action_id = 'release prepare')],
    ['context action', (_req: any, ctx: any) => (ctx.action_id = 'release prepare')],
    ['provider identity', (req: any) => (req.provider.provider_id = 'wrong')],
    ['destination identity', (req: any) => (req.destination.exact_identifier = 'wrong')],
    ['missing predecessor', (_req: any, ctx: any) => (ctx.prior_state = null)],
  ])('rejects a mismatched %s before evidence access', async (_name, mutate) => {
    resetPrepared();
    const req = request() as any;
    const ctx = context() as any;
    mutate(req, ctx);
    const { provider } = createReleaseExportProvider(options());
    await expect(provider(req, ctx)).resolves.toMatchObject({ outcome: 'failure', code: INVALID });
    expect(mocks.createMutation).not.toHaveBeenCalled();
  });

  it.each([
    ['state', { state: 'planned' }],
    ['artifact sink', { artifact_sink: null }],
  ])('rejects an invalid prepared %s', async (_name, change) => {
    resetPrepared();
    Object.assign(mocks.prepared, change);
    const { provider } = createReleaseExportProvider(options());
    await expect(provider(request(), context())).resolves.toMatchObject({
      outcome: 'failure',
      code: INVALID,
    });
  });

  it.each([
    ['missing', (req: any) => delete req.receipt_locators],
    ['empty', (req: any) => (req.receipt_locators = [])],
    ['duplicate', (req: any) => req.receipt_locators.push({ ...req.receipt_locators[0] })],
    ['wrong kind', (req: any) => (req.receipt_locators[0].kind = 'release-certification-receipt')],
  ])('rejects %s plan-receipt population', async (_name, mutate) => {
    resetPrepared();
    const req = request() as any;
    mutate(req);
    const { provider } = createReleaseExportProvider(options());
    await expect(provider(req, context())).resolves.toMatchObject({
      outcome: 'failure',
      code: INVALID,
    });
  });

  it.each([
    'kind',
    'package_id',
    'sink_id',
    'transaction_handle',
    'sha256',
    'size_bytes',
    'export_spec_digest_sha256',
  ])('rejects a store receipt with a mismatched %s', async (field) => {
    resetPrepared();
    mocks.receiptFault = field;
    const { provider } = createReleaseExportProvider(options());
    await expect(provider(request(), context())).resolves.toMatchObject({
      outcome: 'failure',
      dispatch_status: 'failed-before-dispatch',
      code: INVALID,
    });
    expect(mocks.aborted).toBe(1);
  });

  it.each(['non-buffer', 'mismatch'] as const)(
    'rejects %s read-after-write content',
    async (fault) => {
      resetPrepared();
      mocks.observedFault = fault;
      const { provider } = createReleaseExportProvider(options());
      await expect(provider(request(), context())).resolves.toMatchObject({
        outcome: 'failure',
        code: INVALID,
      });
    },
  );

  it.each([
    'release-export-capacity-unavailable',
    'release-export-capacity-insufficient',
    'rpl-package-identity-mismatch',
    'rpl-policy-resolution-mismatch',
    'rpl-adopter-binding-mismatch',
    'rpl-policy-source-unresolved',
  ])('retains the stable pre-sign refusal %s', async (code) => {
    resetPrepared();
    mocks.closureError = new Error(code);
    const { provider } = createReleaseExportProvider(options());
    await expect(provider(request(), context())).resolves.toEqual({
      outcome: 'failure',
      dispatch_status: 'failed-before-dispatch',
      code,
    });
  });

  it.each([
    ['empty', Buffer.alloc(0), 'unknown'],
    ['one byte', Buffer.alloc(1), 'success'],
    ['maximum bytes', Buffer.alloc(12288), 'success'],
    ['oversize', Buffer.alloc(12289), 'unknown'],
    ['non-buffer', 'signature', 'unknown'],
  ])('enforces the exact %s signature boundary', async (_name, signature, outcome) => {
    resetPrepared();
    const base = options() as any;
    const { provider } = createReleaseExportProvider({
      ...base,
      signer: { sign: () => signature, verify: async () => true },
    });
    await expect(provider(request(), context())).resolves.toMatchObject({ outcome });
  });

  it('refuses a mismatched commit acknowledgement', async () => {
    resetPrepared();
    mocks.commitFault = true;
    const { provider } = createReleaseExportProvider(options());
    const result = await provider(request(), context());
    expect(result.outcome).toBe('success');
    await expect(result.transaction!.commit()).rejects.toThrow(INVALID);
  });

  it('preserves the transaction and returns unknown for post-sign transcript or signature failures', async () => {
    resetPrepared();
    mocks.transcriptAfterSigning = Buffer.from('{}');
    const first = createReleaseExportProvider(options());
    await expect(first.provider(request(), context())).resolves.toEqual({
      outcome: 'unknown',
      dispatch_status: 'unknown',
      code: UNKNOWN,
      provider_handle: 'fixture-transaction',
    });
    expect(mocks.preserved).toBe(1);
    expect(mocks.aborted).toBe(0);

    mocks.transcriptAfterSigning = undefined;
    mocks.verifySignature = false;
    const second = createReleaseExportProvider(options());
    await expect(second.provider(request(), context())).resolves.toMatchObject({
      outcome: 'unknown',
      dispatch_status: 'unknown',
      code: UNKNOWN,
    });
    expect(mocks.preserved).toBe(2);
  });

  it('keeps the explicit unsupported-algorithm refusal and converts abort failure to unknown', async () => {
    resetPrepared();
    const base = options() as any;
    const unsupported = createReleaseExportProvider({
      ...base,
      trust: { ...base.trust, signature_algorithm: 'rsa' },
    });
    const unsupportedRequest = request() as any;
    unsupportedRequest.destination.trust.signature_algorithm = 'rsa';
    await expect(unsupported.provider(unsupportedRequest, context())).resolves.toMatchObject({
      outcome: 'failure',
      code: 'SIGNATURE_ALGORITHM_UNSUPPORTED',
    });

    mocks.putError = true;
    mocks.abortError = true;
    const aborting = createReleaseExportProvider(options());
    await expect(aborting.provider(request(), context())).resolves.toEqual({
      outcome: 'unknown',
      dispatch_status: 'unknown',
      code: UNKNOWN,
    });
    expect(mocks.preserved).toBeGreaterThan(0);
  });

  it('preserves exactly once for rollback or dispose and rejects a second invocation', async () => {
    resetPrepared();
    const rollback = createReleaseExportProvider(options());
    const first = await rollback.provider(request(), context());
    first.transaction!.rollback();
    first.transaction!.dispose();
    expect(mocks.preserved).toBe(1);
    await expect(rollback.provider(request(), context())).resolves.toMatchObject({
      outcome: 'failure',
      code: INVALID,
    });

    const dispose = createReleaseExportProvider(options());
    const second = await dispose.provider(request(), context());
    second.transaction!.dispose();
    second.transaction!.rollback();
    expect(mocks.preserved).toBe(2);
  });

  it('retains hashing, ordering, equality, and refusal behavior in a freshly evaluated module', async () => {
    vi.resetModules();
    const fresh =
      await import('../../src/services/release-export-provider.js?fresh-provider-depth');
    const invalid = options() as any;
    invalid.store.max_blob_bytes = 0;
    expect(() => fresh.createReleaseExportProvider(invalid)).toThrow(INVALID);

    resetPrepared();
    const created = fresh.createReleaseExportProvider(options());
    const result = await created.provider(request(), context());
    expect(result.outcome).toBe('success');
    expect(result.material?.artifacts.map((row) => row.kind)).toEqual([
      'evidence-manifest',
      'evidence-manifest',
      'package-manifest',
      'provider-result',
      'provider-result',
    ]);
    expect(mocks.puts.every((row) => row['sha256'] === digest(row['bytes'] as Buffer))).toBe(true);
    await expect(result.transaction!.commit()).resolves.toBeUndefined();
  });
});
