import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { validators } from '@devai-nyx/schemas';
import {
  ACTIONS_FRESHNESS_JOBS,
  ACTIONS_REUSABLE_JOBS,
  aggregateActionsEvidenceRequiredCheck,
  evaluateActionsEvidenceWindow,
  selectActionsEvidenceJobs,
  validateActionsEvidenceShadowTuple,
  verifyActionsRunEvidence,
  type ActionsEvidenceWindowObservation,
  type ActionsSourceHash,
  type CurrentActionsCheckout,
  type VerifyActionsRunEvidenceInputs,
} from '../../src/local-evidence/actions-run.js';

// The canonical Actions-run claim is the published example inside the product
// contract, not a hand-written double: drift between law/schemas and this
// module's reconciliation is itself a defect these tests must surface.
const MANIFEST_SCHEMA = new URL(
  '../../../../law/schemas/local-evidence-manifest.schema.json',
  import.meta.url,
);

interface ExampleTree {
  algorithm: 'sha1' | 'sha256';
  value: string;
}

interface ExampleDigests {
  workflowPolicySha256: string;
  lockfileSha256: string;
  toolchainContractSha256: string;
  testContractSha256: string;
  serviceContractSha256: string;
}

interface ExampleRun {
  repository: string;
  workflowRef: string;
  eventName: string;
  runId: string;
  runAttempt: number;
  actor: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  testedCommitSha: string;
  testedTree: ExampleTree;
  digests: ExampleDigests;
}

interface ExampleManifest {
  schemaVersion: number;
  generatedAt: string;
  expiresAt: string;
  origin?: string;
  subject: { repository: string; commitSha: string; tree: ExampleTree };
  sourceHash: { algorithm: 'sha256'; value: string; fileCount: number };
  policy: { maxAgeHours: number; requiredJobs: string[]; allowedPlatforms: string[] };
  tools: Record<string, unknown>;
  platforms: string[];
  jobs: Record<string, unknown>;
  actionsRun?: ExampleRun;
}

const ACTIONS_RUN_MEMBERS = [
  'repository',
  'workflowRef',
  'eventName',
  'runId',
  'runAttempt',
  'actor',
  'headSha',
  'baseSha',
  'mergeBaseSha',
  'testedCommitSha',
  'testedTree',
  'digests',
] as const;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function canonicalManifest(): ExampleManifest {
  const schema = JSON.parse(readFileSync(MANIFEST_SCHEMA, 'utf8')) as {
    examples?: readonly ExampleManifest[];
  };
  const example = schema.examples?.[0];
  if (example?.actionsRun === undefined) {
    throw new Error('law/schemas no longer publishes a canonical actions-run example');
  }
  return structuredClone(example);
}

function requireRun(manifest: ExampleManifest): ExampleRun {
  const run = manifest.actionsRun;
  if (run === undefined) throw new Error('fixture lost its actions-run identity');
  return run;
}

/** A merged checkout that reproduces the claim exactly, so only the change under test differs. */
function checkoutFor(manifest: ExampleManifest): CurrentActionsCheckout {
  const run = requireRun(manifest);
  return {
    repository: run.repository,
    workflowRef: run.workflowRef,
    runId: run.runId,
    runAttempt: run.runAttempt,
    headSha: run.headSha,
    baseSha: run.baseSha,
    mergeBaseSha: run.mergeBaseSha,
    basePolicySatisfied: true,
    headIsMergeInput: true,
    mergedTree: run.testedTree,
    recomputedSourceHash: manifest.sourceHash,
    digests: run.digests,
    successfulJobs: [...ACTIONS_REUSABLE_JOBS, ...manifest.policy.requiredJobs],
  };
}

function gate(manifest: unknown, current: CurrentActionsCheckout): VerifyActionsRunEvidenceInputs {
  return {
    mode: 'gate',
    gateAuthorization: {
      authorized: true,
      status: 'active',
      source: 'base-parent',
      reason: 'graduated candidate window',
    },
    manifest,
    current,
  };
}

