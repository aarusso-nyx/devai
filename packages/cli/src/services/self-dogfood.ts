import { parsers } from '@devai-nyx/schemas';

export type SelfDogfoodRole = 'owner' | 'architect' | 'inspector' | 'engineer' | 'auditor';
export type SelfDogfoodEffect = 'read' | 'harness-write' | 'local-write' | 'remote-write';

/**
 * The sensing actions ADR-SCR-0001 admits by addition. Their decision is taken
 * from the matrix row and the roster entry keyed by the action id, never from
 * the absence of a rule.
 */
export const SELF_DOGFOOD_SENSE_ACTIONS = Object.freeze([
  'sense run',
  'sense record',
  'audit observe',
] as const);
export type SelfDogfoodSenseAction = (typeof SELF_DOGFOOD_SENSE_ACTIONS)[number];

/** Attribution a recorded reading must carry (ADR-SCR-0001 IA-005). */
export interface SelfDogfoodReadingAttribution {
  readonly declaring_role: SelfDogfoodRole | undefined;
  readonly human_invocation: string | undefined;
}

export interface SelfDogfoodRequest {
  readonly human_invoked: boolean;
  readonly role: SelfDogfoodRole | undefined;
  readonly action_id: string;
  readonly check_id: string;
  readonly effect: SelfDogfoodEffect;
  readonly scheduled?: boolean;
  readonly backlog_dequeue?: boolean;
  readonly self_dispatch?: boolean;
  /** `--write` on a sensing action. Explicit consent never implies publication. */
  readonly write_consent?: boolean;
  /** `--publish` on any action. Refused before the policy or the matrix is consulted. */
  readonly publish?: boolean;
  /** Effects of the resolved population members of a `sense run`. */
  readonly population_effects?: readonly SelfDogfoodEffect[];
  /** Attribution of the reading a `sense record` persists. */
  readonly reading?: SelfDogfoodReadingAttribution;
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

export function isSelfDogfoodSenseAction(actionId: string): actionId is SelfDogfoodSenseAction {
  return (SELF_DOGFOOD_SENSE_ACTIONS as readonly string[]).includes(actionId);
}

/**
 * The effect a sensing request asks the matrix row for.
 *
 * A `sense run` whose population is read-only carries read. Any write member,
 * or explicit write consent, means readings persist through the harness
 * boundary, so the row must permit harness-write: a member's local-write rank
 * never lowers that requirement, which is what keeps write sensing on the
 * inspector row alone. A remote member is refused outright.
 */
function effectiveSenseEffect(request: SelfDogfoodRequest): SelfDogfoodEffect {
  const members = request.population_effects ?? [];
  if (request.effect === 'remote-write' || members.includes('remote-write')) return 'remote-write';
  if (request.action_id !== 'sense run') return request.effect;
  const wantsWrite =
    request.write_consent === true ||
    request.effect !== 'read' ||
    members.some((member) => member !== 'read');
  return wantsWrite ? 'harness-write' : 'read';
}

export function authorizeSelfDogfoodCheck(
  policyInput: unknown,
  request: SelfDogfoodRequest,
): SelfDogfoodDecision {
  // Publication is refused before the policy or the matrix is consulted
  // (ADR-SCR-0001 IA-003). No row, consent, or check pass can reopen it.
  if (request.publish === true) return { ok: false, reasons: ['publication-attempted'] };

  const parsed = parsers.selfDogfoodPolicy.safeParse<SelfDogfoodPolicy>(policyInput);
  if (!parsed.ok) return { ok: false, reasons: ['self-dogfood-policy-invalid'] };
  const reasons: string[] = [];
  if (!request.human_invoked) reasons.push('absent-human-invocation');
  if (request.role === undefined) reasons.push('inferred-role');
  if (request.scheduled === true) reasons.push('scheduled-or-timer-invocation');
  if (request.backlog_dequeue === true) reasons.push('backlog-dequeue-attempted');
  if (request.self_dispatch === true) reasons.push('self-dispatch-attempted');

  const sense = isSelfDogfoodSenseAction(request.action_id);
  const effect = sense ? effectiveSenseEffect(request) : request.effect;
  if (effect === 'remote-write') reasons.push('remote-effect-attempted');
  if (sense && request.population_effects?.includes('remote-write') === true) {
    reasons.push('remote-write-population-member');
  }

  // Sensing entries in the roster are keyed by their action id.
  const check = parsed.value.permitted_checks.find((entry) => entry.check_id === request.check_id);
  if (check === undefined || (sense && request.check_id !== request.action_id)) {
    reasons.push('undeclared-check-id');
  }
  const row = parsed.value.role_effect_matrix.find((entry) => entry.role === request.role);
  if (row === undefined) reasons.push('inferred-role');
  if (row !== undefined && !row.may_initiate.includes(request.action_id)) {
    reasons.push('undeclared-action-id');
  }
  if (row !== undefined && !row.permitted_effects.includes(effect as never)) {
    reasons.push('effect-outside-role-row');
  }
  if (
    check !== undefined &&
    (request.role === undefined || !check.initiator_roles.includes(request.role))
  ) {
    reasons.push('effect-outside-role-row');
  }
  if (check !== undefined && check.effect !== effect) {
    // Only `sense run` may rise above its declared read floor, and only through
    // the row check above; every other roster entry is exact.
    if (!sense || request.action_id !== 'sense run' || check.effect !== 'read') {
      reasons.push('effect-outside-role-row');
    }
  }
  if (sense && effect !== 'read' && request.write_consent !== true) {
    reasons.push('write-consent-absent');
  }
  if (request.action_id === 'sense record') {
    const reading = request.reading;
    if (
      reading === undefined ||
      request.role === undefined ||
      reading.declaring_role !== request.role ||
      typeof reading.human_invocation !== 'string' ||
      reading.human_invocation.trim().length === 0
    ) {
      reasons.push('unattributed-reading');
    }
  }
  if (reasons.length > 0) return { ok: false, reasons: [...new Set(reasons)] };
  return {
    ok: true,
    check_id: request.check_id,
    role: request.role as SelfDogfoodRole,
    effect: effect as Exclude<SelfDogfoodEffect, 'remote-write'>,
    produces_readiness_claim: false,
    grants_publication_authority: false,
  };
}
