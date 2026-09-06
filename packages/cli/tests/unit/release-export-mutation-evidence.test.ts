import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '@devai-nyx/utils';
import {
  createReleaseExportMutationEvidence,
  readReleaseExportMutationEvidence,
  reverifyReleaseExportMutationEvidence,
  type ReleaseExportMutationEvidenceExpected,
  type ReleaseExportMutationEvidenceInput,
} from '../../src/services/release-export-mutation-evidence.js';
import {
  resolveReleaseMutationRequirements,
  type ReleaseLifecycleRequest,
  type ReleaseLifecycleStateV2,
  type ReleaseStateMaterial,
  type TrustedArtifactReader,
} from '../../src/services/release-lifecycle-execution.js';
import type {
  ReleaseMutationPlanReaders,
  ReleaseUnitMutationEvidenceReader,
} from '../../src/services/release-prepare-kernel.js';
import { verifyPortableReleaseMutationEvidence } from '../../src/services/release-prepare-kernel.js';
import {
  RELEASE_EXPORT_SPEC_V3_DIGEST,
  RELEASE_EXPORT_SPEC_V3_ID,
  RELEASE_EXPORT_TRANSCRIPT_V2_FORMAT,
  encodeReleaseExportProviderResultV2,
  encodeReleaseExportTranscriptV2,
  type ReleaseExportTranscriptV2,
} from '../../src/services/release-export-transcript-v2.js';
import {
  createLifecyclePolicyFixture,
  type LifecyclePolicyFixture,
} from '../helpers/release-policy-resolution-fixture.js';
import { fixture as unitMutationEvidenceFixture } from '../helpers/release-unit-mutation-evidence-fixture.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const ADOPTION = JSON.parse(
  readFileSync(resolve(ROOT, 'law/policy/devai-adoption.json'), 'utf8'),
) as {
  readonly release_verification: {
    readonly mutation_roster: readonly {
      readonly package: string;
      readonly manifest_path: string;
      readonly thresholds: { readonly score_min: number; readonly survived_max: number };
    }[];
    readonly mutation_execution: Readonly<Record<string, unknown>>;
  };
};
const ERROR = 'release-export-artifact-sink-protocol-invalid';
const TASK_POLICY_DIGEST = 'f'.repeat(64);

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function lifecycle(roster = ADOPTION.release_verification.mutation_roster): LifecyclePolicyFixture {
  return createLifecyclePolicyFixture(roster, {
    schemaVersion: '1.2.0',
    mutation_execution: {
      ...ADOPTION.release_verification.mutation_execution,
      schemaVersion: '1.2.0',
    },
  });
}

function request(value: LifecyclePolicyFixture): ReleaseLifecycleRequest {
  const candidate = value.candidate.repository;
  return {
    schemaVersion: '1.0.0',
    request_kind: 'release-lifecycle-request',
    action_id: 'release prepare',
    repository_locator: candidate,
    candidate_locator: {
      commit: candidate.commit,
      tree: candidate.tree,
      release_units: [
        {
          release_unit: value.resolution.release_unit,
          version: '1.5.0',
          package_roster: [
            {
              package_id: value.resolution.release_unit,
              manifest_path: 'package.json',
              manifest_digest_sha256: sha256(value.package_json),
            },
          ],
        },
      ],
    },
    receipt_locators: [
      {
        kind: 'release-plan-receipt',
        receipt_id: String(value.receipt.receipt_id),
        receipt_digest_sha256: String(value.receipt.receipt_digest_sha256),
        path: 'receipts/plan.json',
      },
    ],
  };
}

function readers(value: LifecyclePolicyFixture): ReleaseMutationPlanReaders {
  return { resolve_receipt: () => value.receipt, resolve_plan_input: value.resolve_plan_input };
}