/** The three transported values the Auditor imports, shaped exactly as the CLI parses them. */
function transportedTuple(manifest: unknown = canonicalManifest()) {
  const run = requireRun(canonicalManifest());
  return {
    manifest,
    fullResult: {
      schemaVersion: 1,
      kind: 'actions-run-full-result',
      repository: run.repository,
      workflowRef: run.workflowRef,
      runId: run.runId,
      runAttempt: run.runAttempt,
      testedCommitSha: run.testedCommitSha,
      testedTree: { ...run.testedTree },
      result: 'success',
      fullCiAuthoritative: true,
      jobs: Object.fromEntries(ACTIONS_REUSABLE_JOBS.map((job) => [job, 'success'])),
    } as Record<string, unknown>,
    decision: {
      schemaVersion: 1,
      kind: 'actions-evidence-shadow-decision',
      mainRunId: '29632550999',
      mainRunAttempt: 1,
      mergedCommitSha: 'b'.repeat(40),
      fullCiResult: 'success',
      shadowFullEquivalent: true,
      disposition: 'promotion-hit',
      reason: 'exact tested value was promoted',
      executeFullCi: true,
      reusableJobs: [...ACTIONS_REUSABLE_JOBS],
      freshnessJobs: [...ACTIONS_FRESHNESS_JOBS],
    } as Record<string, unknown>,
    mergeParents: [run.baseSha, run.headSha],
  };
}

function windowRow(
  index: number,
  disposition: ActionsEvidenceWindowObservation['disposition'],
): ActionsEvidenceWindowObservation {
  return {
    mergeSha: (index + 1).toString(16).padStart(40, '0'),
    disposition,
    shadowFullEquivalent: true,
    durable: true,
  };
}

function windowRows(count: number, hits: number, offset = 0): ActionsEvidenceWindowObservation[] {
  return Array.from({ length: count }, (_, index) =>
    windowRow(offset + index, index < hits ? 'promotion-hit' : 'fallback-no-evidence'),
  );
}

it('promotes the canonical published Actions claim when the merged checkout reproduces it', () => {
  const manifest = canonicalManifest();
  expect(manifest.origin).toBe('actions-run');
  const result = verifyActionsRunEvidence(gate(manifest, checkoutFor(manifest)));
  expect(result).toEqual({
    disposition: 'promotion-hit',
    reason: 'exact tested value is eligible for promotion',
    executeFullCi: false,
    hardFailure: false,
    reusableJobs: ACTIONS_REUSABLE_JOBS,
    freshnessJobs: ACTIONS_FRESHNESS_JOBS,
  });
  expect(selectActionsEvidenceJobs(result)).toEqual({
    runJobs: ACTIONS_FRESHNESS_JOBS,
    skippedJobs: ACTIONS_REUSABLE_JOBS,
  });
});

it('refuses reuse when the merged checkout recomputed the source hash under another algorithm', () => {
  const manifest = canonicalManifest();
  const current = checkoutFor(manifest);
  // Same digest text and file population, different digest algorithm: the two
  // values are not comparable, so the claim cannot be promoted on their equality.
  const recomputedSourceHash = {
    ...current.recomputedSourceHash,
    algorithm: 'sha1',
  } as unknown as ActionsSourceHash;
  expect(verifyActionsRunEvidence(gate(manifest, { ...current, recomputedSourceHash }))).toEqual({
    disposition: 'fallback-tree-mismatch',
    reason: 'merged-checkout sourceHash or source file count differs from the claim',
    executeFullCi: true,
    hardFailure: false,
    reusableJobs: ACTIONS_REUSABLE_JOBS,
    freshnessJobs: ACTIONS_FRESHNESS_JOBS,
  });
});

