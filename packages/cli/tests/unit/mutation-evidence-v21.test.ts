import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import { describe, expect, it, vi } from 'vitest';
import {
  composeMutationEvidenceV21,
  finalizeMutationEvidenceV21,
  validateMutationV21ActivationSnapshot,
  verifyMutationEvidenceV21,
} from '../../src/services/mutation-evidence-v21.js';
import {
  computeMutationV2Score,
  executeParameterizedMutationRoster,
  verifyMutationAssuranceV2,
} from '../../src/services/mutation-assurance-v2.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const VENDOR_ROOT = resolve(import.meta.dirname, '../../vendor/evidence-verification');
const V21 = '2.1.0';
const CANDIDATE = {
  releaseUnit: 'fixture/repository',
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
} as const;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function framedDigest(domain: string, value: unknown): string {
  const bytes = Buffer.from(canonicalJson(value));
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  return createHash('sha256')
    .update(domain)
    .update(Buffer.from([0]))
    .update(length)
    .update(bytes)
    .digest('hex');
}

function activationSnapshot() {
  const policy = JSON.parse(
    readFileSync(join(ROOT, 'law/policy/mutation-evidence-v2.json'), 'utf8'),
  ) as Record<string, unknown>;
  const manifestBytes = readFileSync(join(VENDOR_ROOT, 'provenance.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
    files: Array<{ path: string }>;
  };
  const files = manifest.files.map(({ path }) => ({
    path,
    bytes: readFileSync(join(VENDOR_ROOT, path)),
  }));
  return { policy, manifestBytes, files };
}

function exactNotRequiredContract(policyDigest: string) {
  return {
    schemaVersion: V21,
    kind: 'mutation-report-set-v2',
    expectedPackageCount: 1,
    summaryPath: 'mutation/summary.json',
    semanticReceiptPath: 'mutation/semantic-receipt.json',
    releasePlanReceiptDigest: 'c'.repeat(64),
    releaseProfileDigest: 'd'.repeat(64),
    policyDigest,
    packages: [
      {
        packageName: '@fixture/package',
        workspace: 'packages/package',
        requirement: 'not-required',
        reasonCode: 'no-mutatable-production-surface',
      },
    ],
    paths: ['mutation/summary.json', 'mutation/semantic-receipt.json'],
  } as const;
}

async function finalizedNotRequiredEvidence() {
  const snapshot = activationSnapshot();
  const contract = exactNotRequiredContract(canonicalSha256(snapshot.policy));
  const summary = await finalizeMutationEvidenceV21({
    contract,
    candidate: CANDIDATE,
    packages: [
      {
        disposition: 'not-required',
        reasonCode: 'no-mutatable-production-surface',
      },
    ],
  });
  const provenance = validateMutationV21ActivationSnapshot(snapshot);
  const summaryEntry = (summary.packages as Array<Record<string, unknown>>)[0];
  const receiptWithoutDigest = {
    schemaVersion: V21,
    kind: 'mutation-semantic-verification-receipt-v2',
    receiptId: `MSV2-${'1'.repeat(16)}`,
    candidate: CANDIDATE,
    outputContractDigest: framedDigest('devai:mutation-output-contract:v2.1', contract),
    releasePlanReceiptDigest: contract.releasePlanReceiptDigest,
    releaseProfileDigest: contract.releaseProfileDigest,
    policyDigest: contract.policyDigest,
    verifierProvenance: provenance,
    packages: [
      {
        packageName: '@fixture/package',
        disposition: 'not-required',
        compositionEntryDigest: framedDigest('devai:mutation-composition-entry:v2.1', summaryEntry),
      },
    ],
    packageResultSetDigest: framedDigest('devai:mutation-package-result-set:v2.1', []),
    evidenceSetDigest: (summary.aggregate as Record<string, unknown>).evidenceSetDigest,
    verdict: summary.verdict,
    semanticVerificationPerformed: true,
  };
  return {
    contract,
    summary,
    receipt: {
      ...receiptWithoutDigest,
      receiptDigest: framedDigest('devai:mutation-semantic-receipt:v2.1', receiptWithoutDigest),
    },
  };
}

function exactCurrentReceipt(input: {
  readonly contract: Record<string, unknown>;
  readonly summary: Record<string, unknown>;
  readonly provenance: unknown;
  readonly candidate: typeof CANDIDATE;
  readonly receiptId: string;
}) {
  const packages = input.contract.packages as Array<Record<string, unknown>>;
  const summaryPackages = input.summary.packages as Array<Record<string, unknown>>;
  const receiptWithoutDigest = {
    schemaVersion: V21,
    kind: 'mutation-semantic-verification-receipt-v2',
    receiptId: input.receiptId,
    candidate: input.candidate,
    outputContractDigest: framedDigest('devai:mutation-output-contract:v2.1', input.contract),
    releasePlanReceiptDigest: input.contract.releasePlanReceiptDigest,
    releaseProfileDigest: input.contract.releaseProfileDigest,
    policyDigest: input.contract.policyDigest,
    verifierProvenance: input.provenance,
    packages: packages.map((entry, index) => {
      const summary = summaryPackages[index] ?? {};
      const required = entry.requirement === 'required';
      return {
        packageName: entry.packageName,
        disposition: summary.disposition,
        ...(required
          ? {
              inputDigest: summary.inputDigest,
              reportDigest: summary.reportDigest,
              resultDigest: summary.resultDigest,
            }
          : {}),
        compositionEntryDigest: framedDigest('devai:mutation-composition-entry:v2.1', summary),
      };
    }),
    packageResultSetDigest: framedDigest(
      'devai:mutation-package-result-set:v2.1',
      summaryPackages
        .filter((entry) => entry.requirement === 'required')
        .map((entry) => ({ packageName: entry.packageName, resultDigest: entry.resultDigest })),
    ),
    evidenceSetDigest: (input.summary.aggregate as Record<string, unknown>).evidenceSetDigest,
    verdict: input.summary.verdict,
    semanticVerificationPerformed: true,
  };
  return {
    ...receiptWithoutDigest,
    receiptDigest: framedDigest('devai:mutation-semantic-receipt:v2.1', receiptWithoutDigest),
  };
}

async function finalizedReusedEvidence() {
  const snapshot = activationSnapshot();
  const policyDigest = canonicalSha256(snapshot.policy);
  const provenance = validateMutationV21ActivationSnapshot(snapshot);
  const thresholds = { break: 90, high: 100, low: 90, scoreMin: 90, survivedMax: 0 };
  const bindingNames = [
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
  ];
  const inputProjection = {
    schemaVersion: V21,
    kind: 'mutation-input-projection-v2',
    packageName: '@fixture/reused',
    workspace: 'packages/reused',
    bindings: Object.fromEntries(
      bindingNames.map((name) => [
        name,
        {
          canonicalization: 'rfc8785-jcs-utf8',
          memberCount: 1,
          populationDigest: sha256(Buffer.from(`population:${name}`)),
          selectionRuleDigest: sha256(Buffer.from(`selection:${name}`)),
        },
      ]),
    ),
  };
  const inputDigest = framedDigest('devai:mutation-input:v2.1', inputProjection);
  const report = {
    schemaVersion: V21,
    kind: 'mutation-normalized-stryker-report-v2',
    strykerSchemaVersion: '1',
    projectRoot: '.',
    thresholds: { break: 90, high: 100, low: 90 },
    files: {
      'src/reused.ts': {
        language: 'typescript',
        mutants: [
          {
            id: '1',
            mutatorName: 'ConditionalExpression',
            replacementDigest: sha256(Buffer.from('replacement')),
            location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
            status: 'Killed',
          },
        ],
      },
    },
    testFiles: {},
    config: {},
    framework: { name: 'StrykerJS' },
  };
  const reportDigest = sha256(Buffer.from(canonicalJson(report)));
  const statusTotals = {
    CompileError: 0,
    Ignored: 0,
    Killed: 1,
    NoCoverage: 0,
    Pending: 0,
    RuntimeError: 0,
    Survived: 0,
    Timeout: 0,
  };
  const result = {
    schemaVersion: V21,
    kind: 'mutation-package-result-v2',
    packageName: '@fixture/reused',
    workspace: 'packages/reused',
    inputProjection,
    inputDigest,
    reportDigest,
    toolVersions: { stryker: '9.6.1', sanitizer: '2.1.0' },
    process: { errorAbsent: true, signal: null, status: 0 },
    thresholds,
    statusTotals,
    targetCensus: { targetFileCount: 1, totalMutants: 1 },
    score: 100,
    complete: true,
    passed: true,
  };
  const resultDigest = sha256(Buffer.from(canonicalJson(result)));
  const root = `.devai/state/mutation/v2/store/inputs/${inputDigest}/objects`;
  const contract = {
    schemaVersion: V21,
    kind: 'mutation-report-set-v2',
    expectedPackageCount: 1,
    summaryPath: 'mutation/summary.json',
    semanticReceiptPath: 'mutation/semantic-receipt.json',
    releasePlanReceiptDigest: 'c'.repeat(64),
    releaseProfileDigest: 'd'.repeat(64),
    policyDigest,
    packages: [
      {
        packageName: '@fixture/reused',
        workspace: 'packages/reused',
        requirement: 'required',
        inputProjection,
        inputDigest,
        reportPath: `${root}/${reportDigest}.report.json`,
        resultPath: `${root}/${resultDigest}.result.json`,
        thresholds,
      },
    ],
    paths: [
      'mutation/summary.json',
      'mutation/semantic-receipt.json',
      `${root}/${reportDigest}.report.json`,
      `${root}/${resultDigest}.result.json`,
    ],
  };
  const origin = {
    candidate: CANDIDATE,
    semanticReceiptDigest: '7'.repeat(64),
    evidenceSetDigest: '6'.repeat(64),
  };
  const material = { disposition: 'reused', report, result, origin } as const;
  const initialSummary = (await finalizeMutationEvidenceV21({
    contract,
    candidate: CANDIDATE,
    packages: [material],
  })) as Record<string, unknown>;
  const originEntry = structuredClone(
    (initialSummary.packages as Array<Record<string, unknown>>)[0],
  );
  const originPackages = [originEntry];
  origin.evidenceSetDigest = framedDigest('devai:mutation-composition:v2.1', originPackages);
  const originComposition = {
    schemaVersion: V21,
    kind: 'mutation-composed-report-set-v2',
    candidate: CANDIDATE,
    complete: true,
    verdict: 'pass',
    passed: true,
    packages: originPackages,
    aggregate: {
      packageCount: 1,
      executedPackageCount: 0,
      reusedPackageCount: 1,
      notRequiredPackageCount: 0,
      score: 100,
      statusTotals,
      verdict: 'pass',
      passed: true,
      evidenceSetDigest: origin.evidenceSetDigest,
    },
  };
  const originReceipt = exactCurrentReceipt({
    contract: contract as Record<string, unknown>,
    summary: originComposition,
    provenance,
    candidate: CANDIDATE,
    receiptId: `MSV2-${'2'.repeat(16)}`,
  });
  origin.semanticReceiptDigest = originReceipt.receiptDigest;
  const summary = (await finalizeMutationEvidenceV21({
    contract,
    candidate: CANDIDATE,
    packages: [material],
  })) as Record<string, unknown>;
  const receipt = exactCurrentReceipt({
    contract: contract as Record<string, unknown>,
    summary,
    provenance,
    candidate: CANDIDATE,
    receiptId: `MSV2-${'1'.repeat(16)}`,
  });
  return {
    contract,
    summary,
    receipt,
    report,
    result,
    material,
    originComposition,
    originReceipt,
  };
}

function expectActivationRefusal(action: () => unknown): void {
  expect(action).toThrow(expect.objectContaining({ code: 'MUTATION_VENDOR_PROVENANCE_MISMATCH' }));
}

describe('source-pinned mutation evidence v2.1 activation', () => {
  it('accepts exactly the policy, raw manifest, declared 24-file population, and bytes', () => {
    const snapshot = activationSnapshot();
    const provenance = validateMutationV21ActivationSnapshot(snapshot);
    expect(provenance).toEqual({
      source: {
        repository: 'devai-verifier',
        commit: '098d090013dda34e38d1045ba06274d99bd5aec1',
        tree: '8eb8491dc43ca893399b2fc87dcfc25815c4a209',
        byteSetDigest: 'dcb9af5f43f396e4a2a1a09fcdb181ade346575cd111dd532b78269e3fdfc34e',
      },
      vendor: {
        root: 'packages/cli/vendor/evidence-verification',
        manifestPath: 'packages/cli/vendor/evidence-verification/provenance.json',
        manifestDigest: '5319ef6154ca90b0851cc2b7fbce4e16919c9f4b5326a67a452e1c52ffb7027b',
        sourceCommit: '098d090013dda34e38d1045ba06274d99bd5aec1',
        sourceTree: '8eb8491dc43ca893399b2fc87dcfc25815c4a209',
        byteSetDigest: 'dcb9af5f43f396e4a2a1a09fcdb181ade346575cd111dd532b78269e3fdfc34e',
      },
      byteEquality: true,
    });
    expect(snapshot.files).toHaveLength(24);
    expect(sha256(snapshot.manifestBytes)).toBe(provenance.vendor.manifestDigest);
  });

  it('refuses policy, manifest, membership, path, and file-byte substitutions', () => {
    const snapshot = activationSnapshot();
    const policyChanged = structuredClone(snapshot.policy) as {
      approvedSource: { commit: string };
    };
    policyChanged.approvedSource.commit = '0'.repeat(40);
    expectActivationRefusal(() =>
      validateMutationV21ActivationSnapshot({ ...snapshot, policy: policyChanged }),
    );

    const manifestChanged = Buffer.from(snapshot.manifestBytes);
    const firstManifestByte = manifestChanged[0];
    if (firstManifestByte === undefined) throw new Error('fixture manifest is empty');
    manifestChanged[0] = firstManifestByte ^ 1;
    expectActivationRefusal(() =>
      validateMutationV21ActivationSnapshot({ ...snapshot, manifestBytes: manifestChanged }),
    );

    const changedBytes = snapshot.files.map((file, index) =>
      index === 0 ? { ...file, bytes: Buffer.concat([file.bytes, Buffer.from('changed')]) } : file,
    );
    expectActivationRefusal(() =>
      validateMutationV21ActivationSnapshot({ ...snapshot, files: changedBytes }),
    );
    expectActivationRefusal(() =>
      validateMutationV21ActivationSnapshot({ ...snapshot, files: snapshot.files.slice(1) }),
    );
    expectActivationRefusal(() =>
      validateMutationV21ActivationSnapshot({
        ...snapshot,
        files: [...snapshot.files, { path: 'src/foreign.js', bytes: Buffer.from('foreign') }],
      }),
    );
    const firstFile = snapshot.files[0];
    const secondFile = snapshot.files[1];
    if (firstFile === undefined || secondFile === undefined) {
      throw new Error('fixture runtime population is incomplete');
    }
    expectActivationRefusal(() =>
      validateMutationV21ActivationSnapshot({
        ...snapshot,
        files: [...snapshot.files.slice(1), { ...firstFile, path: secondFile.path }],
      }),
    );
  });

  it('finalizes without launching mutation work and verifies only the exact current receipt provenance', async () => {
    const evidence = await finalizedNotRequiredEvidence();
    expect(evidence.summary).toMatchObject({
      complete: true,
      verdict: 'not-applicable',
      passed: false,
      aggregate: { notRequiredPackageCount: 1, executedPackageCount: 0, reusedPackageCount: 0 },
    });

    const artifacts = new Map<string, Uint8Array>([
      [evidence.contract.summaryPath, Buffer.from(canonicalJson(evidence.summary))],
      [evidence.contract.semanticReceiptPath, Buffer.from(canonicalJson(evidence.receipt))],
    ]);
    const readArtifact = vi.fn((path: string) => artifacts.get(path) ?? Buffer.alloc(0));
    await expect(
      verifyMutationEvidenceV21(evidence.contract, readArtifact, {
        releaseUnit: CANDIDATE.releaseUnit,
        candidateCommit: CANDIDATE.commit,
        candidateTree: CANDIDATE.tree,
        mutationVerificationMode: 'offline',
      }),
    ).resolves.toMatchObject({ verdict: 'not-applicable', passed: false });

    const altered = structuredClone(evidence.receipt) as {
      verifierProvenance: { vendor: { root: string } };
    };
    altered.verifierProvenance.vendor.root = 'dist/runtime/evidence-verification';
    artifacts.set(evidence.contract.semanticReceiptPath, Buffer.from(canonicalJson(altered)));
    await expect(
      verifyMutationEvidenceV21(evidence.contract, readArtifact, {
        releaseUnit: CANDIDATE.releaseUnit,
        candidateCommit: CANDIDATE.commit,
        candidateTree: CANDIDATE.tree,
        mutationVerificationMode: 'offline',
      }),
    ).rejects.toMatchObject({ code: 'MUTATION_VENDOR_PROVENANCE_MISMATCH' });
  });

  it('binds the complete active policy rather than an arbitrary task-policy digest', async () => {
    const contract = exactNotRequiredContract('0'.repeat(64));
    await expect(
      finalizeMutationEvidenceV21({
        contract,
        candidate: CANDIDATE,
        packages: [
          {
            disposition: 'not-required',
            reasonCode: 'no-mutatable-production-surface',
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'MUTATION_SEMANTIC_RECEIPT_MISMATCH' });
  });

  it('requires an exact source-pinned provenance receipt for a resolved reused origin', async () => {
    const evidence = await finalizedReusedEvidence();
    const artifacts = new Map<string, Uint8Array>([
      [evidence.contract.summaryPath, Buffer.from(canonicalJson(evidence.summary))],
      [evidence.contract.semanticReceiptPath, Buffer.from(canonicalJson(evidence.receipt))],
      [
        evidence.contract.packages[0]?.reportPath ?? '',
        Buffer.from(canonicalJson(evidence.report)),
      ],
      [
        evidence.contract.packages[0]?.resultPath ?? '',
        Buffer.from(canonicalJson(evidence.result)),
      ],
    ]);
    const resolveReuseOrigin = vi.fn(() => ({
      composition: evidence.originComposition,
      semanticReceipt: evidence.originReceipt,
    }));
    await expect(
      verifyMutationEvidenceV21(
        evidence.contract,
        (path) => artifacts.get(path) ?? Buffer.alloc(0),
        {
          releaseUnit: CANDIDATE.releaseUnit,
          candidateCommit: CANDIDATE.commit,
          candidateTree: CANDIDATE.tree,
          mutationVerificationMode: 'certify',
          resolveReuseOrigin,
        },
      ),
    ).resolves.toMatchObject({ reusedPackageCount: 1, verdict: 'pass', passed: true });
    expect(resolveReuseOrigin).toHaveBeenCalledOnce();

    const forgedOriginReceipt = structuredClone(evidence.originReceipt);
    const forgedProvenance = forgedOriginReceipt.verifierProvenance as unknown as {
      source: { commit: string };
    };
    forgedProvenance.source.commit = '0'.repeat(40);
    resolveReuseOrigin.mockReturnValue({
      composition: evidence.originComposition,
      semanticReceipt: forgedOriginReceipt,
    });
    await expect(
      verifyMutationEvidenceV21(
        evidence.contract,
        (path) => artifacts.get(path) ?? Buffer.alloc(0),
        {
          releaseUnit: CANDIDATE.releaseUnit,
          candidateCommit: CANDIDATE.commit,
          candidateTree: CANDIDATE.tree,
          mutationVerificationMode: 'certify',
          resolveReuseOrigin,
        },
      ),
    ).rejects.toMatchObject({ code: 'MUTATION_REUSE_DENIED' });
  });

  it('composes deterministic immutable artifacts, including a trusted reused origin', async () => {
    const evidence = await finalizedReusedEvidence();
    const input = {
      contract: evidence.contract,
      candidate: CANDIDATE,
      packages: [evidence.material],
    };
    const before = canonicalJson(input);
    const resolveReuseOrigin = () => ({
      composition: evidence.originComposition,
      semanticReceipt: evidence.originReceipt,
    });
    const first = await composeMutationEvidenceV21(input, resolveReuseOrigin);
    const second = await composeMutationEvidenceV21(structuredClone(input), resolveReuseOrigin);
    expect(canonicalJson(input)).toBe(before);
    expect(second.summary).toEqual(first.summary);
    expect(second.semanticReceipt).toEqual(first.semanticReceipt);
    expect(second.artifacts).toEqual(first.artifacts);
    expect(first.artifacts.map((artifact) => artifact.path)).toEqual(input.contract.paths);
    expect(first.summary).toMatchObject({ verdict: 'pass', passed: true });
    expect(first.semanticReceipt).toMatchObject({
      verifierProvenance: validateMutationV21ActivationSnapshot(activationSnapshot()),
      policyDigest: input.contract.policyDigest,
    });

    await expect(composeMutationEvidenceV21(input)).rejects.toMatchObject({
      code: 'MUTATION_REUSE_DENIED',
    });
    await expect(
      composeMutationEvidenceV21(input, () => ({
        composition: evidence.originComposition,
        semanticReceipt: { ...evidence.originReceipt, verifierProvenance: {} },
      })),
    ).rejects.toMatchObject({ code: 'MUTATION_REUSE_DENIED' });
  });

  it('keeps an all-not-required composition non-passing without a reuse resolver', async () => {
    const evidence = await finalizedNotRequiredEvidence();
    const composed = await composeMutationEvidenceV21({
      contract: evidence.contract,
      candidate: CANDIDATE,
      packages: [
        {
          disposition: 'not-required',
          reasonCode: 'no-mutatable-production-surface',
        },
      ],
    });
    expect(composed.summary).toMatchObject({ verdict: 'not-applicable', passed: false });
    expect(composed.artifacts).toHaveLength(2);
  });
});

describe('retired mutation assurance v2 callables', () => {
  it('refuses before a legacy verifier provider or roster callback can run', async () => {
    const provider = {
      readArtifact: vi.fn(),
      parseOutcomeLog: vi.fn(),
      loadThresholds: vi.fn(),
      loadReusedReport: vi.fn(),
    };
    await expect(verifyMutationAssuranceV2({}, provider)).rejects.toMatchObject({
      code: 'MUTATION_VERSION_UNSUPPORTED',
    });
    expect(provider.readArtifact).not.toHaveBeenCalled();
    expect(provider.parseOutcomeLog).not.toHaveBeenCalled();
    expect(provider.loadThresholds).not.toHaveBeenCalled();
    expect(provider.loadReusedReport).not.toHaveBeenCalled();

    const input = {
      entries: [],
      loadPrior: vi.fn(),
      verify: vi.fn(),
      execute: vi.fn(),
    };
    await expect(executeParameterizedMutationRoster(input)).rejects.toMatchObject({
      code: 'MUTATION_VERSION_UNSUPPORTED',
    });
    expect(input.loadPrior).not.toHaveBeenCalled();
    expect(input.verify).not.toHaveBeenCalled();
    expect(input.execute).not.toHaveBeenCalled();
    expect(() =>
      computeMutationV2Score({
        killed: 0,
        survived: 0,
        timeout: 0,
        no_coverage: 0,
        runtime_error: 0,
        infrastructure_error: 0,
      }),
    ).toThrow(expect.objectContaining({ code: 'MUTATION_VERSION_UNSUPPORTED' }));
  });
});
