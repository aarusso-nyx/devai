import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getValidator } from '@devai-nyx/schemas';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  authorizeSelfDogfoodCheck,
  SELF_DOGFOOD_SENSE_ACTIONS,
  type SelfDogfoodRequest,
  type SelfDogfoodRole,
} from '../../src/services/self-dogfood.js';

type Json = Record<string, unknown>;
interface RosterEntry {
  readonly check_id: string;
  readonly effect: string;
  readonly initiator_roles: readonly string[];
}
interface MatrixRow {
  readonly role: SelfDogfoodRole;
  readonly permitted_effects: readonly string[];
  readonly forbidden_effects: readonly string[];
  readonly may_initiate: readonly string[];
}
interface Policy extends Json {
  readonly permitted_checks: readonly RosterEntry[];
  readonly role_effect_matrix: readonly MatrixRow[];
}

const ROOT = resolve(import.meta.dirname, '../../../..');
const ROLES: readonly SelfDogfoodRole[] = [
  'owner',
  'architect',
  'inspector',
  'engineer',
  'auditor',
];
const NON_INSPECTORS = ROLES.filter((role) => role !== 'inspector');
const HARNESS_WRITE_ACTIONS = ['sense record', 'audit observe'] as const;
const ATTRIBUTED = { declaring_role: 'inspector', human_invocation: 'maintainer:R-0206' } as const;
// ADR-SCR-0008: the sense record row declares the chain path beside the readings directory.
const SENSE_RECORD_WRITE_PATHS = ['.devai/state/sensor-readings', 'record/proofs/chain.json'];

function declaredWritePaths(checkId: string) {
  return checkId === 'sense record' ? { harness_write_paths: SENSE_RECORD_WRITE_PATHS } : {};
}

let policy: Policy;

beforeAll(() => {
  policy = JSON.parse(readFileSync(resolve(ROOT, 'law/policy/self-dogfood.json'), 'utf8'));
});

function sense(
  actionId: (typeof SELF_DOGFOOD_SENSE_ACTIONS)[number],
  overrides: Partial<SelfDogfoodRequest> = {},
): SelfDogfoodRequest {
  return {
    human_invoked: true,
    role: 'inspector',
    action_id: actionId,
    check_id: actionId,
    effect: actionId === 'sense run' ? 'read' : 'harness-write',
    ...overrides,
  };
}

function admitted(role: SelfDogfoodRole, checkId: string, effect: string) {
  return {
    ok: true,
    check_id: checkId,
    role,
    effect,
    ...declaredWritePaths(checkId),
    produces_readiness_claim: false,
    grants_publication_authority: false,
  };
}

function refusal(decision: ReturnType<typeof authorizeSelfDogfoodCheck>): readonly string[] {
  expect(decision.ok).toBe(false);
  return decision.ok ? [] : decision.reasons;
}

