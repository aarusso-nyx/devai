import { describe, expect, it } from 'vitest';
import { getValidator } from '../../src/index.js';
import { canonicalJson, mutationReport, readJson, sha256 } from '../fixtures/governance-v15.js';

type Json = Record<string, unknown>;

const APPROVED_SOURCE = {
  repository: 'devai-nyx/devai-verifier',
  commit: '9f849f117fe1e460b5e3c647515f5ccbe783cbfb',
  tree: 'ad825591bd32fb39d1a045c492660acf90f78c38',
} as const;

const PROVENANCE_PROOF = {
  source: APPROVED_SOURCE,
  vendor: {
    root: 'packages/cli/vendor/evidence-verification',
    manifestPath: 'packages/cli/vendor/evidence-verification/provenance.json',
    manifestDigest: 'f61cccd8a0c0c5e7020cc6055f254c1a5ab56388fc9fc220ea76b1f9dc9a196c',
    sourceCommit: APPROVED_SOURCE.commit,
    sourceTree: APPROVED_SOURCE.tree,
    byteSetDigest: '9ce3f981f51fb4fa5f628cd5d2249bf8146aa44017b06603b797589ebe6505d4',
  },
  sourceByteSetDigest: '9ce3f981f51fb4fa5f628cd5d2249bf8146aa44017b06603b797589ebe6505d4',
  byteEqual: true,
} as const;

const SEMANTIC_RECEIPT_PROVENANCE = {
  source: {
    repository: 'devai-verifier',
    commit: APPROVED_SOURCE.commit,
    tree: APPROVED_SOURCE.tree,
    byteSetDigest: PROVENANCE_PROOF.sourceByteSetDigest,
  },
  vendor: PROVENANCE_PROOF.vendor,
  byteEquality: true,
} as const;

function aggregate(
  expectedPackages: readonly string[],
  reports: Readonly<Record<string, Json>>,
): 'pass' | 'fail' | 'unknown' | 'not-applicable' {
  const values: Json[] = [];
  for (const name of expectedPackages) {
    const report = reports[name];
    if (report === undefined) return 'unknown';
    values.push(report);
  }
  if (values.some((report) => report.verdict === 'fail')) return 'fail';
  if (values.some((report) => report.verdict === 'unknown')) return 'unknown';
  if (values.every((report) => report.disposition === 'not-required')) return 'not-applicable';
  return 'pass';
}

function binary64Score(results: Json): number | undefined {
  const fields = [
    'killed',
    'survived',
    'timeout',
    'no_coverage',
    'runtime_error',
    'infrastructure_error',
  ] as const;
  if (fields.some((field) => !Number.isSafeInteger(results[field]) || Number(results[field]) < 0)) {
    return undefined;
  }
  const detected = Number(results.killed) + Number(results.timeout);
  const scored = detected + Number(results.survived) + Number(results.no_coverage);
  return scored === 0 ? 100 : (detected / scored) * 100;
}

function scoreIsSemanticallyExact(report: Json): boolean {
  const results = report.results as Json;
  const recomputed = binary64Score(results);
  return (
    recomputed !== undefined &&
    !Object.is(results.score, -0) &&
    Object.is(results.score, recomputed)
  );
}

function artifactDigestsMatch(
  report: Json,
  artifactBytes: Readonly<Record<string, string>>,
): boolean {
  const execution = report.execution as Json;
  const artifacts = execution.artifacts as Json[];
  return artifacts.every((artifact) => {
    const path = artifact.path;
    if (typeof path !== 'string') return false;
    const bytes = artifactBytes[path];
    return bytes !== undefined && sha256(bytes) === artifact.sha256;
  });
}

