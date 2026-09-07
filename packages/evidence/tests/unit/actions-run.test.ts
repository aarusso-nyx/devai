import { expect, it } from 'vitest';
import {
  ACTIONS_FRESHNESS_JOBS,
  ACTIONS_REUSABLE_JOBS,
  aggregateActionsEvidenceRequiredCheck,
  selectActionsEvidenceJobs,
  verifyActionsRunEvidence,
  validateActionsEvidenceShadowTuple,
  evaluateActionsEvidenceWindow,
  type ActionsEvidenceWindowObservation,
  type VerifyActionsRunEvidenceInputs,
} from '../../src/local-evidence/actions-run.js';

function windowRows(count: number, hits: number): ActionsEvidenceWindowObservation[] {
  return Array.from({ length: count }, (_, index) => ({
    mergeSha: (index + 1).toString(16).padStart(40, '0'),
    disposition: index < hits ? 'promotion-hit' : 'fallback-no-evidence',
    shadowFullEquivalent: true,
    durable: true,
  }));
}

it.each([
  [0, 0, false],
  [4, 4, false],
  [5, 2, false],
  [5, 3, true],
  [6, 3, true],
  [7, 3, false],
  [8, 4, true],
] as const)(
  'requires every graduation threshold with %i merges and %i hits',
  (count, hits, qualifies) => {
    expect(evaluateActionsEvidenceWindow(windowRows(count, hits))).toMatchObject({
      qualifies,
      consecutiveMerges: count,
      promotionHits: hits,
    });
  },
);

it.each([
  ['UNKNOWN', { disposition: 'UNKNOWN' }],
  ['invalid claim', { disposition: 'invalid-claim' }],
  ['disagreement', { shadowFullEquivalent: false }],
  ['undurable', { durable: false }],
  ['mechanism defect', { mechanismDefect: true }],
] as const)(
  'resets both counters after %s and counts only the new complete window',
  (_name, change) => {
    const before = windowRows(5, 5);
    const failed: ActionsEvidenceWindowObservation = {
      mergeSha: 'a'.repeat(40),
      disposition: 'promotion-hit',
      shadowFullEquivalent: true,
      durable: true,
      ...change,
    };
    const result = evaluateActionsEvidenceWindow([...before, failed]);
    expect(result).toMatchObject({
      qualifies: false,
      consecutiveMerges: 0,
      promotionHits: 0,
      resetAfterMerge: failed.mergeSha,
    });
    const after = windowRows(5, 3).map((row, index) => ({
      ...row,
      mergeSha: (index + 20).toString(16).padStart(40, '0'),
    }));
    expect(evaluateActionsEvidenceWindow([...before, failed, ...after])).toMatchObject({
      qualifies: true,
      consecutiveMerges: 5,
      promotionHits: 3,
      resetAfterMerge: failed.mergeSha,
    });
  },
);

// Invariants: INV-DEVAI-020. Reuse must preserve current authorization and exact evidence inputs.
function fixture() {
  const tree = { algorithm: 'sha1' as const, value: 'a'.repeat(40) };
  const sourceHash = { algorithm: 'sha256' as const, value: 'b'.repeat(64), fileCount: 12 };
  const digests = {
    workflowPolicySha256: '1'.repeat(64),
    lockfileSha256: '2'.repeat(64),
    toolchainContractSha256: '3'.repeat(64),
    testContractSha256: '4'.repeat(64),
    serviceContractSha256: '5'.repeat(64),
  };
  const identity = {
    repository: 'example/adopter',
    workflowRef: 'example/adopter/.github/workflows/ci.yml@refs/pull/1/merge',
    eventName: 'pull_request' as const,
    runId: '123',
    runAttempt: 2,
    actor: 'inspector',
    headSha: 'c'.repeat(40),
    baseSha: 'd'.repeat(40),
    mergeBaseSha: 'e'.repeat(40),
    testedCommitSha: 'f'.repeat(40),
    testedTree: tree,
    digests,
  };
  const manifest = {
    schemaVersion: 1 as const,
    origin: 'actions-run' as const,
    generatedAt: '2026-09-07T00:00:00.000Z',
    expiresAt: '2026-09-08T00:00:00.000Z',
    subject: { repository: identity.repository, commitSha: identity.testedCommitSha, tree },
    sourceHash,
    policy: {
      maxAgeHours: 24,
      requiredJobs: [...ACTIONS_REUSABLE_JOBS],
      allowedPlatforms: ['linux/amd64'],
    },
    tools: {},
    platforms: ['linux/amd64'],
    jobs: Object.fromEntries(
      ACTIONS_REUSABLE_JOBS.map((job) => [
        job,
        {
          result: 'success' as const,
          metadata: { job, platform: 'linux/amd64' },
          artifactChecksum: { algorithm: 'sha256', value: '6'.repeat(64), fileCount: 1 },
        },
      ]),
    ),
    actionsRun: identity,
  };
  return {
    mode: 'gate' as const,
    gateAuthorization: {
      authorized: true,
      status: 'active' as const,
      source: 'base-parent' as const,
      reason: 'approved',
    },
    manifest,
    current: {
      ...identity,
      basePolicySatisfied: true,
      headIsMergeInput: true,
      mergedTree: tree,
      recomputedSourceHash: sourceHash,
      successfulJobs: [...ACTIONS_REUSABLE_JOBS],
    },
  };
}

