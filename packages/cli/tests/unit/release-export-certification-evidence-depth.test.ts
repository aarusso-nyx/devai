import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import {
  createCertifiedEvidenceCarrier,
  finalizeCertifiedEvidenceNamespaceCensus,
} from '../../src/services/release-certified-evidence-carrier.js';
import {
  createReleaseExportCertificationEvidence,
  readReleaseExportCertificationEvidence,
  reverifyReleaseExportCertificationEvidence,
  type ReleaseCertifiedEvidenceCarrierReader,
  type ReleaseExportCertificationEvidenceExpected,
  type ReleaseExportCertificationEvidenceInput,
} from '../../src/services/release-export-certification-evidence.js';
import type {
  ReleaseLifecycleRequest,
  ReleaseStateMaterial,
} from '../../src/services/release-lifecycle-execution.js';

const ERROR = 'release-export-artifact-sink-protocol-invalid';
const COMMIT = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const MAXIMUM = 1_048_576;
const UNIT = '@fixture/release';

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

const taskPolicy = {
  schemaVersion: '1.2.0',
  tasks: [
    { nodeId: 'build', taskKey: 'build@1' },
    { nodeId: 'test', taskKey: 'test@1' },
  ],
};

function result(nodeId: string, taskKey: string) {
  return {
    schemaVersion: '1.0.0' as const,
    nodeId,
    taskKey,
    status: 'PASS' as const,
    inputDigest: digest({ nodeId }),
    dependencyResultDigests: {},
    outputDigests: { [`dist/${nodeId}.js`]: digest(nodeId) },
    startedAt: '2026-09-09T00:00:00.000Z',
    finishedAt: '2026-09-09T00:00:01.000Z',
  };
}

const results = [result('build', 'build@1'), result('test', 'test@1')];
const repository = { id: 'aarusso-nyx/devai', commit: COMMIT, tree: TREE };
const derivation = {
  repository,
  candidate: { commit: COMMIT, tree: TREE },
  task_policy_digest_sha256: digest(taskPolicy),
};
const receipt = {
  schemaVersion: '1.1.0',
  repository,
  profile: 'rc',
  taskPolicyDigest: derivation.task_policy_digest_sha256,
  createdAt: '2026-09-09T00:00:02.000Z',
  tasks: results.map((value) => ({
    nodeId: value.nodeId,
    taskKey: value.taskKey,
    resultDigest: digest(value),
  })),
};
const census = finalizeCertifiedEvidenceNamespaceCensus({
  release_unit: UNIT,
  derivation,
  entries: results.map((value) => ({
    path: `dist/${value.nodeId}.js`,
    mode: '100644',
    sha256: digest(value.nodeId),
    size_bytes: value.nodeId.length,
    task_node: value.nodeId,
  })),
});

function carrier(
  overrides: {
    readonly release_unit?: string;
    readonly derivation?: unknown;
    readonly namespace_census?: unknown;
  } = {},
) {
  return createCertifiedEvidenceCarrier({
    release_unit: overrides.release_unit ?? UNIT,
    derivation: overrides.derivation ?? derivation,
    candidate_receipt: receipt,
    task_policy: taskPolicy,
    task_results: results,
    namespace_census: overrides.namespace_census ?? census,
    maximum_bytes: MAXIMUM,
  });
}

function request(): ReleaseLifecycleRequest {
  return {
    schemaVersion: '1.0.0',
    request_kind: 'release-lifecycle-request',
    action_id: 'release export',
    repository_locator: repository,
    candidate_locator: {
      commit: COMMIT,
      tree: TREE,
      release_units: [
        {
          release_unit: UNIT,
          version: '1.5.0',
          package_roster: [
            {
              package_id: '@fixture/a',
              manifest_path: 'packages/a/package.json',
              manifest_digest_sha256: 'c'.repeat(64),
            },
            {
              package_id: '@fixture/z',
              manifest_path: 'packages/z/package.json',
              manifest_digest_sha256: 'd'.repeat(64),
            },
          ],
        },
      ],
    },
    receipt_locators: [
      {
        kind: 'release-plan-receipt',
        receipt_id: 'RPL-0123456789abcdef',
        receipt_digest_sha256: 'e'.repeat(64),
        path: 'receipts/plan.json',
      },
    ],
    provider: { kind: 'evidence-export', provider_id: 'fixture-exporter' },
    destination: { kind: 'evidence-destination', exact_identifier: 'fixture/export' },
  };
}