describe('mutation assurance v2 evidence matrix', () => {
  const validate = getValidator('mutation-assurance-v2.schema.json');

  it.each([
    ['all-fresh', { core: mutationReport('executed'), cli: mutationReport('executed') }],
    ['all-reused', { core: mutationReport('reused'), cli: mutationReport('reused') }],
    [
      'mixed',
      {
        core: mutationReport('executed'),
        cli: mutationReport('reused'),
        docs: mutationReport('not-required'),
      },
    ],
  ])('accepts independently explicit %s package dispositions', (_name, reports) => {
    for (const report of Object.values(reports)) expect(validate(report)).toBe(true);
    expect(aggregate(Object.keys(reports), reports)).toBe('pass');
  });

  it('preserves failed, missing, and unknown package outcomes in the aggregate', () => {
    expect(
      aggregate(['core', 'cli'], {
        core: mutationReport('executed'),
        cli: mutationReport('failed'),
      }),
    ).toBe('fail');
    expect(aggregate(['core', 'cli'], { core: mutationReport('executed') })).toBe('unknown');
    expect(
      aggregate(['core', 'cli'], {
        core: mutationReport('executed'),
        cli: mutationReport('unknown'),
      }),
    ).toBe('unknown');
  });

  it('rejects invalid semantic metadata, corrupt digest syntax, and unknown schema versions', () => {
    const reused = mutationReport('reused');
    const reuse = reused.reuse as Json;
    const identity = reused.identity as Json;
    const source = identity.source as Json;
    for (const invalid of [
      { ...reused, reuse: { ...reuse, all_identities_match: false } },
      { ...reused, identity: { ...identity, source: { ...source, digest_sha256: 'corrupt' } } },
      { ...reused, schemaVersion: '3.0.0' },
      { ...reused, selection: { scenario_ids: [], roster_complete: false, caller_trimmed: true } },
    ]) {
      expect(validate(invalid)).toBe(false);
    }
  });

  it('distinguishes not-required from pass and refuses empty passing selections', () => {
    const notRequired = mutationReport('not-required');
    expect(notRequired).toMatchObject({ disposition: 'not-required', verdict: 'not-applicable' });
    expect(validate({ ...notRequired, verdict: 'pass' })).toBe(false);

    const executed = mutationReport('executed');
    expect(
      validate({
        ...executed,
        selection: { scenario_ids: [], roster_complete: false, caller_trimmed: false },
      }),
    ).toBe(false);
  });

  it('recomputes scores with exact ordered binary64 operations and SameValue comparison', () => {
    const report = mutationReport('executed');
    const results = report.results as Json;
    const score = binary64Score(results);
    expect(score).toBe(66.66666666666666);
    expect(Object.is(results.score, score)).toBe(true);
    expect(Object.is(-0, 0)).toBe(false);

    expect(scoreIsSemanticallyExact(report)).toBe(true);
    expect(scoreIsSemanticallyExact({ ...report, results: { ...results, score: -0 } })).toBe(false);
    expect(
      scoreIsSemanticallyExact({ ...report, results: { ...results, score: 66.66666666666667 } }),
    ).toBe(false);

    expect(binary64Score({ ...results, killed: Number.MAX_SAFE_INTEGER + 1 })).toBeUndefined();
    expect(binary64Score({ ...results, killed: -1 })).toBeUndefined();
  });

  it('requires artifact content digests and all reuse identities to match semantically', () => {
    const fresh = mutationReport('executed');
    const artifacts = ((fresh.execution as Json).artifacts as Json[]).map((entry) =>
      String(entry.path),
    );
    const artifactBytes = Object.fromEntries(artifacts.map((path) => [path, 'test']));
    expect(artifactDigestsMatch(fresh, artifactBytes)).toBe(true);

    const execution = fresh.execution as Json;
    const executionArtifacts = execution.artifacts as Json[];
    const corrupt = {
      ...fresh,
      execution: {
        ...execution,
        artifacts: [
          { ...executionArtifacts[0], sha256: 'a'.repeat(64) },
          ...executionArtifacts.slice(1),
        ],
      },
    };
    expect(validate(corrupt)).toBe(true);
    expect(artifactDigestsMatch(corrupt, artifactBytes)).toBe(false);

    const reused = mutationReport('reused');
    expect(canonicalJson(reused.identity)).toBe(canonicalJson(fresh.identity));
    expect(canonicalJson({ ...(reused.identity as Json), source: { changed: true } })).not.toBe(
      canonicalJson(fresh.identity),
    );
  });

  it('freezes every identity input that invalidates reuse', () => {
    const policy = readJson<{
      required_identity_bindings: string[];
    }>('law/policy/mutation-assurance-v2.json');
    expect(policy.required_identity_bindings).toEqual([
      'candidate',
      'source',
      'test',
      'config',
      'toolchain',
      'roster',
      'threshold',
      'sanitizer',
      'orchestration',
      'lockfile',
    ]);
  });
});