function tuple() {
  const { manifest } = fixture();
  const run = manifest.actionsRun;
  return {
    manifest,
    fullResult: {
      schemaVersion: 1,
      kind: 'actions-run-full-result',
      result: 'success',
      fullCiAuthoritative: true,
      repository: run.repository,
      workflowRef: run.workflowRef,
      runId: run.runId,
      runAttempt: run.runAttempt,
      testedCommitSha: run.testedCommitSha,
      testedTree: run.testedTree,
      jobs: Object.fromEntries(ACTIONS_REUSABLE_JOBS.map((job) => [job, 'success'])),
    },
    decision: {
      schemaVersion: 1,
      kind: 'actions-evidence-shadow-decision',
      mainRunId: '456',
      mainRunAttempt: 1,
      mergedCommitSha: '7'.repeat(40),
      fullCiResult: 'success',
      executeFullCi: true,
      disposition: 'promotion-hit',
      shadowFullEquivalent: true,
      reason: 'exact tested tree',
      reusableJobs: [...ACTIONS_REUSABLE_JOBS],
      freshnessJobs: [...ACTIONS_FRESHNESS_JOBS],
    },
    mergeParents: [run.baseSha, run.headSha],
  };
}

it.each([40, 64])('accepts an exact shadow tuple with a %i-character Git identity', (length) => {
  const input = tuple();
  input.decision.mergedCommitSha = '7'.repeat(length);
  expect(validateActionsEvidenceShadowTuple(input)).toEqual({
    mergeSha: '7'.repeat(length),
    disposition: 'promotion-hit',
    shadowFullEquivalent: true,
    durable: true,
  });
});

it.each([39, 41, 48, 63, 65])('rejects a %i-character non-Git merge identity', (length) => {
  const input = tuple();
  input.decision.mergedCommitSha = '7'.repeat(length);
  expect(() => validateActionsEvidenceShadowTuple(input)).toThrow(
    'shadow decision merge SHA is invalid',
  );
});

it.each([
  ['repository', 'wrong/repository'],
  ['workflowRef', 'wrong/workflow'],
  ['runId', '999'],
  ['runAttempt', 1],
  ['testedCommitSha', '8'.repeat(40)],
  ['schemaVersion', 2],
  ['kind', 'other'],
  ['result', 'failure'],
  ['fullCiAuthoritative', false],
  ['testedTree', { algorithm: 'sha1', value: '9'.repeat(40) }],
] as const)('rejects substituted full-result %s', (field, value) => {
  const input = tuple();
  expect(() =>
    validateActionsEvidenceShadowTuple({
      ...input,
      fullResult: { ...input.fullResult, [field]: value },
    }),
  ).toThrow(/actions evidence tuple: full result/u);
});

it.each(ACTIONS_REUSABLE_JOBS)(
  'requires authoritative success for %s in the full result',
  (job) => {
    const input = tuple();
    input.fullResult.jobs = Object.fromEntries(
      Object.entries(input.fullResult.jobs).filter(([name]) => name !== job),
    );
    expect(() => validateActionsEvidenceShadowTuple(input)).toThrow(
      `full result is missing successful job ${job}`,
    );
  },
);

