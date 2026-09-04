import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  withProtectedReleasePrepareCapacity,
  type AuthorityHostEffectScope,
  type ProtectedReleasePrepareCapacityBinding,
} from '@devai-nyx/authority';
import { canonicalSha256 } from '@devai-nyx/utils';
import { createLifecyclePolicyFixture } from '../helpers/release-policy-resolution-fixture.js';
import { fixture as unitMutationFixture } from '../helpers/release-unit-mutation-evidence-fixture.js';
import {
  finalizeUnitMutationEvidenceClosure,
  verifyUnitMutationEvidenceDocuments,
  type UnitMutationEvidenceBinding,
} from '../../src/services/release-unit-mutation-evidence.js';
import { resolveReleaseMutationRequirements } from '../../src/services/release-lifecycle-execution.js';
import {
  createReleasePrepareProvider as createKernelReleasePrepareProvider,
  finalizeCertificationManifest,
  finalizeCertificationReceipt,
  RELEASE_PACK_SPEC_CANONICAL_BYTES,
  RELEASE_PACK_SPEC_DIGEST,
  RELEASE_PACK_SPEC_ID,
  reverifySinkArtifacts,
  type ArtifactSinkObject,
  type ArtifactSinkObjectReceipt,
  type CertificationOutputClosureBinding,
  type ImmutableReleaseContentSource,
  type TrustedArtifactSink,
} from '../../src/services/release-prepare-kernel.js';
import type {
  CertificationPackageEntryManifest,
  ReleaseLifecycleRequest,
  ReleaseLifecycleStateV2,
} from '../../src/services/release-lifecycle-execution.js';

const TASK_POLICY = '3'.repeat(64);
const CERTIFICATION_EVIDENCE = '4'.repeat(64);

async function withKernelPrepareCapacity<T>(
  request: ReleaseLifecycleRequest,
  callback: () => Promise<T>,
  available: Readonly<{ batches: number; targets: number }> = { batches: 256, targets: 8192 },
): Promise<T> {
  const plan = request.receipt_locators?.find((receipt) => receipt.kind === 'release-plan-receipt');
  if (plan === undefined) throw new Error('test release plan receipt missing');
  let ordinal = 0;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'release-prepare-kernel-capacity-test',
    issuer_version: '1.0.0',
    invocation_id: 'release-prepare-kernel-capacity-test',
    canonicalSha256,
    randomId: () => `release-prepare-kernel-capacity-${String(++ordinal)}`,
    now: () => '2026-09-03T00:00:00.000Z',
    receipt_ttl_ms: 30_000,
  });
  const binding: ProtectedReleasePrepareCapacityBinding = {
    action_id: 'release prepare',
    repository: request.repository_locator,
    candidate: {
      commit: request.candidate_locator.commit,
      tree: request.candidate_locator.tree,
    },
    plan_receipt_digest_sha256: plan.receipt_digest_sha256,
  };
  const scope: AuthorityHostEffectScope = {
    action_id: 'release prepare',
    invocation_id: 'release-prepare-kernel-capacity-test',
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (_request, apply) => apply(),
    read_prepare_capacity: (selected) => {
      expect(selected).toEqual(binding);
      return { remaining_batches: available.batches, remaining_targets: available.targets };
    },
  };
  try {
    return await runWithAuthorityHostEffects(scope, () =>
      withProtectedReleasePrepareCapacity(binding, callback),
    );
  } finally {
    issuer.dispose();
  }
}

