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
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '@devai-nyx/utils';
import {
  createReleaseExportArtifactStore,
  RELEASE_EXPORT_SPEC_DIGEST,
  type ProtectedReleaseExportBinding,
  type ReleaseExportArtifactObject,
  type ReleaseExportArtifactStoreOptions,
} from '../../src/services/release-export-artifact-store.js';
import { encodeReleaseExportProviderResult } from '../../src/services/release-export-transcript.js';
import type {
  OpaqueArtifactIdentity,
  ReleaseLifecycleStateV2,
  TrustedArtifactReader,
} from '../../src/services/release-lifecycle-execution.js';

const mocks = vi.hoisted(() => ({
  parentBytes: new Map<string, Buffer>(),
  checkRoot: vi.fn(),
  reverify: vi.fn(),
  verifyManifest: vi.fn(),
}));

vi.mock('@devai-nyx/authority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@devai-nyx/authority')>();
  return {
    ...actual,
    createProtectedExportSinkAdapter: () => ({
      invokeSink: <T>(operation: () => T) => operation(),
    }),
    createProtectedReleaseSinkOwner: () => ({}),
    readProtectedReleaseExportCapacity: () => ({
      remaining_batches: 1_000,
      remaining_targets: 1_000,
    }),
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
            artifact_spec: legacyArtifactSpec(),
          },
        },
      },
    }),
  }),
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

async function refusal(callback: () => unknown | Promise<unknown>): Promise<void> {
  await expect(Promise.resolve().then(callback)).rejects.toThrow(ERROR);
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('release export artifact store depth', () => {
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