describe('ADR-SCR-0001 self-dogfood admission of the sensing actions', () => {
  it('IA-001 admits sense run with a read effect for every role from the matrix row', () => {
    for (const role of ROLES) {
      const row = policy.role_effect_matrix.find((entry) => entry.role === role);
      expect(row?.may_initiate).toContain('sense run');
      expect(row?.permitted_effects).toContain('read');
      expect(authorizeSelfDogfoodCheck(policy, sense('sense run', { role }))).toEqual(
        admitted(role, 'sense run', 'read'),
      );
    }
    const roster = policy.permitted_checks.find((entry) => entry.check_id === 'sense run');
    expect(roster).toEqual({ check_id: 'sense run', effect: 'read', initiator_roles: ROLES });
    // An action the row does not name is refused: admission is never by omission.
    for (const role of ROLES) {
      expect(
        refusal(
          authorizeSelfDogfoodCheck(policy, {
            human_invoked: true,
            role,
            action_id: 'sense inventory',
            check_id: 'sense inventory',
            effect: 'read',
          }),
        ),
      ).toEqual(['undeclared-check-id', 'undeclared-action-id']);
    }
  });

  it('IA-002 refuses sense record and audit observe for every non-inspector and admits the inspector with write consent', () => {
    for (const actionId of HARNESS_WRITE_ACTIONS) {
      const roster = policy.permitted_checks.find((entry) => entry.check_id === actionId);
      expect(roster).toEqual({
        check_id: actionId,
        effect: 'harness-write',
        initiator_roles: ['inspector'],
        ...declaredWritePaths(actionId),
      });
      for (const role of NON_INSPECTORS) {
        const row = policy.role_effect_matrix.find((entry) => entry.role === role);
        expect(row?.may_initiate).not.toContain(actionId);
        expect(row?.forbidden_effects).toContain('harness-write');
        const reasons = refusal(
          authorizeSelfDogfoodCheck(
            policy,
            sense(actionId, { role, write_consent: true, reading: ATTRIBUTED }),
          ),
        );
        expect(reasons).toContain('undeclared-action-id');
        expect(reasons).toContain('effect-outside-role-row');
      }
      expect(
        authorizeSelfDogfoodCheck(
          policy,
          sense(actionId, { write_consent: true, reading: ATTRIBUTED }),
        ),
      ).toEqual(admitted('inspector', actionId, 'harness-write'));
      expect(
        refusal(authorizeSelfDogfoodCheck(policy, sense(actionId, { reading: ATTRIBUTED }))),
      ).toEqual(['write-consent-absent']);
      // A harness-write sensing action never degrades to a read admission.
      expect(
        refusal(
          authorizeSelfDogfoodCheck(
            policy,
            sense(actionId, { effect: 'read', write_consent: true, reading: ATTRIBUTED }),
          ),
        ),
      ).toEqual(['effect-outside-role-row']);
    }
  });

  it('IA-003 refuses --publish on every sense action for every role before the matrix is consulted', () => {
    for (const actionId of SELF_DOGFOOD_SENSE_ACTIONS) {
      for (const role of ROLES) {
        const request = sense(actionId, {
          role,
          publish: true,
          write_consent: true,
          reading: ATTRIBUTED,
        });
        expect(authorizeSelfDogfoodCheck(policy, request)).toEqual({
          ok: false,
          reasons: ['publication-attempted'],
        });
        // The same verdict without any policy at all: nothing downstream was consulted.
        expect(authorizeSelfDogfoodCheck(null, request)).toEqual({
          ok: false,
          reasons: ['publication-attempted'],
        });
      }
    }
  });

  it('IA-004 refuses a sense run whose population contains a remote-write member even for the inspector with write consent', () => {
    const reasons = refusal(
      authorizeSelfDogfoodCheck(
        policy,
        sense('sense run', {
          write_consent: true,
          population_effects: ['read', 'local-write', 'remote-write'],
        }),
      ),
    );
    expect(reasons).toContain('remote-effect-attempted');
    expect(reasons).toContain('remote-write-population-member');
    expect(
      refusal(authorizeSelfDogfoodCheck(policy, sense('sense run', { effect: 'remote-write' }))),
    ).toContain('remote-effect-attempted');
    // The same population without the remote member is an inspector harness-write.
    expect(
      authorizeSelfDogfoodCheck(
        policy,
        sense('sense run', { write_consent: true, population_effects: ['read', 'local-write'] }),
      ),
    ).toEqual(admitted('inspector', 'sense run', 'harness-write'));
  });

  it('IA-005 requires a recorded reading to carry the declaring role and the human invocation', () => {
    const base = { write_consent: true } as const;
    expect(refusal(authorizeSelfDogfoodCheck(policy, sense('sense record', base)))).toEqual([
      'unattributed-reading',
    ]);
    for (const reading of [
      { declaring_role: undefined, human_invocation: 'maintainer:R-0206' },
      { declaring_role: 'architect', human_invocation: 'maintainer:R-0206' },
      { declaring_role: 'inspector', human_invocation: undefined },
      { declaring_role: 'inspector', human_invocation: '   ' },
    ] as const) {
      expect(
        refusal(authorizeSelfDogfoodCheck(policy, sense('sense record', { ...base, reading }))),
      ).toEqual(['unattributed-reading']);
    }
    expect(
      authorizeSelfDogfoodCheck(policy, sense('sense record', { ...base, reading: ATTRIBUTED })),
    ).toEqual(admitted('inspector', 'sense record', 'harness-write'));
  });

  it('refuses sense run --write from every role except the inspector', () => {
    for (const role of NON_INSPECTORS) {
      expect(
        refusal(
          authorizeSelfDogfoodCheck(policy, sense('sense run', { role, write_consent: true })),
        ),
      ).toEqual(['effect-outside-role-row']);
      expect(
        refusal(
          authorizeSelfDogfoodCheck(
            policy,
            sense('sense run', { role, write_consent: true, population_effects: ['local-write'] }),
          ),
        ),
      ).toEqual(['effect-outside-role-row']);
    }
    expect(authorizeSelfDogfoodCheck(policy, sense('sense run', { write_consent: true }))).toEqual(
      admitted('inspector', 'sense run', 'harness-write'),
    );
    expect(
      refusal(
        authorizeSelfDogfoodCheck(
          policy,
          sense('sense run', { population_effects: ['read', 'harness-write'] }),
        ),
      ),
    ).toEqual(['write-consent-absent']);
  });

  it('keeps the fail-closed remainder for the sensing actions', () => {
    expect(
      refusal(
        authorizeSelfDogfoodCheck(
          policy,
          sense('sense run', { role: undefined, human_invoked: false }),
        ),
      ),
    ).toEqual(['absent-human-invocation', 'inferred-role', 'effect-outside-role-row']);
    expect(
      refusal(authorizeSelfDogfoodCheck(policy, sense('sense run', { check_id: 'lint' }))),
    ).toEqual(['undeclared-check-id']);
    expect(
      refusal(
        authorizeSelfDogfoodCheck(
          policy,
          sense('sense run', { scheduled: true, backlog_dequeue: true, self_dispatch: true }),
        ),
      ),
    ).toEqual([
      'scheduled-or-timer-invocation',
      'backlog-dequeue-attempted',
      'self-dispatch-attempted',
    ]);
    for (const reason of [
      'publication-attempted',
      'write-consent-absent',
      'remote-write-population-member',
      'unattributed-reading',
    ]) {
      expect(policy.fail_closed).toContain(reason);
    }
  });

  it('structurally limits the harness-write sensing actions and keeps remote-write forbidden in every row', () => {
    const validate = getValidator('self-dogfood-policy.schema.json');
    expect(validate(policy)).toBe(true);
    for (const row of policy.role_effect_matrix) {
      expect(row.forbidden_effects).toContain('remote-write');
      expect(row.permitted_effects).not.toContain('remote-write');
    }
    const roster = policy.permitted_checks;
    const rows = policy.role_effect_matrix;
    const swap = <T>(list: readonly T[], match: (entry: T) => boolean, patch: Partial<T>) =>
      list.map((entry) => (match(entry) ? { ...entry, ...patch } : entry));
    const invalid: readonly Policy[] = [
      // sense record or audit observe with any effect other than harness-write.
      {
        ...policy,
        permitted_checks: swap(roster, (e) => e.check_id === 'sense record', { effect: 'read' }),
      },
      {
        ...policy,
        permitted_checks: swap(roster, (e) => e.check_id === 'audit observe', {
          effect: 'local-write',
        }),
      },
      // A harness-write sensing action offered to a row that forbids harness-write.
      {
        ...policy,
        permitted_checks: swap(roster, (e) => e.check_id === 'audit observe', {
          initiator_roles: ['inspector', 'auditor'],
        }),
      },
      {
        ...policy,
        role_effect_matrix: swap(rows, (r) => r.role === 'owner', {
          may_initiate: [
            ...(rows.find((r) => r.role === 'owner')?.may_initiate ?? []),
            'sense record',
          ].sort(),
        }),
      },
      // Remote-write can neither be permitted nor dropped from the forbidden list.
      {
        ...policy,
        role_effect_matrix: swap(rows, (r) => r.role === 'inspector', { forbidden_effects: [] }),
      },
      {
        ...policy,
        permitted_checks: swap(roster, (e) => e.check_id === 'sense run', {
          effect: 'remote-write',
        }),
      },
    ];
    for (const candidate of invalid) {
      expect(validate(candidate)).toBe(false);
      expect(authorizeSelfDogfoodCheck(candidate, sense('sense run', { role: 'owner' }))).toEqual({
        ok: false,
        reasons: ['self-dogfood-policy-invalid'],
      });
    }
  });
});