function createReleasePrepareProvider(
  input: Parameters<typeof createKernelReleasePrepareProvider>[0],
): ReturnType<typeof createKernelReleasePrepareProvider> {
  const provider = createKernelReleasePrepareProvider(input);
  return async (request) =>
    await withKernelPrepareCapacity(request, () => Promise.resolve(provider(request)));
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitObjectId(
  bytes: Buffer,
  type: 'blob' | 'tree' | 'commit',
  format: 'sha1' | 'sha256' = 'sha1',
): string {
  return createHash(format)
    .update(Buffer.from(`${type} ${String(bytes.byteLength)}\0`))
    .update(bytes)
    .digest('hex');
}

function fixture(
  generatedBytes?: Buffer,
  objectFormat: 'sha1' | 'sha256' = 'sha1',
  mutationProfile?: Readonly<Record<string, unknown>>,
) {
  const packageJson = Buffer.from(
    `${JSON.stringify({ name: '@scope/demo', version: '1.2.0', files: ['dist'], main: 'dist/index.js' })}\n`,
  );
  const generated =
    generatedBytes ?? Buffer.from('#!/usr/bin/env node\nexport const answer = 42;\n');
  const generatedHandle = {
    evidence_sink_id: 'certification-evidence-sink',
    opaque_handle: `output-${sha256(generated)}`,
    sha256: sha256(generated),
    size_bytes: generated.byteLength,
  } as const;
  const packageBlobId = gitObjectId(packageJson, 'blob', objectFormat);
  const policy = createLifecyclePolicyFixture(
    [],
    {
      ...mutationProfile,
      release_unit: '@scope/demo',
      version_source: 'packages/demo/package.json',
    },
    {
      repository_id: 'scope/repository',
      object_format: objectFormat,
      files: new Map([['packages/demo/package.json', packageJson]]),
      current_version: '1.1.0',
      target_version: '1.2.0',
      adopter_dependency: true,
    },
  );
  const { commit, tree } = policy.candidate.repository;
  const resolvers = {
    resolve_receipt: () => policy.receipt,
    resolve_plan_input: policy.resolve_plan_input,
  };
  const certificationEvidenceReceipt = finalizeCertificationReceipt({
    candidate_commit: commit,
    candidate_tree: tree,
    task_policy_digest_sha256: TASK_POLICY,
    package_id: '@scope/demo',
    output_blob_sha256: sha256(generated),
    output_blob_handle: generatedHandle,
  });
  const manifestDraft = {
    candidate: { commit, tree },
    task_policy_digest_sha256: TASK_POLICY,
    package_id: '@scope/demo',
    package_version: '1.2.0',
    entry_order: 'ascending-utf-8-byte-collation-by-path;duplicates-refuse' as const,
    manifest_digest_contract: {
      domain: 'DEVAI-CERTIFIED-PACKAGE-ENTRY-MANIFEST-V1\0' as const,
      payload:
        'utf-8-rfc8785-jcs-of-the-entire-manifest-with-manifest_digest_sha256-omitted;framed-as-domain-utf8-bytes-plus-payload-utf8-bytes' as const,
      canonicalization: 'rfc8785-jcs' as const,
      algorithm: 'sha256' as const,
    },
    entries: [
      {
        path: 'dist/index.js',
        mode: '100755' as const,
        size_bytes: generated.byteLength,
        sha256: sha256(generated),
        immutable_blob_locator: {
          kind: 'generated-output' as const,
          output_blob_sha256: sha256(generated),
          output_blob_handle: generatedHandle,
          certification_evidence_receipt: certificationEvidenceReceipt,
        },
      },
      {
        path: 'package.json',
        mode: '100644' as const,
        size_bytes: packageJson.byteLength,
        sha256: sha256(packageJson),
        immutable_blob_locator: {
          kind: 'git-object' as const,
          repository: 'scope/repository',
          commit,
          tree,
          object_format: objectFormat,
          path: 'packages/demo/package.json',
          mode: '100644' as const,
          object_id: packageBlobId,
          size_bytes: packageJson.byteLength,
          content_digest_sha256: sha256(packageJson),
        },
      },
    ],
  };
  const certificationManifest = finalizeCertificationManifest(manifestDraft);
  const request = {
    schemaVersion: '1.0.0',
    request_kind: 'release-lifecycle-request',
    action_id: 'release prepare',
    repository_locator: { id: 'scope/repository', commit, tree },
    candidate_locator: {
      commit,
      tree,
      release_units: [
        {
          release_unit: '@scope/demo',
          version: '1.2.0',
          package_roster: [
            {
              package_id: '@scope/demo',
              manifest_path: 'packages/demo/package.json',
              manifest_digest_sha256: sha256(packageJson),
            },
          ],
        },
      ],
    },
    receipt_locators: [
      {
        kind: 'release-plan-receipt',
        receipt_id: policy.receipt.receipt_id,
        receipt_digest_sha256: policy.receipt.receipt_digest_sha256,
        path: 'receipts/plan.json',
      },
    ],
  } satisfies ReleaseLifecycleRequest;
  const state = {
    schemaVersion: '2.0.0',
    state: 'certified',
    repository: request.repository_locator,
    candidate: {
      release_unit: '@scope/demo',
      version: '1.2.0',
      commit,
      tree,
    },
    release_units: [
      {
        release_unit: '@scope/demo',
        version: '1.2.0',
        packages: [
          {
            package_id: '@scope/demo',
            manifest: {
              path: 'packages/demo/package.json',
              sha256: sha256(packageJson),
              size_bytes: packageJson.byteLength,
            },
            tarball: null,
            sbom: null,
            evidence_manifest: null,
            provider_result: null,
            trust: null,
            certification_manifest: certificationManifest,
          },
        ],
      },
    ],
    inputs: [{ kind: 'task-policy', path: 'task-policy/certify/selection', sha256: TASK_POLICY }],
    evidence: {
      manifest_digest_sha256: CERTIFICATION_EVIDENCE,
      receipt_digests: [policy.receipt.receipt_digest_sha256],
      independently_checkable: true,
    },
    artifacts: [],
  } as unknown as ReleaseLifecycleStateV2;
  const source: ImmutableReleaseContentSource = {
    readGitObject: ({ object_id, type }) => {
      const object = policy.objects.get(object_id);
      if (object === undefined || object.type !== type) throw new Error('wrong git object');
      return Buffer.from(object.bytes);
    },
    readGitBlob: ({ object_id }) => {
      if (object_id !== packageBlobId) throw new Error('wrong git object');
      return packageJson;
    },
    readCertificationEvidenceReceipt: ({ receipt_digest_sha256, evidence_sink_id }) => {
      if (receipt_digest_sha256 !== certificationEvidenceReceipt.receipt_digest_sha256) {
        throw new Error('wrong certification receipt');
      }
      if (evidence_sink_id !== generatedHandle.evidence_sink_id)
        throw new Error('wrong evidence sink');
      return certificationEvidenceReceipt;
    },
    readCertificationOutputClosure: (binding) => ({
      ...binding,
      outputs: [
        {
          path: 'dist/index.js',
          mode: '100755',
          output_blob_handle: generatedHandle,
          certification_evidence_receipt: certificationEvidenceReceipt,
        },
      ],
    }),
    readGeneratedBlob: ({ output_blob_sha256, output_blob_handle, receipt }) => {
      if (output_blob_sha256 !== sha256(generated)) throw new Error('wrong generated object');
      if (output_blob_handle.opaque_handle !== generatedHandle.opaque_handle)
        throw new Error('wrong generated handle');
      if (receipt.receipt_digest_sha256 !== certificationEvidenceReceipt.receipt_digest_sha256) {
        throw new Error('wrong certification receipt');
      }
      return generated;
    },
  };
  return {
    packageJson,
    generated,
    certificationManifest,
    request,
    state,
    source,
    policy,
    resolvers,
  };
}

function memorySink(
  options: { readonly corruptPut?: boolean; readonly failCommit?: boolean } = {},
) {
  const bytes = new Map<string, Buffer>();
  const abort = vi.fn();
  const begin = vi.fn(() => ({
    sink_id: 'trusted-sink',
    transaction_handle: 'transaction-1',
    put: vi.fn((artifact: ArtifactSinkObject): ArtifactSinkObjectReceipt => {
      const handle = `object-${artifact.sha256}`;
      bytes.set(handle, Buffer.from(artifact.bytes));
      return {
        sink_id: 'trusted-sink',
        transaction_handle: 'transaction-1',
        opaque_handle: handle,
        kind: artifact.kind,
        logical_name: artifact.logical_name,
        sha256: options.corruptPut === true ? 'f'.repeat(64) : artifact.sha256,
        size_bytes: artifact.size_bytes,
        pack_spec_id: RELEASE_PACK_SPEC_ID,
        pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
      };
    }),
    readArtifact: ({ opaque_handle }: { readonly opaque_handle: string }) =>
      bytes.get(opaque_handle) ?? Buffer.alloc(0),
    commit: vi.fn((manifest: ArtifactSinkObjectReceipt) => {
      if (options.failCommit === true) throw new Error('sink unavailable');
      return {
        committed: true as const,
        sink_id: 'trusted-sink',
        transaction_handle: 'transaction-1',
        committed_manifest_handle: manifest.opaque_handle,
        committed_manifest_sha256: manifest.sha256,
        committed_manifest_size_bytes: manifest.size_bytes,
        commit_protocol: 'devai.artifact-sink.two-phase.v1' as const,
      };
    }),
    abort,
  }));
  return { sink: { begin } satisfies TrustedArtifactSink, begin, abort, bytes };
}

function fixtureWithGeneratedPath(path: string) {
  const value = fixture();
  const entry = value.certificationManifest.entries[0];
  if (entry === undefined || entry.immutable_blob_locator.kind !== 'generated-output') {
    throw new Error('generated entry missing');
  }
  const locator = entry.immutable_blob_locator;
  (entry as { path: string }).path = path;
  const { manifest_digest_sha256: _digest, ...draft } = value.certificationManifest;
  (value.certificationManifest as { manifest_digest_sha256: string }).manifest_digest_sha256 =
    finalizeCertificationManifest(draft).manifest_digest_sha256;
  return {
    value,
    source: {
      ...value.source,
      readCertificationOutputClosure: (binding: CertificationOutputClosureBinding) => ({
        ...binding,
        outputs: [
          {
            path,
            mode: entry.mode,
            output_blob_handle: locator.output_blob_handle,
            certification_evidence_receipt: locator.certification_evidence_receipt,
          },
        ],
      }),
    },
  };
}

async function mutationFixture(rosterFault?: 'omitted-package' | 'substituted-package') {
  const adoption = JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, '../../../../law/policy/devai-adoption.json'),
      'utf8',
    ),
  ) as {
    release_verification: Record<string, unknown> & {
      mutation_roster: Array<{ package: string; manifest_path: string }>;
    };
  };
  const profile = adoption.release_verification;
  const value = fixture(undefined, 'sha1', profile);
  const required = resolveReleaseMutationRequirements(value.request, value.resolvers)[0];
  if (required?.binding === null || required?.binding === undefined)
    throw new Error('fixture requires mutation');
  const binding: UnitMutationEvidenceBinding = {
    ...required.binding,
    task_policy_digests_sha256: [TASK_POLICY],
  };
  const packages = profile.mutation_roster.map((row) => ({
    packageName: row.package,
    workspace: dirname(row.manifest_path),
  }));
  if (rosterFault === 'omitted-package') packages.pop();
  if (rosterFault === 'substituted-package')
    packages[0] = { packageName: '@fixture/substituted', workspace: 'packages/substituted' };
  const evidence = await unitMutationFixture({ binding, packages });
  const unit = value.state.release_units[0];
  if (unit === undefined) throw new Error('fixture release unit missing');
  Object.assign(unit, { mutation_evidence: structuredClone(evidence.closure) });
  const source = {
    ...value.source,
    unit_mutation_maximum_bytes: 1_000_000,
    readUnitMutationEvidenceClosure: vi.fn((selected: UnitMutationEvidenceBinding) => {
      expect(selected).toEqual(binding);
      return structuredClone(evidence.closure);
    }),
    readUnitMutationEvidenceReceipt: vi.fn(
      (selected: { evidence_sink_id: string; receipt_digest_sha256: string }) => {
        expect(selected).toEqual({
          evidence_sink_id: evidence.closure.output_contract.evidence_sink_id,
          receipt_digest_sha256: evidence.closure.receipt.receipt_digest_sha256,
        });
        return structuredClone(evidence.closure.receipt);
      },
    ),
    readUnitMutationEvidenceBlob: vi.fn(
      (selected: {
        binding: UnitMutationEvidenceBinding;
        identity: Parameters<typeof evidence.read>[0];
      }) => {
        expect(selected.binding).toEqual(binding);
        return evidence.read(selected.identity);
      },
    ),
  } satisfies ImmutableReleaseContentSource;
  return { value, source, evidence, binding, profile };
}

