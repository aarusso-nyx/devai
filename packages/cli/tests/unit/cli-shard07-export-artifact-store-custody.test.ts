import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '@devai-nyx/utils';
import {
  createReleaseExportArtifactStore,
  RELEASE_EXPORT_SPEC_DIGEST,
  RELEASE_EXPORT_SPEC_ID,
  type ProtectedReleaseExportBinding,
  type ReleaseExportArtifactObject,
  type ReleaseExportArtifactObjectReceipt,
  type ReleaseExportArtifactStoreOptions,
} from '../../src/services/release-export-artifact-store.js';
import { encodeReleaseExportProviderResult } from '../../src/services/release-export-transcript.js';
import { RELEASE_EXPORT_SPEC_V4_DIGEST } from '../../src/services/release-export-transcript-v3.js';
import { RELEASE_EXPORT_SPEC_V3_DIGEST } from '../../src/services/release-export-transcript-v2.js';
import type {
  OpaqueArtifactIdentity,
  ReleaseLifecycleStateV2,
  TrustedArtifactReader,
} from '../../src/services/release-lifecycle-execution.js';

const mocks = vi.hoisted(() => ({
  parentBytes: new Map<string, Buffer>(),
  checkRoot: vi.fn(),
  capacity: vi.fn(),
  artifactSpec: undefined as Readonly<Record<string, unknown>> | undefined,
  reverify: vi.fn(),
  verifyManifest: vi.fn(),
  mutationUnits: [{ release_unit: '@fixture/release', mutation_evidence: null }],
  certificationUnits: [
    { release_unit: '@fixture/release', carrier_package_id: '@fixture/package' },
  ],
  reverifyMutation: vi.fn(),
  reverifyCertification: vi.fn(),
  verifyProviderSetV3: vi.fn(),
}));

vi.mock('@devai-nyx/authority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@devai-nyx/authority')>();
  return {
    ...actual,
    createProtectedExportSinkAdapter: () => ({
      invokeSink: <T>(operation: () => T) => operation(),
    }),
    createProtectedReleaseSinkOwner: () => ({}),
    readProtectedReleaseExportCapacity: (...args: unknown[]) => mocks.capacity(...args),
    createProtectedReleaseSinkFilesystem: () => ({
      closeSync,
      fsyncSync,
      linkSync,
      mkdirSync,
      openSync,
      writeSync,
      readdirSync,
      assertWriteAuthority: () => undefined,
    }),
  };
});

vi.mock('../../src/services/release-artifact-store.js', () => ({
  createReleaseArtifactStore: () => ({
    readArtifact: ({ opaque_handle }: { readonly opaque_handle: string }) => {
      const value = mocks.parentBytes.get(opaque_handle);
      if (value === undefined) throw new Error('fixture parent object missing');
      return Buffer.from(value);
    },
  }),
}));

vi.mock('../../src/services/release-host-package-binding.js', () => ({
  assertBoundReleaseHostPackageSnapshot: () => undefined,
}));

vi.mock('../../src/services/release-lifecycle-execution.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/release-lifecycle-execution.js')>()),
  verifyReleaseStateIdentity: (value: unknown) => value,
}));

vi.mock('../../src/services/release-prepare-kernel.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/release-prepare-kernel.js')>()),
  reverifySinkArtifacts: (...args: unknown[]) => mocks.reverify(...args),
  verifyPreparedPackageManifest: (...args: unknown[]) => mocks.verifyManifest(...args),
}));

vi.mock('../../src/services/release-policy-closure-transport.js', () => ({
  decodeReleasePolicyClosure: () => ({
    plan: { receipt_digest_sha256: 'd'.repeat(64), determination: { mutation: 'none' } },
  }),
}));

vi.mock('../../src/services/release-policy-closure.js', () => ({
  verifyReleasePolicyClosure: () => ({
    resolution: { fixture: 'release-export-resolution' },
    readInput: () => ({
      execution_contract: {
        prepare_kernel: {
          export_extension: {
            artifact_spec: mocks.artifactSpec ?? legacyArtifactSpec(),
          },
        },
      },
    }),
  }),
}));

vi.mock('../../src/services/release-export-mutation-evidence.js', () => ({
  readReleaseExportMutationEvidence: () => ({ mutation_units: mocks.mutationUnits }),
  reverifyReleaseExportMutationEvidence: (...args: unknown[]) => mocks.reverifyMutation(...args),
}));

vi.mock('../../src/services/release-export-certification-evidence.js', () => ({
  readReleaseExportCertificationEvidence: () => ({ certification_units: mocks.certificationUnits }),
  reverifyReleaseExportCertificationEvidence: (...args: unknown[]) =>
    mocks.reverifyCertification(...args),
}));