it.each([
  [
    'a local-producer manifest carrying no Actions run',
    (manifest: ExampleManifest) => {
      manifest.origin = 'local';
      delete manifest.actionsRun;
    },
  ],
  [
    'a manifest that declares no producer at all',
    (manifest: ExampleManifest) => {
      delete manifest.origin;
      delete manifest.actionsRun;
    },
  ],
])('refuses %s as an Actions-run claim even though it is schema-valid', (_name, change) => {
  const manifest = canonicalManifest();
  const current = checkoutFor(manifest);
  change(manifest);
  expect(validators.localEvidenceManifest(manifest)).toBe(true);
  expect(verifyActionsRunEvidence(gate(manifest, current))).toMatchObject({
    disposition: 'invalid-claim',
    reason: 'Actions-run evidence manifest or schema claim is invalid',
    executeFullCi: true,
    hardFailure: true,
  });
  expect(() => validateActionsEvidenceShadowTuple(transportedTuple(manifest))).toThrow(
    'actions evidence tuple: manifest is not a valid actions-run claim',
  );
});

it.each(ACTIONS_RUN_MEMBERS)('refuses an Actions claim that omits run identity %s', (member) => {
  const manifest = canonicalManifest();
  const current = checkoutFor(manifest);
  manifest.actionsRun = Object.fromEntries(
    Object.entries(requireRun(manifest)).filter(([name]) => name !== member),
  ) as unknown as ExampleRun;
  expect(validators.localEvidenceManifest(manifest)).toBe(false);
  expect(verifyActionsRunEvidence(gate(manifest, current))).toMatchObject({
    disposition: 'invalid-claim',
    hardFailure: true,
  });
  expect(() => validateActionsEvidenceShadowTuple(transportedTuple(manifest))).toThrow(
    'manifest is not a valid actions-run claim',
  );
});

it('refuses an Actions claim whose run identity is missing entirely', () => {
  const manifest = canonicalManifest();
  const current = checkoutFor(manifest);
  delete manifest.actionsRun;
  expect(validators.localEvidenceManifest(manifest)).toBe(false);
  expect(verifyActionsRunEvidence(gate(manifest, current))).toMatchObject({
    disposition: 'invalid-claim',
    hardFailure: true,
  });
});

it.each([
  ['a numeric run id', 'runId', 29632550731],
  ['a zero-padded run id', 'runId', '029632550731'],
  ['a stringified run attempt', 'runAttempt', '1'],
  ['a fractional run attempt', 'runAttempt', 1.5],
  ['a zero run attempt', 'runAttempt', 0],
  ['an upper-case head identity', 'headSha', 'F74C617100220D0ADBFFD3281ED79B1498EDFBA7'],
  ['an abbreviated base identity', 'baseSha', '400bcf7'],
] as const)('refuses %s in the Actions run identity', (_name, member, value) => {
  const manifest = canonicalManifest();
  const current = checkoutFor(manifest);
  (requireRun(manifest) as unknown as Record<string, unknown>)[member] = value;
  expect(validators.localEvidenceManifest(manifest)).toBe(false);
  expect(verifyActionsRunEvidence(gate(manifest, current))).toMatchObject({
    disposition: 'invalid-claim',
    hardFailure: true,
  });
});

it.each([
  ['both endpoints', { generatedAt: '1998-12-31T23:59:60Z', expiresAt: '1999-01-01T23:59:60Z' }],
  ['only the generation instant', { generatedAt: '1998-12-31T23:59:60Z' }],
])(
  'refuses leap-second evidence timestamps the date-time format accepts but JavaScript Date cannot parse (%s)',
  (_name, stamps) => {
    const manifest = { ...canonicalManifest(), ...stamps };
    const current = checkoutFor(manifest);
    expect(validators.localEvidenceManifest(manifest)).toBe(true);
    expect(Number.isNaN(Date.parse(manifest.generatedAt))).toBe(true);
    expect(verifyActionsRunEvidence(gate(manifest, current))).toMatchObject({
      disposition: 'invalid-claim',
      reason: 'Actions-run evidence manifest or schema claim is invalid',
      hardFailure: true,
    });
    expect(() => validateActionsEvidenceShadowTuple(transportedTuple(manifest))).toThrow(
      'manifest is not a valid actions-run claim',
    );
  },
);