function preparedTarball(
  result: Awaited<ReturnType<ReturnType<typeof createReleasePrepareProvider>>>,
  target: ReturnType<typeof memorySink>,
): Buffer {
  if (result.outcome !== 'success' || result.material === undefined) {
    throw new Error(`prepare failed: ${result.code ?? 'unknown'}`);
  }
  const tarball = result.material.release_units[0]?.packages[0]?.package_tarball;
  if (tarball === null || tarball === undefined || !('opaque_handle' in tarball)) {
    throw new Error('tarball missing');
  }
  return target.bytes.get(tarball.opaque_handle) ?? Buffer.alloc(0);
}

function tarEntries(tarball: Buffer) {
  const tar = gunzipSync(tarball);
  const values: { path: string; mode: number; bytes: Buffer }[] = [];
  for (let offset = 0; offset + 512 <= tar.byteLength;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/u, '');
    const path = prefix.length === 0 ? name : `${prefix}/${name}`;
    const mode = Number.parseInt(
      header.subarray(100, 108).toString('ascii').replace(/\0.*$/u, ''),
      8,
    );
    const size = Number.parseInt(
      header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, ''),
      8,
    );
    const start = offset + 512;
    values.push({ path, mode, bytes: tar.subarray(start, start + size) });
    offset = start + Math.ceil(size / 512) * 512;
  }
  return values;
}

function storedDeflateBlocks(gzip: Buffer) {
  const blocks: { readonly final: boolean; readonly type: number; readonly bytes: Buffer }[] = [];
  let offset = 10;
  let final = false;
  while (!final) {
    const header = gzip[offset];
    if (header === undefined || offset + 5 > gzip.byteLength - 8) {
      throw new Error('invalid stored deflate fixture');
    }
    final = (header & 1) === 1;
    const type = (header >> 1) & 0x03;
    const length = gzip.readUInt16LE(offset + 1);
    const complement = gzip.readUInt16LE(offset + 3);
    if ((~length & 0xffff) !== complement) throw new Error('invalid stored block complement');
    offset += 5;
    const bytes = gzip.subarray(offset, offset + length);
    if (bytes.byteLength !== length) throw new Error('truncated stored block');
    blocks.push({ final, type, bytes });
    offset += length;
  }
  if (offset !== gzip.byteLength - 8) throw new Error('unexpected stored deflate trailing bytes');
  return blocks;
}

