import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

function withSemanticReceiptDigest(receipt: Record<string, unknown>): Record<string, unknown> {
  const { receiptDigest: _discarded, ...withoutDigest } = receipt;
  return {
    ...withoutDigest,
    receiptDigest: framedDigest('devai:mutation-semantic-receipt:v2.1', withoutDigest),
  };
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

function packagedActivationFiles(options: { readonly tamperVendorBytes?: boolean } = {}) {
  const snapshot = activationSnapshot();
  return [
    {
      path: 'dist/runtime/evidence-verification/provenance.json',
      mode: 0o644,
      bytes: snapshot.manifestBytes,
    },
    ...snapshot.files.map((file, index) => ({
      path: `dist/runtime/evidence-verification/${file.path}`,
      mode: 0o644,
      bytes:
        options.tamperVendorBytes === true && index === 0
          ? Buffer.concat([file.bytes, Buffer.from('\n')])
          : file.bytes,
    })),
  ];
}

function installedActivationFixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'devai-mutation-evidence-installed-'));
  const snapshot = activationSnapshot();
  const vendorRoot = join(root, 'dist/runtime/evidence-verification');
  const policyRoot = join(root, 'dist/law/policy');
  mkdirSync(vendorRoot, { recursive: true });
  mkdirSync(policyRoot, { recursive: true });
  writeFileSync(join(vendorRoot, 'provenance.json'), snapshot.manifestBytes);
  for (const file of snapshot.files) {
    const path = join(vendorRoot, file.path);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, file.bytes);
  }
  writeFileSync(
    join(policyRoot, 'mutation-evidence-v2.json'),
    Buffer.from(canonicalJson(snapshot.policy)),
  );
  return {
    root,
    modulePath: join(root, 'dist/runtime/index/mutation-evidence-v21.js'),
    policy: snapshot.policy,
  };
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
  expect(action).toThrow(
    expect.objectContaining({
      name: 'MutationActivationError',
      message: 'MUTATION_VENDOR_PROVENANCE_MISMATCH',
      code: 'MUTATION_VENDOR_PROVENANCE_MISMATCH',
    }),
  );
}

type FsModule = typeof import('node:fs');
type FsStat = ReturnType<FsModule['lstatSync']>;