function material(
  value: LifecyclePolicyFixture,
  closure: Awaited<ReturnType<typeof unitMutationEvidenceFixture>>['closure'] | null,
): Pick<ReleaseStateMaterial, 'release_units' | 'inputs'> {
  return {
    release_units: [
      {
        release_unit: value.resolution.release_unit,
        version: '1.5.0',
        packages: [
          {
            package_id: value.resolution.release_unit,
            manifest: null,
            tarball: null,
            sbom: null,
            evidence_manifest: null,
            provider_result: null,
            trust: null,
            certification_manifest: {
              task_policy_digest_sha256: TASK_POLICY_DIGEST,
            },
          },
        ],
        mutation_evidence: closure,
      },
    ],
    inputs: [
      {
        kind: 'task-policy',
        path: 'task-policy/certify/selection',
        sha256: TASK_POLICY_DIGEST,
      },
    ],
  } as unknown as Pick<ReleaseStateMaterial, 'release_units' | 'inputs'>;
}

async function requiredFixture(
  roster = ADOPTION.release_verification.mutation_roster,
  sourceOverrides: Partial<ReleaseUnitMutationEvidenceReader> = {},
  evidenceRoster = roster,
) {
  const value = lifecycle(roster);
  const selected = request(value);
  const [requirement] = resolveReleaseMutationRequirements(selected, readers(value));
  if (requirement?.binding === null || requirement === undefined)
    throw new Error('fixture required mutation binding missing');
  const evidence = await unitMutationEvidenceFixture({
    binding: {
      ...requirement.binding,
      task_policy_digests_sha256: [TASK_POLICY_DIGEST],
    },
    packages: evidenceRoster.map((entry) => ({
      packageName: entry.package,
      workspace: entry.manifest_path.replace(/\/package\.json$/u, ''),
    })),
  });
  const source = {
    unit_mutation_maximum_bytes: 1_000_000,
    readUnitMutationEvidenceClosure: vi.fn(() => evidence.closure),
    readUnitMutationEvidenceReceipt: vi.fn(() => evidence.closure.receipt),
    readUnitMutationEvidenceBlob: vi.fn(
      ({ identity }: { readonly identity: Parameters<typeof evidence.read>[0] }) =>
        evidence.read(identity),
    ),
    ...sourceOverrides,
  } as ReleaseUnitMutationEvidenceReader;
  const input: ReleaseExportMutationEvidenceInput = {
    request: selected,
    material: material(value, evidence.closure),
    source,
    plan: readers(value),
    maximum_provider_result_bytes: 1_000_000,
  };
  const expected: ReleaseExportMutationEvidenceExpected = {
    repository: selected.repository_locator,
    plan_receipt_digest_sha256: String(value.receipt.receipt_digest_sha256),
    release_units: input.material.release_units,
    inputs: input.material.inputs,
  };
  return { value, selected, evidence, source, input, expected };
}

function identity(
  kind:
    | 'package-manifest'
    | 'package-tarball'
    | 'package-sbom'
    | 'evidence-manifest'
    | 'provider-result',
  handle: string,
  bytes: Buffer,
) {
  return {
    kind,
    sink_id: 'offline-fixture-sink',
    opaque_handle: handle,
    sha256: sha256(bytes),
    size_bytes: bytes.byteLength,
  } as const;
}