function manifest(policyDigest = derivation.task_policy_digest_sha256) {
  return {
    task_policy_digest_sha256: policyDigest,
    candidate: { commit: COMMIT, tree: TREE },
  };
}

function material(): Pick<ReleaseStateMaterial, 'release_units'> {
  return {
    release_units: [
      {
        release_unit: UNIT,
        version: '1.5.0',
        packages: ['@fixture/a', '@fixture/z'].map((packageId) => ({
          package_id: packageId,
          certification_manifest: manifest(),
        })),
      },
    ],
  } as unknown as Pick<ReleaseStateMaterial, 'release_units'>;
}

function fixture(sourceOverrides: Partial<ReleaseCertifiedEvidenceCarrierReader> = {}): {
  readonly bytes: Buffer;
  readonly source: ReleaseCertifiedEvidenceCarrierReader;
  readonly input: ReleaseExportCertificationEvidenceInput;
  readonly expected: ReleaseExportCertificationEvidenceExpected;
} {
  const bytes = carrier();
  const source: ReleaseCertifiedEvidenceCarrierReader = {
    certified_evidence_carrier_maximum_bytes: MAXIMUM,
    readCertifiedEvidenceCarrier: vi.fn(() => Buffer.from(bytes)),
    ...sourceOverrides,
  };
  const selected = request();
  const selectedMaterial = material();
  return {
    bytes,
    source,
    input: {
      request: selected,
      material: selectedMaterial,
      source,
      maximum_provider_result_bytes: MAXIMUM,
    },
    expected: { repository: selected.repository_locator, ...selectedMaterial },
  };
}

function refusal(run: () => unknown): void {
  expect(run).toThrow(ERROR);
}