it.each([
  ['schemaVersion', 2],
  ['kind', 'other'],
  ['mainRunId', ''],
  ['mainRunAttempt', 0],
  ['mainRunAttempt', 1.5],
  ['fullCiResult', 'failure'],
  ['executeFullCi', false],
  ['reason', ''],
  ['disposition', 'invented'],
  ['shadowFullEquivalent', false],
  ['reusableJobs', []],
  ['freshnessJobs', []],
] as const)('rejects invalid shadow-decision %s=%s', (field, value) => {
  const input = tuple();
  expect(() =>
    validateActionsEvidenceShadowTuple({
      ...input,
      decision: { ...input.decision, [field]: value },
    }),
  ).toThrow(/actions evidence tuple:/u);
});

it.each(['reversed', 'missing', 'extra'] as const)('rejects %s merge-parent identity', (kind) => {
  const input = tuple();
  const mergeParents =
    kind === 'reversed'
      ? input.mergeParents.toReversed()
      : kind === 'missing'
        ? input.mergeParents.slice(0, 1)
        : [...input.mergeParents, '8'.repeat(40)];
  expect(() => validateActionsEvidenceShadowTuple({ ...input, mergeParents })).toThrow(
    'exact tested base and head merge inputs',
  );
});

it.each(['UNKNOWN', 'invalid-claim'])(
  'retains %s as a non-equivalent observation',
  (disposition) => {
    const input = tuple();
    expect(() =>
      validateActionsEvidenceShadowTuple({
        ...input,
        decision: { ...input.decision, disposition },
      }),
    ).toThrow('cannot claim shadow/full equivalence');
    expect(
      validateActionsEvidenceShadowTuple({
        ...input,
        decision: { ...input.decision, disposition, shadowFullEquivalent: false },
      }),
    ).toMatchObject({ disposition, shadowFullEquivalent: false, durable: true });
  },
);