it.each([
  ['an unparsed manifest document', JSON.stringify(canonicalManifest())],
  ['an array', []],
  ['a number', 42],
  ['a boolean', true],
  // `null` is the declared absent-evidence sentinel and falls back softly; every
  // other absent-looking value is an unreadable claim and must fail closed.
  ['an undefined claim', undefined],
])('fails closed on %s rather than treating it as absent evidence', (_name, claim) => {
  const current = checkoutFor(canonicalManifest());
  expect(verifyActionsRunEvidence(gate(claim, current))).toMatchObject({
    disposition: 'invalid-claim',
    hardFailure: true,
    executeFullCi: true,
  });
  expect(verifyActionsRunEvidence(gate(null, current))).toMatchObject({
    disposition: 'fallback-no-evidence',
    hardFailure: false,
    executeFullCi: true,
  });
});

it.each([
  ['a numeric run id', 'runId', 29632550731],
  ['a stringified run attempt', 'runAttempt', '1'],
])('refuses %s transported in the authoritative full result', (_name, field, value) => {
  const input = transportedTuple();
  expect(() =>
    validateActionsEvidenceShadowTuple({
      ...input,
      fullResult: { ...input.fullResult, [field]: value },
    }),
  ).toThrow(`actions evidence tuple: full result ${field} does not match the manifest`);
});

it('validates a shadow tuple exactly as the CLI parses it from disk', () => {
  const root = mkdtempSync(join(tmpdir(), 'devai-actions-tuple-'));
  roots.push(root);
  const input = transportedTuple();
  const files = {
    'manifest.json': input.manifest,
    'full-result.json': input.fullResult,
    'decision.json': input.decision,
  };
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(root, name), `${JSON.stringify(value, null, 2)}\n`);
  }
  const read = (name: string): unknown => JSON.parse(readFileSync(join(root, name), 'utf8'));
  const transported = {
    manifest: read('manifest.json'),
    fullResult: read('full-result.json'),
    decision: read('decision.json'),
    mergeParents: input.mergeParents,
  };
  expect(validateActionsEvidenceShadowTuple(transported)).toEqual({
    mergeSha: 'b'.repeat(40),
    disposition: 'promotion-hit',
    shadowFullEquivalent: true,
    durable: true,
  });

  writeFileSync(
    join(root, 'decision.json'),
    `${JSON.stringify({ ...input.decision, mergedCommitSha: 'B'.repeat(40) }, null, 2)}\n`,
  );
  expect(() =>
    validateActionsEvidenceShadowTuple({ ...transported, decision: read('decision.json') }),
  ).toThrow('actions evidence tuple: shadow decision merge SHA is invalid');

  writeFileSync(join(root, 'manifest.json'), 'null\n');
  expect(() =>
    validateActionsEvidenceShadowTuple({ ...transported, manifest: read('manifest.json') }),
  ).toThrow('actions evidence tuple: manifest is not a valid actions-run claim');
});

it('reports no interruption for a window that has simply not grown long enough', () => {
  const result = evaluateActionsEvidenceWindow(windowRows(4, 4));
  expect(result).toEqual({
    qualifies: false,
    consecutiveMerges: 4,
    promotionHits: 4,
    reason: 'candidate window has not reached every graduation threshold',
  });
  expect(Object.hasOwn(result, 'resetAfterMerge')).toBe(false);
});

it('reports the most recent interruption, not the first, when a window is broken twice', () => {
  const first: ActionsEvidenceWindowObservation = {
    ...windowRow(90, 'promotion-hit'),
    disposition: 'UNKNOWN',
    shadowFullEquivalent: false,
  };
  const second: ActionsEvidenceWindowObservation = {
    ...windowRow(91, 'promotion-hit'),
    durable: false,
  };
  expect(
    evaluateActionsEvidenceWindow([
      ...windowRows(5, 5),
      first,
      ...windowRows(2, 2, 10),
      second,
      ...windowRows(3, 3, 20),
    ]),
  ).toEqual({
    qualifies: false,
    consecutiveMerges: 3,
    promotionHits: 3,
    resetAfterMerge: second.mergeSha,
    reason: 'undurable observation resets the candidate window',
  });
});

