import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import { vi } from 'vitest';
import { composeMutationEvidenceV21 } from '../../src/services/mutation-evidence-v21.js';
import {
  finalizeReleaseMutationArtifactsV21,
  normalizeReleaseMutationPackageV21,
} from '../../src/services/release-mutation-artifacts.js';
import {
  finalizeUnitMutationEvidenceClosure,
  type UnitMutationEvidenceBinding,
  type UnitMutationEvidenceMember,
  type UnitMutationEvidenceObject,
  type UnitMutationEvidenceProjection,
} from '../../src/services/release-unit-mutation-evidence.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const CANDIDATE = {
  releaseUnit: '@fixture/publishable',
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
};
export const PACKAGE_NAMES = Array.from(
  { length: 10 },
  (_, index) => `@fixture/internal-${String(index).padStart(2, '0')}`,
);
export const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');
export const bytes = (value: unknown): Buffer => Buffer.from(canonicalJson(value));
export const sortMembers = (members: readonly UnitMutationEvidenceMember[]) =>
  [...members].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));

/** Pure semantic fixture, not execution custody or a candidate-authority substitute. */
export async function fixture(
  options: {
    reused?: boolean;
    notRequired?: boolean;
    binding?: Partial<UnitMutationEvidenceBinding>;
    sinkId?: string;
    packages?: readonly { readonly packageName: string; readonly workspace: string }[];
  } = {},
) {
  const policy = JSON.parse(
    readFileSync(resolve(ROOT, 'law/policy/mutation-evidence-v2.json'), 'utf8'),
  ) as Record<string, unknown>;
  const binding: UnitMutationEvidenceBinding = {
    repository_id: 'fixture/repository',
    candidate_commit: CANDIDATE.commit,
    candidate_tree: CANDIDATE.tree,
    release_unit: CANDIDATE.releaseUnit,
    release_plan_receipt_digest_sha256: 'c'.repeat(64),
    release_profile_digest_sha256: 'd'.repeat(64),
    mutation_policy_digest_sha256: canonicalSha256(policy),
    task_policy_digests_sha256: ['e'.repeat(64), 'f'.repeat(64)],
    ...options.binding,
  };
  const candidate = {
    releaseUnit: binding.release_unit,
    commit: binding.candidate_commit,
    tree: binding.candidate_tree,
  };
  const packagesUnderTest =
    options.packages ??
    PACKAGE_NAMES.map((packageName) => ({
      packageName,
      workspace: `packages/${packageName.slice('@fixture/'.length)}`,
    }));
  const expected = packagesUnderTest.map(({ packageName, workspace }) => ({
    packageName,
    workspace,
    inputProjection: {
      schemaVersion: '2.1.0',
      kind: 'mutation-input-projection-v2',
      packageName,
      workspace,
      bindings: Object.fromEntries(
        [
          'source',
          'tests',
          'manifests',
          'mutationConfiguration',
          'runner',
          'roster',
          'thresholds',
          'sanitizer',
          'lockfile',
          'environment',
          'toolchain',
          'semanticRebind',
        ].map((name) => [
          name,
          {
            canonicalization: 'rfc8785-jcs-utf8',
            memberCount: 1,
            populationDigest: sha256(`${packageName}:population:${name}`),
            selectionRuleDigest: sha256(`selection:${name}`),
          },
        ]),
      ),
    },
    thresholds: { break: 60, high: 60, low: 60, scoreMin: 60, survivedMax: 50 },
    toolVersions: { stryker: '9.6.1', node: '24.20.0', vitest: '4.1.10' },
  }));
  const source = 'export const value = true;\n';
  const location = { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } };
  const packages = expected.map((entry) => ({
    packageName: entry.packageName,
    disposition: 'executed' as const,
    origin: null,
    artifacts: normalizeReleaseMutationPackageV21({
      expected: entry,
      raw_report: Buffer.from(
        JSON.stringify({
          schemaVersion: '1.0',
          projectRoot: '/trusted/candidate',
          framework: { name: 'StrykerJS', version: '9.6.1' },
          thresholds: { break: 60, high: 60, low: 60 },
          files: {
            'src/value.ts': {
              language: 'typescript',
              source,
              mutants: [
                {
                  id: '0',
                  mutatorName: 'BooleanLiteral',
                  replacement: 'false',
                  location: structuredClone(location),
                  status: 'Killed',
                },
              ],
            },
          },
          testFiles: {},
          config: {},
        }),
      ),
      execution_cwd: '/trusted/candidate',
      process: { errorAbsent: true, signal: null, status: 0 },
      source_files: [
        {
          path: 'src/value.ts',
          sha256: sha256(source),
          mutants: [
            {
              id: '0',
              mutatorName: 'BooleanLiteral',
              replacementDigest: sha256('false'),
              location: structuredClone(location),
            },
          ],
        },
      ],
      test_files: [],
      limits: {
        maximum_raw_report_bytes: 100_000,
        maximum_document_bytes: 100_000,
        maximum_files: 10,
        maximum_mutants: 100,
      },
    }),
  }));
  const finalized = await finalizeReleaseMutationArtifactsV21({
    candidate,
    releasePlanReceiptDigest: binding.release_plan_receipt_digest_sha256,
    releaseProfileDigest: binding.release_profile_digest_sha256,
    policyDigest: canonicalSha256(policy),
    summaryPath: 'mutation/summary.json',
    semanticReceiptPath: 'mutation/semantic-receipt.json',
    expected,
    packages,
    maximum_document_bytes: 100_000,
  });
  const contract = { ...finalized.contract };
  let materials = [...finalized.materials];
  if (options.notRequired) {
    contract['packages'] = [
      ...(contract['packages'] as unknown[]),
      {
        packageName: '@fixture/zero',
        workspace: 'packages/zero',
        requirement: 'not-required',
        reasonCode: 'no-mutatable-production-surface',
      },
    ];
    contract['expectedPackageCount'] = 11;
    materials.push({ disposition: 'not-required', reasonCode: 'no-mutatable-production-surface' });
  }
  const initial = await composeMutationEvidenceV21({
    contract,
    candidate,
    packages: materials,
  });
  if (options.reused) {
    const first = materials[0];
    if (first === undefined) throw new Error('fixture material missing');
    materials = [
      {
        ...first,
        disposition: 'reused',
        origin: {
          candidate,
          semanticReceiptDigest: initial.semanticReceipt['receiptDigest'],
          evidenceSetDigest: (initial.summary['aggregate'] as Record<string, unknown>)[
            'evidenceSetDigest'
          ],
        },
      },
      ...materials.slice(1),
    ];
  }
  const composed = options.reused
    ? await composeMutationEvidenceV21({ contract, candidate, packages: materials }, () => ({
        composition: initial.summary,
        semanticReceipt: initial.semanticReceipt,
      }))
    : initial;

  const objects = new Map<string, Buffer>();
  const identity = (path: string, value: Buffer): UnitMutationEvidenceObject => {
    const digest = sha256(value);
    objects.set(digest, Buffer.from(value));
    return {
      path,
      sha256: digest,
      size_bytes: value.length,
      evidence_sink_id: options.sinkId ?? 'unit-mutation-test',
      opaque_handle: `sha256:${digest}`,
    };
  };
  const rows = contract['packages'] as Array<Record<string, unknown>>;
  const members = composed.artifacts.map((artifact): UnitMutationEvidenceMember => {
    const document = JSON.parse(artifact.bytes.toString('utf8')) as Record<string, unknown>;
    const row = rows.find(
      (entry) => entry['reportPath'] === artifact.path || entry['resultPath'] === artifact.path,
    );
    return {
      ...identity(artifact.path, artifact.bytes),
      document_kind: document['kind'] as UnitMutationEvidenceMember['document_kind'],
      package_name: row === undefined ? null : String(row['packageName']),
    };
  });
  const projection: UnitMutationEvidenceProjection = {
    summary_path: String(contract['summaryPath']),
    semantic_receipt_path: String(contract['semanticReceiptPath']),
    output_contract: identity('mutation/output-contract.json', bytes(contract)),
    members: sortMembers(members),
  };
  const closure = finalizeUnitMutationEvidenceClosure(binding, projection);
  const read = vi.fn((object: UnitMutationEvidenceObject): Buffer => {
    const value = objects.get(object.sha256);
    if (value === undefined) throw new Error('fixture object missing');
    return Buffer.from(value);
  });
  return { binding, projection, closure, objects, read, contract, composed, initial };
}