describe('source-pinned mutation v2.1 verifier activation', () => {
  const validate = getValidator('mutation-evidence-policy-v2.schema.json');
  const policy = readJson<Json>('law/policy/mutation-evidence-v2.json');

  function changed(mutator: (candidate: Json) => void): Json {
    const candidate = structuredClone(policy);
    mutator(candidate);
    return candidate;
  }

  it('accepts only the complete active source and vendor provenance proof', () => {
    expect(validate(policy), JSON.stringify(validate.errors)).toBe(true);

    const activation = policy.activation as Json;
    const proof = activation.provenanceProof as Json;
    const vendor = proof.vendor as Json;
    const activationModel = policy.activationModel as Json;
    expect(policy.status).toBe('active');
    expect(policy.approvedSource).toEqual(APPROVED_SOURCE);
    expect(proof).toEqual(PROVENANCE_PROOF);
    expect(activation).toMatchObject({ emissionPermitted: true, verificationPermitted: true });
    expect(policy.approvedSource).toEqual(proof.source);
    expect(vendor.sourceCommit).toBe((policy.approvedSource as Json).commit);
    expect(vendor.sourceTree).toBe((policy.approvedSource as Json).tree);
    expect(proof.sourceByteSetDigest).toBe(vendor.byteSetDigest);
    expect(proof.byteEqual).toBe(true);
    expect(activationModel.policyDigestRequirement).toBe(
      'before-emission-or-verification-require-output-contract-and-current-and-every-reused-producing-semantic-receipt-policyDigest-to-equal-sha256-of-rfc8785-jcs-utf8-of-the-complete-canonical-law-policy-mutation-evidence-v2-json-document-with-no-excluded-members;distinct-from-taskPolicyDigest;compute-at-runtime-and-never-store-the-actual-policy-digest-inside-this-policy',
    );
    expect(activationModel.semanticReceiptProvenance).toEqual(SEMANTIC_RECEIPT_PROVENANCE);
    expect(activationModel.sourceOnlyTestPaths).toEqual([
      'test/artifact-safety.test.js',
      'test/detached-trust.test.js',
      'test/export.test.js',
      'test/mutation-v21-contract.test.js',
      'test/mutation-v22-contract.test.js',
      'test/mutation.test.js',
      'test/policy-builder.test.js',
      'test/publish.test.js',
      'test/verifier.test.js',
    ]);
  });

  it.each([
    [
      'inactive status',
      (candidate: Json) => {
        candidate.status = 'frozen-pending-canonical-verifier';
      },
    ],
    [
      'missing approved source',
      (candidate: Json) => {
        candidate.approvedSource = null;
      },
    ],
    [
      'substituted approved source repository',
      (candidate: Json) => {
        (candidate.approvedSource as Json).repository = 'candidate-controlled/verifier';
      },
    ],
    [
      'substituted approved source commit',
      (candidate: Json) => {
        (candidate.approvedSource as Json).commit = 'a'.repeat(40);
      },
    ],
    [
      'substituted approved source tree',
      (candidate: Json) => {
        (candidate.approvedSource as Json).tree = 'b'.repeat(40);
      },
    ],
    [
      'substituted vendor manifest digest',
      (candidate: Json) => {
        const activation = candidate.activation as Json;
        const proof = activation.provenanceProof as Json;
        (proof.vendor as Json).manifestDigest = 'c'.repeat(64);
      },
    ],
    [
      'substituted vendor root',
      (candidate: Json) => {
        const activation = candidate.activation as Json;
        const proof = activation.provenanceProof as Json;
        (proof.vendor as Json).root = 'candidate/vendor';
      },
    ],
    [
      'substituted vendor manifest path',
      (candidate: Json) => {
        const activation = candidate.activation as Json;
        const proof = activation.provenanceProof as Json;
        (proof.vendor as Json).manifestPath = 'candidate/provenance.json';
      },
    ],
    [
      'substituted vendor source commit',
      (candidate: Json) => {
        const activation = candidate.activation as Json;
        const proof = activation.provenanceProof as Json;
        (proof.vendor as Json).sourceCommit = 'e'.repeat(40);
      },
    ],
    [
      'substituted vendor source tree',
      (candidate: Json) => {
        const activation = candidate.activation as Json;
        const proof = activation.provenanceProof as Json;
        (proof.vendor as Json).sourceTree = 'f'.repeat(40);
      },
    ],
    [
      'substituted vendor byte-set digest',
      (candidate: Json) => {
        const activation = candidate.activation as Json;
        const proof = activation.provenanceProof as Json;
        (proof.vendor as Json).byteSetDigest = 'd'.repeat(64);
      },
    ],
    [
      'substituted source byte-set digest',
      (candidate: Json) => {
        const activation = candidate.activation as Json;
        (activation.provenanceProof as Json).sourceByteSetDigest = '0'.repeat(64);
      },
    ],
    [
      'self-asserted byte equality',
      (candidate: Json) => {
        const activation = candidate.activation as Json;
        (activation.provenanceProof as Json).byteEqual = false;
      },
    ],
    [
      'substituted semantic receipt wire repository',
      (candidate: Json) => {
        const model = candidate.activationModel as Json;
        const provenance = model.semanticReceiptProvenance as Json;
        (provenance.source as Json).repository = 'candidate-verifier';
      },
    ],
    [
      'weakened complete-policy digest binding',
      (candidate: Json) => {
        (candidate.activationModel as Json).policyDigestRequirement = 'task-policy-digest-only';
      },
    ],
    [
      'installed vendor root emitted as semantic provenance',
      (candidate: Json) => {
        const model = candidate.activationModel as Json;
        const provenance = model.semanticReceiptProvenance as Json;
        (provenance.vendor as Json).root = 'dist/runtime/evidence-verification';
      },
    ],
    [
      'missing source-only test closure member',
      (candidate: Json) => {
        const model = candidate.activationModel as Json;
        (model.sourceOnlyTestPaths as unknown[]).pop();
      },
    ],
  ])('rejects %s', (_name, mutate) => {
    expect(validate(changed(mutate))).toBe(false);
  });
});