it('keeps a window interrupted on its final merge from carrying any earned credit forward', () => {
  const interrupted: ActionsEvidenceWindowObservation = {
    ...windowRow(80, 'promotion-hit'),
    mechanismDefect: true,
  };
  expect(evaluateActionsEvidenceWindow([...windowRows(6, 6), interrupted])).toEqual({
    qualifies: false,
    consecutiveMerges: 0,
    promotionHits: 0,
    resetAfterMerge: interrupted.mergeSha,
    reason: 'promotion mechanism defect resets the candidate window',
  });
});

it.each([
  [
    'unknown outcome',
    { disposition: 'UNKNOWN', mechanismDefect: true, durable: false, shadowFullEquivalent: false },
    'UNKNOWN observation is non-skippable and resets the candidate window',
  ],
  [
    'mechanism defect',
    { disposition: 'invalid-claim', mechanismDefect: true, durable: false },
    'promotion mechanism defect resets the candidate window',
  ],
  [
    'lost durability',
    { disposition: 'invalid-claim', durable: false, shadowFullEquivalent: false },
    'undurable observation resets the candidate window',
  ],
] as const)(
  'diagnoses the %s first when several interruption causes coincide',
  (_name, change, reason) => {
    const observation: ActionsEvidenceWindowObservation = {
      ...windowRow(70, 'promotion-hit'),
      ...change,
    };
    expect(evaluateActionsEvidenceWindow([observation])).toMatchObject({
      qualifies: false,
      resetAfterMerge: observation.mergeSha,
      reason,
    });
  },
);

it('will not excuse an interrupted heavy lane behind a soft fallback decision', () => {
  const manifest = canonicalManifest();
  const current = checkoutFor(manifest);
  const decision = verifyActionsRunEvidence(
    gate(manifest, {
      ...current,
      digests: { ...current.digests, lockfileSha256: '0'.repeat(64) },
    }),
  );
  expect(decision).toMatchObject({
    disposition: 'fallback-lockfile-changed',
    executeFullCi: true,
    hardFailure: false,
  });
  const checks = {
    preflight: 'success',
    evidenceGate: 'success',
    freshness: 'success',
    decision,
  } as const;
  expect(aggregateActionsEvidenceRequiredCheck({ ...checks, reusable: 'skipped' })).toBe('failure');
  expect(aggregateActionsEvidenceRequiredCheck({ ...checks, reusable: 'success' })).toBe('success');
  expect(selectActionsEvidenceJobs(decision)).toEqual({
    runJobs: [...ACTIONS_FRESHNESS_JOBS, ...ACTIONS_REUSABLE_JOBS],
    skippedJobs: [],
  });
});

it.each(['gate-hit', 'fallback', 'invalid'] as const)(
  'never both runs and skips the same job for a %s decision',
  (kind) => {
    const manifest = canonicalManifest();
    const current = checkoutFor(manifest);
    const decision = verifyActionsRunEvidence(
      gate(
        kind === 'invalid' ? { ...manifest, origin: 'local' } : manifest,
        kind === 'fallback' ? { ...current, basePolicySatisfied: false } : current,
      ),
    );
    const { runJobs, skippedJobs } = selectActionsEvidenceJobs(decision);
    expect(runJobs.filter((job) => skippedJobs.includes(job))).toEqual([]);
    expect([...runJobs, ...skippedJobs].toSorted()).toEqual(
      [...ACTIONS_FRESHNESS_JOBS, ...ACTIONS_REUSABLE_JOBS].toSorted(),
    );
  },
);