function alteredStat(
  stat: FsStat,
  alteration: 'symlink' | 'not-file' | 'device' | 'inode',
): FsStat {
  return new Proxy(stat, {
    get(target, property) {
      if (property === 'isSymbolicLink' && alteration === 'symlink') return () => true;
      if (property === 'isFile' && alteration === 'not-file') return () => false;
      if (property === 'dev' && alteration === 'device') return target.dev + 1;
      if (property === 'ino' && alteration === 'inode') return target.ino + 1;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function expectProtectedFileRefusal(
  decorate: (actual: FsModule) => Record<string, unknown>,
): Promise<void> {
  const snapshot = activationSnapshot();
  const contract = exactNotRequiredContract(canonicalSha256(snapshot.policy));
  vi.resetModules();
  vi.doMock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<FsModule>();
    return { ...actual, ...decorate(actual) };
  });
  try {
    const isolated = await import('../../src/services/mutation-evidence-v21.js');
    await expect(
      isolated.finalizeMutationEvidenceV21({
        contract,
        candidate: CANDIDATE,
        packages: [{ disposition: 'not-required', reasonCode: 'no-mutatable-production-surface' }],
      }),
    ).rejects.toThrow('MUTATION_VENDOR_PROVENANCE_MISMATCH');
  } finally {
    vi.doUnmock('node:fs');
    vi.resetModules();
  }
}

describe('source-pinned mutation evidence v2.1 activation', () => {
  it('accepts exactly the policy, raw manifest, declared 26-file population, and bytes', () => {
    const snapshot = activationSnapshot();
    const provenance = validateMutationV21ActivationSnapshot(snapshot);
    expect(provenance).toEqual({
      source: {
        repository: 'devai-verifier',
        commit: '9f849f117fe1e460b5e3c647515f5ccbe783cbfb',
        tree: 'ad825591bd32fb39d1a045c492660acf90f78c38',
        byteSetDigest: '9ce3f981f51fb4fa5f628cd5d2249bf8146aa44017b06603b797589ebe6505d4',
      },
      vendor: {
        root: 'packages/cli/vendor/evidence-verification',
        manifestPath: 'packages/cli/vendor/evidence-verification/provenance.json',
        manifestDigest: 'f61cccd8a0c0c5e7020cc6055f254c1a5ab56388fc9fc220ea76b1f9dc9a196c',
        sourceCommit: '9f849f117fe1e460b5e3c647515f5ccbe783cbfb',
        sourceTree: 'ad825591bd32fb39d1a045c492660acf90f78c38',
        byteSetDigest: '9ce3f981f51fb4fa5f628cd5d2249bf8146aa44017b06603b797589ebe6505d4',
      },
      byteEquality: true,
    });
    expect(snapshot.files).toHaveLength(26);
    expect(sha256(snapshot.manifestBytes)).toBe(provenance.vendor.manifestDigest);
  });

  it('enforces schema validation before accepting an otherwise valid snapshot', async () => {
    const snapshot = activationSnapshot();
    vi.resetModules();
    vi.doMock('@devai-nyx/schemas', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@devai-nyx/schemas')>();
      return { ...actual, getValidator: () => () => false };
    });
    try {
      const isolated = await import('../../src/services/mutation-evidence-v21.js');
      expectActivationRefusal(() => isolated.validateMutationV21ActivationSnapshot(snapshot));
    } finally {
      vi.doUnmock('@devai-nyx/schemas');
      vi.resetModules();
    }
  });

  it('enforces the frozen source-only roster independently of schema validation', async () => {
    const snapshot = activationSnapshot();
    const missingSourceTest = structuredClone(snapshot.policy) as {
      activationModel: { sourceOnlyTestPaths: string[] };
    };
    missingSourceTest.activationModel.sourceOnlyTestPaths.pop();
    vi.resetModules();
    vi.doMock('@devai-nyx/schemas', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@devai-nyx/schemas')>();
      return { ...actual, getValidator: () => () => true };
    });
    try {
      const isolated = await import('../../src/services/mutation-evidence-v21.js');
      expectActivationRefusal(() =>
        isolated.validateMutationV21ActivationSnapshot({
          ...snapshot,
          policy: missingSourceTest,
        }),
      );
    } finally {
      vi.doUnmock('@devai-nyx/schemas');
      vi.resetModules();
    }
  });

  it('binds the raw manifest bytes even when alternate bytes decode identically', () => {
    const snapshot = activationSnapshot();
    expectActivationRefusal(() =>
      validateMutationV21ActivationSnapshot({
        ...snapshot,
        manifestBytes: Buffer.concat([snapshot.manifestBytes, Buffer.from('\n')]),
      }),
    );
  });

  it('refuses undeclared manifest fields independently of schema validation', async () => {
    const snapshot = activationSnapshot();
    const manifest = JSON.parse(snapshot.manifestBytes.toString('utf8')) as Record<string, unknown>;
    const manifestBytes = Buffer.from(JSON.stringify({ ...manifest, extra: true }));
    const manifestDigest = sha256(manifestBytes);
    const policy = structuredClone(snapshot.policy) as {
      activation: { provenanceProof: { vendor: { manifestDigest: string } } };
      activationModel: { semanticReceiptProvenance: { vendor: { manifestDigest: string } } };
    };
    policy.activation.provenanceProof.vendor.manifestDigest = manifestDigest;
    policy.activationModel.semanticReceiptProvenance.vendor.manifestDigest = manifestDigest;

    vi.resetModules();
    vi.doMock('@devai-nyx/schemas', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@devai-nyx/schemas')>();
      return { ...actual, getValidator: () => () => true };
    });
    try {
      const isolated = await import('../../src/services/mutation-evidence-v21.js');
      expectActivationRefusal(() =>
        isolated.validateMutationV21ActivationSnapshot({ ...snapshot, policy, manifestBytes }),
      );
    } finally {
      vi.doUnmock('@devai-nyx/schemas');
      vi.resetModules();
    }
  });

  it('binds each manifest header and population digest independently', async () => {
    const base = activationSnapshot();
    type ActivationPolicy = {
      approvedSource: { commit: string };
      activation: {
        provenanceProof: {
          sourceByteSetDigest: string;
          vendor: { manifestDigest: string; byteSetDigest: string };
        };
      };
      activationModel: {
        runtimeFileCount: number;
        semanticReceiptProvenance: {
          source: { byteSetDigest: string };
          vendor: { manifestDigest: string; byteSetDigest: string };
        };
      };
    };
    const withManifest = (change: (manifest: Record<string, unknown>) => void) => {
      const policy = structuredClone(base.policy) as ActivationPolicy;
      const manifest = JSON.parse(base.manifestBytes.toString('utf8')) as Record<string, unknown>;
      change(manifest);
      const manifestBytes = Buffer.from(JSON.stringify(manifest));
      const manifestDigest = sha256(manifestBytes);
      policy.activation.provenanceProof.vendor.manifestDigest = manifestDigest;
      policy.activationModel.semanticReceiptProvenance.vendor.manifestDigest = manifestDigest;
      return { ...base, policy, manifestBytes };
    };
    const wrongRuntimeCount = structuredClone(base.policy) as ActivationPolicy;
    wrongRuntimeCount.activationModel.runtimeFileCount -= 1;
    const wrongVendorDigest = structuredClone(base.policy) as ActivationPolicy;
    wrongVendorDigest.activation.provenanceProof.vendor.byteSetDigest = '0'.repeat(64);
    wrongVendorDigest.activationModel.semanticReceiptProvenance.vendor.byteSetDigest = '0'.repeat(
      64,
    );
    const wrongSourceDigest = structuredClone(base.policy) as ActivationPolicy;
    wrongSourceDigest.activation.provenanceProof.sourceByteSetDigest = '0'.repeat(64);
    wrongSourceDigest.activationModel.semanticReceiptProvenance.source.byteSetDigest = '0'.repeat(
      64,
    );
    const substitutions = [
      withManifest((manifest) => {
        manifest.schemaVersion = '2.0.0';
      }),
      withManifest((manifest) => {
        manifest.sourceCommit = '0'.repeat(40);
      }),
      { ...base, policy: wrongRuntimeCount },
      { ...base, policy: wrongVendorDigest },
      { ...base, policy: wrongSourceDigest },
    ];

    vi.resetModules();
    vi.doMock('@devai-nyx/schemas', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@devai-nyx/schemas')>();
      return { ...actual, getValidator: () => () => true };
    });
    try {
      const isolated = await import('../../src/services/mutation-evidence-v21.js');
      for (const substitution of substitutions) {
        expectActivationRefusal(() => isolated.validateMutationV21ActivationSnapshot(substitution));
      }
    } finally {
      vi.doUnmock('@devai-nyx/schemas');
      vi.resetModules();
    }
  });

  it('binds manifest and supplied-file path populations before accepting file bytes', async () => {
    const base = activationSnapshot();
    type ManifestFile = { path: string; sha256: string; [key: string]: unknown };
    type ActivationPolicy = {
      activation: {
        provenanceProof: {
          sourceByteSetDigest: string;
          vendor: { manifestDigest: string; byteSetDigest: string };
        };
      };
      activationModel: {
        semanticReceiptProvenance: {
          source: { byteSetDigest: string };
          vendor: { manifestDigest: string; byteSetDigest: string };
        };
      };
    };
    const withManifestFiles = (
      change: (files: ManifestFile[]) => ManifestFile[],
      suppliedFiles = base.files,
    ) => {
      const policy = structuredClone(base.policy) as ActivationPolicy;
      const manifest = JSON.parse(base.manifestBytes.toString('utf8')) as {
        files: ManifestFile[];
      } & Record<string, unknown>;
      manifest.files = change(manifest.files);
      const manifestBytes = Buffer.from(JSON.stringify(manifest));
      const manifestDigest = sha256(manifestBytes);
      const byteSetDigest = canonicalSha256(manifest.files);
      policy.activation.provenanceProof.vendor.manifestDigest = manifestDigest;
      policy.activation.provenanceProof.vendor.byteSetDigest = byteSetDigest;
      policy.activation.provenanceProof.sourceByteSetDigest = byteSetDigest;
      policy.activationModel.semanticReceiptProvenance.vendor.manifestDigest = manifestDigest;
      policy.activationModel.semanticReceiptProvenance.vendor.byteSetDigest = byteSetDigest;
      policy.activationModel.semanticReceiptProvenance.source.byteSetDigest = byteSetDigest;
      return { ...base, policy, manifestBytes, files: suppliedFiles };
    };
    const firstSuppliedFile = base.files[0];
    if (firstSuppliedFile === undefined) throw new Error('fixture runtime population is empty');
    const duplicateManifestFiles = base.files.map((file, index) =>
      index === 1 ? { ...firstSuppliedFile } : file,
    );
    const duplicatePopulation = withManifestFiles((files) => {
      const firstManifestFile = files[0];
      if (firstManifestFile === undefined) throw new Error('fixture manifest is empty');
      return files.map((file, index) => (index === 1 ? { ...firstManifestFile } : file));
    }, duplicateManifestFiles);
    const unsortedManifest = withManifestFiles((files) => [...files].reverse());
    const extraSuppliedFile = {
      ...base,
      files: [...base.files, { ...firstSuppliedFile }],
    };
    const extraManifestKey = withManifestFiles((files) =>
      files.map((file, index) => (index === 0 ? { ...file, extra: true } : file)),
    );
    const withChangedPath = (path: string) => {
      const suppliedFiles = base.files
        .map((file, index) => (index === 0 ? { ...file, path } : file))
        .sort((left, right) => left.path.localeCompare(right.path));
      return withManifestFiles(
        (files) =>
          files
            .map((file, index) => (index === 0 ? { ...file, path } : file))
            .sort((left, right) => left.path.localeCompare(right.path)),
        suppliedFiles,
      );
    };
    const reorderedManifestKeys = withManifestFiles((files) =>
      files.map((file, index) => (index === 0 ? { sha256: file.sha256, path: file.path } : file)),
    );

    vi.resetModules();
    vi.doMock('@devai-nyx/schemas', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@devai-nyx/schemas')>();
      return { ...actual, getValidator: () => () => true };
    });
    try {
      const isolated = await import('../../src/services/mutation-evidence-v21.js');
      for (const substitution of [
        duplicatePopulation,
        unsortedManifest,
        extraSuppliedFile,
        extraManifestKey,
        withChangedPath('foreign/src/runtime.js'),
        withChangedPath('src/runtime.js/foreign'),
      ]) {
        expectActivationRefusal(() => isolated.validateMutationV21ActivationSnapshot(substitution));
      }
      expect(isolated.validateMutationV21ActivationSnapshot(reorderedManifestKeys)).toBeDefined();
      expect(
        isolated.validateMutationV21ActivationSnapshot({
          ...base,
          files: [...base.files].reverse(),
        }),
      ).toBeDefined();
    } finally {
      vi.doUnmock('@devai-nyx/schemas');
      vi.resetModules();
    }
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

  it('requires the frozen source-only roster and exact semantic-receipt wire provenance', () => {
    const snapshot = activationSnapshot();
    type ActivationPolicy = {
      activationModel: {
        sourceOnlyTestPaths: string[];
        semanticReceiptRepositoryBinding: { wireRepository: string };
        semanticReceiptProvenance: { source: { repository: string }; byteEquality: boolean };
      };
    };

    const missingSourceTest = structuredClone(snapshot.policy) as ActivationPolicy;
    missingSourceTest.activationModel.sourceOnlyTestPaths.pop();
    expectActivationRefusal(() =>
      validateMutationV21ActivationSnapshot({ ...snapshot, policy: missingSourceTest }),
    );

    const alternateWire = structuredClone(snapshot.policy) as ActivationPolicy;
    alternateWire.activationModel.semanticReceiptRepositoryBinding.wireRepository =
      'devai-nyx/devai-verifier';
    expectActivationRefusal(() =>
      validateMutationV21ActivationSnapshot({ ...snapshot, policy: alternateWire }),
    );

    const alternateReceiptProvenance = structuredClone(snapshot.policy) as ActivationPolicy;
    alternateReceiptProvenance.activationModel.semanticReceiptProvenance.source.repository =
      'devai-nyx/devai-verifier';
    expectActivationRefusal(() =>
      validateMutationV21ActivationSnapshot({
        ...snapshot,
        policy: alternateReceiptProvenance,
      }),
    );

    const unequalReceiptProvenance = structuredClone(snapshot.policy) as ActivationPolicy;
    unequalReceiptProvenance.activationModel.semanticReceiptProvenance.byteEquality = false;
    expectActivationRefusal(() =>
      validateMutationV21ActivationSnapshot({
        ...snapshot,
        policy: unequalReceiptProvenance,
      }),
    );
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, Object.create({ inherited: true })])(
    'refuses non-JSON canonicalizer input %p',
    async (value) => {
      const canonical = (await import(
        new URL('../../vendor/evidence-verification/src/canonical-json.js', import.meta.url).href
      )) as { canonicalize: (input: unknown) => string };
      expect(() => canonical.canonicalize(value)).toThrow(
        expect.objectContaining({ code: 'NON_CANONICAL_JSON' }),
      );
    },
  );

  it('refuses before opening verifier files when the platform lacks O_NOFOLLOW', async () => {
    const snapshot = activationSnapshot();
    const contract = exactNotRequiredContract(canonicalSha256(snapshot.policy));
    const opened = vi.fn();
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        constants: { ...actual.constants, O_NOFOLLOW: undefined },
        openSync: opened,
      };
    });
    try {
      const isolated = await import('../../src/services/mutation-evidence-v21.js');
      await expect(
        isolated.finalizeMutationEvidenceV21({
          contract,
          candidate: CANDIDATE,
          packages: [
            { disposition: 'not-required', reasonCode: 'no-mutatable-production-surface' },
          ],
        }),
      ).rejects.toThrow('MUTATION_VENDOR_PROVENANCE_MISMATCH');
      expect(opened).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  it('refuses a symbolic-link ancestor before opening protected verifier bytes', async () => {
    const vendorRoot = join(ROOT, 'packages/cli/vendor/evidence-verification');
    const opened = vi.fn();
    await expectProtectedFileRefusal((actual) => ({
      lstatSync: (path: Parameters<FsModule['lstatSync']>[0]) => {
        const stat = actual.lstatSync(path);
        return String(path) === vendorRoot ? alteredStat(stat, 'symlink') : stat;
      },
      openSync: opened,
    }));
    expect(opened).not.toHaveBeenCalled();
  });

  it.each([
    ['symbolic-link', 'isSymbolicLink'],
    ['non-regular-file', 'isFile'],
  ] as const)('refuses a %s entry in the protected verifier tree', async (_label, property) => {
    const vendorRoot = join(ROOT, 'packages/cli/vendor/evidence-verification');
    let altered = false;
    await expectProtectedFileRefusal((actual) => ({
      readdirSync: (
        path: Parameters<FsModule['readdirSync']>[0],
        options?: { readonly withFileTypes?: boolean },
      ) =>
        options?.withFileTypes === true
          ? actual.readdirSync(path, { withFileTypes: true }).map((entry) => {
              if (altered || !String(path).startsWith(vendorRoot) || !entry.isFile()) return entry;
              altered = true;
              return new Proxy(entry, {
                get(target, key) {
                  if (key === property) return () => property === 'isSymbolicLink';
                  const value = Reflect.get(target, key, target) as unknown;
                  return typeof value === 'function' ? value.bind(target) : value;
                },
              });
            })
          : actual.readdirSync(path),
    }));
    expect(altered).toBe(true);
  });

  it('refuses every ancestor identity change observed after reading protected bytes', async () => {
    const policyPath = join(ROOT, 'law/policy/mutation-evidence-v2.json');
    for (const alteration of ['symlink', 'device', 'inode'] as const) {
      let policyStats = 0;
      await expectProtectedFileRefusal((actual) => ({
        lstatSync: (path: Parameters<FsModule['lstatSync']>[0]) => {
          const stat = actual.lstatSync(path);
          if (String(path) !== policyPath) return stat;
          policyStats += 1;
          return policyStats === 5 ? alteredStat(stat, alteration) : stat;
        },
      }));
    }
  });

  it('refuses a protected path that is not a regular file before opening it', async () => {
    const policyPath = join(ROOT, 'law/policy/mutation-evidence-v2.json');
    let policyStats = 0;
    await expectProtectedFileRefusal((actual) => ({
      lstatSync: (path: Parameters<FsModule['lstatSync']>[0]) => {
        const stat = actual.lstatSync(path);
        if (String(path) !== policyPath) return stat;
        policyStats += 1;
        return policyStats === 2 ? alteredStat(stat, 'not-file') : stat;
      },
    }));
  });

  it('refuses every opened-descriptor identity mismatch', async () => {
    const policyPath = join(ROOT, 'law/policy/mutation-evidence-v2.json');
    for (const alteration of ['not-file', 'device', 'inode'] as const) {
      let policyStats = 0;
      let openedStats = 0;
      await expectProtectedFileRefusal((actual) => ({
        lstatSync: (path: Parameters<FsModule['lstatSync']>[0]) => {
          const stat = actual.lstatSync(path);
          if (String(path) !== policyPath) return stat;
          policyStats += 1;
          return policyStats === 3 && alteration !== 'not-file'
            ? alteredStat(stat, alteration)
            : stat;
        },
        fstatSync: (descriptor: number) => {
          const stat = actual.fstatSync(descriptor);
          openedStats += 1;
          return openedStats === 1 ? alteredStat(stat, alteration) : stat;
        },
      }));
    }
  });

  it('refuses every protected-path identity change observed after opening', async () => {
    const policyPath = join(ROOT, 'law/policy/mutation-evidence-v2.json');
    for (const alteration of ['symlink', 'device', 'inode'] as const) {
      let policyStats = 0;
      await expectProtectedFileRefusal((actual) => ({
        lstatSync: (path: Parameters<FsModule['lstatSync']>[0]) => {
          const stat = actual.lstatSync(path);
          if (String(path) !== policyPath) return stat;
          policyStats += 1;
          return policyStats === 3 ? alteredStat(stat, alteration) : stat;
        },
      }));
    }
  });

  it('closes an opened protected descriptor when reading fails', async () => {
    const closed = vi.fn();
    await expectProtectedFileRefusal((actual) => ({
      readFileSync: (path: Parameters<FsModule['readFileSync']>[0]) => {
        if (typeof path === 'number') throw new Error('injected protected read failure');
        return actual.readFileSync(path);
      },
      closeSync: (descriptor: number) => {
        closed(descriptor);
        actual.closeSync(descriptor);
      },
    }));
    expect(closed).toHaveBeenCalledOnce();
  });

  it('loads the protected verifier independently of directory enumeration order', async () => {
    const snapshot = activationSnapshot();
    const contract = exactNotRequiredContract(canonicalSha256(snapshot.policy));
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<FsModule>();
      return {
        ...actual,
        readdirSync: ((...args: Parameters<FsModule['readdirSync']>) => {
          const entries = actual.readdirSync(...args);
          return Array.isArray(entries) ? [...entries].reverse() : entries;
        }) as FsModule['readdirSync'],
      };
    });
    try {
      const isolated = await import('../../src/services/mutation-evidence-v21.js');
      await expect(
        isolated.finalizeMutationEvidenceV21({
          contract,
          candidate: CANDIDATE,
          packages: [
            { disposition: 'not-required', reasonCode: 'no-mutatable-production-surface' },
          ],
        }),
      ).resolves.toMatchObject({ complete: true, verdict: 'not-applicable' });
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  it('refuses a changed source-only verifier test population before loading code', async () => {
    const testRoot = join(VENDOR_ROOT, 'test');
    await expectProtectedFileRefusal((actual) => ({
      readdirSync: ((...args: Parameters<FsModule['readdirSync']>) => {
        const entries = actual.readdirSync(...args);
        if (String(args[0]) !== testRoot || !Array.isArray(entries)) return entries;
        return entries.filter((entry) => entry.name !== 'verifier.test.js');
      }) as FsModule['readdirSync'],
    }));
  });

  it('rechecks source-only verifier test bytes after loading the protected graph', async () => {
    const target = join(VENDOR_ROOT, 'test/verifier.test.js');
    const descriptorPaths = new Map<number, string>();
    let targetReads = 0;
    await expectProtectedFileRefusal((actual) => ({
      openSync: (path: Parameters<FsModule['openSync']>[0], flags: number) => {
        const descriptor = actual.openSync(path, flags);
        descriptorPaths.set(descriptor, String(path));
        return descriptor;
      },
      readFileSync: (path: Parameters<FsModule['readFileSync']>[0]) => {
        const bytes = actual.readFileSync(path);
        if (typeof path !== 'number' || descriptorPaths.get(path) !== target) return bytes;
        targetReads += 1;
        return targetReads === 1 ? bytes : Buffer.concat([bytes, Buffer.from('\n')]);
      },
    }));
    expect(targetReads).toBe(2);
  });

  it('refuses a verifier directory population change observed before code loading', async () => {
    let rootReads = 0;
    await expectProtectedFileRefusal((actual) => ({
      readdirSync: ((...args: Parameters<FsModule['readdirSync']>) => {
        const entries = actual.readdirSync(...args);
        if (String(args[0]) !== VENDOR_ROOT || !Array.isArray(entries)) return entries;
        rootReads += 1;
        if (rootReads === 1) return entries;
        const file = entries.find((entry) => entry.isFile());
        if (file === undefined) throw new Error('verifier file fixture missing');
        return [
          ...entries,
          new Proxy(file, {
            get(target, property, receiver) {
              return property === 'name'
                ? 'unexpected-verifier-file.js'
                : Reflect.get(target, property, receiver);
            },
          }),
        ];
      }) as FsModule['readdirSync'],
    }));
    expect(rootReads).toBe(2);
  });

  it('keeps the verified loader namespace closed to unselected and ambient modules', async () => {
    type HookSet = {
      resolve: (
        specifier: string,
        context: { parentURL?: string },
        nextResolve: (specifier: string, context: { parentURL?: string }) => unknown,
      ) => unknown;
      load: (
        url: string,
        context: object,
        nextLoad: (url: string, context: object) => unknown,
      ) => unknown;
    };
    const snapshot = activationSnapshot();
    const contract = exactNotRequiredContract(canonicalSha256(snapshot.policy));
    const loadedUrls: string[] = [];
    const deregistered = vi.fn();
    let hooks: HookSet | undefined;
    vi.resetModules();
    vi.doMock('node:module', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:module')>();
      return {
        ...actual,
        registerHooks: (registeredHooks: HookSet) => {
          hooks = registeredHooks;
          const registration = actual.registerHooks({
            resolve: registeredHooks.resolve,
            load(url, context, nextLoad) {
              if (url.includes('/.verified-mutation-')) loadedUrls.push(url);
              const result = registeredHooks.load(url, context, nextLoad);
              if (
                url.includes('/.verified-mutation-') &&
                (result as { format?: string }).format !== 'module'
              ) {
                throw new Error('verified loader returned an invalid module format');
              }
              return result;
            },
          });
          return {
            deregister() {
              deregistered();
              registration.deregister();
            },
          };
        },
      };
    });
    try {
      const isolated = await import('../../src/services/mutation-evidence-v21.js');
      await isolated.finalizeMutationEvidenceV21({
        contract,
        candidate: CANDIDATE,
        packages: [{ disposition: 'not-required', reasonCode: 'no-mutatable-production-surface' }],
      });
      if (hooks === undefined) throw new Error('verified loader hooks were not registered');
      const loadedEntry = loadedUrls.find((url) => url.endsWith('/src/mutation-v21.js'));
      if (loadedEntry === undefined) throw new Error('verified loader entry was not observed');
      const scope = loadedEntry.slice(0, -'src/mutation-v21.js'.length);
      const insideParent = new URL('src/verify.js', scope).href;

      const outsideResolve = vi.fn(() => ({ url: 'node:fs' }));
      expect(hooks.resolve('node:fs', { parentURL: 'file:///outside.js' }, outsideResolve)).toEqual(
        {
          url: 'node:fs',
        },
      );
      expect(outsideResolve).toHaveBeenCalledOnce();

      const testFilename = fileURLToPath(new URL('test/verifier.test.js', scope));
      const unselectedResolve = vi.fn(() => ({ url: 'file:///unselected.js' }));
      expect(hooks.resolve(testFilename, {}, unselectedResolve)).toEqual({
        url: 'file:///unselected.js',
      });
      expect(unselectedResolve).toHaveBeenCalledOnce();

      expect(hooks.resolve('node:fs', { parentURL: insideParent }, vi.fn())).toEqual({
        url: new URL('offline-fs.js', scope).href,
        shortCircuit: true,
      });
      expect(hooks.resolve('node:child_process', { parentURL: insideParent }, vi.fn())).toEqual({
        url: new URL('offline-process.js', scope).href,
        shortCircuit: true,
      });
      expect(() => hooks?.resolve('ambient-package', { parentURL: insideParent }, vi.fn())).toThrow(
        'MUTATION_VENDOR_PROVENANCE_MISMATCH',
      );
      expect(() => hooks?.resolve('./missing.js', { parentURL: insideParent }, vi.fn())).toThrow(
        'MUTATION_VENDOR_PROVENANCE_MISMATCH',
      );
      expect(hooks.resolve(loadedEntry, {}, vi.fn())).toEqual({
        url: loadedEntry,
        shortCircuit: true,
      });
      const missingUrl = new URL('src/missing.js', scope).href;
      expect(() => hooks?.resolve(missingUrl, {}, vi.fn())).toThrow(
        'MUTATION_VENDOR_PROVENANCE_MISMATCH',
      );

      const outsideLoad = vi.fn(() => ({ format: 'builtin' }));
      expect(hooks.load('node:fs', {}, outsideLoad)).toEqual({ format: 'builtin' });
      expect(outsideLoad).toHaveBeenCalledOnce();
      expect(() => hooks?.load(missingUrl, {}, vi.fn())).toThrow(
        'MUTATION_VENDOR_PROVENANCE_MISMATCH',
      );
      expect(hooks.load(loadedEntry, {}, vi.fn())).toMatchObject({
        format: 'module',
        shortCircuit: true,
      });
      expect(deregistered).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock('node:module');
      vi.resetModules();
    }
  });

  it('refuses package snapshot binding after the verifier has loaded', async () => {
    const snapshot = activationSnapshot();
    const contract = exactNotRequiredContract(canonicalSha256(snapshot.policy));
    vi.resetModules();
    vi.doMock('../../src/services/release-package-snapshot.js', async (importOriginal) => {
      const actual =
        await importOriginal<typeof import('../../src/services/release-package-snapshot.js')>();
      return { ...actual, isVerifiedReleasePackageSnapshot: () => true };
    });
    try {
      const isolated = await import('../../src/services/mutation-evidence-v21.js');
      await isolated.finalizeMutationEvidenceV21({
        contract,
        candidate: CANDIDATE,
        packages: [{ disposition: 'not-required', reasonCode: 'no-mutatable-production-surface' }],
      });
      expectActivationRefusal(() => isolated.bindMutationEvidenceV21PackageSnapshot({} as never));
    } finally {
      vi.doUnmock('../../src/services/release-package-snapshot.js');
      vi.resetModules();
    }
  });

  it('uses the first verified package snapshot and refuses a second binding', async () => {
    vi.resetModules();
    const { installedPackage } = await import('../helpers/release-mutation-inputs-fixture.js');
    const snapshot = installedPackage(packagedActivationFiles(), { current: true });
    const activation = activationSnapshot();
    const contract = exactNotRequiredContract(canonicalSha256(activation.policy));
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<FsModule>();
      return {
        ...actual,
        lstatSync: () => {
          throw new Error('source installation must not be read after package binding');
        },
      };
    });
    try {
      const isolated = await import('../../src/services/mutation-evidence-v21.js');
      isolated.bindMutationEvidenceV21PackageSnapshot(snapshot);
      expectActivationRefusal(() => isolated.bindMutationEvidenceV21PackageSnapshot(snapshot));
      await expect(
        isolated.finalizeMutationEvidenceV21({
          contract,
          candidate: CANDIDATE,
          packages: [
            { disposition: 'not-required', reasonCode: 'no-mutatable-production-surface' },
          ],
        }),
      ).resolves.toMatchObject({ complete: true, verdict: 'not-applicable' });
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  it('refuses a verified package snapshot whose vendor bytes contradict its provenance', async () => {
    vi.resetModules();
    const { installedPackage } = await import('../helpers/release-mutation-inputs-fixture.js');
    const snapshot = installedPackage(packagedActivationFiles({ tamperVendorBytes: true }), {
      current: true,
    });
    const activation = activationSnapshot();
    const contract = exactNotRequiredContract(canonicalSha256(activation.policy));
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<FsModule>();
      return {
        ...actual,
        lstatSync: () => {
          throw new Error('source installation must not be read after package binding');
        },
      };
    });
    try {
      const isolated = await import('../../src/services/mutation-evidence-v21.js');
      isolated.bindMutationEvidenceV21PackageSnapshot(snapshot);
      await expect(
        isolated.finalizeMutationEvidenceV21({
          contract,
          candidate: CANDIDATE,
          packages: [
            { disposition: 'not-required', reasonCode: 'no-mutatable-production-surface' },
          ],
        }),
      ).rejects.toMatchObject({
        name: 'MutationActivationError',
        message: 'MUTATION_VENDOR_PROVENANCE_MISMATCH',
        code: 'MUTATION_VENDOR_PROVENANCE_MISMATCH',
      });
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  it('loads the verifier only from the installed runtime layout derived from its module URL', async () => {
    const fixture = installedActivationFixture();
    const contract = exactNotRequiredContract(canonicalSha256(fixture.policy));
    vi.resetModules();
    vi.doMock('node:url', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:url')>();
      return {
        ...actual,
        fileURLToPath: (url: string | URL) =>
          String(url).includes('mutation-evidence-v21')
            ? fixture.modulePath
            : actual.fileURLToPath(url),
      };
    });
    try {
      const isolated = await import('../../src/services/mutation-evidence-v21.js');
      await expect(
        isolated.finalizeMutationEvidenceV21({
          contract,
          candidate: CANDIDATE,
          packages: [
            { disposition: 'not-required', reasonCode: 'no-mutatable-production-surface' },
          ],
        }),
      ).resolves.toMatchObject({ complete: true, verdict: 'not-applicable' });
    } finally {
      vi.doUnmock('node:url');
      vi.resetModules();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    ['wrong runtime parent', 'dist/not-runtime/index'],
    ['wrong index directory', 'dist/runtime/services'],
  ])('refuses an installed verifier module under the %s', async (_label, directory) => {
    const fixture = installedActivationFixture();
    const contract = exactNotRequiredContract(canonicalSha256(fixture.policy));
    const modulePath = join(fixture.root, directory, 'mutation-evidence-v21.js');
    vi.resetModules();
    vi.doMock('node:url', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:url')>();
      return {
        ...actual,
        fileURLToPath: (url: string | URL) =>
          String(url).includes('mutation-evidence-v21') ? modulePath : actual.fileURLToPath(url),
      };
    });
    try {
      const isolated = await import('../../src/services/mutation-evidence-v21.js');
      await expect(
        isolated.finalizeMutationEvidenceV21({
          contract,
          candidate: CANDIDATE,
          packages: [
            { disposition: 'not-required', reasonCode: 'no-mutatable-production-surface' },
          ],
        }),
      ).rejects.toMatchObject({
        name: 'MutationActivationError',
        message: 'MUTATION_VENDOR_PROVENANCE_MISMATCH',
        code: 'MUTATION_VENDOR_PROVENANCE_MISMATCH',
      });
    } finally {
      vi.doUnmock('node:url');
      vi.resetModules();
      rmSync(fixture.root, { recursive: true, force: true });
    }
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
    } & Record<string, unknown>;
    altered.verifierProvenance.vendor.root = 'dist/runtime/evidence-verification';
    artifacts.set(
      evidence.contract.semanticReceiptPath,
      Buffer.from(canonicalJson(withSemanticReceiptDigest(altered))),
    );
    await expect(
      verifyMutationEvidenceV21(evidence.contract, readArtifact, {
        releaseUnit: CANDIDATE.releaseUnit,
        candidateCommit: CANDIDATE.commit,
        candidateTree: CANDIDATE.tree,
        mutationVerificationMode: 'offline',
      }),
    ).rejects.toMatchObject({ code: 'MUTATION_VENDOR_PROVENANCE_MISMATCH' });
  });

  it('enforces artifact and provenance trust before delegating to the pinned kernel', async () => {
    const evidence = await finalizedNotRequiredEvidence();
    const validArtifacts = new Map<string, Uint8Array>([
      [evidence.contract.summaryPath, Buffer.from(canonicalJson(evidence.summary))],
      [evidence.contract.semanticReceiptPath, Buffer.from(canonicalJson(evidence.receipt))],
    ]);
    const altered = structuredClone(evidence.receipt) as {
      verifierProvenance: { source: { commit: string } };
    } & Record<string, unknown>;
    altered.verifierProvenance.source.commit = '0'.repeat(40);
    const forgedReceipt = withSemanticReceiptDigest(altered);
    const safety = vi.fn(
      ({ mediaType }: { mediaType?: string }) => mediaType === 'application/json',
    );
    vi.resetModules();
    vi.doMock('node:module', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:module')>();
      const kernel = {
        validateMutationContractV21: vi.fn(),
        finalizeMutationReportSetV21: vi.fn(),
        verifyMutationReportSetV21: vi.fn(
          (
            _contract: unknown,
            read: (path: string) => unknown,
            options: { resolveReuseOrigin?: (origin: unknown) => unknown },
          ) => {
            options.resolveReuseOrigin?.({});
            read('mutation/undeclared.json');
            return { passed: true };
          },
        ),
      };
      const load = (path: string) => {
        if (path.endsWith('/src/mutation-v21.js')) return kernel;
        if (path.endsWith('/src/artifact-safety.js')) return { validateArtifactContent: safety };
        if (path.endsWith('/src/canonical-json.js'))
          return {
            canonicalize: canonicalJson,
            canonicalBytes: (value: unknown) => Buffer.from(canonicalJson(value)),
            sha256Hex: canonicalSha256,
            framedDigest,
          };
        if (path.endsWith('/src/verify.js')) return {};
        if (path.endsWith('/src/trust.js')) return {};
        throw new Error(`unexpected verified module: ${path}`);
      };
      return {
        ...actual,
        createRequire: () => load,
        registerHooks: () => ({ deregister: vi.fn() }),
      };
    });
    try {
      const isolated = await import('../../src/services/mutation-evidence-v21.js');
      const verify = (
        artifacts: ReadonlyMap<string, Uint8Array>,
        resolveReuseOrigin?: () => { semanticReceipt: unknown },
      ) =>
        isolated.verifyMutationEvidenceV21(
          evidence.contract,
          (path) => artifacts.get(path) ?? Buffer.alloc(0),
          {
            releaseUnit: CANDIDATE.releaseUnit,
            candidateCommit: CANDIDATE.commit,
            candidateTree: CANDIDATE.tree,
            mutationVerificationMode: 'offline',
            ...(resolveReuseOrigin === undefined ? {} : { resolveReuseOrigin }),
          },
        );

      const nonCanonical = new Map(validArtifacts);
      const summaryBytes = validArtifacts.get(evidence.contract.summaryPath);
      if (summaryBytes === undefined) throw new Error('summary fixture missing');
      nonCanonical.set(
        evidence.contract.summaryPath,
        Buffer.concat([summaryBytes, Buffer.from('\n')]),
      );
      await expect(verify(nonCanonical)).rejects.toMatchObject({
        message: 'NON_CANONICAL_JSON',
        code: 'NON_CANONICAL_JSON',
      });

      const forgedCurrent = new Map(validArtifacts);
      forgedCurrent.set(
        evidence.contract.semanticReceiptPath,
        Buffer.from(canonicalJson(forgedReceipt)),
      );
      await expect(verify(forgedCurrent)).rejects.toMatchObject({
        code: 'MUTATION_VENDOR_PROVENANCE_MISMATCH',
      });

      await expect(
        verify(validArtifacts, () => ({ semanticReceipt: forgedReceipt })),
      ).rejects.toMatchObject({ code: 'MUTATION_VENDOR_PROVENANCE_MISMATCH' });

      await expect(verify(validArtifacts)).rejects.toMatchObject({
        message: 'MUTATION_ROSTER_MISMATCH',
        code: 'MUTATION_ROSTER_MISMATCH',
      });
      expect(safety).toHaveBeenCalledWith(
        expect.objectContaining({ mediaType: 'application/json' }),
      );
    } finally {
      vi.doUnmock('node:module');
      vi.resetModules();
    }
  });

  it('binds finalization delegation and inspects each protected material independently', async () => {
    const policy = activationSnapshot().policy;
    const contract = exactNotRequiredContract(canonicalSha256(policy));
    const input = {
      contract,
      candidate: CANDIDATE,
      packages: [
        {
          packageName: '@fixture/package',
          disposition: 'executed',
          report: { score: 100 },
          result: { verdict: 'pass' },
        },
      ],
    };
    const summary = { complete: true, verdict: 'pass' };
    const validateMutationContractV21 = vi.fn();
    const finalizeMutationReportSetV21 = vi.fn(() => summary);
    const validateArtifactContent = vi.fn();
    vi.resetModules();
    vi.doMock('node:module', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:module')>();
      const load = (path: string) => {
        if (path.endsWith('/src/mutation-v21.js'))
          return { validateMutationContractV21, finalizeMutationReportSetV21 };
        if (path.endsWith('/src/artifact-safety.js')) return { validateArtifactContent };
        if (path.endsWith('/src/canonical-json.js'))
          return {
            canonicalize: canonicalJson,
            canonicalBytes: (value: unknown) => Buffer.from(canonicalJson(value)),
            sha256Hex: canonicalSha256,
            framedDigest,
          };
        if (path.endsWith('/src/verify.js') || path.endsWith('/src/trust.js')) return {};
        throw new Error(`unexpected verified module: ${path}`);
      };
      return {
        ...actual,
        createRequire: () => load,
        registerHooks: () => ({ deregister: vi.fn() }),
      };
    });
    try {
      const isolated = await import('../../src/services/mutation-evidence-v21.js');
      await expect(isolated.finalizeMutationEvidenceV21(input)).resolves.toEqual(summary);
      expect(validateMutationContractV21).toHaveBeenCalledWith(contract);
      expect(finalizeMutationReportSetV21).toHaveBeenCalledWith(JSON.parse(canonicalJson(input)));
      expect(validateArtifactContent.mock.calls.map(([value]) => value)).toEqual(
        [
          { contract, candidate: CANDIDATE },
          {
            packageName: '@fixture/package',
            disposition: 'executed',
          },
          { score: 100 },
          { verdict: 'pass' },
        ].map((value) => ({
          bytes: Buffer.from(canonicalJson(value)),
          path: 'mutation-finalization.json',
          mediaType: 'application/json',
        })),
      );

      await expect(isolated.finalizeMutationEvidenceV21(null)).rejects.toMatchObject({
        message: 'MUTATION_SEMANTIC_RECEIPT_MISMATCH',
        code: 'MUTATION_SEMANTIC_RECEIPT_MISMATCH',
      });
      for (const invalidContract of [
        undefined,
        null,
        1,
        { ...contract, policyDigest: '0'.repeat(64) },
      ]) {
        await expect(
          isolated.finalizeMutationEvidenceV21({ ...input, contract: invalidContract }),
        ).rejects.toMatchObject({
          message: 'MUTATION_SEMANTIC_RECEIPT_MISMATCH',
          code: 'MUTATION_SEMANTIC_RECEIPT_MISMATCH',
        });
      }
    } finally {
      vi.doUnmock('node:module');
      vi.resetModules();
    }
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

    const forgedOriginReceipt = structuredClone(evidence.originReceipt) as Record<string, unknown>;
    const forgedProvenance = forgedOriginReceipt.verifierProvenance as unknown as {
      source: { commit: string };
    };
    forgedProvenance.source.commit = '0'.repeat(40);
    resolveReuseOrigin.mockReturnValue({
      composition: evidence.originComposition,
      semanticReceipt: withSemanticReceiptDigest(forgedOriginReceipt),
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
      receiptId: `MSV2-${canonicalSha256({
        candidate: CANDIDATE,
        outputContractDigest: framedDigest('devai:mutation-output-contract:v2.1', input.contract),
        evidenceSetDigest: (first.summary.aggregate as Record<string, unknown>).evidenceSetDigest,
      }).slice(0, 16)}`,
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
      message: 'MUTATION_VERSION_UNSUPPORTED',
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
      message: 'MUTATION_VERSION_UNSUPPORTED',
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
    ).toThrow(
      expect.objectContaining({
        message: 'MUTATION_VERSION_UNSUPPORTED',
        code: 'MUTATION_VERSION_UNSUPPORTED',
      }),
    );
  });
});
