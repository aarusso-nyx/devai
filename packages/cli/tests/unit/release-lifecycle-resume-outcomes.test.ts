import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@devai-nyx/utils';
import { createLifecyclePolicyFixture } from '../helpers/release-policy-resolution-fixture.js';
import {
  finalizeReleaseStateV2,
  finalizeStoreHead,
  finalizeStoreRecord,
  resumeReleaseLifecycleExecution,
  type ReleaseLifecycleRequest,
  type ReleaseLifecycleStateV2,
} from '../../src/services/release-lifecycle-execution.js';

const POLICY = createLifecyclePolicyFixture();
const PLAN = POLICY.receipt as Readonly<Record<string, unknown>>;
const REPOSITORY = PLAN['repository'] as ReleaseLifecycleRequest['repository_locator'];
const CANDIDATE = PLAN['candidate'] as ReleaseLifecycleStateV2['candidate'];
const CANDIDATE_LOCATOR = {
  commit: CANDIDATE.commit,
  tree: CANDIDATE.tree,
  release_units: [
    {
      release_unit: CANDIDATE.release_unit,
      version: CANDIDATE.version,
      package_roster: [{ package_id: '@aarusso-nyx/devai' }],
    },
  ],
} as const;
const PLAN_DERIVATION = {
  state: 'planned',
  receipt_kind: 'release-plan-receipt',
  receipt_id: PLAN['receipt_id'],
  receipt_digest_sha256: PLAN['receipt_digest_sha256'],
  verified: true,
} as const;

function object(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('fixture-object-required');
  }
  return value as Readonly<Record<string, unknown>>;
}

function identify(draft: Readonly<Record<string, unknown>>) {
  const digest = canonicalSha256(draft);
  return {
    ...draft,
    observation_id: `RLO-${digest.slice(0, 16)}`,
    observation_digest_sha256: digest,
  };
}

function expected(input: {
  readonly repository?: ReleaseLifecycleRequest['repository_locator'];
  readonly candidate?: ReleaseLifecycleStateV2['candidate'];
  readonly head?: ReleaseLifecycleStateV2 | null;
  readonly derived?: readonly Readonly<Record<string, unknown>>[];
  readonly nextAction: string | null;
  readonly nextOutcome:
    'ready' | 'awaiting-external-receipt' | 'complete' | 'blocked' | 'ambiguous';
  readonly blockedReason?: string;
  readonly blockedRequirements?: readonly string[];
  readonly reconciliationRequirements?: readonly string[];
  readonly published?: Readonly<Record<string, unknown>>;
}) {
  const head = input.head ?? null;
  return identify({
    schemaVersion: '1.1.0',
    observation_kind: 'release-lifecycle-observation',
    repository: input.repository ?? REPOSITORY,
    candidate: input.candidate ?? CANDIDATE,
    verification_kernel: {
      kernel_id: 'devai.kernel.release-lifecycle-observation.v1',
      policy_source: 'law/policy/release-lifecycle.json#/observation_kernel',
      schema_validation_alone_derives_published: false,
    },
    head:
      head === null
        ? null
        : {
            state: head.state,
            state_id: head.state_id,
            record_digest_sha256: head.record_digest_sha256,
          },
    derived_states: input.derived ?? [],
    published: input.published ?? { observed: false, receipt: null, verified_against: null },
    next_action: input.nextAction,
    next_outcome: input.nextOutcome,
    ...(input.reconciliationRequirements === undefined
      ? {}
      : { reconciliation_requirements: input.reconciliationRequirements }),
    ...(input.nextOutcome === 'blocked'
      ? {
          blocked_reason: input.blockedReason,
          blocked_requirements: input.blockedRequirements ?? [],
        }
      : {}),
    emitted_by: {
      action_id: 'release resume',
      effect: 'read',
      output_channel: 'stdout',
      persists_repository_state: false,
      appends_state_record: false,
      writes_receipt_file: false,
    },
    grants: {
      authority: false,
      publication_authority: false,
      lifecycle_transition: false,
      appends_published_state: false,
    },
    determinism: {
      deterministic: true,
      derived_from_bound_inputs_only: true,
      contains_wall_clock_time: false,
    },
  });
}