it('reuses only the heavy jobs while retaining every freshness job', () => {
  const result = verifyActionsRunEvidence(fixture());
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

it('executes full CI during shadow observation even for an exact hit', () => {
  const result = verifyActionsRunEvidence({ ...fixture(), mode: 'shadow' });
  expect(result).toMatchObject({
    disposition: 'promotion-hit',
    executeFullCi: true,
    hardFailure: false,
  });
  expect(selectActionsEvidenceJobs(result)).toEqual({
    runJobs: [...ACTIONS_FRESHNESS_JOBS, ...ACTIONS_REUSABLE_JOBS],
    skippedJobs: [],
  });
});

it.each(['revoked', 'unavailable'] as const)(
  'does not promote under %s authorization',
  (status) => {
    const input = fixture();
    expect(
      verifyActionsRunEvidence({
        ...input,
        gateAuthorization: { ...input.gateAuthorization, status },
      }),
    ).toMatchObject({
      disposition: 'fallback-no-evidence',
      executeFullCi: true,
      hardFailure: false,
    });
  },
);

it.each([
  ['repository', 'other/repository'],
  ['workflowRef', 'other/workflow'],
  ['runId', '124'],
  ['runAttempt', 3],
  ['headSha', '1'.repeat(40)],
  ['mergeBaseSha', '2'.repeat(40)],
  ['headIsMergeInput', false],
] as const)('rejects substituted %s', (field, value) => {
  const input = fixture();
  const result = verifyActionsRunEvidence({
    ...input,
    current: { ...input.current, [field]: value },
  });
  expect(result).toMatchObject({
    disposition: 'invalid-claim',
    executeFullCi: true,
    hardFailure: true,
  });
});

it.each(ACTIONS_REUSABLE_JOBS)(
  'will not skip missing mandatory job %s even if the claim omits it',
  (job) => {
    const input = fixture();
    input.current.successfulJobs = input.current.successfulJobs.filter((name) => name !== job);
    input.manifest.policy.requiredJobs = input.manifest.policy.requiredJobs.filter(
      (name) => name !== job,
    );
    expect(verifyActionsRunEvidence(input)).toMatchObject({
      disposition: 'fallback-job-incomplete',
      executeFullCi: true,
    });
  },
);

it.each(['preflight', 'evidenceGate', 'freshness', 'reusable'] as const)(
  'fails the required result when %s fails',
  (field) => {
    const inputs = {
      preflight: 'success',
      evidenceGate: 'success',
      freshness: 'success',
      reusable: 'success',
      decision: verifyActionsRunEvidence(fixture()),
    } as const;
    expect(aggregateActionsEvidenceRequiredCheck({ ...inputs, [field]: 'failure' })).toBe(
      'failure',
    );
  },
);

it('accepts skipped heavy jobs only for authorized promotion, never shadow execution', () => {
  const common = {
    preflight: 'success',
    evidenceGate: 'success',
    freshness: 'success',
    reusable: 'skipped',
  } as const;
  expect(
    aggregateActionsEvidenceRequiredCheck({
      ...common,
      decision: verifyActionsRunEvidence(fixture()),
    }),
  ).toBe('success');
  expect(
    aggregateActionsEvidenceRequiredCheck({
      ...common,
      decision: verifyActionsRunEvidence({ ...fixture(), mode: 'shadow' }),
    }),
  ).toBe('failure');
});

it('refuses an authorization from a caller-selected source', () => {
  const input = fixture();
  const altered = {
    ...input,
    gateAuthorization: { ...input.gateAuthorization, source: 'candidate' },
  };
  expect(
    verifyActionsRunEvidence(altered as unknown as VerifyActionsRunEvidenceInputs),
  ).toMatchObject({ disposition: 'fallback-no-evidence', executeFullCi: true });
});

it.each([
  {
    name: 'expiry interval',
    change: (m: ReturnType<typeof fixture>['manifest']) => {
      m.expiresAt = '2026-09-08T00:00:00.001Z';
    },
  },
  {
    name: 'policy age binding',
    change: (m: ReturnType<typeof fixture>['manifest']) => {
      m.policy.maxAgeHours = 23;
    },
  },
  {
    name: 'repository binding',
    change: (m: ReturnType<typeof fixture>['manifest']) => {
      m.subject = { ...m.subject, repository: 'example/different' };
    },
  },
  {
    name: 'commit binding',
    change: (m: ReturnType<typeof fixture>['manifest']) => {
      m.subject = { ...m.subject, commitSha: '0'.repeat(40) };
    },
  },
  {
    name: 'tree binding',
    change: (m: ReturnType<typeof fixture>['manifest']) => {
      m.subject = { ...m.subject, tree: { ...m.subject.tree, value: '0'.repeat(40) } };
    },
  },
])(
  'rejects internally inconsistent manifest $name before granting reuse or durable shadow evidence',
  ({ change }) => {
    const input = fixture();
    change(input.manifest);
    expect(verifyActionsRunEvidence(input)).toMatchObject({
      disposition: 'invalid-claim',
      executeFullCi: true,
      hardFailure: true,
    });
    const observation = tuple();
    observation.manifest = input.manifest;
    expect(() => validateActionsEvidenceShadowTuple(observation)).toThrow(
      'manifest is not a valid actions-run claim',
    );
  },
);

it.each([
  { value: '0'.repeat(64), fileCount: 12 },
  { value: 'b'.repeat(64), fileCount: 13 },
])('refuses reuse when independently recomputed source hash differs: %j', (source) => {
  const input = fixture();
  input.current.recomputedSourceHash = { algorithm: 'sha256', ...source };
  const result = verifyActionsRunEvidence(input);
  expect(result.executeFullCi).toBe(true);
  expect(result.disposition).not.toBe('promotion-hit');
});

it.each(['preflight', 'evidenceGate', 'freshness'] as const)(
  'fails the required result when mandatory %s could not run',
  (field) => {
    const input = {
      preflight: 'success',
      evidenceGate: 'success',
      freshness: 'success',
      reusable: 'success',
      decision: verifyActionsRunEvidence(fixture()),
    } as const;
    expect(aggregateActionsEvidenceRequiredCheck({ ...input, [field]: 'skipped' })).toBe('failure');
  },
);

it('cannot mask an invalid evidence claim with successful CI jobs', () => {
  const input = fixture();
  input.current.headSha = '0'.repeat(40);
  const decision = verifyActionsRunEvidence(input);
  expect(decision.hardFailure).toBe(true);
  expect(
    aggregateActionsEvidenceRequiredCheck({
      preflight: 'success',
      evidenceGate: 'success',
      freshness: 'success',
      reusable: 'success',
      decision,
    }),
  ).toBe('failure');
  expect(selectActionsEvidenceJobs(decision)).toEqual({
    runJobs: [...ACTIONS_FRESHNESS_JOBS, ...ACTIONS_REUSABLE_JOBS],
    skippedJobs: [],
  });
});

it('requires and accepts actual full execution after a legitimate evidence miss', () => {
  const decision = verifyActionsRunEvidence({ ...fixture(), manifest: null });
  expect(decision).toMatchObject({
    executeFullCi: true,
    hardFailure: false,
    disposition: 'fallback-no-evidence',
  });
  const base = {
    preflight: 'success',
    evidenceGate: 'success',
    freshness: 'success',
    decision,
  } as const;
  expect(aggregateActionsEvidenceRequiredCheck({ ...base, reusable: 'success' })).toBe('success');
  expect(aggregateActionsEvidenceRequiredCheck({ ...base, reusable: 'skipped' })).toBe('failure');
  expect(selectActionsEvidenceJobs(decision)).toEqual({
    runJobs: [...ACTIONS_FRESHNESS_JOBS, ...ACTIONS_REUSABLE_JOBS],
    skippedJobs: [],
  });
});

it.each([
  ['lockfileSha256', 'fallback-lockfile-changed', 'lockfile digest changed'],
  ['toolchainContractSha256', 'fallback-toolchain-changed', 'toolchain contract digest changed'],
  ['workflowPolicySha256', 'fallback-policy-changed', 'workflow policy digest changed'],
  ['testContractSha256', 'fallback-policy-changed', 'test contract digest changed'],
  ['serviceContractSha256', 'fallback-policy-changed', 'service contract digest changed'],
] as const)(
  'requires full execution after independently changed %s',
  (field, disposition, reason) => {
    const input = fixture();
    input.current.digests = { ...input.current.digests, [field]: '0'.repeat(64) };
    expect(verifyActionsRunEvidence(input)).toEqual({
      disposition,
      reason,
      executeFullCi: true,
      hardFailure: false,
      reusableJobs: ACTIONS_REUSABLE_JOBS,
      freshnessJobs: ACTIONS_FRESHNESS_JOBS,
    });
  },
);

it.each([{ baseSha: '0'.repeat(40) }, { basePolicySatisfied: false }])(
  'requires full execution after changed base condition %j',
  (change) => {
    const input = fixture();
    expect(
      verifyActionsRunEvidence({ ...input, current: { ...input.current, ...change } }),
    ).toMatchObject({
      disposition: 'fallback-base-moved',
      executeFullCi: true,
      hardFailure: false,
    });
  },
);

it('refuses to reuse a different actual merged tree while preserving fallback rather than invalid-claim classification', () => {
  const input = fixture();
  input.current.mergedTree = { ...input.current.mergedTree, value: '0'.repeat(40) };
  expect(verifyActionsRunEvidence(input)).toMatchObject({
    disposition: 'fallback-tree-mismatch',
    reason: 'actual merged tree differs from tested tree',
    executeFullCi: true,
    hardFailure: false,
  });
});

it('honors additional jobs required by the claim without subtracting the built-in floor', () => {
  const base = fixture();
  const input = {
    ...base,
    manifest: {
      ...base.manifest,
      policy: {
        ...base.manifest.policy,
        requiredJobs: [...base.manifest.policy.requiredJobs, 'extra-verification'],
      },
    },
  };
  expect(verifyActionsRunEvidence(input)).toMatchObject({
    disposition: 'fallback-job-incomplete',
    reason: 'required heavy job is incomplete: extra-verification',
    executeFullCi: true,
  });
  expect(
    verifyActionsRunEvidence({
      ...input,
      current: {
        ...input.current,
        successfulJobs: [...input.current.successfulJobs, 'extra-verification'],
      },
    }).disposition,
  ).toBe('promotion-hit');
});
