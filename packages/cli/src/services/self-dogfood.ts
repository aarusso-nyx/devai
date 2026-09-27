import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** The file whose presence puts a repository under the self-dogfood policy. */
export const SELF_DOGFOOD_POLICY_PATH = 'law/policy/self-dogfood.json' as const;
/** The subject the framework's policy names in `scope.subject`. */
export const SELF_DOGFOOD_SUBJECT = 'devai-source-repository';

/**
 * The human declaration a sensing command was invoked under, as the CLI
 * resolved it from the invocation. It is never inferred: an absent role stays
 * absent and the matrix refuses it.
 */
export interface SelfDogfoodCommandDeclaration {
  readonly role: SelfDogfoodRole | undefined;
  readonly human_invoked: boolean;
  /** How the human declared the role (`cli-flag` or `session-state`). */
  readonly declaration_source: string | undefined;
  readonly write_consent: boolean;
  readonly publish: boolean;
}

/** The resolved population of a `sense run`, as the facade reports it. */
export interface SelfDogfoodPopulation {
  readonly aggregate_effect: SelfDogfoodEffect;
  readonly member_effects: readonly SelfDogfoodEffect[];
}

export type SelfDogfoodCommandGate =
  | { readonly applies: false }
  | {
      readonly applies: true;
      readonly policy: typeof SELF_DOGFOOD_POLICY_PATH;
      readonly action_id: SelfDogfoodSenseAction;
      readonly declared_role: SelfDogfoodRole | null;
      readonly write_consent: boolean;
      readonly decision: SelfDogfoodDecision;
    };

const SELF_DOGFOOD_ROLES: readonly SelfDogfoodRole[] = [
  'owner',
  'architect',
  'inspector',
  'engineer',
  'auditor',
];

export function isSelfDogfoodRole(value: unknown): value is SelfDogfoodRole {
  return typeof value === 'string' && (SELF_DOGFOOD_ROLES as readonly string[]).includes(value);
}

let invocationDeclaration: SelfDogfoodCommandDeclaration | undefined;

/** Hold the declaration the CLI resolved for the current invocation. */
export function declareSelfDogfoodInvocation(
  declaration: SelfDogfoodCommandDeclaration | undefined,
): void {
  invocationDeclaration = declaration === undefined ? undefined : Object.freeze({ ...declaration });
}

export function selfDogfoodInvocationDeclaration(): SelfDogfoodCommandDeclaration | undefined {
  return invocationDeclaration;
}

/**
 * Read the policy the repository carries, or report that it carries none.
 *
 * The policy governs only the framework's own repository: an adopter without
 * the file, or with a policy whose subject names another repository, is not
 * governed by it. A present but unreadable policy is handed to the service
 * as-is so it fails closed as an invalid policy rather than disappearing.
 */
export function readSelfDogfoodPolicy(
  repoRoot: string,
): { readonly applies: false } | { readonly applies: true; readonly policy: unknown } {
  const path = join(repoRoot, SELF_DOGFOOD_POLICY_PATH);
  if (!existsSync(path)) return { applies: false };
  let policy: unknown;
  try {
    policy = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return { applies: true, policy: undefined };
  }
  const subject =
    typeof policy === 'object' && policy !== null && !Array.isArray(policy)
      ? (policy as { readonly scope?: { readonly subject?: unknown } }).scope?.subject
      : undefined;
  if (subject !== undefined && subject !== SELF_DOGFOOD_SUBJECT) return { applies: false };
  return { applies: true, policy };
}

/**
 * Decide one sensing command on the repository it targets.
 *
 * Publication is refused before the policy is parsed (IA-003). A repository
 * that does not carry the framework's policy is unaffected.
 */
export function gateSelfDogfoodCommand(input: {
  readonly repoRoot: string;
  readonly action_id: SelfDogfoodSenseAction;
  readonly declaration: SelfDogfoodCommandDeclaration | undefined;
  readonly population?: SelfDogfoodPopulation;
  readonly reading?: SelfDogfoodReadingAttribution;
}): SelfDogfoodCommandGate {
  const declaration = input.declaration;
  const base = {
    applies: true as const,
    policy: SELF_DOGFOOD_POLICY_PATH,
    action_id: input.action_id,
    declared_role: declaration?.role ?? null,
    write_consent: declaration?.write_consent === true,
  };
  if (declaration?.publish === true) {
    if (!existsSync(join(input.repoRoot, SELF_DOGFOOD_POLICY_PATH))) return { applies: false };
    return { ...base, decision: { ok: false, reasons: ['publication-attempted'] } };
  }
  const loaded = readSelfDogfoodPolicy(input.repoRoot);
  if (!loaded.applies) return { applies: false };
  const decision = authorizeSelfDogfoodCheck(loaded.policy, {
    human_invoked: declaration?.human_invoked === true,
    role: declaration?.role,
    action_id: input.action_id,
    check_id: input.action_id,
    effect:
      input.action_id === 'sense run'
        ? (input.population?.aggregate_effect ?? 'read')
        : 'harness-write',
    write_consent: declaration?.write_consent === true,
    publish: false,
    ...(input.population === undefined
      ? {}
      : { population_effects: input.population.member_effects }),
    ...(input.reading === undefined ? {} : { reading: input.reading }),
  });
  return { ...base, decision };
}

/**
 * The structured fail-closed refusal a sensing command writes to stderr.
 * `POLICY_DENY` is the stable routing-authority code; the policy's own
 * fail-closed identifiers travel in `context.reasons`.
 */
export function selfDogfoodRefusal(
  gate: Extract<SelfDogfoodCommandGate, { readonly applies: true }>,
): string {
  const reasons = gate.decision.ok ? [] : gate.decision.reasons;
  return `${JSON.stringify({
    schemaVersion: '1.0.0',
    code: 'POLICY_DENY',
    class: 'routing-authority',
    exit: 2,
    message: `self-dogfood policy refused ${gate.action_id}: ${reasons.join(', ')}`,
    remediation:
      'Declare a role the self-dogfood matrix admits for this action, with the consent it requires; publication is never admitted.',
    refs: { doc: 'law/adr/ADR-SCR-0001-self-sensing-under-declared-roles.md' },
    context: {
      policy: gate.policy,
      action_id: gate.action_id,
      declared_role: gate.declared_role,
      write_consent: gate.write_consent,
      reasons,
    },
  })}\n`;
}

/**
 * The declaration a sensing handler decides under: the role and consent the
 * pre-dispatch authority layer resolved when it resolved one, otherwise the
 * declaration the CLI captured for a read-effect `sense run`, whose flags the
 * generic authority layer does not accept.
 */
export function resolveSelfDogfoodDeclaration(
  authority:
    | Readonly<{
        actor: Readonly<{ kind: 'human'; role: string; declaration_source: string }>;
        consent: Readonly<{ write: boolean; allow_publish: boolean }>;
      }>
    | undefined,
): SelfDogfoodCommandDeclaration | undefined {
  const captured = selfDogfoodInvocationDeclaration();
  if (authority === undefined) return captured;
  return Object.freeze({
    role: isSelfDogfoodRole(authority.actor.role) ? authority.actor.role : undefined,
    human_invoked: authority.actor.kind === 'human',
    declaration_source: authority.actor.declaration_source,
    write_consent: authority.consent.write,
    publish: authority.consent.allow_publish || captured?.publish === true,
  });
}