function common() {
  return {
    states: [] as readonly unknown[],
    repository: REPOSITORY,
    candidate: CANDIDATE,
    candidate_locator: CANDIDATE_LOCATOR,
    resolve_plan_input: POLICY.resolve_plan_input,
  };
}

function currentPreflightState(): ReleaseLifecycleStateV2 {
  const schema = JSON.parse(
    readFileSync(join(process.cwd(), 'law/schemas/release-lifecycle-state.schema.json'), 'utf8'),
  ) as { examples: readonly Readonly<Record<string, unknown>>[] };
  const example = object(schema.examples[0]);
  const { state_id: _id, record_digest_sha256: _digest, ...draft } = example;
  return finalizeReleaseStateV2({
    ...draft,
    repository: REPOSITORY,
    candidate: CANDIDATE,
    bound_receipts: [
      {
        kind: 'release-plan-receipt',
        receipt_id: PLAN['receipt_id'],
        receipt_digest_sha256: PLAN['receipt_digest_sha256'],
        verdict: 'pass',
      },
    ],
  } as Parameters<typeof finalizeReleaseStateV2>[0]);
}

function historicalPlan(): Readonly<Record<string, unknown>> {
  const schema = JSON.parse(
    readFileSync(join(process.cwd(), 'law/schemas/release-plan-receipt.schema.json'), 'utf8'),
  ) as { examples: readonly Readonly<Record<string, unknown>>[] };
  const receipt = schema.examples[0];
  if (receipt === undefined) throw new Error('historical-plan-fixture-missing');
  return receipt;
}

function stateSequence(): readonly ReleaseLifecycleStateV2[] {
  const first = currentPreflightState();
  const states: ReleaseLifecycleStateV2[] = [first];
  const steps = [['certified', 'release certify', 'harness-write', 'inspector']] as const;
  for (const [state, action_id, effect, role] of steps) {
    const prior = states.at(-1);
    if (prior === undefined) throw new Error('prior-state-fixture-missing');
    const { state_id: _id, record_digest_sha256: _digest, ...draft } = prior;
    states.push(
      finalizeReleaseStateV2({
        ...draft,
        state,
        action_id,
        effect,
        prior_state: {
          state: prior.state,
          state_id: prior.state_id,
          record_digest_sha256: prior.record_digest_sha256,
        },
        actor: { kind: 'human', role, declaration_source: 'cli-flag' },
        consent: {
          write: true,
          allow_publish:
            action_id === 'release evidence-publish' || action_id === 'release publish',
          experimental: false,
        },
        storage: {
          generation: prior.storage.generation + 1,
          head_before: {
            generation: prior.storage.generation,
            record_digest_sha256: prior.record_digest_sha256,
          },
        },
      } as Parameters<typeof finalizeReleaseStateV2>[0]),
    );
  }
  return states;
}

