import { describe, expect, it } from 'vitest';
import { getValidator } from '../../src/index.js';
import { readJson } from '../fixtures/governance-v15.js';

type Json = Record<string, unknown>;

describe('constrained DEVAI self-dogfood policy', () => {
  const policy = readJson<Json>('law/policy/self-dogfood.json');
  const validate = getValidator('self-dogfood-policy.schema.json');

  it('accepts the canonical example without producing authority or readiness', () => {
    expect(validate(policy)).toBe(true);
    expect(policy.scope).toMatchObject({
      subject: 'devai-source-repository',
      governs_human_maintainers: false,
      produces_readiness_claim: false,
      adopter_applicability: 'none',
    });
    expect(policy.publication_authority).toMatchObject({
      granted: false,
      implied_by_check_pass: false,
      implied_by_write_consent: false,
      remote_effects: 'forbidden',
    });
  });

  it('requires a human invocation and forbids scheduling, dequeue, and self-dispatch', () => {
    expect(policy.invocation).toEqual({
      human_invoked_only: true,
      autonomous_work: 'forbidden',
      scheduled_execution: 'forbidden',
      backlog_dequeue: 'forbidden',
      self_dispatch: 'forbidden',
      unknown_invocation_behavior: 'fail',
    });
  });

  it('rejects policy attempts to grant readiness, publication, or remote checks', () => {
    const scope = policy.scope as Json;
    const publication = policy.publication_authority as Json;
    const checks = policy.permitted_checks as Json[];
    for (const invalid of [
      { ...policy, scope: { ...scope, produces_readiness_claim: true } },
      { ...policy, publication_authority: { ...publication, granted: true } },
      {
        ...policy,
        permitted_checks: [
          ...checks,
          { check_id: 'release:publish', effect: 'remote-write', initiator_roles: ['owner'] },
        ],
      },
    ]) {
      expect(validate(invalid)).toBe(false);
    }
  });
});