vi.mock('../../src/services/release-export-transcript-v3.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/release-export-transcript-v3.js')>()),
  encodeReleaseExportTranscriptV3: (value: unknown) => canonical(value),
  verifyReleaseExportProviderResultV3: () => undefined,
  verifyReleaseExportProviderResultSetV3: (...args: unknown[]) =>
    mocks.verifyProviderSetV3(...args),
}));

const ERROR = 'release-export-artifact-sink-protocol-invalid';
const SINK = 'fixture-export-sink';
const PLAN = 'd'.repeat(64);
const REPOSITORY = { id: 'aarusso-nyx/devai', commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
const CANDIDATE = { commit: REPOSITORY.commit, tree: REPOSITORY.tree };
const EXPECTED_INSTALLED = {
  name: '@aarusso-nyx/devai' as const,
  version: '1.5.0',
  archive_sha256: 'e'.repeat(64),
  content_manifest_sha256: 'f'.repeat(64),
};
const roots: string[] = [];

function legacyArtifactSpec(): Readonly<Record<string, unknown>> {
  const schema = JSON.parse(
    readFileSync(join(process.cwd(), 'law/schemas/release-lifecycle-policy.schema.json'), 'utf8'),
  ) as {
    readonly $defs: {
      readonly export_extension_v2: {
        readonly const: { readonly artifact_spec: Readonly<Record<string, unknown>> };
      };
    };
  };
  return schema.$defs.export_extension_v2.const.artifact_spec;
}

function v4ArtifactSpec(): Readonly<Record<string, unknown>> {
  const schema = JSON.parse(
    readFileSync(join(process.cwd(), 'law/schemas/release-lifecycle-policy.schema.json'), 'utf8'),
  ) as {
    readonly $defs: {
      readonly export_extension_v4: {
        readonly const: { readonly artifact_spec: Readonly<Record<string, unknown>> };
      };
    };
  };
  return schema.$defs.export_extension_v4.const.artifact_spec;
}

function v3ArtifactSpec(): Readonly<Record<string, unknown>> {
  const schema = JSON.parse(
    readFileSync(join(process.cwd(), 'law/schemas/release-lifecycle-policy.schema.json'), 'utf8'),
  ) as {
    readonly $defs: {
      readonly export_extension_v3: {
        readonly const: { readonly artifact_spec: Readonly<Record<string, unknown>> };
      };
    };
  };
  return schema.$defs.export_extension_v3.const.artifact_spec;
}

function hash(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8');
}

function temporary(prefix: string): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-`)));
  chmodSync(value, 0o700);
  roots.push(value);
  return value;
}

function artifact(kind: OpaqueArtifactIdentity['kind'], handle: string, value: Buffer) {
  mocks.parentBytes.set(handle, Buffer.from(value));
  return {
    kind,
    sink_id: SINK,
    opaque_handle: handle,
    sha256: hash(value),
    size_bytes: value.length,
  };
}

function order(values: readonly OpaqueArtifactIdentity[]) {
  return [...values].sort((left, right) =>
    Buffer.compare(
      Buffer.from(
        `${left.kind}\0${left.sink_id}\0${left.opaque_handle}\0${left.sha256}\0${left.size_bytes}`,
      ),
      Buffer.from(
        `${right.kind}\0${right.sink_id}\0${right.opaque_handle}\0${right.sha256}\0${right.size_bytes}`,
      ),
    ),
  );
}

function fixture(): {
  readonly options: ReleaseExportArtifactStoreOptions;
  readonly closure: Buffer;
  readonly parentReader: TrustedArtifactReader;
} {
  mocks.parentBytes.clear();
  mocks.reverify.mockClear();
  mocks.verifyManifest.mockClear();
  mocks.capacity.mockReset().mockReturnValue({
    remaining_batches: 1_000,
    remaining_targets: 1_000,
  });
  mocks.artifactSpec = undefined;
  const root = temporary('devai export artifact store');
  const candidateRoot = temporary('devai export candidate');
  const packageJson = canonical({ name: '@fixture/package', version: '1.5.0' });
  const manifest = artifact('package-manifest', 'parent-manifest', packageJson);
  const tarball = artifact('package-tarball', 'parent-tarball', Buffer.from('tarball'));
  const sbom = artifact('package-sbom', 'parent-sbom', Buffer.from('sbom'));
  const parentArtifacts = order([manifest, tarball, sbom]);
  const parentManifest = canonical({ kind: 'prepared-parent', artifacts: parentArtifacts });
  const parent = {
    sink_id: SINK,
    transaction_handle: 'parent-transaction',
    committed_manifest_handle: 'parent-commit',
    committed_manifest_sha256: hash(parentManifest),
    committed_manifest_size_bytes: parentManifest.length,
    commit_protocol: 'devai.artifact-sink.two-phase.v1' as const,
  };
  mocks.parentBytes.set(parent.committed_manifest_handle, parentManifest);
  const closure = canonical({ fixture: 'policy-closure' });
  const resolution = { fixture: 'release-export-resolution' };
  const binding: ProtectedReleaseExportBinding = {
    action_id: 'release export',
    repository: REPOSITORY,
    candidate: CANDIDATE,
    plan_receipt_digest_sha256: PLAN,
    parent_artifact_sink: parent,
    sink_id: SINK,
    destination: { kind: 'evidence-destination', exact_identifier: 'fixture/export' },
    trust: {
      trust_root_id: 'fixture/trust',
      trust_store_digest_sha256: 'c'.repeat(64),
      key_id: 'fixture-key',
      signature_algorithm: 'ed25519',
    },
    attempt_id: 'RLA-0123456789abcdef',
    export_spec_digest_sha256: RELEASE_EXPORT_SPEC_DIGEST,
    closure_inputs: [
      {
        package_id: '@fixture/package',
        sha256: hash(closure),
        size_bytes: closure.length,
        expected_installed_package: EXPECTED_INSTALLED,
        policy_resolution_digest_sha256: hash(canonical(resolution)),
      },
    ],
  };
  const state = {
    schemaVersion: '2.1.0',
    state: 'prepared',
    action_id: 'release prepare',
    state_id: 'RLS-fixture',
    record_digest_sha256: '1'.repeat(64),
    repository: REPOSITORY,
    candidate: { release_unit: '@fixture/release', version: '1.5.0', ...CANDIDATE },
    release_units: [
      {
        release_unit: '@fixture/release',
        version: '1.5.0',
        packages: [
          {
            package_id: '@fixture/package',
            manifest: null,
            tarball: null,
            sbom: null,
            package_manifest: manifest,
            package_tarball: tarball,
            package_sbom: sbom,
            evidence_manifest: null,
            provider_result: null,
            trust: null,
          },
        ],
      },
    ],
    inputs: [],
    evidence: {
      manifest_digest_sha256: '2'.repeat(64),
      receipt_digests: [PLAN],
      independently_checkable: true,
    },
    artifacts: parentArtifacts,
    artifact_sink: parent,
    bound_receipts: [
      {
        kind: 'release-plan-receipt',
        receipt_id: `RPL-${PLAN.slice(0, 16)}`,
        receipt_digest_sha256: PLAN,
        verdict: 'pass',
      },
    ],
  } as unknown as ReleaseLifecycleStateV2;
  const parentReader: TrustedArtifactReader = {
    readArtifact: ({ opaque_handle }) => {
      const value = mocks.parentBytes.get(opaque_handle);
      if (value === undefined) throw new Error('fixture parent object missing');
      return Buffer.from(value);
    },
  };
  return {
    closure,
    parentReader,
    options: {
      root,
      sink_id: SINK,
      repository_roots: [candidateRoot],
      max_blob_bytes: 64 * 1024,
      binding,
      prepared_state: state,
      parent_reader: parentReader,
      implementation: {} as never,
      closures: [
        {
          package_id: '@fixture/package',
          bytes: closure,
          expected: {
            repository: REPOSITORY,
            release_unit: '@fixture/release',
            installed_package: EXPECTED_INSTALLED,
          } as never,
        },
      ],
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
        maximum_provider_result_bytes: 64 * 1024,
        maximum_packages: 1,
      },
    },
  };
}

function object(
  kind: ReleaseExportArtifactObject['kind'],
  packageId: string | null,
  value: Buffer,
): ReleaseExportArtifactObject {
  const common = { bytes: value, sha256: hash(value), size_bytes: value.length };
  return kind === 'committed-manifest'
    ? { ...common, kind, package_id: null }
    : { ...common, kind, package_id: packageId ?? '@fixture/package' };
}

function forwardFixture() {
  const value = fixture();
  mocks.artifactSpec = v4ArtifactSpec();
  const binding = value.options.binding;
  return {
    ...value,
    options: {
      ...value.options,
      binding: {
        ...binding,
        export_spec_digest_sha256: RELEASE_EXPORT_SPEC_V4_DIGEST,
        closure_inputs: binding.closure_inputs.map((entry) => ({
          ...entry,
          release_unit: '@fixture/release',
        })),
        mutation_units: mocks.mutationUnits,
        certification_units: mocks.certificationUnits,
      },
      mutation_evidence: Buffer.from('mutation-evidence'),
      certification_evidence: Buffer.from('certification-evidence'),
    } as unknown as ReleaseExportArtifactStoreOptions,
  };
}

function currentFixture() {
  const value = fixture();
  mocks.artifactSpec = v3ArtifactSpec();
  const binding = value.options.binding;
  return {
    ...value,
    options: {
      ...value.options,
      binding: {
        ...binding,
        export_spec_digest_sha256: RELEASE_EXPORT_SPEC_V3_DIGEST,
        closure_inputs: binding.closure_inputs.map((entry) => ({
          ...entry,
          release_unit: '@fixture/release',
        })),
        mutation_units: mocks.mutationUnits,
      },
      mutation_evidence: Buffer.from('mutation-evidence'),
    } as unknown as ReleaseExportArtifactStoreOptions,
  };
}

async function forwardTransactionFixture() {
  const value = forwardFixture();
  const store = await createReleaseExportArtifactStore(value.options);
  const transaction = await store.begin();
  const closureReceipt = await transaction.put(
    object('evidence-manifest', '@fixture/package', value.closure),
  );
  const transcript = await transaction.markSigningStarted();
  const provider = canonical({ package_id: '@fixture/package', signature: 'AQ==' });
  const providerReceipt = await transaction.put(
    object('provider-result', '@fixture/package', provider),
  );
  return { ...value, store, transaction, closureReceipt, providerReceipt, transcript };
}

async function transactionFixture() {
  const value = fixture();
  const store = await createReleaseExportArtifactStore(value.options);
  const transaction = await store.begin();
  const closureReceipt = await transaction.put(
    object('evidence-manifest', '@fixture/package', value.closure),
  );
  const transcript = await transaction.markSigningStarted();
  const provider = encodeReleaseExportProviderResult(
    { package_id: '@fixture/package', transcript, signature: 'AQ==' },
    value.options.transcript_limits,
  );
  const providerReceipt = await transaction.put(
    object('provider-result', '@fixture/package', provider),
  );
  return { ...value, store, transaction, closureReceipt, providerReceipt, transcript };
}

async function committedFixture() {
  const value = await transactionFixture();
  const manifest = await value.transaction.readCommitManifest();
  const manifestReceipt = await value.transaction.put(object('committed-manifest', null, manifest));
  const commit = await value.transaction.commit(manifestReceipt);
  return { ...value, manifest, manifestReceipt, commit };
}

function receiptPath(root: string, handle: string): string {
  const [transaction, id] = handle.split(':');
  return join(root, 'exports', transaction ?? '', 'receipts', `${id ?? ''}.json`);
}

function objectPath(root: string, sha256: string): string {
  return join(root, 'objects', sha256);
}

async function refusal(callback: () => unknown | Promise<unknown>): Promise<void> {
  await expect(Promise.resolve().then(callback)).rejects.toThrow(ERROR);
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('release export artifact store depth', () => {
  it('keeps the current mutation-only transcript on the V2 format branch', async () => {
    const value = currentFixture();
    const store = await createReleaseExportArtifactStore(value.options);
    const transaction = await store.begin();
    await transaction.put(object('evidence-manifest', '@fixture/package', value.closure));
    const transcript = JSON.parse((await transaction.markSigningStarted()).toString('utf8')) as {
      version: string;
      mutation_units: unknown;
    };
    expect(transcript.version).toBe('devai.release-export-transcript-json.v2');
    expect(transcript.mutation_units).toEqual(mocks.mutationUnits);
  });

  it('binds forward mutation and certification evidence through transcript custody', async () => {
    const value = await forwardTransactionFixture();
    expect(mocks.reverifyMutation).toHaveBeenCalledWith(Buffer.from('mutation-evidence'));
    expect(mocks.reverifyCertification).toHaveBeenCalledWith(Buffer.from('certification-evidence'));
    await expect(
      value.transaction.readArtifact({
        sink_id: SINK,
        opaque_handle: value.closureReceipt.opaque_handle,
      }),
    ).resolves.toEqual(value.closure);
    expect(JSON.parse(value.transcript.toString('utf8'))).toMatchObject({
      version: 'devai.release-export-transcript-json.v3',
      mutation_units: mocks.mutationUnits,
      certification_units: mocks.certificationUnits,
    });
    const manifest = await value.transaction.readCommitManifest();
    expect(JSON.parse(manifest.toString('utf8'))).toMatchObject({
      kind: 'release-artifact-sink-commit-manifest',
    });
    expect(mocks.verifyProviderSetV3).toHaveBeenCalledTimes(1);
    const providerSet = mocks.verifyProviderSetV3.mock.calls[0]?.[0] as Buffer[] | undefined;
    expect(providerSet).toBeDefined();
    expect(providerSet).toHaveLength(1);
    expect(JSON.parse(providerSet?.[0]?.toString('utf8') ?? 'null')).toEqual({
      package_id: '@fixture/package',
      signature: 'AQ==',
    });
  });

  it('requires exact forward evidence keys and unit projections', async () => {
    for (const mutate of [
      (value: ReturnType<typeof forwardFixture>) => {
        const options = { ...value.options } as Record<string, unknown>;
        delete options['mutation_evidence'];
        return options;
      },
      (value: ReturnType<typeof forwardFixture>) => {
        const options = { ...value.options } as Record<string, unknown>;
        delete options['certification_evidence'];
        return options;
      },
      (value: ReturnType<typeof forwardFixture>) => ({
        ...value.options,
        binding: { ...value.options.binding, mutation_units: [] },
      }),
      (value: ReturnType<typeof forwardFixture>) => ({
        ...value.options,
        binding: { ...value.options.binding, certification_units: [] },
      }),
    ]) {
      const value = forwardFixture();
      await expect(
        createReleaseExportArtifactStore(mutate(value) as ReleaseExportArtifactStoreOptions),
      ).rejects.toThrow(ERROR);
    }
  });

  it('persists, commits, and deterministically reopens the exact transaction objects', async () => {
    const value = await transactionFixture();
    expect(await value.transaction.readTranscript()).toEqual(value.transcript);
    const manifest = await value.transaction.readCommitManifest();
    const manifestReceipt = await value.transaction.put(
      object('committed-manifest', null, manifest),
    );
    const commit = await value.transaction.commit(manifestReceipt);

    expect(commit).toEqual({
      committed: true,
      sink_id: SINK,
      transaction_handle: value.transaction.transaction_handle,
      committed_manifest_handle: manifestReceipt.opaque_handle,
      committed_manifest_sha256: manifestReceipt.sha256,
      committed_manifest_size_bytes: manifestReceipt.size_bytes,
      commit_protocol: 'devai.artifact-sink.two-phase.v1',
    });
    for (const [receipt, expected] of [
      [value.closureReceipt, value.closure],
      [
        value.providerReceipt,
        await value.transaction.readArtifact({
          sink_id: SINK,
          opaque_handle: value.providerReceipt.opaque_handle,
        }),
      ],
      [manifestReceipt, manifest],
    ] as const) {
      expect(
        await value.store.readArtifact({ sink_id: SINK, opaque_handle: receipt.opaque_handle }),
      ).toEqual(expected);
    }
    expect(mocks.reverify).toHaveBeenCalled();
    expect(mocks.verifyManifest).toHaveBeenCalled();
  });

  it('returns an exact receipt and canonical transcript binding', async () => {
    const value = await transactionFixture();
    const [transaction, id, sha256] = value.closureReceipt.opaque_handle.split(':');
    expect(transaction).toBe(value.transaction.transaction_handle);
    expect(id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(sha256).toBe(hash(value.closure));
    expect(value.closureReceipt).toEqual({
      sink_id: SINK,
      transaction_handle: value.transaction.transaction_handle,
      opaque_handle: value.closureReceipt.opaque_handle,
      kind: 'evidence-manifest',
      package_id: '@fixture/package',
      sha256: hash(value.closure),
      size_bytes: value.closure.length,
      export_spec_id: RELEASE_EXPORT_SPEC_ID,
      export_spec_digest_sha256: RELEASE_EXPORT_SPEC_DIGEST,
    });
    const decoded = JSON.parse(value.transcript.toString('utf8')) as Record<string, unknown>;
    expect(decoded).toMatchObject({
      version: 'devai.release-export-transcript-json.v1',
      binding: {
        action_id: 'release export',
        repository: REPOSITORY,
        candidate: CANDIDATE,
        sink_id: SINK,
        attempt_id: 'RLA-0123456789abcdef',
      },
      destination: value.options.binding.destination,
      trust: value.options.binding.trust,
    });
  });

  it('refuses malformed objects, duplicate logical slots, and phase-invalid operations', async () => {
    const value = fixture();
    const store = await createReleaseExportArtifactStore(value.options);
    const transaction = await store.begin();
    await refusal(() =>
      transaction.put(object('provider-result', '@fixture/package', Buffer.from('{}'))),
    );
    await refusal(() =>
      transaction.put({
        ...object('evidence-manifest', '@fixture/package', value.closure),
        sha256: '0'.repeat(64),
      }),
    );
    await transaction.put(object('evidence-manifest', '@fixture/package', value.closure));
    await refusal(() =>
      transaction.put(object('evidence-manifest', '@fixture/package', value.closure)),
    );
    await refusal(() => transaction.readCommitManifest());
    await transaction.abort();
    await refusal(() => transaction.readTranscript());
    await refusal(() => store.begin());
  });

  it('preserves interrupted handles while terminalizing further mutation', async () => {
    const value = fixture();
    const store = await createReleaseExportArtifactStore(value.options);
    const transaction = await store.begin();
    const receipt = await transaction.put(
      object('evidence-manifest', '@fixture/package', value.closure),
    );

    expect(transaction.preserve()).toEqual([receipt]);
    await refusal(() =>
      transaction.put(object('evidence-manifest', '@fixture/package', value.closure)),
    );
    await refusal(() => transaction.markSigningStarted());
  });

  it('refuses binding, roster, parent, closure, and size mismatches before allocation', async () => {
    const value = fixture();
    const [closure] = value.options.closures;
    if (closure === undefined) throw new Error('fixture closure missing');
    const variants: ReleaseExportArtifactStoreOptions[] = [
      { ...value.options, sink_id: 'foreign-sink' },
      {
        ...value.options,
        prepared_state: {
          ...value.options.prepared_state,
          state: 'exported',
        } as ReleaseLifecycleStateV2,
      },
      { ...value.options, closures: [] },
      {
        ...value.options,
        closures: [{ ...closure, bytes: Buffer.alloc(64 * 1024 + 1) }],
      },
      {
        ...value.options,
        transcript_limits: { ...value.options.transcript_limits, maximum_packages: 0 },
      },
    ];
    for (const options of variants)
      await expect(createReleaseExportArtifactStore(options)).rejects.toThrow(ERROR);

    const changedParent: TrustedArtifactReader = {
      readArtifact: (input) => {
        const observed = value.parentReader.readArtifact(input);
        return Buffer.concat([awaited(observed), Buffer.from('drift')]);
      },
    };
    await expect(
      createReleaseExportArtifactStore({
        ...value.options,
        parent_reader: changedParent,
      }),
    ).rejects.toThrow(ERROR);
  });

  it('rejects each independently invalid initializer boundary', async () => {
    const mutations: Array<
      (value: ReturnType<typeof fixture>) => ReleaseExportArtifactStoreOptions
    > = [
      (value) => ({ ...value.options, max_blob_bytes: 0 }),
      (value) => ({
        ...value.options,
        closure_limits: { ...value.options.closure_limits, maximum_git_entries: 0 },
      }),
      (value) => ({
        ...value.options,
        closure_limits: { ...value.options.closure_limits, maximum_git_entries: 1.5 },
      }),
      (value) => ({
        ...value.options,
        transcript_limits: { ...value.options.transcript_limits, maximum_packages: 0x80000000 },
      }),
      (value) => ({
        ...value.options,
        prepared_state: { ...value.options.prepared_state, schemaVersion: '2.0.0' } as never,
      }),
      (value) => ({
        ...value.options,
        prepared_state: { ...value.options.prepared_state, action_id: 'release export' } as never,
      }),
      (value) => ({
        ...value.options,
        binding: { ...value.options.binding, repository: { ...REPOSITORY, tree: '9'.repeat(40) } },
      }),
      (value) => ({
        ...value.options,
        binding: { ...value.options.binding, candidate: { ...CANDIDATE, tree: '9'.repeat(40) } },
      }),
      (value) => ({
        ...value.options,
        prepared_state: { ...value.options.prepared_state, bound_receipts: [] } as never,
      }),
      (value) => ({
        ...value.options,
        prepared_state: { ...value.options.prepared_state, artifacts: [] } as never,
      }),
      (value) => {
        const state = structuredClone(value.options.prepared_state) as ReleaseLifecycleStateV2;
        const pkg = state.release_units[0]?.packages[0];
        if (pkg === undefined) throw new Error('fixture package missing');
        return {
          ...value.options,
          prepared_state: {
            ...state,
            release_units: [
              {
                ...state.release_units[0],
                packages: [{ ...pkg, trust: { fixture: true } }],
              },
            ],
          } as never,
        };
      },
      (value) => {
        const closure = value.options.closures[0];
        if (closure === undefined) throw new Error('fixture closure missing');
        return { ...value.options, closures: [{ ...closure, package_id: '@fixture/wrong' }] };
      },
      (value) => {
        const closure = value.options.closures[0];
        if (closure === undefined) throw new Error('fixture closure missing');
        return {
          ...value.options,
          closures: [{ ...closure, expected: { ...closure.expected, release_unit: 'wrong' } }],
        };
      },
    ];
    for (const mutate of mutations) {
      const value = fixture();
      await expect(createReleaseExportArtifactStore(mutate(value))).rejects.toThrow(ERROR);
    }

    for (const key of [
      'artifact_spec_id',
      'artifact_spec_digest_sha256',
      'artifact_spec_canonical_bytes',
    ]) {
      const value = fixture();
      mocks.artifactSpec = { ...legacyArtifactSpec(), [key]: 'invalid' };
      await expect(createReleaseExportArtifactStore(value.options)).rejects.toThrow(ERROR);
    }
  });

  it('rejects hidden input structure without evaluating accessors', async () => {
    {
      const value = fixture();
      const binding = Object.assign(Object.create({ inherited: true }), value.options.binding);
      await expect(createReleaseExportArtifactStore({ ...value.options, binding })).rejects.toThrow(
        ERROR,
      );
    }
    {
      const value = fixture();
      let calls = 0;
      const binding = { ...value.options.binding } as Record<string, unknown>;
      Object.defineProperty(binding, 'sink_id', {
        enumerable: true,
        get: () => {
          calls += 1;
          return SINK;
        },
      });
      await expect(
        createReleaseExportArtifactStore({ ...value.options, binding } as never),
      ).rejects.toThrow(ERROR);
      expect(calls).toBe(0);
    }
    {
      const value = fixture();
      const closures = [...value.options.closures] as unknown[] & { extra?: string };
      closures.extra = 'hidden-caller-state';
      await expect(
        createReleaseExportArtifactStore({ ...value.options, closures } as never),
      ).rejects.toThrow(ERROR);
    }
  });

  it('preserves approved authority failures and enforces the exact capacity boundary', async () => {
    for (const message of [
      'AUTHORITY_TEST_REFUSAL',
      'release-export-capacity-unavailable',
      'release-export-capacity-insufficient',
    ]) {
      const value = fixture();
      mocks.capacity.mockImplementationOnce(() => {
        throw new Error(message);
      });
      const store = await createReleaseExportArtifactStore(value.options);
      await expect(store.begin()).rejects.toThrow(message);
    }
    for (const [remaining_batches, remaining_targets, accepted] of [
      [35, 36, false],
      [36, 35, false],
      [36, 36, true],
    ] as const) {
      const value = fixture();
      mocks.capacity.mockReturnValue({ remaining_batches, remaining_targets });
      const store = await createReleaseExportArtifactStore(value.options);
      if (accepted) await expect(store.begin()).resolves.toBeDefined();
      else await expect(store.begin()).rejects.toThrow('release-export-capacity-insufficient');
    }
  });

  it('detects committed receipt, object, marker, reservation, and population corruption', async () => {
    const cases: Array<
      (value: Awaited<ReturnType<typeof committedFixture>>) => { path: string; bytes?: Buffer }
    > = [
      (value) => ({
        path: receiptPath(value.options.root, value.closureReceipt.opaque_handle),
        bytes: Buffer.from('{}'),
      }),
      (value) => ({ path: objectPath(value.options.root, value.closureReceipt.sha256) }),
      (value) => ({
        path: join(
          value.options.root,
          'exports',
          value.transaction.transaction_handle,
          'commit.json',
        ),
        bytes: Buffer.from('{}'),
      }),
      (value) => ({
        path: join(
          value.options.root,
          'exports',
          'attempts',
          `${value.options.binding.attempt_id}.json`,
        ),
        bytes: Buffer.from('{}'),
      }),
    ];
    for (const corrupt of cases) {
      const value = await committedFixture();
      const selected = corrupt(value);
      if (selected.bytes === undefined) unlinkSync(selected.path);
      else writeFileSync(selected.path, selected.bytes);
      await refusal(() =>
        value.store.readArtifact({
          sink_id: SINK,
          opaque_handle: value.closureReceipt.opaque_handle,
        }),
      );
    }

    const value = await committedFixture();
    writeFileSync(
      join(
        value.options.root,
        'exports',
        value.transaction.transaction_handle,
        'receipts',
        '00000000-0000-4000-8000-000000000000.json',
      ),
      Buffer.from('{}'),
    );
    await refusal(() =>
      value.store.readArtifact({
        sink_id: SINK,
        opaque_handle: value.manifestReceipt.opaque_handle,
      }),
    );
  });

  it('refuses malformed handles and unknown or foreign reads in pending and committed phases', async () => {
    const value = fixture();
    const store = await createReleaseExportArtifactStore(value.options);
    const transaction = await store.begin();
    for (const input of [
      { sink_id: 'foreign', opaque_handle: 'unknown' },
      {
        sink_id: SINK,
        opaque_handle: `${transaction.transaction_handle}:00000000-0000-4000-8000-000000000000:${'0'.repeat(64)}`,
      },
    ])
      await refusal(() => transaction.readArtifact(input));

    const committed = await committedFixture();
    for (const input of [
      { sink_id: 'foreign', opaque_handle: committed.manifestReceipt.opaque_handle },
      { sink_id: SINK, opaque_handle: 'malformed-handle' },
      {
        sink_id: SINK,
        opaque_handle: `${committed.transaction.transaction_handle}:00000000-0000-4000-8000-000000000000:${'0'.repeat(64)}`,
      },
    ])
      await refusal(() => committed.store.readArtifact(input));
  });

  it('checks each object boundary and makes signer-phase failures terminal', async () => {
    for (const alter of [
      (input: ReleaseExportArtifactObject) => ({ ...input, bytes: Buffer.alloc(0) }),
      (input: ReleaseExportArtifactObject) => ({ ...input, size_bytes: input.size_bytes + 1 }),
      (input: ReleaseExportArtifactObject) => ({
        ...input,
        bytes: Buffer.alloc(64 * 1024 + 1),
        size_bytes: 64 * 1024 + 1,
        sha256: hash(Buffer.alloc(64 * 1024 + 1)),
      }),
    ]) {
      const value = fixture();
      const store = await createReleaseExportArtifactStore(value.options);
      const transaction = await store.begin();
      await refusal(() =>
        transaction.put(
          alter(object('evidence-manifest', '@fixture/package', value.closure)) as never,
        ),
      );
    }

    for (const invalid of [
      object('evidence-manifest', '@fixture/package', Buffer.from('wrong closure')),
      object('evidence-manifest', '@fixture/unknown', Buffer.from('wrong closure')),
    ]) {
      const value = await transactionFixture();
      await refusal(() => value.transaction.put(invalid));
      await refusal(() => value.transaction.readTranscript());
    }

    {
      const value = fixture();
      const store = await createReleaseExportArtifactStore(value.options);
      const transaction = await store.begin();
      await transaction.put(object('evidence-manifest', '@fixture/package', value.closure));
      const transcript = await transaction.markSigningStarted();
      const provider = encodeReleaseExportProviderResult(
        { package_id: '@fixture/package', transcript, signature: 'AQ==' },
        value.options.transcript_limits,
      );
      await refusal(() => transaction.put(object('provider-result', '@fixture/unknown', provider)));
      await refusal(() => transaction.readCommitManifest());
    }
  });

  it('refuses each incomplete or altered commit input and abort after signer dispatch', async () => {
    {
      const value = fixture();
      const store = await createReleaseExportArtifactStore(value.options);
      const transaction = await store.begin();
      await refusal(() => transaction.commit({} as never));
    }
    {
      const value = await transactionFixture();
      await refusal(() => value.transaction.abort());
      await refusal(() => value.transaction.markSigningStarted());
    }
    for (const alter of [
      (receipt: ReleaseExportArtifactObjectReceipt) => ({ ...receipt, kind: 'provider-result' }),
      (receipt: ReleaseExportArtifactObjectReceipt) => ({ ...receipt, sha256: '0'.repeat(64) }),
    ]) {
      const value = await transactionFixture();
      const manifest = await value.transaction.readCommitManifest();
      const receipt = await value.transaction.put(object('committed-manifest', null, manifest));
      await refusal(() => value.transaction.commit(alter(receipt) as never));
    }
    {
      const value = await committedFixture();
      await refusal(() => value.transaction.abort());
      expect(() => value.transaction.preserve()).toThrow(ERROR);
    }
  });

  it('refuses overlapping operations while protected revalidation is outstanding', async () => {
    const value = fixture();
    const store = await createReleaseExportArtifactStore(value.options);
    const transaction = await store.begin();
    await transaction.put(object('evidence-manifest', '@fixture/package', value.closure));
    let release!: () => void;
    mocks.reverify.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const pending = transaction.readTranscript();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await refusal(() => transaction.readTranscript());
    release();
    await pending;
  });

  it('refuses symlinked transaction storage and overlapping repository roots', async () => {
    const value = fixture();
    await expect(
      createReleaseExportArtifactStore({
        ...value.options,
        repository_roots: [value.options.root],
      }),
    ).rejects.toThrow(ERROR);

    const store = await createReleaseExportArtifactStore(value.options);
    const transaction = await store.begin();
    const receipts = join(
      value.options.root,
      'exports',
      transaction.transaction_handle,
      'receipts',
    );
    const outside = temporary('devai export outside');
    rmSync(receipts, { recursive: true });
    symlinkSync(outside, receipts);
    await refusal(() =>
      transaction.put(object('evidence-manifest', '@fixture/package', value.closure)),
    );
  });
});

function awaited(value: Buffer | Promise<Buffer>): Buffer {
  if (!Buffer.isBuffer(value)) throw new Error('fixture expected synchronous parent reader');
  return value;
}