function completionFixture(state: ReleaseLifecycleStateV2) {
  const candidate = {
    commit: CANDIDATE.commit,
    tree: CANDIDATE.tree,
    release_units: [
      {
        release_unit: CANDIDATE.release_unit,
        version: CANDIDATE.version,
        packages: [{ package_id: '@aarusso-nyx/devai' }],
      },
    ],
  };
  const canonicalization = {
    json_form: 'rfc8785-jcs' as const,
    encoding: 'utf-8' as const,
    digest_algorithm: 'sha256' as const,
    projection_excludes: ['record_id', 'record_digest_sha256'] as const,
    id_derivation: 'RLE-hyphen-plus-first-16-lowercase-hex-of-record_digest_sha256' as const,
  };
  const requestDigest = '1'.repeat(64);
  const attemptId = `RLA-${canonicalSha256({
    request_digest_sha256: requestDigest,
    action_id: 'release preflight',
    sequence: 0,
    predecessor_record: null,
  }).slice(0, 16)}`;
  const attempt = finalizeStoreRecord({
    schemaVersion: '1.0.0',
    record_kind: 'attempt',
    canonicalization,
    sequence: 0,
    repository: REPOSITORY,
    candidate,
    predecessor_record: null,
    observed_head_before: null,
    attempt_id: attemptId,
    action_id: 'release preflight',
    request_digest_sha256: requestDigest,
    authorization_event_id: null,
    provider_handle: null,
    provider_dispatch: { status: 'not-dispatched', handle_observed: false },
    completion: null,
    failure: null,
    unknown: null,
  });
  const completion = finalizeStoreRecord({
    schemaVersion: '1.0.0',
    record_kind: 'completion',
    canonicalization,
    sequence: 1,
    repository: REPOSITORY,
    candidate,
    predecessor_record: {
      sequence: attempt.sequence,
      record_id: attempt.record_id,
      record_digest_sha256: attempt.record_digest_sha256,
    },
    observed_head_before: null,
    attempt_id: attemptId,
    action_id: 'release preflight',
    request_digest_sha256: requestDigest,
    authorization_event_id: null,
    provider_handle: null,
    provider_dispatch: { status: 'not-dispatched', handle_observed: false },
    completion: {
      state_id: state.state_id,
      state_digest_sha256: state.record_digest_sha256,
      state: state.state,
    },
    failure: null,
    unknown: null,
  });
  const head = finalizeStoreHead({
    schemaVersion: '2.0.0',
    canonicalization: {
      kernel_id: 'devai.kernel.release-lifecycle-store-head.v2',
      encoding: 'utf-8',
      json_form: 'rfc8785-jcs',
      digest_algorithm: 'sha256',
      projection_excludes: ['head_digest_sha256'],
    },
    repository: REPOSITORY,
    candidate: { commit: CANDIDATE.commit, tree: CANDIDATE.tree },
    generation: 0,
    state_id: state.state_id,
    state_digest_sha256: state.record_digest_sha256,
    completion_record: {
      sequence: completion.sequence,
      record_id: completion.record_id,
      record_digest_sha256: completion.record_digest_sha256,
      attempt_id: completion.attempt_id,
    },
  });
  return { records: [attempt, completion] as const, head };
}