describe('release export certification evidence capture', () => {
  it('projects every certified byte identity, elects the first package, and returns defensive copies', async () => {
    const value = fixture();
    const token = await createReleaseExportCertificationEvidence(value.input);
    const snapshot = readReleaseExportCertificationEvidence(token, value.expected);

    expect(token).toEqual({ kind: 'protected-release-export-certification-evidence' });
    expect(Object.isFrozen(token)).toBe(true);
    expect(snapshot.certification_units).toEqual([
      {
        release_unit: UNIT,
        carrier_package_id: '@fixture/a',
        carrier: {
          sha256: digest(JSON.parse(value.bytes.toString('utf8'))),
          size_bytes: value.bytes.length,
        },
        derivation_binding_digest_sha256: digest(derivation),
        candidate_receipt: {
          sha256: digest(receipt),
          size_bytes: Buffer.byteLength(canonicalJson(receipt)),
        },
        task_policy: {
          sha256: digest(taskPolicy),
          size_bytes: Buffer.byteLength(canonicalJson(taskPolicy)),
        },
        task_results: [...results]
          .sort((left, right) => digest(left).localeCompare(digest(right)))
          .map((value) => ({
            sha256: digest(value),
            size_bytes: Buffer.byteLength(canonicalJson(value)),
          })),
        namespace_census: {
          sha256: digest(census),
          size_bytes: Buffer.byteLength(canonicalJson(census)),
        },
        census_member_projection_digest_sha256: canonicalSha256(census.entries),
        census_member_count: census.entries.length,
      },
    ]);
    expect(snapshot.portable_units).toEqual([
      { release_unit: UNIT, carrier_bytes_base64: value.bytes.toString('base64') },
    ]);
    expect(value.source.readCertifiedEvidenceCarrier).toHaveBeenCalledWith({
      repository,
      candidate: { commit: COMMIT, tree: TREE },
      task_policy_digest_sha256: derivation.task_policy_digest_sha256,
      release_unit: UNIT,
    });

    (snapshot.certification_units[0] as { carrier_package_id: string }).carrier_package_id =
      '@forged/package';
    expect(
      readReleaseExportCertificationEvidence(token, value.expected).certification_units[0],
    ).toMatchObject({ carrier_package_id: '@fixture/a' });
  });

  it('reverifies the captured source and refuses changed carrier bytes', async () => {
    const value = fixture();
    const read = value.source.readCertifiedEvidenceCarrier as ReturnType<typeof vi.fn>;
    const token = await createReleaseExportCertificationEvidence(value.input);

    await expect(reverifyReleaseExportCertificationEvidence(token)).resolves.toBeUndefined();
    expect(read).toHaveBeenCalledTimes(2);
    const changedCensus = finalizeCertifiedEvidenceNamespaceCensus({
      release_unit: UNIT,
      derivation,
      entries: [
        ...census.entries,
        {
          path: 'dist/extra.js',
          mode: '100644',
          sha256: 'f'.repeat(64),
          size_bytes: 5,
          task_node: 'build',
        },
      ],
    });
    read.mockImplementation(() => carrier({ namespace_census: changedCensus }));
    await expect(reverifyReleaseExportCertificationEvidence(token)).rejects.toThrow(ERROR);
  });

  it('refuses forged tokens and any expected repository or material drift', async () => {
    const value = fixture();
    const token = await createReleaseExportCertificationEvidence(value.input);
    refusal(() =>
      readReleaseExportCertificationEvidence(
        { kind: 'protected-release-export-certification-evidence' },
        value.expected,
      ),
    );
    refusal(() =>
      readReleaseExportCertificationEvidence(token, {
        ...value.expected,
        repository: { ...repository, id: 'foreign/repository' },
      }),
    );
    refusal(() =>
      readReleaseExportCertificationEvidence(token, { ...value.expected, release_units: [] }),
    );
  });

  it('refuses missing controls, invalid budgets, malformed carriers, and cross-unit substitution', async () => {
    const value = fixture();
    for (const source of [
      {},
      { readCertifiedEvidenceCarrier: () => value.bytes },
      { certified_evidence_carrier_maximum_bytes: MAXIMUM },
      {
        certified_evidence_carrier_maximum_bytes: 0,
        readCertifiedEvidenceCarrier: () => value.bytes,
      },
    ]) {
      await expect(
        createReleaseExportCertificationEvidence({ ...value.input, source }),
      ).rejects.toThrow(ERROR);
    }
    for (const maximum_provider_result_bytes of [0, MAXIMUM + 0.5, 0x80000000]) {
      await expect(
        createReleaseExportCertificationEvidence({
          ...value.input,
          maximum_provider_result_bytes,
        }),
      ).rejects.toThrow(ERROR);
    }
    for (const bytes of [
      'not-a-buffer',
      Buffer.alloc(0),
      Buffer.from('{}'),
      carrier({ release_unit: '@other' }),
    ]) {
      await expect(
        createReleaseExportCertificationEvidence({
          ...value.input,
          source: {
            certified_evidence_carrier_maximum_bytes: MAXIMUM,
            readCertifiedEvidenceCarrier: () => bytes as Buffer,
          },
        }),
      ).rejects.toThrow(ERROR);
    }
  });

  it('honors exact raw and encoded budgets and the signed 32-bit provider ceiling', async () => {
    const value = fixture();
    const encodedBytes = Math.ceil(value.bytes.length / 3) * 4;
    const exactRaw = {
      ...value.input,
      source: {
        certified_evidence_carrier_maximum_bytes: value.bytes.length,
        readCertifiedEvidenceCarrier: () => value.bytes,
      },
      maximum_provider_result_bytes: encodedBytes,
    };
    await expect(createReleaseExportCertificationEvidence(exactRaw)).resolves.toEqual({
      kind: 'protected-release-export-certification-evidence',
    });
    await expect(
      createReleaseExportCertificationEvidence({
        ...exactRaw,
        maximum_provider_result_bytes: encodedBytes - 1,
      }),
    ).rejects.toThrow(ERROR);
    await expect(
      createReleaseExportCertificationEvidence({
        ...value.input,
        maximum_provider_result_bytes: 0x7fffffff,
      }),
    ).resolves.toEqual({ kind: 'protected-release-export-certification-evidence' });
    await expect(
      createReleaseExportCertificationEvidence({
        ...value.input,
        source: {
          certified_evidence_carrier_maximum_bytes: value.bytes.length - 1,
          readCertifiedEvidenceCarrier: () => value.bytes,
        },
      }),
    ).rejects.toThrow(ERROR);
  });

  it('refuses a non-Buffer carrier even when its bytes are otherwise authentic', async () => {
    const value = fixture();
    const bytes = Uint8Array.from(value.bytes);
    await expect(
      createReleaseExportCertificationEvidence({
        ...value.input,
        source: {
          certified_evidence_carrier_maximum_bytes: MAXIMUM,
          readCertifiedEvidenceCarrier: () => bytes as unknown as Buffer,
        },
      }),
    ).rejects.toThrow(ERROR);
  });

  it('refuses uniformly malformed manifest policy and candidate identities before carrier access', async () => {
    const value = fixture();
    const read = value.source.readCertifiedEvidenceCarrier as ReturnType<typeof vi.fn>;
    const [unit] = value.input.material.release_units;
    if (unit === undefined) throw new Error('fixture unit missing');
    const variants = [
      unit.packages.map((entry) => ({
        ...entry,
        certification_manifest: { ...manifest(), task_policy_digest_sha256: 42 },
      })),
      unit.packages.map((entry) => ({
        ...entry,
        certification_manifest: {
          ...manifest(),
          candidate: { commit: COMMIT, tree: 'f'.repeat(40) },
        },
      })),
    ];
    for (const packages of variants) {
      read.mockClear();
      await expect(
        createReleaseExportCertificationEvidence({
          ...value.input,
          material: {
            release_units: [{ ...unit, packages }],
          } as Pick<ReleaseStateMaterial, 'release_units'>,
        }),
      ).rejects.toThrow(ERROR);
      expect(read).not.toHaveBeenCalled();
    }
  });

  it('refuses incomplete unit populations, split policy identities, and candidate substitutions before reading', async () => {
    const value = fixture();
    const read = value.source.readCertifiedEvidenceCarrier as ReturnType<typeof vi.fn>;
    const [unit] = value.input.material.release_units;
    if (unit === undefined) throw new Error('fixture unit missing');
    const [first, second] = unit.packages;
    if (first === undefined || second === undefined) throw new Error('fixture package missing');

    const variants = [
      [],
      [{ ...unit, packages: [] }],
      [{ ...unit, release_unit: '@fixture/other' }],
      [{ ...unit, packages: [{ ...first, certification_manifest: undefined }, second] }],
      [{ ...unit, packages: [{ ...first, certification_manifest: null }, second] }],
      [
        {
          ...unit,
          packages: [
            {
              ...first,
              certification_manifest: {
                ...manifest(),
                task_policy_digest_sha256: 42,
              },
            },
            second,
          ],
        },
      ],
      [
        {
          ...unit,
          packages: [first, { ...second, certification_manifest: manifest('f'.repeat(64)) }],
        },
      ],
      [
        {
          ...unit,
          packages: [
            first,
            {
              ...second,
              certification_manifest: {
                ...manifest(),
                candidate: { commit: 'f'.repeat(40), tree: TREE },
              },
            },
          ],
        },
      ],
    ];
    for (const release_units of variants) {
      await expect(
        createReleaseExportCertificationEvidence({
          ...value.input,
          material: { release_units } as Pick<ReleaseStateMaterial, 'release_units'>,
        }),
      ).rejects.toThrow(ERROR);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses a valid empty release request before consulting a carrier source', async () => {
    const value = fixture();
    const read = value.source.readCertifiedEvidenceCarrier as ReturnType<typeof vi.fn>;
    const emptyRequest = {
      ...value.input.request,
      candidate_locator: { ...value.input.request.candidate_locator, release_units: [] },
      receipt_locators: [],
    };
    await expect(
      createReleaseExportCertificationEvidence({
        ...value.input,
        request: emptyRequest,
        material: { release_units: [] },
      }),
    ).rejects.toThrow(ERROR);
    expect(read).not.toHaveBeenCalled();
  });
});