describe('pure release prepare kernel', () => {
  it('pins the exact final pack specification identity', () => {
    expect(sha256(Buffer.from(RELEASE_PACK_SPEC_CANONICAL_BYTES, 'utf8'))).toBe(
      RELEASE_PACK_SPEC_DIGEST,
    );
    expect(RELEASE_PACK_SPEC_DIGEST).toBe(
      '46ba1063f36f48fb6d5082548024b17b274cf475e24a5c1df89faa5f07a46316',
    );
  });

  it('produces stable npm-layout gzip bytes from verified Git and generated blobs while preserving mode', async () => {
    const value = fixture();
    const first = memorySink();
    const second = memorySink();
    const firstResult = await createReleasePrepareProvider({
      ...value.resolvers,
      certified_state: value.state,
      content_source: value.source,
      artifact_sink: first.sink,
    })(value.request);
    const secondResult = await createReleasePrepareProvider({
      ...value.resolvers,
      certified_state: value.state,
      content_source: value.source,
      artifact_sink: second.sink,
    })(value.request);
    expect(firstResult.outcome).toBe('success');
    expect(secondResult.outcome).toBe('success');
    const firstTarball = [...first.bytes.entries()].find(([handle]) =>
      firstResult.material?.artifacts.some(
        (artifact) =>
          artifact.kind === 'package-tarball' &&
          'opaque_handle' in artifact &&
          artifact.opaque_handle === handle,
      ),
    )?.[1];
    const secondTarball = [...second.bytes.entries()].find(([handle]) =>
      secondResult.material?.artifacts.some(
        (artifact) =>
          artifact.kind === 'package-tarball' &&
          'opaque_handle' in artifact &&
          artifact.opaque_handle === handle,
      ),
    )?.[1];
    expect(firstTarball).toBeDefined();
    expect(firstTarball).toEqual(secondTarball);
    expect(sha256(firstTarball ?? Buffer.alloc(0))).toBe(
      '6dde079d83213ddaa496e9d130ccc9839285efe792e0b098596393ec6a109d0e',
    );
    expect(firstTarball?.subarray(0, 10)).toEqual(
      Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff]),
    );
    const firstHeader = gunzipSync(firstTarball ?? Buffer.alloc(0)).subarray(0, 512);
    expect(firstHeader.subarray(108, 124).toString('ascii')).toBe('0000000\0'.repeat(2));
    expect(firstHeader.subarray(136, 148).toString('ascii')).toBe('00000000000\0');
    expect(firstHeader[156]).toBe('0'.charCodeAt(0));
    expect(firstHeader.subarray(257, 265)).toEqual(
      Buffer.concat([Buffer.from('ustar\0', 'ascii'), Buffer.from('00', 'ascii')]),
    );
    expect(firstHeader.subarray(265, 329)).toEqual(Buffer.alloc(64));
    expect(firstHeader.subarray(329, 345).toString('ascii')).toBe('0000000\0'.repeat(2));
    expect(firstHeader.subarray(345, 500)).toEqual(Buffer.alloc(155));
    const checksumHeader = Buffer.from(firstHeader);
    checksumHeader.fill(0x20, 148, 156);
    const checksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    expect(Number.parseInt(firstHeader.subarray(148, 156).toString('ascii'), 8)).toBe(checksum);
    const entries = tarEntries(firstTarball ?? Buffer.alloc(0));
    expect(entries.map((entry) => entry.path)).toEqual([
      'package/dist/index.js',
      'package/package.json',
    ]);
    expect(entries[0]).toMatchObject({ mode: 0o755, bytes: value.generated });
    expect(entries[1]).toMatchObject({ mode: 0o644, bytes: value.packageJson });
    await firstResult.transaction?.commit();
  });

  it('accepts a SHA-256 Git locator only after exact candidate-tree traversal', async () => {
    const value = fixture(undefined, 'sha256');
    const target = memorySink();
    const result = await createReleasePrepareProvider({
      ...value.resolvers,
      certified_state: value.state,
      content_source: value.source,
      artifact_sink: target.sink,
    })(value.request);
    expect(result.outcome).toBe('success');
    await result.transaction?.rollback();
  });

  it.each([
    ['omitted', []],
    ['duplicated', ['dist/index.js', 'dist/index.js']],
  ])(
    'refuses a %s externally finalized generated-output closure before sink effects',
    async (_name, paths) => {
      const value = fixture();
      const target = memorySink();
      const generated = value.certificationManifest.entries[0];
      if (generated === undefined || generated.immutable_blob_locator.kind !== 'generated-output') {
        throw new Error('generated entry missing');
      }
      const locator = generated.immutable_blob_locator;
      const result = await createReleasePrepareProvider({
        ...value.resolvers,
        certified_state: value.state,
        content_source: {
          ...value.source,
          readCertificationOutputClosure: (binding) => ({
            ...binding,
            outputs: paths.map((path) => ({
              path,
              mode: '100755' as const,
              output_blob_handle: locator.output_blob_handle,
              certification_evidence_receipt: locator.certification_evidence_receipt,
            })),
          }),
        },
        artifact_sink: target.sink,
      })(value.request);
      expect(result).toMatchObject({
        outcome: 'failure',
        code: 'release-certification-output-closure-invalid',
      });
      expect(target.begin).not.toHaveBeenCalled();
    },
  );

  it('emits the exact SPDX 2.3 package, file, checksum, and relationship projection', async () => {
    const value = fixture();
    const target = memorySink();
    const result = await createReleasePrepareProvider({
      ...value.resolvers,
      certified_state: value.state,
      content_source: value.source,
      artifact_sink: target.sink,
    })(value.request);
    if (result.outcome !== 'success' || result.material === undefined) {
      throw new Error('prepare failed');
    }
    const pkg = result.material.release_units[0]?.packages[0];
    const sbom = pkg?.package_sbom;
    if (sbom === null || sbom === undefined || !('opaque_handle' in sbom)) {
      throw new Error('SBOM missing');
    }
    const document = JSON.parse(
      (target.bytes.get(sbom.opaque_handle) ?? Buffer.alloc(0)).toString('utf8'),
    ) as Readonly<Record<string, unknown>>;
    const entries = [
      { path: 'package/dist/index.js', bytes: value.generated },
      { path: 'package/package.json', bytes: value.packageJson },
    ];
    const sha1s = entries.map(({ bytes }) =>
      createHash('sha1').update(bytes).digest('hex').toLowerCase(),
    );
    expect(document).toEqual({
      spdxVersion: 'SPDX-2.3',
      dataLicense: 'CC0-1.0',
      SPDXID: 'SPDXRef-DOCUMENT',
      name: '@scope/demo@1.2.0',
      documentNamespace: `https://devai.nyxk.com.br/spdx/${value.request.candidate_locator.commit}/@scope/demo`,
      creationInfo: {
        created: '1970-01-01T00:00:00Z',
        creators: ['Tool: devai.pure-npm-compatible-pack.v4'],
      },
      documentDescribes: ['SPDXRef-Package'],
      packages: [
        {
          name: '@scope/demo@1.2.0',
          SPDXID: 'SPDXRef-Package',
          downloadLocation: 'NOASSERTION',
          filesAnalyzed: true,
          packageVerificationCode: {
            packageVerificationCodeValue: createHash('sha1')
              .update(Buffer.from([...sha1s].sort().join(''), 'utf8'))
              .digest('hex')
              .toLowerCase(),
          },
          licenseConcluded: 'NOASSERTION',
          licenseDeclared: 'NOASSERTION',
          copyrightText: 'NOASSERTION',
          supplier: 'NOASSERTION',
          originator: 'NOASSERTION',
        },
      ],
      files: entries.map(({ path, bytes }, index) => ({
        SPDXID: `SPDXRef-File-${sha256(Buffer.from(path, 'utf8'))}`,
        fileName: path,
        checksums: [
          { algorithm: 'SHA1', checksumValue: sha1s[index] },
          { algorithm: 'SHA256', checksumValue: sha256(bytes) },
        ],
        licenseConcluded: 'NOASSERTION',
        licenseInfoInFiles: ['NOASSERTION'],
        copyrightText: 'NOASSERTION',
      })),
      relationships: [
        {
          spdxElementId: 'SPDXRef-DOCUMENT',
          relationshipType: 'DESCRIBES',
          relatedSpdxElement: 'SPDXRef-Package',
        },
        ...entries.map(({ path }) => ({
          spdxElementId: 'SPDXRef-Package',
          relationshipType: 'CONTAINS',
          relatedSpdxElement: `SPDXRef-File-${sha256(Buffer.from(path, 'utf8'))}`,
        })),
      ],
    });
    expect(JSON.stringify(document)).not.toMatch(/[A-F0-9]{64}/u);
    await result.transaction?.rollback();
  });

  it('uses greedy 65535-byte stored-DEFLATE blocks and only finalizes the remainder block', async () => {
    const value = fixture(Buffer.alloc(140_000, 0xa5));
    const target = memorySink();
    const result = await createReleasePrepareProvider({
      ...value.resolvers,
      certified_state: value.state,
      content_source: value.source,
      artifact_sink: target.sink,
    })(value.request);
    if (result.outcome !== 'success' || result.material === undefined) {
      throw new Error('prepare failed');
    }
    const tarball = result.material.release_units[0]?.packages[0]?.package_tarball;
    if (tarball === null || tarball === undefined || !('opaque_handle' in tarball)) {
      throw new Error('tarball missing');
    }
    const bytes = target.bytes.get(tarball.opaque_handle) ?? Buffer.alloc(0);
    const blocks = storedDeflateBlocks(bytes);
    expect(blocks.length).toBeGreaterThan(2);
    expect(blocks.every((block) => block.type === 0)).toBe(true);
    expect(
      blocks.slice(0, -1).every((block) => !block.final && block.bytes.length === 65_535),
    ).toBe(true);
    expect(blocks.at(-1)?.final).toBe(true);
    expect(blocks.at(-1)?.bytes.length).toBeLessThan(65_535);
    expect(Buffer.concat(blocks.map((block) => block.bytes))).toEqual(gunzipSync(bytes));
    await result.transaction?.rollback();
  });

  it('refuses a missing sink before reading or generating package content', async () => {
    const value = fixture();
    const source = {
      ...value.source,
      readGitBlob: vi.fn(value.source.readGitBlob),
      readCertificationEvidenceReceipt: vi.fn(value.source.readCertificationEvidenceReceipt),
      readGeneratedBlob: vi.fn(value.source.readGeneratedBlob),
    };
    const result = await createReleasePrepareProvider({
      ...value.resolvers,
      certified_state: value.state,
      content_source: source,
      artifact_sink: undefined as never,
    })(value.request);
    expect(result).toEqual({ outcome: 'failure', code: 'release-artifact-sink-unavailable' });
    expect(source.readGitBlob).not.toHaveBeenCalled();
    expect(source.readCertificationEvidenceReceipt).not.toHaveBeenCalled();
    expect(source.readGeneratedBlob).not.toHaveBeenCalled();
  });

  it.each([
    [
      'entry digest',
      (value: ReturnType<typeof fixture>) => {
        const entry = value.certificationManifest.entries[0] as { sha256: string } | undefined;
        if (entry === undefined) throw new Error('entry fixture missing');
        entry.sha256 = 'f'.repeat(64);
      },
      'release-prepare-certification-manifest-invalid',
    ],
    [
      'Git framing',
      (value: ReturnType<typeof fixture>) => {
        const entry = value.certificationManifest.entries[1] as
          | {
              immutable_blob_locator: CertificationPackageEntryManifest['entries'][number]['immutable_blob_locator'];
            }
          | undefined;
        if (entry === undefined) throw new Error('entry fixture missing');
        const locator = entry.immutable_blob_locator;
        if (locator.kind !== 'git-object') throw new Error('git locator missing');
        entry.immutable_blob_locator = { ...locator, object_id: 'e'.repeat(40) };
        const { manifest_digest_sha256: _digest, ...draft } = value.certificationManifest;
        (value.certificationManifest as { manifest_digest_sha256: string }).manifest_digest_sha256 =
          finalizeCertificationManifest(draft).manifest_digest_sha256;
      },
      'release-prepare-git-tree-membership-invalid',
    ],
  ] as const)('refuses a mutated %s before a sink effect', async (_name, mutate, code) => {
    const value = fixture();
    mutate(value);
    const target = memorySink();
    const result = await createReleasePrepareProvider({
      ...value.resolvers,
      certified_state: value.state,
      content_source: value.source,
      artifact_sink: target.sink,
    })(value.request);
    expect(result).toMatchObject({ outcome: 'failure', code });
    expect(target.begin).not.toHaveBeenCalled();
  });

  it.each([0, 1, 511, 512, 513, 4097])(
    'round-trips an entry across tar block boundary size %i',
    async (size) => {
      const generated = Buffer.alloc(size, 0xa5);
      const value = fixture(generated);
      const target = memorySink();
      const result = await createReleasePrepareProvider({
        ...value.resolvers,
        certified_state: value.state,
        content_source: value.source,
        artifact_sink: target.sink,
      })(value.request);
      if (result.outcome !== 'success' || result.material === undefined) {
        throw new Error('prepare failed');
      }
      const tarball = result.material.release_units[0]?.packages[0]?.package_tarball;
      if (tarball === null || tarball === undefined) throw new Error('tarball missing');
      if (!('opaque_handle' in tarball)) throw new Error('opaque tarball missing');
      const entry = tarEntries(target.bytes.get(tarball.opaque_handle) ?? Buffer.alloc(0))[0];
      expect(entry).toMatchObject({ path: 'package/dist/index.js', mode: 0o755 });
      expect(entry?.bytes).toEqual(generated);
      await result.transaction?.rollback();
      expect(target.abort).toHaveBeenCalledOnce();
    },
  );

  it('refuses an archive path beyond the frozen ustar bound before beginning the sink', async () => {
    const value = fixture();
    const entry = value.certificationManifest.entries[0] as { path: string } | undefined;
    if (entry === undefined) throw new Error('entry fixture missing');
    entry.path = `${'a'.repeat(93)}.js`;
    const { manifest_digest_sha256: _digest, ...draft } = value.certificationManifest;
    (value.certificationManifest as { manifest_digest_sha256: string }).manifest_digest_sha256 =
      finalizeCertificationManifest(draft).manifest_digest_sha256;
    const target = memorySink();
    const result = await createReleasePrepareProvider({
      ...value.resolvers,
      certified_state: value.state,
      content_source: value.source,
      artifact_sink: target.sink,
    })(value.request);
    expect(result).toMatchObject({
      outcome: 'failure',
      code: 'release-certification-output-closure-invalid',
    });
    expect(target.begin).not.toHaveBeenCalled();
  });

  it('encodes the maximum 256-byte archive path in exact USTAR prefix and name fields', async () => {
    const value = fixture();
    const generatedPath = `${'a'.repeat(147)}/${'b'.repeat(100)}`;
    const archivePath = `package/${generatedPath}`;
    expect(Buffer.byteLength(archivePath, 'utf8')).toBe(256);
    const entry = value.certificationManifest.entries[0] as { path: string } | undefined;
    if (entry === undefined) throw new Error('entry fixture missing');
    const generated = value.certificationManifest.entries[0];
    if (generated === undefined || generated.immutable_blob_locator.kind !== 'generated-output')
      throw new Error('generated entry missing');
    const locator = generated.immutable_blob_locator;
    entry.path = generatedPath;
    const { manifest_digest_sha256: _digest, ...draft } = value.certificationManifest;
    (value.certificationManifest as { manifest_digest_sha256: string }).manifest_digest_sha256 =
      finalizeCertificationManifest(draft).manifest_digest_sha256;
    const target = memorySink();
    const result = await createReleasePrepareProvider({
      ...value.resolvers,
      certified_state: value.state,
      content_source: {
        ...value.source,
        readCertificationOutputClosure: (binding) => ({
          ...binding,
          outputs: [
            {
              path: generatedPath,
              mode: '100755',
              output_blob_handle: locator.output_blob_handle,
              certification_evidence_receipt: locator.certification_evidence_receipt,
            },
          ],
        }),
      },
      artifact_sink: target.sink,
    })(value.request);
    if (result.outcome !== 'success' || result.material === undefined)
      throw new Error('prepare failed');
    const tarball = result.material.release_units[0]?.packages[0]?.package_tarball;
    if (tarball === null || tarball === undefined || !('opaque_handle' in tarball))
      throw new Error('tarball missing');
    const header = gunzipSync(target.bytes.get(tarball.opaque_handle) ?? Buffer.alloc(0)).subarray(
      0,
      512,
    );
    expect(header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '')).toBe('b'.repeat(100));
    expect(header.subarray(345, 500).toString('utf8').replace(/\0.*$/u, '')).toBe(
      `package/${'a'.repeat(147)}`,
    );
    await result.transaction?.rollback();
  });

  it.each([
    ['the exact 100-byte name', 'a'.repeat(92), `package/${'a'.repeat(92)}`, ''],
    [
      'a 101-byte path at its rightmost valid separator',
      `a/${'b'.repeat(91)}`,
      'b'.repeat(91),
      'package/a',
    ],
    [
      'the real 102-byte scaffold template',
      'dist/resources/operations/scaffold/templates/api/controllers/__kebabEntity__.controller.ts.tpl',
      '__kebabEntity__.controller.ts.tpl',
      'package/dist/resources/operations/scaffold/templates/api/controllers',
    ],
    [
      'a UTF-8 boundary without splitting a scalar',
      `${'a'.repeat(147)}/${'é'.repeat(50)}`,
      'é'.repeat(50),
      `package/${'a'.repeat(147)}`,
    ],
  ] as const)(
    'retains %s with exact USTAR bytes and reconstruction',
    async (_name, path, name, prefix) => {
      const { value, source } = fixtureWithGeneratedPath(path);
      const archivePath = `package/${path}`;
      const target = memorySink();
      const result = await createReleasePrepareProvider({
        ...value.resolvers,
        certified_state: value.state,
        content_source: source,
        artifact_sink: target.sink,
      })(value.request);
      const tarball = preparedTarball(result, target);
      const header = gunzipSync(tarball).subarray(0, 512);
      const nameBytes = Buffer.from(name, 'utf8');
      const prefixBytes = Buffer.from(prefix, 'utf8');
      expect(header.subarray(0, nameBytes.byteLength)).toEqual(nameBytes);
      expect(header.subarray(nameBytes.byteLength, 100)).toEqual(
        Buffer.alloc(100 - nameBytes.byteLength),
      );
      expect(header.subarray(345, 345 + prefixBytes.byteLength)).toEqual(prefixBytes);
      expect(header.subarray(345 + prefixBytes.byteLength, 500)).toEqual(
        Buffer.alloc(155 - prefixBytes.byteLength),
      );
      expect(prefix.length === 0 ? name : `${prefix}/${name}`).toBe(archivePath);
      expect(tarEntries(tarball).map((entry) => entry.path)).toContain(archivePath);
      await result.transaction?.rollback();
    },
  );

  it.each([
    [
      'a 156-byte prefix',
      `${'a'.repeat(148)}/${'b'.repeat(100)}`,
      'release-prepare-unsupported-package-semantics',
    ],
    [
      'a 101-byte suffix',
      `${'a'.repeat(147)}/${'b'.repeat(101)}`,
      'release-prepare-unsupported-package-semantics',
    ],
    [
      'an unsplittable 101-byte name',
      'a'.repeat(101),
      'release-prepare-unsupported-package-semantics',
    ],
    [
      'an invalid Unicode scalar',
      `dir/${String.fromCharCode(0xd800)}`,
      'release-prepare-certification-manifest-invalid',
    ],
    [
      'an unsafe dot-dot segment',
      'dir/../file.js',
      'release-prepare-certification-manifest-invalid',
    ],
  ] as const)(
    'refuses %s after complete verification or manifest rejection, before sink.begin',
    async (_name, path, code) => {
      const { value, source } = fixtureWithGeneratedPath(path);
      const target = memorySink();
      const result = await createReleasePrepareProvider({
        ...value.resolvers,
        certified_state: value.state,
        content_source: source,
        artifact_sink: target.sink,
      })(value.request);
      expect(result).toMatchObject({
        outcome: 'failure',
        code,
      });
      expect(target.begin).not.toHaveBeenCalled();
    },
  );

  it('aborts a pre-commit failure and preserves an uncertain commit attempt for inspection', async () => {
    const value = fixture();
    const corrupt = memorySink({ corruptPut: true });
    const refused = await createReleasePrepareProvider({
      ...value.resolvers,
      certified_state: value.state,
      content_source: value.source,
      artifact_sink: corrupt.sink,
    })(value.request);
    expect(refused).toMatchObject({
      outcome: 'failure',
      code: 'release-artifact-sink-protocol-invalid',
    });
    expect(corrupt.abort).toHaveBeenCalledOnce();

    const failing = memorySink({ failCommit: true });
    const staged = await createReleasePrepareProvider({
      ...value.resolvers,
      certified_state: value.state,
      content_source: value.source,
      artifact_sink: failing.sink,
    })(value.request);
    expect(staged.outcome).toBe('success');
    await expect(staged.transaction?.commit()).rejects.toThrow(
      'release-artifact-sink-commit-unknown',
    );
    await staged.transaction?.rollback();
    expect(failing.abort).not.toHaveBeenCalled();
  });

  it('independently rereads every sink artifact and rejects post-commit substitution', async () => {
    const value = fixture();
    const target = memorySink();
    const result = await createReleasePrepareProvider({
      ...value.resolvers,
      certified_state: value.state,
      content_source: value.source,
      artifact_sink: target.sink,
    })(value.request);
    if (result.outcome !== 'success' || result.material === undefined)
      throw new Error('prepare failed');
    const prepared = {
      ...value.state,
      schemaVersion: '2.1.0',
      state: 'prepared',
      release_units: result.material.release_units,
      inputs: result.material.inputs,
      evidence: result.material.evidence,
      artifacts: result.material.artifacts,
      artifact_sink: result.material.artifact_sink,
    } as unknown as ReleaseLifecycleStateV2;
    await expect(
      reverifySinkArtifacts(prepared, {
        readArtifact: ({ opaque_handle }) => target.bytes.get(opaque_handle) ?? Buffer.alloc(0),
      }),
    ).resolves.toBeUndefined();
    const tarball = result.material.release_units[0]?.packages[0]?.package_tarball;
    if (tarball === null || tarball === undefined) throw new Error('tarball missing');
    if (!('opaque_handle' in tarball)) throw new Error('opaque tarball missing');
    target.bytes.set(tarball.opaque_handle, Buffer.from('substituted'));
    await expect(
      reverifySinkArtifacts(prepared, {
        readArtifact: ({ opaque_handle }) => target.bytes.get(opaque_handle) ?? Buffer.alloc(0),
      }),
    ).rejects.toThrow('release-downstream-artifact-reverification-failed');
  });

  it.each(['duplicate', 'omission', 'order', 'package-kind'] as const)(
    'refuses a %s in the current sorted one-to-one artifact projection',
    async (mutation) => {
      const value = fixture();
      const target = memorySink();
      const result = await createReleasePrepareProvider({
        ...value.resolvers,
        certified_state: value.state,
        content_source: value.source,
        artifact_sink: target.sink,
      })(value.request);
      if (result.outcome !== 'success' || result.material === undefined) {
        throw new Error('prepare failed');
      }
      const originalArtifacts = [...result.material.artifacts];
      const firstArtifact = originalArtifacts[0];
      if (firstArtifact === undefined) throw new Error('artifact missing');
      const artifacts =
        mutation === 'duplicate'
          ? [...originalArtifacts, firstArtifact]
          : mutation === 'omission'
            ? originalArtifacts.slice(0, -1)
            : mutation === 'order'
              ? [...originalArtifacts].reverse()
              : originalArtifacts;
      const releaseUnits =
        mutation === 'package-kind'
          ? result.material.release_units.map((unit, unitIndex) => ({
              ...unit,
              packages: unit.packages.map((pkg, packageIndex) =>
                unitIndex === 0 && packageIndex === 0
                  ? {
                      ...pkg,
                      package_manifest:
                        pkg.package_manifest === undefined
                          ? undefined
                          : { ...pkg.package_manifest, kind: 'package-sbom' as const },
                    }
                  : pkg,
              ),
            }))
          : result.material.release_units;
      const prepared = {
        ...value.state,
        schemaVersion: '2.1.0',
        state: 'prepared',
        release_units: releaseUnits,
        inputs: result.material.inputs,
        evidence: result.material.evidence,
        artifacts,
        artifact_sink: result.material.artifact_sink,
      } as unknown as ReleaseLifecycleStateV2;
      await expect(
        reverifySinkArtifacts(prepared, {
          readArtifact: ({ opaque_handle }) => target.bytes.get(opaque_handle) ?? Buffer.alloc(0),
        }),
      ).rejects.toThrow('release-downstream-artifact-reverification-failed');
      await result.transaction?.rollback();
    },
  );
});

