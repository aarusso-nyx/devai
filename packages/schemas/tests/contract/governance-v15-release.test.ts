import { describe, expect, it } from 'vitest';
import { getValidator } from '../../src/index.js';
import { canonicalSha256, omitPaths, readJson, schemaExample } from '../fixtures/governance-v15.js';

type Json = Record<string, unknown>;

const STATE_ORDER = [
  'planned',
  'preflight_passed',
  'certified',
  'prepared',
  'exported',
  'offline_verified',
  'evidence_published',
  'publication_dispatched',
  'published',
] as const;

describe('release lifecycle state and refusal contracts', () => {
  const policy = readJson<{
    plan_determination: {
      kernel_id: string;
      blocked_receipt: {
        verdict: string;
        state_observed: null;
        plan: unknown[];
        profile_verdict: string;
        transition: null;
        capabilities: unknown[];
        mutation: string;
        mutation_disposition_status: string;
        bindable_by_mutating_action: boolean;
        lifecycle_transition: boolean;
        semver_reason_precedence: string[];
        semver_outcomes: Array<{
          condition: string;
          blocking_reasons: string[];
          mutation_disposition_reason: string;
        }>;
      };
    };
    states: Array<Record<string, unknown>>;
    actions: Array<Record<string, unknown>>;
    read_action_purity: Record<string, unknown>;
    publication_separation: Record<string, unknown>;
  }>('law/policy/release-lifecycle.json');
  const validateState = getValidator('release-lifecycle-state.schema.json');
  getValidator('release-intent.schema.json');
  const validatePlan = getValidator('release-plan-receipt.schema.json');
  const validateStoreRecord = getValidator('release-lifecycle-store-record.schema.json');

  const blockedCases = [
    [
      'invalid-semver',
      {
        current_version: '1.4.5',
        target_version: '',
        support: 'current',
        support_promotion: false,
      },
    ],
    [
      'downgrade',
      {
        current_version: '1.4.5',
        target_version: '1.4.4',
        support: 'current',
        support_promotion: false,
      },
    ],
    [
      'same-version-without-support-promotion',
      {
        current_version: '1.4.5',
        target_version: '1.4.5',
        support: 'current',
        support_promotion: false,
      },
    ],
    [
      'support-promotion-requires-lts',
      {
        current_version: '1.4.5',
        target_version: '1.4.5',
        support: 'current',
        support_promotion: true,
      },
    ],
  ] as const;

  function blockedPlanReceipt(reason: string, intentPatch: Record<string, unknown>): Json {
    const receipt = schemaExample<Json>('release-plan-receipt.schema.json');
    const input = (receipt.inputs as Json[])[0];
    if (input === undefined) throw new Error('release plan fixture is missing its intent input');
    const inlineDocument = { ...(input.inline_document as Json), ...intentPatch };
    input.inline_document = inlineDocument;
    input.sha256 = canonicalSha256(inlineDocument);
    (receipt.candidate as Json).version = inlineDocument.target_version;
    receipt.verdict = 'block';
    receipt.state_observed = null;
    receipt.plan = [];
    receipt.determination = {
      profile_verdict: 'block',
      transition: null,
      support: inlineDocument.support,
      impact: inlineDocument.change_kind,
      risk_classes: inlineDocument.risks,
      capabilities: [],
      mutation: 'none',
      mutation_disposition: { status: 'blocked', reason },
      blocking_reasons: [reason],
    };
    delete receipt.receipt_id;
    delete receipt.receipt_digest_sha256;
    const digest = canonicalSha256(receipt);
    receipt.receipt_id = `RPL-${digest.slice(0, 16)}`;
    receipt.receipt_digest_sha256 = digest;
    return receipt;
  }

  it('freezes exactly nine ordered states and never persists derived states', () => {
    expect(policy.states.map((entry) => entry.state)).toEqual(STATE_ORDER);
    expect(
      policy.states.filter((entry) => entry.persisted === false).map((entry) => entry.state),
    ).toEqual(['planned', 'offline_verified', 'published']);
    expect(policy.states.filter((entry) => entry.appendable === true)).toHaveLength(6);
  });

  it('registers the canonical v2 store-head dependency before compiling store records', () => {
    expect(validateStoreRecord({})).toBe(false);
    expect(validateStoreRecord.errors).not.toBeNull();
  });

  it('binds each mutating action to one exact state transition', () => {
    const persisted = policy.states.filter((entry) => entry.persisted === true);
    for (const state of persisted) {
      const action = policy.actions.find((entry) => entry.action_id === state.produced_by_action);
      expect(action).toMatchObject({
        produces_state: state.state,
        appends_state_record: true,
        persists_repository_state: true,
      });
    }
  });

  it('keeps read actions pure and evidence/product authorizations separate', () => {
    expect(policy.read_action_purity).toMatchObject({
      actions: ['release plan', 'release offline-verify', 'release resume'],
      persists_repository_state: false,
      appends_state_record: false,
      writes_receipt_file: false,
      emits_to: 'stdout',
      deterministic: true,
      grants_authority: false,
    });
    expect(policy.publication_separation).toMatchObject({
      evidence_implies_product: false,
      product_implies_evidence: false,
      shared_authorization: false,
    });
  });

  it('pins v2 plan kernels and the exact deterministic SemVer refusal contract', () => {
    expect(policy.plan_determination.kernel_id).toBe('devai.kernel.release-plan-determination.v2');
    expect(policy.plan_determination.blocked_receipt).toMatchObject({
      verdict: 'block',
      state_observed: null,
      plan: [],
      profile_verdict: 'block',
      transition: null,
      capabilities: [],
      mutation: 'none',
      mutation_disposition_status: 'blocked',
      bindable_by_mutating_action: false,
      lifecycle_transition: false,
      semver_reason_precedence: blockedCases.map(([reason]) => reason),
    });
    expect(policy.plan_determination.blocked_receipt.semver_outcomes).toEqual(
      blockedCases.map(([reason]) => ({
        condition: reason,
        blocking_reasons: [reason],
        mutation_disposition_reason: reason,
      })),
    );
  });

  it.each(blockedCases)('emits a deterministic non-transition receipt for %s', (reason, input) => {
    const first = blockedPlanReceipt(reason, input);
    const second = blockedPlanReceipt(reason, input);
    expect(first).toEqual(second);
    expect(validatePlan(first), JSON.stringify(validatePlan.errors)).toBe(true);
    expect(first).toMatchObject({
      verdict: 'block',
      state_observed: null,
      plan: [],
      determination: {
        profile_verdict: 'block',
        transition: null,
        capabilities: [],
        mutation: 'none',
        mutation_disposition: { status: 'blocked', reason },
        blocking_reasons: [reason],
      },
      verification_kernel: { kernel_id: 'devai.kernel.release-plan-receipt.v2' },
      grants: { lifecycle_transition: false },
    });
    expect(first.receipt_digest_sha256).toBe(
      canonicalSha256(omitPaths(first, ['receipt_id', 'receipt_digest_sha256'])),
    );
  });

  it('does not weaken the passing plan or let a blocked plan resemble one', () => {
    const passing = schemaExample<Json>('release-plan-receipt.schema.json');
    expect(validatePlan(passing)).toBe(true);
    expect(passing).toMatchObject({
      verdict: 'pass',
      state_observed: 'planned',
      determination: { profile_verdict: 'ready', blocking_reasons: [] },
    });
    expect(passing.plan).toHaveLength(9);

    const passingDetermination = passing.determination as Json;
    const invalidPassing = [
      { ...passing, state_observed: null },
      { ...passing, plan: (passing.plan as unknown[]).slice(0, 8) },
      { ...passing, determination: { ...passingDetermination, profile_verdict: 'block' } },
      { ...passing, determination: { ...passingDetermination, transition: null } },
      {
        ...passing,
        determination: {
          ...passingDetermination,
          mutation_disposition: { status: 'blocked', reason: 'invalid-semver' },
        },
      },
      { ...passing, determination: { ...passingDetermination, blocking_reasons: ['downgrade'] } },
    ];
    for (const candidate of invalidPassing) expect(validatePlan(candidate)).toBe(false);

    const blocked = blockedPlanReceipt('downgrade', blockedCases[1][1]);
    const blockedDetermination = blocked.determination as Json;
    for (const candidate of [
      { ...blocked, state_observed: 'planned' },
      { ...blocked, plan: passing.plan },
      { ...blocked, determination: { ...blockedDetermination, transition: 'patch' } },
      { ...blocked, determination: { ...blockedDetermination, capabilities: ['lint'] } },
    ]) {
      expect(validatePlan(candidate)).toBe(false);
    }
  });

  it('rejects appended derived states and action/state/role mismatches', () => {
    const preflight = schemaExample<Json>('release-lifecycle-state.schema.json');
    for (const invalid of [
      { ...preflight, state: 'published' },
      { ...preflight, action_id: 'release prepare' },
      { ...preflight, actor: { kind: 'human', role: 'engineer', declaration_source: 'cli-flag' } },
      { ...preflight, bound_receipts: [] },
    ]) {
      expect(validateState(invalid)).toBe(false);
    }
  });

  it('rejects publication without the exact Owner grant and protected expectation', () => {
    const dispatch = schemaExample<Json>('release-lifecycle-state.schema.json', 1);
    const expectation = dispatch.publication_expectation as Json;
    const workflow = expectation.workflow as Json;
    for (const invalid of [
      { ...dispatch, authorization_event_id: null },
      { ...dispatch, actor: { kind: 'human', role: 'architect', declaration_source: 'cli-flag' } },
      { ...dispatch, consent: { write: true, allow_publish: false, experimental: false } },
      { ...dispatch, publication_expectation: null },
      {
        ...dispatch,
        publication_expectation: { ...expectation, workflow: { ...workflow, protected: false } },
      },
    ]) {
      expect(validateState(invalid)).toBe(false);
    }
  });
});