async function offlineFixture() {
  const fixture = await requiredFixture();
  const token = await createReleaseExportMutationEvidence(fixture.input);
  const captured = readReleaseExportMutationEvidence(token, fixture.expected);
  const [mutationUnit] = captured.mutation_units;
  const [portableUnit] = captured.portable_units;
  const mutationEvidence = mutationUnit?.mutation_evidence;
  const portable = portableUnit?.mutation_evidence;
  const [releaseUnit] = fixture.input.material.release_units;
  const packageEntry = releaseUnit?.packages[0];
  if (
    mutationUnit === undefined ||
    portableUnit === undefined ||
    mutationEvidence === undefined ||
    mutationEvidence === null ||
    portable === undefined ||
    portable === null ||
    releaseUnit === undefined ||
    packageEntry === undefined
  )
    throw new Error('offline fixture mutation evidence missing');
  const packageManifestBytes = Buffer.from('package-manifest', 'utf8');
  const packageTarballBytes = Buffer.from('package-tarball', 'utf8');
  const packageSbomBytes = Buffer.from('package-sbom', 'utf8');
  const parent = [
    identity('package-manifest', 'parent-manifest', packageManifestBytes),
    identity('package-tarball', 'parent-tarball', packageTarballBytes),
    identity('package-sbom', 'parent-sbom', packageSbomBytes),
  ].sort((left, right) =>
    Buffer.compare(
      Buffer.from(`${left.kind}\0${left.opaque_handle}`),
      Buffer.from(`${right.kind}\0${right.opaque_handle}`),
    ),
  );
  const evidenceManifest = identity(
    'evidence-manifest',
    'policy-closure',
    Buffer.from('policy-closure', 'utf8'),
  );
  const trust = {
    trust_root_id: 'fixture/trust',
    trust_store_digest_sha256: 'a'.repeat(64),
    key_id: 'fixture-key',
    signature_algorithm: 'ed25519' as const,
  };
  const destination = { kind: 'evidence-destination', exact_identifier: 'fixture/export' };
  const limits = {
    maximum_transcript_bytes: 1_000_000,
    maximum_provider_result_bytes: 1_000_000,
    maximum_packages: 1,
  };
  const transcript: ReleaseExportTranscriptV2 = {
    version: RELEASE_EXPORT_TRANSCRIPT_V2_FORMAT,
    binding: {
      action_id: 'release export',
      repository: fixture.selected.repository_locator,
      candidate: {
        commit: fixture.selected.candidate_locator.commit,
        tree: fixture.selected.candidate_locator.tree,
      },
      plan_receipt_digest_sha256: String(fixture.value.receipt.receipt_digest_sha256),
      parent_artifact_sink: {
        sink_id: 'offline-fixture-sink',
        transaction_handle: 'parent-transaction',
        committed_manifest_handle: 'parent-commit',
        committed_manifest_sha256: 'b'.repeat(64),
        committed_manifest_size_bytes: 1,
        commit_protocol: 'devai.artifact-sink.two-phase.v1',
      },
      sink_id: 'offline-fixture-sink',
      destination,
      trust,
      attempt_id: 'RLA-0123456789abcdef',
    },
    parent,
    closures: [
      {
        package_id: packageEntry.package_id,
        release_unit: releaseUnit.release_unit,
        evidence_manifest: evidenceManifest,
        expected_installed_package: {
          name: '@aarusso-nyx/devai',
          version: '1.5.0',
          archive_sha256: 'c'.repeat(64),
          content_manifest_sha256: 'd'.repeat(64),
        },
        policy_resolution_digest_sha256: 'e'.repeat(64),
      },
    ],
    mutation_units: [mutationUnit],
    destination,
    trust,
  };
  const transcriptBytes = encodeReleaseExportTranscriptV2(transcript, limits);
  const providerBytes = encodeReleaseExportProviderResultV2(
    {
      package_id: packageEntry.package_id,
      transcript: transcriptBytes,
      signature: 'AQ==',
      mutation_evidence: portable,
    },
    limits,
  );
  const provider = identity('provider-result', 'provider-result', providerBytes);
  const manifestBytes = Buffer.from(
    canonicalJson({
      export_spec_id: RELEASE_EXPORT_SPEC_V3_ID,
      export_spec_digest_sha256: RELEASE_EXPORT_SPEC_V3_DIGEST,
    }),
    'utf8',
  );
  const committed = identity('provider-result', 'export-commit', manifestBytes);
  const artifacts = new Map<string, Buffer>([
    [provider.opaque_handle, providerBytes],
    [committed.opaque_handle, manifestBytes],
  ]);
  const reader: TrustedArtifactReader = {
    readArtifact: ({ opaque_handle }) => {
      const bytes = artifacts.get(opaque_handle);
      if (bytes === undefined) throw new Error('unexpected offline artifact read');
      return Buffer.from(bytes);
    },
  };
  // Deliberately partial transport-only state: this direct pure-kernel test does not exercise
  // lifecycle parsing, signing, or store transitions. It supplies every field consumed below.
  const state = {
    schemaVersion: '2.1.0',
    state: 'exported',
    repository: fixture.selected.repository_locator,
    candidate: {
      commit: fixture.selected.candidate_locator.commit,
      tree: fixture.selected.candidate_locator.tree,
    },
    release_units: [
      {
        ...releaseUnit,
        packages: [{ ...packageEntry, provider_result: provider }],
      },
    ],
    inputs: fixture.input.material.inputs,
    artifact_sink: {
      sink_id: committed.sink_id,
      transaction_handle: 'export-transaction',
      committed_manifest_handle: committed.opaque_handle,
      committed_manifest_sha256: committed.sha256,
      committed_manifest_size_bytes: committed.size_bytes,
      commit_protocol: 'devai.artifact-sink.two-phase.v1',
    },
  } as unknown as ReleaseLifecycleStateV2;
  return { fixture, reader, state, limits, artifacts };
}

