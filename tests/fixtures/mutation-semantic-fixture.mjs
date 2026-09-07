// Synthetic protocol fixtures adapted from the pinned verifier's mutation-v21-contract
// tests. These exercise real verification kernels, never installed execution acceptance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  canonicalBytes,
  sha256Hex,
} from '../../packages/cli/vendor/evidence-verification/src/canonical.js';
import { finalizeMutationReportSetV21 } from '../../packages/cli/vendor/evidence-verification/src/mutation-v21.js';
const V21_SCHEMA = '2.1.0';
const INPUT_DOMAIN = 'devai:mutation-input:v2.1';
const SEMANTIC_RECEIPT_DOMAIN = 'devai:mutation-semantic-receipt:v2.1';
const EVIDENCE_REF_DOMAIN = 'devai:mutation-evidence-ref:v2.1';
const COMPOSITION_ENTRY_DOMAIN = 'devai:mutation-composition-entry:v2.1';
const PACKAGE_RESULT_SET_DOMAIN = 'devai:mutation-package-result-set:v2.1';
const OUTPUT_CONTRACT_DOMAIN = 'devai:mutation-output-contract:v2.1';
const INPUT_BINDINGS = [
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
function framedDigest(domain, value) {
  assert.equal(typeof domain, 'string');
  assert.equal(domain.includes('\0'), false);
  const bytes = canonicalBytes(value);
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return createHash('sha256')
    .update(Buffer.from(domain, 'utf8'))
    .update(Buffer.from([0]))
    .update(length)
    .update(bytes)
    .digest('hex');
}

function zeroTotals(overrides = {}) {
  return {
    CompileError: overrides.CompileError ?? 0,
    Ignored: overrides.Ignored ?? 0,
    Killed: overrides.Killed ?? 0,
    NoCoverage: overrides.NoCoverage ?? 0,
    Pending: overrides.Pending ?? 0,
    RuntimeError: overrides.RuntimeError ?? 0,
    Survived: overrides.Survived ?? 0,
    Timeout: overrides.Timeout ?? 0,
  };
}

function aggregateMetrics(totals) {
  const detected = totals.Killed + totals.Timeout;
  const scored = detected + totals.Survived + totals.NoCoverage;
  return { score: scored === 0 ? 100 : (detected / scored) * 100 };
}

function populationBinding(seed, memberCount = 1) {
  return {
    canonicalization: 'rfc8785-jcs-utf8',
    memberCount,
    populationDigest: sha256Hex(Buffer.from(`population:${seed}`)),
    selectionRuleDigest: sha256Hex(Buffer.from(`selection:${seed}`)),
  };
}

function inputProjection(packageName, workspace, suffix = 'current') {
  return {
    schemaVersion: V21_SCHEMA,
    kind: 'mutation-input-projection-v2',
    packageName,
    workspace,
    bindings: Object.fromEntries(
      INPUT_BINDINGS.map((name) => [name, populationBinding(`${packageName}:${name}:${suffix}`)]),
    ),
  };
}

function artifactPaths(inputDigest, reportDigest, resultDigest) {
  const root = `.devai/state/mutation/v2/store/inputs/${inputDigest}/objects`;
  return {
    reportPath: `${root}/${reportDigest}.report.json`,
    resultPath: `${root}/${resultDigest}.result.json`,
  };
}

function reportFor(packageName, thresholds, statuses = ['Killed']) {
  const stem = packageName.slice(packageName.indexOf('/') + 1);
  return {
    schemaVersion: V21_SCHEMA,
    kind: 'mutation-normalized-stryker-report-v2',
    strykerSchemaVersion: '1',
    projectRoot: '.',
    thresholds: {
      break: thresholds.break,
      high: thresholds.high,
      low: thresholds.low,
    },
    files: {
      [`src/${stem}.ts`]: {
        language: 'typescript',
        mutants: statuses.map((status, index) => ({
          id: String(index),
          mutatorName: 'ConditionalExpression',
          replacementDigest: sha256Hex(Buffer.from(`replacement:${index}`)),
          location: {
            start: { line: index + 1, column: 1 },
            end: { line: index + 1, column: 2 },
          },
          status,
        })),
      },
    },
    testFiles: {},
    config: {},
    framework: { name: 'StrykerJS' },
  };
}

function evidencePackage({
  packageName,
  workspace,
  disposition,
  candidate,
  statuses = ['Killed'],
}) {
  const thresholds = {
    break: 60,
    high: 60,
    low: 60,
    scoreMin: 60,
    survivedMax: 50,
  };
  const projection = inputProjection(packageName, workspace);
  const inputDigest = framedDigest(INPUT_DOMAIN, projection);
  const report = reportFor(packageName, thresholds, statuses);
  const statusTotals = zeroTotals(
    Object.fromEntries(
      statuses.map((status) => [status, statuses.filter((item) => item === status).length]),
    ),
  );
  const score = aggregateMetrics(statusTotals).score;
  const complete = statusTotals.Pending === 0;
  const passed =
    complete &&
    statusTotals.RuntimeError === 0 &&
    score >= Math.max(thresholds.break, thresholds.scoreMin) &&
    statusTotals.Survived <= thresholds.survivedMax;
  const process = { errorAbsent: true, signal: null, status: 0 };
  const reportDigest = sha256Hex(canonicalBytes(report));
  const result = {
    schemaVersion: V21_SCHEMA,
    kind: 'mutation-package-result-v2',
    packageName,
    workspace,
    inputProjection: projection,
    inputDigest,
    reportDigest,
    toolVersions: { stryker: '9.6.1', sanitizer: '2.1.0' },
    process,
    thresholds,
    statusTotals,
    targetCensus: { targetFileCount: 1, totalMutants: statuses.length },
    score,
    complete,
    passed,
  };
  const resultDigest = sha256Hex(canonicalBytes(result));
  const paths = artifactPaths(inputDigest, reportDigest, resultDigest);
  const origin =
    disposition === 'executed'
      ? null
      : {
          candidate: {
            releaseUnit: candidate.releaseUnit,
            commit: '9'.repeat(40),
            tree: '8'.repeat(40),
          },
          semanticReceiptDigest: '7'.repeat(64),
          evidenceSetDigest: '6'.repeat(64),
        };
  const evidenceRef = {
    kind: 'mutation-package-evidence-ref-v2',
    packageName,
    workspace,
    reportPath: paths.reportPath,
    resultPath: paths.resultPath,
    reportDigest,
    resultDigest,
    inputDigest,
    provenance: disposition === 'executed' ? 'fresh' : 'reused',
    origin,
  };
  const evidenceRefDigest = framedDigest(EVIDENCE_REF_DOMAIN, evidenceRef);
  const entry = {
    packageName,
    workspace,
    requirement: 'required',
    disposition,
    verdict: passed ? 'pass' : complete ? 'fail' : 'unknown',
    passed,
    complete,
    reportPath: paths.reportPath,
    resultPath: paths.resultPath,
    reportDigest,
    resultDigest,
    inputDigest,
    evidenceRef,
    evidenceRefDigest,
    thresholds,
    statusTotals,
    targetCensus: result.targetCensus,
    score,
    origin,
  };
  const contract = {
    packageName,
    workspace,
    requirement: 'required',
    inputProjection: projection,
    inputDigest,
    reportPath: paths.reportPath,
    resultPath: paths.resultPath,
    thresholds,
  };
  return { contract, entry, report, result, candidate };
}

export function mutationSemanticFixture(statuses = ['Killed']) {
  const ids = [
    'authority',
    'cli',
    'effects-check',
    'evidence',
    'loop',
    'schemas',
    'sensors',
    'skills',
    'spec',
    'utils',
  ];
  const candidate = {
    releaseUnit: '@aarusso-nyx/devai',
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
  };
  const packages = ids.map((id) =>
    evidencePackage({
      packageName: id === 'cli' ? '@aarusso-nyx/devai' : `@devai-nyx/${id}`,
      workspace: `packages/${id}`,
      disposition: 'executed',
      candidate,
      statuses,
    }),
  );
  const contract = {
    schemaVersion: '2.1.0',
    kind: 'mutation-report-set-v2',
    expectedPackageCount: 10,
    summaryPath: 'mutation/summary.json',
    semanticReceiptPath: 'mutation/semantic-receipt.json',
    releasePlanReceiptDigest: 'c'.repeat(64),
    releaseProfileDigest: 'd'.repeat(64),
    policyDigest: 'e'.repeat(64),
    packages: packages.map((p) => p.contract),
    paths: [
      'mutation/summary.json',
      'mutation/semantic-receipt.json',
      ...packages.flatMap((p) => [p.contract.reportPath, p.contract.resultPath]),
    ],
  };
  const state = { candidate, contract, packages };
  state.summary = finalizeMutationReportSetV21({
    candidate,
    contract,
    packages: packages.map((p) => ({
      disposition: 'executed',
      origin: null,
      report: p.report,
      result: p.result,
    })),
  });
  const receiptWithoutDigest = {
    schemaVersion: V21_SCHEMA,
    kind: 'mutation-semantic-verification-receipt-v2',
    receiptId: `MSV2-${'1'.repeat(16)}`,
    candidate: state.candidate,
    outputContractDigest: framedDigest(OUTPUT_CONTRACT_DOMAIN, state.contract),
    releasePlanReceiptDigest: state.contract.releasePlanReceiptDigest,
    releaseProfileDigest: state.contract.releaseProfileDigest,
    policyDigest: state.contract.policyDigest,
    verifierProvenance: {
      source: {
        repository: 'devai-verifier',
        commit: 'fcefd0ad9b1210f5d460509f801a16fc3c4dcbd1',
        tree: 'ad06a07074428af47e2fd33ad1115efc7b1feb1e',
        byteSetDigest: '5'.repeat(64),
      },
      vendor: {
        root: 'vendor/devai-verifier',
        manifestPath: 'vendor/devai-verifier/provenance.json',
        manifestDigest: '4'.repeat(64),
        sourceCommit: 'fcefd0ad9b1210f5d460509f801a16fc3c4dcbd1',
        sourceTree: 'ad06a07074428af47e2fd33ad1115efc7b1feb1e',
        byteSetDigest: '5'.repeat(64),
      },
      byteEquality: true,
    },
    packages: state.packages.map((item) => ({
      packageName: item.entry.packageName,
      disposition: item.entry.disposition,
      ...(item.contract.requirement === 'required' && {
        inputDigest: item.entry.inputDigest,
      }),
      ...(item.contract.requirement === 'required' && {
        reportDigest: item.entry.reportDigest,
        resultDigest: item.entry.resultDigest,
      }),
      compositionEntryDigest: framedDigest(COMPOSITION_ENTRY_DOMAIN, item.entry),
    })),
    packageResultSetDigest: framedDigest(
      PACKAGE_RESULT_SET_DOMAIN,
      state.packages
        .filter((item) => item.contract.requirement === 'required')
        .map((item) => ({
          packageName: item.entry.packageName,
          resultDigest: item.entry.resultDigest,
        })),
    ),
    evidenceSetDigest: state.summary.aggregate.evidenceSetDigest,
    verdict: state.summary.verdict,
    semanticVerificationPerformed: true,
  };
  state.semanticReceipt = {
    ...receiptWithoutDigest,
    receiptDigest: framedDigest(SEMANTIC_RECEIPT_DOMAIN, receiptWithoutDigest),
  };
  const files = Object.fromEntries(
    packages.flatMap((p) => [
      [p.contract.reportPath, canonicalBytes(p.report)],
      [p.contract.resultPath, canonicalBytes(p.result)],
    ]),
  );
  files[contract.summaryPath] = canonicalBytes(state.summary);
  files[contract.semanticReceiptPath] = canonicalBytes(state.semanticReceipt);
  const plan = {
    repository: { id: 'aarusso-nyx/devai', commit: candidate.commit, tree: candidate.tree },
    release_unit: candidate.releaseUnit,
    mutation_policy_digest: contract.policyDigest,
    release_plan_receipt_digest: contract.releasePlanReceiptDigest,
    release_profile_digest: contract.releaseProfileDigest,
    packages: packages.map((p, index) => ({
      id: ids[index],
      input_digest: p.contract.inputDigest,
      expected: {
        packageName: p.contract.packageName,
        workspace: p.contract.workspace,
        inputProjection: p.contract.inputProjection,
        thresholds: p.contract.thresholds,
      },
    })),
  };
  return { contract, files, plan, provenance: state.semanticReceipt.verifierProvenance };
}

export async function mutationSemanticFixtureV22(statuses = ['Killed']) {
  const { finalizeMutationReportSetV22, buildMutationSemanticReceiptV22 } =
    await import('../../packages/cli/vendor/evidence-verification/src/mutation-v22.js');
  const state = mutationSemanticFixture(statuses);
  const contract = {
    ...state.contract,
    schemaVersion: '2.2.0',
    packages: state.contract.packages.map((entry, index) => ({
      ...entry,
      executionBinding: {
        templateId: 'mutation-template',
        templateVersion: '1.3.0',
        taskNode: `test:mutation-${index}`,
        taskPolicyDigest: sha256Hex(Buffer.from(`task-policy:${index}`)),
      },
    })),
  };
  const candidate = {
    releaseUnit: state.plan.release_unit,
    commit: state.plan.repository.commit,
    tree: state.plan.repository.tree,
  };
  const summary = finalizeMutationReportSetV22({
    contract,
    candidate,
    packages: contract.packages.map((entry) => ({
      disposition: 'executed',
      origin: null,
      report: JSON.parse(state.files[entry.reportPath]),
      result: JSON.parse(state.files[entry.resultPath]),
    })),
  });
  const receipt = buildMutationSemanticReceiptV22({
    contract,
    summary,
    receiptId: 'MSV2-1111111111111111',
    verifierProvenance: state.provenance,
  });
  state.files[contract.summaryPath] = canonicalBytes(summary);
  state.files[contract.semanticReceiptPath] = canonicalBytes(receipt);
  return {
    ...state,
    contract,
    v22: {
      expectedExecutionBindings: contract.packages.map((entry) => ({
        packageName: entry.packageName,
        ...entry.executionBinding,
      })),
      expectedOutputContract: {
        path: 'mutation/output-contract.json',
        sha256: sha256Hex(canonicalBytes(contract)),
        sizeBytes: canonicalBytes(contract).length,
      },
      finalUnitReferent: {
        repositoryId: state.plan.repository.id,
        candidate,
        releasePlanReceiptDigest: contract.releasePlanReceiptDigest,
        releaseProfileDigest: contract.releaseProfileDigest,
        policyDigest: contract.policyDigest,
        taskPolicyDigests: contract.packages
          .map((entry) => entry.executionBinding.taskPolicyDigest)
          .sort(),
        members: Object.entries(state.files)
          .map(([path, bytes]) => ({ path, sha256: sha256Hex(bytes), sizeBytes: bytes.length }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      },
    },
  };
}
