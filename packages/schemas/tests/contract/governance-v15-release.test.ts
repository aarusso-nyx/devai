import { describe, expect, it } from 'vitest';
import { getValidator } from '../../src/index.js';
import { readJson, schemaExample } from '../fixtures/governance-v15.js';

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
    states: Array<Record<string, unknown>>;
    actions: Array<Record<string, unknown>>;
    read_action_purity: Record<string, unknown>;
    publication_separation: Record<string, unknown>;
  }>('law/policy/release-lifecycle.json');
  const validateState = getValidator('release-lifecycle-state.schema.json');

  it('freezes exactly nine ordered states and never persists derived states', () => {
    expect(policy.states.map((entry) => entry.state)).toEqual(STATE_ORDER);
    expect(
      policy.states.filter((entry) => entry.persisted === false).map((entry) => entry.state),
    ).toEqual(['planned', 'offline_verified', 'published']);
    expect(policy.states.filter((entry) => entry.appendable === true)).toHaveLength(6);
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