describe('verified mutation continuity through prepare (ADR-MUT-0008 IA-001 through IA-004)', () => {
  it.each(['omitted-package', 'substituted-package'] as const)(
    'refuses semantically valid %s census against the genuine ten-package profile',
    async (rosterFault) => {
      const { value, source, evidence, binding, profile } = await mutationFixture(rosterFault);
      expect(profile.mutation_roster).toHaveLength(10);
      expect(evidence.closure.receipt.referent.release_profile_digest_sha256).toBe(
        resolveReleaseMutationRequirements(value.request, value.resolvers)[0]?.binding
          ?.release_profile_digest_sha256,
      );
      expect(
        evidence.closure.members.filter(
          (member) => member.document_kind === 'mutation-package-result-v2',
        ),
      ).toHaveLength(rosterFault === 'omitted-package' ? 9 : 10);
      await expect(
        verifyUnitMutationEvidenceDocuments({
          closure: evidence.closure,
          expected: binding,
          read: evidence.read,
          maximum_bytes: 1_000_000,
        }),
      ).resolves.toBeUndefined();
      const target = memorySink();
      const result = await createReleasePrepareProvider({
        ...value.resolvers,
        certified_state: value.state,
        content_source: source,
        artifact_sink: target.sink,
      })(value.request);
      expect(result).toMatchObject({
        outcome: 'failure',
        code: 'release-certification-generated-output-untrusted',
      });
      expect(target.begin).not.toHaveBeenCalled();
    },
  );

  it('retains all ten internal package pairs on one unit while preserving the exact one-package tarball', async () => {
    const { value, source, evidence, profile } = await mutationFixture();
    const target = memorySink();
    const result = await createReleasePrepareProvider({
      ...value.resolvers,
      certified_state: value.state,
      content_source: source,
      artifact_sink: target.sink,
    })(value.request);
    expect(result.outcome).toBe('success');
    expect(result.material?.release_units).toHaveLength(1);
    expect(result.material?.release_units[0]?.packages).toHaveLength(1);
    expect(result.material?.release_units[0]?.mutation_evidence).toEqual(evidence.closure);
    expect(result.material?.release_units[0]?.mutation_evidence?.members).toHaveLength(22);
    const labels = evidence.closure.members
      .filter((member) => member.document_kind === 'mutation-package-result-v2')
      .map((member) => member.package_name)
      .sort();
    expect(labels).toEqual(profile.mutation_roster.map((row) => row.package).sort());
    expect(labels).toHaveLength(10);
    expect(source.readUnitMutationEvidenceClosure).toHaveBeenCalledOnce();
    expect(source.readUnitMutationEvidenceReceipt).toHaveBeenCalledOnce();
    expect(source.readUnitMutationEvidenceBlob).toHaveBeenCalledTimes(23);
    const tarball = preparedTarball(result, target);
    expect(sha256(tarball)).toBe(
      '6dde079d83213ddaa496e9d130ccc9839285efe792e0b098596393ec6a109d0e',
    );
    expect(tarEntries(tarball)).toEqual([
      { path: 'package/dist/index.js', mode: 0o755, bytes: value.generated },
      { path: 'package/package.json', mode: 0o644, bytes: value.packageJson },
    ]);
    expect(result.material?.artifacts.map((artifact) => artifact.kind).sort()).toEqual([
      'package-manifest',
      'package-sbom',
      'package-tarball',
    ]);
    expect(result.material?.release_units[0]?.packages[0]?.certification_manifest?.entries).toEqual(
      value.certificationManifest.entries,
    );
    await result.transaction?.commit();
  });

  it('forbids a mutation carrier for a genuinely verified none plan without calling its readers', async () => {
    const required = await mutationFixture();
    const value = fixture();
    expect(
      resolveReleaseMutationRequirements(value.request, value.resolvers)[0]?.binding,
    ).toBeNull();
    Object.assign(value.state.release_units[0] ?? {}, {
      mutation_evidence: required.evidence.closure,
    });
    const target = memorySink();
    const result = await createReleasePrepareProvider({
      ...value.resolvers,
      certified_state: value.state,
      content_source: { ...required.source, ...value.source },
      artifact_sink: target.sink,
    })(value.request);
    expect(result).toMatchObject({
      outcome: 'failure',
      code: 'release-certification-generated-output-untrusted',
    });
    expect(target.begin).not.toHaveBeenCalled();
    expect(required.source.readUnitMutationEvidenceClosure).not.toHaveBeenCalled();
    expect(required.source.readUnitMutationEvidenceReceipt).not.toHaveBeenCalled();
    expect(required.source.readUnitMutationEvidenceBlob).not.toHaveBeenCalled();
  });

  it.each([
    'carrier',
    'closure-reader',
    'receipt-reader',
    'blob-reader',
    'bound',
    'invalid-bound',
  ] as const)(
    'refuses missing or invalid required %s before ArtifactSink effects',
    async (missing) => {
      const { value, source } = await mutationFixture();
      if (missing === 'carrier')
        Object.assign(value.state.release_units[0] ?? {}, { mutation_evidence: null });
      else if (missing === 'closure-reader')
        Object.assign(source, { readUnitMutationEvidenceClosure: undefined });
      else if (missing === 'receipt-reader')
        Object.assign(source, { readUnitMutationEvidenceReceipt: undefined });
      else if (missing === 'blob-reader')
        Object.assign(source, { readUnitMutationEvidenceBlob: undefined });
      else
        Object.assign(source, { unit_mutation_maximum_bytes: missing === 'bound' ? undefined : 0 });
      const target = memorySink();
      const result = await createReleasePrepareProvider({
        ...value.resolvers,
        certified_state: value.state,
        content_source: source,
        artifact_sink: target.sink,
      })(value.request);
      expect(result).toMatchObject({
        outcome: 'failure',
        code: 'release-certification-generated-output-untrusted',
      });
      expect(target.begin).not.toHaveBeenCalled();
    },
  );

  it.each([
    'missing-bytes',
    'corrupt-bytes',
    'stale-binding',
    'wrong-receipt',
    'sink-substitute',
  ] as const)('refuses required %s before ArtifactSink effects', async (fault) => {
    const { value, source, evidence, binding } = await mutationFixture();
    if (fault === 'missing-bytes') evidence.objects.delete(evidence.closure.output_contract.sha256);
    else if (fault === 'corrupt-bytes') {
      const original = evidence.objects.get(evidence.closure.output_contract.sha256);
      if (original === undefined) throw new Error('fixture contract missing');
      const corrupt = Buffer.from(original);
      corrupt[0] = 0;
      evidence.objects.set(evidence.closure.output_contract.sha256, corrupt);
    } else if (fault === 'stale-binding') {
      source.readUnitMutationEvidenceClosure.mockImplementation(() =>
        finalizeUnitMutationEvidenceClosure(
          { ...binding, candidate_commit: '0'.repeat(40) },
          evidence.projection,
        ),
      );
    } else if (fault === 'wrong-receipt') {
      source.readUnitMutationEvidenceReceipt.mockImplementation(() => ({
        ...evidence.closure.receipt,
        receipt_digest_sha256: '0'.repeat(64),
      }));
    } else {
      const projection = {
        ...evidence.projection,
        output_contract: {
          ...evidence.projection.output_contract,
          evidence_sink_id: 'foreign-sink',
        },
        members: evidence.projection.members.map((member) => ({
          ...member,
          evidence_sink_id: 'foreign-sink',
        })),
      };
      source.readUnitMutationEvidenceClosure.mockImplementation(() =>
        finalizeUnitMutationEvidenceClosure(binding, projection),
      );
    }
    const target = memorySink();
    const result = await createReleasePrepareProvider({
      ...value.resolvers,
      certified_state: value.state,
      content_source: source,
      artifact_sink: target.sink,
    })(value.request);
    expect(result).toMatchObject({
      outcome: 'failure',
      code: 'release-certification-generated-output-untrusted',
    });
    expect(target.begin).not.toHaveBeenCalled();
  });

  it('refuses missing plan resolvers even when the fixture plan requires no mutation', async () => {
    const value = fixture();
    const target = memorySink();
    const result = await createReleasePrepareProvider({
      certified_state: value.state,
      content_source: value.source,
      artifact_sink: target.sink,
    })(value.request);
    expect(result).toMatchObject({
      outcome: 'failure',
      code: 'release-receipt-provider-unavailable',
    });
    expect(target.begin).not.toHaveBeenCalled();
  });
});