describe('release lifecycle resume outcome matrix', () => {
  it('returns complete immutable observations for empty and plan-bound inputs', async () => {
    const states: unknown[] = [];
    const records: unknown[] = [];
    const empty = { ...common(), states, store_records: records };

    await expect(resumeReleaseLifecycleExecution(empty)).resolves.toEqual(
      expected({ nextAction: 'release plan', nextOutcome: 'ready' }),
    );
    expect(states).toEqual([]);
    expect(records).toEqual([]);

    await expect(
      resumeReleaseLifecycleExecution({ ...empty, receipt_documents: [PLAN] }),
    ).resolves.toEqual(
      expected({
        derived: [PLAN_DERIVATION],
        nextAction: 'release preflight',
        nextOutcome: 'ready',
      }),
    );
  });

  it('binds locator resolution and refuses unavailable, mismatched, and duplicate receipts', async () => {
    const locator = {
      kind: 'release-plan-receipt' as const,
      receipt_id: String(PLAN['receipt_id']),
      receipt_digest_sha256: String(PLAN['receipt_digest_sha256']),
      path: 'receipts/plan.json',
    };
    const resolveReceipt = vi.fn(() => PLAN);
    await expect(
      resumeReleaseLifecycleExecution({
        ...common(),
        receipt_locators: [locator],
        resolve_receipt: resolveReceipt,
      }),
    ).resolves.toEqual(
      expected({
        derived: [PLAN_DERIVATION],
        nextAction: 'release preflight',
        nextOutcome: 'ready',
      }),
    );
    expect(resolveReceipt).toHaveBeenCalledOnce();
    expect(resolveReceipt).toHaveBeenCalledWith(locator);

    const refused = expected({
      nextAction: null,
      nextOutcome: 'blocked',
      blockedReason: 'receipt-identity-mismatch',
    });
    await expect(
      resumeReleaseLifecycleExecution({ ...common(), receipt_locators: [locator] }),
    ).resolves.toEqual(refused);
    await expect(
      resumeReleaseLifecycleExecution({
        ...common(),
        receipt_locators: [{ ...locator, receipt_id: `RPL-${'0'.repeat(16)}` }],
        resolve_receipt: () => PLAN,
      }),
    ).resolves.toEqual(refused);
    await expect(
      resumeReleaseLifecycleExecution({ ...common(), receipt_documents: [PLAN, PLAN] }),
    ).resolves.toEqual(refused);
  });

  it('distinguishes current plan authority from intact historical evidence', async () => {
    const historical = historicalPlan();
    const repository = historical['repository'] as ReleaseLifecycleRequest['repository_locator'];
    const candidate = historical['candidate'] as ReleaseLifecycleStateV2['candidate'];
    const output = await resumeReleaseLifecycleExecution({
      states: [],
      repository,
      candidate,
      receipt_documents: [historical],
    });
    expect(output).toEqual(
      expected({
        repository,
        candidate,
        nextAction: null,
        nextOutcome: 'blocked',
        blockedReason: 'legacy-plan-non-authoritative',
      }),
    );
  });

  it('maps state, store, candidate, and head failures to exact blocked observations', async () => {
    const state = currentPreflightState();
    const store = completionFixture(state);
    const valid = {
      ...common(),
      states: [state],
      store_records: store.records,
      store_head: store.head,
      receipt_documents: [PLAN],
    };
    await expect(resumeReleaseLifecycleExecution(valid)).resolves.toEqual(
      expected({
        head: state,
        derived: [PLAN_DERIVATION],
        nextAction: 'release certify',
        nextOutcome: 'ready',
      }),
    );

    const cases: readonly [
      string,
      Parameters<typeof resumeReleaseLifecycleExecution>[0],
      string,
    ][] = [
      ['orphan completion', { ...valid, states: [] }, 'orphan-record'],
      ['missing store head', (({ store_head: _head, ...rest }) => rest)(valid), 'stale-head'],
      [
        'candidate locator',
        { ...common(), candidate_locator: { ...CANDIDATE_LOCATOR, commit: 'f'.repeat(40) } },
        'candidate-identity-mismatch',
      ],
      [
        'broken state chain',
        {
          ...common(),
          states: [{ ...state, state_id: 'RLS-0000000000000000' }],
          receipt_documents: [PLAN],
        },
        'broken-chain',
      ],
    ];
    for (const [label, input, blockedReason] of cases) {
      await expect(resumeReleaseLifecycleExecution(input), label).resolves.toEqual(
        expected({
          head:
            label === 'orphan completion' ||
            label === 'candidate locator' ||
            label === 'broken state chain'
              ? null
              : state,
          nextAction: null,
          nextOutcome: 'blocked',
          blockedReason,
        }),
      );
    }
  });

  it('derives persisted preflight and certification outcomes without appending or granting authority', async () => {
    const states = stateSequence();
    const cases = [
      [0, 'release certify', 'ready'],
      [1, 'release prepare', 'ready'],
    ] as const;
    for (const [lastIndex, nextAction, nextOutcome] of cases) {
      const selected = states.slice(0, lastIndex + 1);
      const head = selected.at(-1);
      if (head === undefined) throw new Error('head-fixture-missing');
      const before = structuredClone(selected);
      await expect(
        resumeReleaseLifecycleExecution({
          ...common(),
          states: selected,
          receipt_documents: [PLAN],
        }),
      ).resolves.toEqual(expected({ head, derived: [PLAN_DERIVATION], nextAction, nextOutcome }));
      expect(selected).toEqual(before);
    }
  });
});
