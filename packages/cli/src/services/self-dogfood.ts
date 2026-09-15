import { parsers } from '@devai-nyx/schemas';

export type SelfDogfoodRole = 'owner' | 'architect' | 'inspector' | 'engineer' | 'auditor';
export type SelfDogfoodEffect = 'read' | 'harness-write' | 'local-write' | 'remote-write';

export interface SelfDogfoodRequest {
  readonly human_invoked: boolean;
  readonly role: SelfDogfoodRole | undefined;
  readonly action_id: string;
  readonly check_id: string;
  readonly effect: SelfDogfoodEffect;
  readonly scheduled?: boolean;
  readonly backlog_dequeue?: boolean;
  readonly self_dispatch?: boolean;
}

export type SelfDogfoodDecision =
  | {
      readonly ok: true;
      readonly check_id: string;
      readonly role: SelfDogfoodRole;
      readonly effect: Exclude<SelfDogfoodEffect, 'remote-write'>;
      readonly produces_readiness_claim: false;
      readonly grants_publication_authority: false;
    }
  | { readonly ok: false; readonly reasons: readonly string[] };

interface SelfDogfoodPolicy {
  readonly scope: { readonly produces_readiness_claim: false };
  readonly permitted_checks: readonly {
    readonly check_id: string;
    readonly effect: Exclude<SelfDogfoodEffect, 'remote-write'>;
    readonly initiator_roles: readonly SelfDogfoodRole[];
  }[];
  readonly role_effect_matrix: readonly {
    readonly role: SelfDogfoodRole;
    readonly permitted_effects: readonly Exclude<SelfDogfoodEffect, 'remote-write'>[];
    readonly forbidden_effects: readonly SelfDogfoodEffect[];
    readonly may_initiate: readonly string[];
  }[];
}

export function authorizeSelfDogfoodCheck(
  policyInput: unknown,
  request: SelfDogfoodRequest,
): SelfDogfoodDecision {
  const parsed = parsers.selfDogfoodPolicy.safeParse<SelfDogfoodPolicy>(policyInput);
  if (!parsed.ok) return { ok: false, reasons: ['self-dogfood-policy-invalid'] };
  const reasons: string[] = [];
  if (!request.human_invoked) reasons.push('absent-human-invocation');
  if (request.role === undefined) reasons.push('inferred-role');
  if (request.scheduled === true) reasons.push('scheduled-or-timer-invocation');
  if (request.backlog_dequeue === true) reasons.push('backlog-dequeue-attempted');
  if (request.self_dispatch === true) reasons.push('self-dispatch-attempted');
  if (request.effect === 'remote-write') reasons.push('remote-effect-attempted');

  const check = parsed.value.permitted_checks.find((entry) => entry.check_id === request.check_id);
  if (check === undefined) reasons.push('undeclared-check-id');
  const row = parsed.value.role_effect_matrix.find((entry) => entry.role === request.role);
  if (row === undefined) reasons.push('inferred-role');
  if (row !== undefined && !row.may_initiate.includes(request.action_id)) {
    reasons.push('undeclared-action-id');
  }
  if (row !== undefined && !row.permitted_effects.includes(request.effect as never)) {
    reasons.push('effect-outside-role-row');
  }
  if (
    check !== undefined &&
    (check.effect !== request.effect ||
      request.role === undefined ||
      !check.initiator_roles.includes(request.role))
  ) {
    reasons.push('effect-outside-role-row');
  }
  if (reasons.length > 0) return { ok: false, reasons: [...new Set(reasons)] };
  return {
    ok: true,
    check_id: request.check_id,
    role: request.role as SelfDogfoodRole,
    effect: request.effect as Exclude<SelfDogfoodEffect, 'remote-write'>,
    produces_readiness_claim: false,
    grants_publication_authority: false,
  };
}