function refusal(run: () => unknown): void {
  expect(run).toThrow(ERROR);
}

describe('release export mutation evidence capture', () => {
  it('captures genuine required evidence once, returns defensive portable copies, and rechecks it', async () => {
    const fixture = await requiredFixture();
    const token = await createReleaseExportMutationEvidence(fixture.input);
    const first = readReleaseExportMutationEvidence(token, fixture.expected);
    const [firstUnit] = first.mutation_units;
    const evidence = firstUnit?.mutation_evidence;
    if (evidence === undefined || evidence === null) throw new Error('fixture carrier missing');
    (evidence as { carrier_package_id: string }).carrier_package_id = '@forged/carrier';
    const second = readReleaseExportMutationEvidence(token, fixture.expected);

    expect(second.mutation_units).toHaveLength(1);
    expect(second.mutation_units[0]?.mutation_evidence).toMatchObject({
      carrier_package_id: fixture.value.resolution.release_unit,
    });
    expect(second.portable_units[0]?.mutation_evidence).not.toBeNull();
    expect(fixture.source.readUnitMutationEvidenceClosure).toHaveBeenCalledTimes(1);
    expect(fixture.source.readUnitMutationEvidenceReceipt).toHaveBeenCalledTimes(1);
    expect(fixture.source.readUnitMutationEvidenceBlob).toHaveBeenCalled();
    await expect(reverifyReleaseExportMutationEvidence(token)).resolves.toBeUndefined();
    expect(fixture.source.readUnitMutationEvidenceClosure).toHaveBeenCalledTimes(2);
    expect(fixture.source.readUnitMutationEvidenceReceipt).toHaveBeenCalledTimes(2);
  });

  it('captures a genuinely verified mutation-none unit as explicit null rows without evidence reads', async () => {
    const value = createLifecyclePolicyFixture();
    const selected = request(value);
    const source: ReleaseUnitMutationEvidenceReader = { unit_mutation_maximum_bytes: 1_000_000 };
    const input: ReleaseExportMutationEvidenceInput = {
      request: selected,
      material: material(value, null),
      source,
      plan: readers(value),
      maximum_provider_result_bytes: 1_000_000,
    };
    const token = await createReleaseExportMutationEvidence(input);
    const snapshot = readReleaseExportMutationEvidence(token, {
      repository: selected.repository_locator,
      plan_receipt_digest_sha256: String(value.receipt.receipt_digest_sha256),
      release_units: input.material.release_units,
      inputs: input.material.inputs,
    });

    expect(snapshot).toEqual({
      mutation_units: [{ release_unit: value.resolution.release_unit, mutation_evidence: null }],
      portable_units: [{ release_unit: value.resolution.release_unit, mutation_evidence: null }],
    });
    await expect(reverifyReleaseExportMutationEvidence(token)).resolves.toBeUndefined();
  });

  it('refuses forged tokens and every expected candidate, plan, material, and input drift', async () => {
    const fixture = await requiredFixture();
    const token = await createReleaseExportMutationEvidence(fixture.input);
    const foreign = { kind: 'protected-release-export-mutation-evidence' } as const;
    refusal(() => readReleaseExportMutationEvidence(foreign, fixture.expected));
    const [input] = fixture.expected.inputs;
    if (input === undefined) throw new Error('fixture input missing');

    const variants: readonly ReleaseExportMutationEvidenceExpected[] = [
      {
        ...fixture.expected,
        repository: { ...fixture.expected.repository, id: 'foreign/repository' },
      },
      { ...fixture.expected, plan_receipt_digest_sha256: '0'.repeat(64) },
      { ...fixture.expected, release_units: [] },
      {
        ...fixture.expected,
        inputs: [{ ...input, sha256: '0'.repeat(64) }],
      },
    ];
    for (const expected of variants)
      refusal(() => readReleaseExportMutationEvidence(token, expected));
  });

  it('refuses missing plan readers, roster or threshold divergence, and receipt/control/member substitutions', async () => {
    const fixture = await requiredFixture();
    await expect(
      createReleaseExportMutationEvidence({ ...fixture.input, plan: {} }),
    ).rejects.toThrow(ERROR);

    const rosterMismatch = await requiredFixture(
      ADOPTION.release_verification.mutation_roster,
      {},
      ADOPTION.release_verification.mutation_roster.slice(0, 9),
    );
    await expect(createReleaseExportMutationEvidence(rosterMismatch.input)).rejects.toThrow(ERROR);

    const thresholdRoster = ADOPTION.release_verification.mutation_roster.map((entry, index) =>
      index === 0
        ? {
            ...entry,
            thresholds: { ...entry.thresholds, score_min: entry.thresholds.score_min + 1 },
          }
        : entry,
    );
    const threshold = await requiredFixture(thresholdRoster);
    await expect(createReleaseExportMutationEvidence(threshold.input)).rejects.toThrow(ERROR);

    const receipt = await requiredFixture();
    const changedReceipt = {
      ...receipt.input,
      source: {
        ...receipt.source,
        readUnitMutationEvidenceReceipt: () => ({
          ...receipt.evidence.closure.receipt,
          receipt_digest_sha256: '0'.repeat(64),
        }),
      },
    };
    await expect(createReleaseExportMutationEvidence(changedReceipt)).rejects.toThrow(ERROR);

    const changedDocument = {
      ...fixture.input,
      source: {
        ...fixture.source,
        readUnitMutationEvidenceBlob: ({
          identity,
        }: {
          readonly identity: Parameters<typeof fixture.evidence.read>[0];
        }) => {
          const bytes = fixture.evidence.read(identity);
          if (identity.path === fixture.evidence.closure.output_contract.path)
            bytes[0] = (bytes[0] ?? 0) ^ 1;
          return bytes;
        },
      },
    };
    await expect(createReleaseExportMutationEvidence(changedDocument)).rejects.toThrow(ERROR);

    const changedMember = {
      ...fixture.input,
      source: {
        ...fixture.source,
        readUnitMutationEvidenceBlob: ({
          identity,
        }: {
          readonly identity: Parameters<typeof fixture.evidence.read>[0];
        }) => {
          const bytes = fixture.evidence.read(identity);
          if (identity.path !== fixture.evidence.closure.output_contract.path)
            bytes[0] = (bytes[0] ?? 0) ^ 1;
          return bytes;
        },
      },
    };
    await expect(createReleaseExportMutationEvidence(changedMember)).rejects.toThrow(ERROR);
  });

  it('refuses a changed sink reread rather than replacing the captured snapshot', async () => {
    const fixture = await requiredFixture();
    let changed = false;
    const input: ReleaseExportMutationEvidenceInput = {
      ...fixture.input,
      source: {
        unit_mutation_maximum_bytes: 1_000_000,
        readUnitMutationEvidenceClosure: () => fixture.evidence.closure,
        readUnitMutationEvidenceReceipt: () => fixture.evidence.closure.receipt,
        readUnitMutationEvidenceBlob: ({ identity }) => {
          const bytes = fixture.evidence.read(identity);
          if (changed && identity.path !== fixture.evidence.closure.output_contract.path)
            bytes[0] = (bytes[0] ?? 0) ^ 1;
          return bytes;
        },
      },
    };
    const token = await createReleaseExportMutationEvidence(input);
    changed = true;
    await expect(reverifyReleaseExportMutationEvidence(token)).rejects.toThrow(ERROR);
  });

  it('rechecks embedded v2 unit bytes using only the bundle reader and genuine profile semantics', async () => {
    const offline = await offlineFixture();
    await expect(
      verifyPortableReleaseMutationEvidence(
        offline.fixture.selected,
        offline.state,
        offline.reader,
        readers(offline.fixture.value),
        offline.limits,
      ),
    ).resolves.toBeUndefined();
  });

  it('refuses a legacy export, corrupted portable control/member bytes, and absent bundle reader', async () => {
    const offline = await offlineFixture();
    await expect(
      verifyPortableReleaseMutationEvidence(
        offline.fixture.selected,
        offline.state,
        undefined,
        readers(offline.fixture.value),
        offline.limits,
      ),
    ).rejects.toThrow('release-certification-generated-output-untrusted');

    const legacy = structuredClone(offline.state) as Record<string, unknown>;
    const artifactSink = legacy['artifact_sink'] as Record<string, unknown>;
    const legacyManifest = Buffer.from(
      canonicalJson({
        export_spec_id: 'devai.release-export-closure.v2',
        export_spec_digest_sha256:
          '77ab8fd69d2b3d4edeaebd12b516eb5c15fe910f93ff4516deadd466f0853f98',
      }),
      'utf8',
    );
    artifactSink['committed_manifest_sha256'] = sha256(legacyManifest);
    artifactSink['committed_manifest_size_bytes'] = legacyManifest.byteLength;
    offline.artifacts.set(String(artifactSink['committed_manifest_handle']), legacyManifest);
    await expect(
      verifyPortableReleaseMutationEvidence(
        offline.fixture.selected,
        legacy as ReleaseLifecycleStateV2,
        offline.reader,
        readers(offline.fixture.value),
        offline.limits,
      ),
    ).rejects.toThrow('release-certification-generated-output-untrusted');

    const offlineCorrupt = await offlineFixture();
    const provider = offlineCorrupt.state.release_units[0]?.packages[0]?.provider_result;
    if (
      provider === undefined ||
      provider === null ||
      !('opaque_handle' in provider) ||
      typeof provider.opaque_handle !== 'string'
    )
      throw new Error('fixture provider missing');
    const bytes = offlineCorrupt.artifacts.get(provider.opaque_handle);
    if (bytes === undefined) throw new Error('fixture provider bytes missing');
    const corrupt = Buffer.from(bytes);
    corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] ?? 0) ^ 1;
    offlineCorrupt.artifacts.set(provider.opaque_handle, corrupt);
    await expect(
      verifyPortableReleaseMutationEvidence(
        offlineCorrupt.fixture.selected,
        offlineCorrupt.state,
        offlineCorrupt.reader,
        readers(offlineCorrupt.fixture.value),
        offlineCorrupt.limits,
      ),
    ).rejects.toThrow('release-certification-generated-output-untrusted');
  });
});
