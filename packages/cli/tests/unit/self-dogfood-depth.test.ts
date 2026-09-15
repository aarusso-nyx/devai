import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  authorizeSelfDogfoodCheck,
  type SelfDogfoodRequest,
} from '../../src/services/self-dogfood.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
let policy: unknown;

beforeAll(() => {
  policy = JSON.parse(readFileSync(resolve(ROOT, 'law/policy/self-dogfood.json'), 'utf8'));
});

function request(overrides: Partial<SelfDogfoodRequest> = {}): SelfDogfoodRequest {
  return {
    human_invoked: true,
    role: 'engineer',
    action_id: 'check',
    check_id: 'lint',
    effect: 'read',
    ...overrides,
  };
}

describe('self-dogfood check authorization', () => {
  it('authorizes only the exact canonical role, action, check, and effect tuple', () => {
    expect(authorizeSelfDogfoodCheck(policy, request())).toEqual({
      ok: true,
      check_id: 'lint',
      role: 'engineer',
      effect: 'read',
      produces_readiness_claim: false,
      grants_publication_authority: false,
    });
    expect(
      authorizeSelfDogfoodCheck(
        policy,
        request({
          role: 'architect',
          check_id: 'release:closure',
          effect: 'local-write',
        }),
      ),
    ).toEqual({
      ok: true,
      check_id: 'release:closure',
      role: 'architect',
      effect: 'local-write',
      produces_readiness_claim: false,
      grants_publication_authority: false,
    });
  });

  it('fails closed when the policy cannot be parsed', () => {
    expect(authorizeSelfDogfoodCheck(null, request())).toEqual({
      ok: false,
      reasons: ['self-dogfood-policy-invalid'],
    });
    expect(authorizeSelfDogfoodCheck({ permitted_checks: [] }, request())).toEqual({
      ok: false,
      reasons: ['self-dogfood-policy-invalid'],
    });
  });

  it('aggregates autonomous and remote invocation defects in stable order', () => {
    expect(
      authorizeSelfDogfoodCheck(
        policy,
        request({
          human_invoked: false,
          role: undefined,
          action_id: 'unknown action',
          check_id: 'unknown:check',
          effect: 'remote-write',
          scheduled: true,
          backlog_dequeue: true,
          self_dispatch: true,
        }),
      ),
    ).toEqual({
      ok: false,
      reasons: [
        'absent-human-invocation',
        'inferred-role',
        'scheduled-or-timer-invocation',
        'backlog-dequeue-attempted',
        'self-dispatch-attempted',
        'remote-effect-attempted',
        'undeclared-check-id',
      ],
    });
  });

  it('distinguishes undeclared checks and actions from role/effect mismatches', () => {
    expect(authorizeSelfDogfoodCheck(policy, request({ check_id: 'unknown:check' }))).toEqual({
      ok: false,
      reasons: ['undeclared-check-id'],
    });
    expect(
      authorizeSelfDogfoodCheck(
        policy,
        request({ role: 'owner', action_id: 'check', check_id: 'lint', effect: 'read' }),
      ),
    ).toEqual({ ok: false, reasons: ['undeclared-action-id'] });
    expect(
      authorizeSelfDogfoodCheck(
        policy,
        request({ role: 'owner', action_id: 'doctor', check_id: 'lint', effect: 'local-write' }),
      ),
    ).toEqual({ ok: false, reasons: ['effect-outside-role-row'] });
    expect(
      authorizeSelfDogfoodCheck(
        policy,
        request({
          role: 'auditor',
          action_id: 'release status',
          check_id: 'release:closure',
          effect: 'local-write',
        }),
      ),
    ).toEqual({ ok: false, reasons: ['effect-outside-role-row'] });
  });
});
