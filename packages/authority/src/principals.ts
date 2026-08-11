import {
  HUMAN_ROLES,
  type CallerDeclarablePrincipal,
  type HumanRole,
  type Principal,
} from './types.js';

export type DeclareHumanPrincipalInput =
  | Readonly<{
      role: string;
      source: 'cli-flag';
      declared_at: string;
      session_id?: never;
    }>
  | Readonly<{
      role: string;
      source: 'session-state';
      session_id: string;
      declared_at: string;
    }>;

export function isHumanRole(value: string): value is HumanRole {
  return (HUMAN_ROLES as readonly string[]).includes(value);
}

/** Caller-facing declaration accepts exactly the five constitutional roles. */
export function declareHumanPrincipal(
  input: DeclareHumanPrincipalInput,
): CallerDeclarablePrincipal {
  if (!isHumanRole(input.role)) {
    throw new Error(
      `principal '${input.role}' is not caller-declarable; expected one of ${HUMAN_ROLES.join(', ')}`,
    );
  }
  if (input.source === 'cli-flag' && input.session_id !== undefined) {
    throw new Error('session_id is forbidden for cli-flag declarations');
  }
  if (
    input.source === 'session-state' &&
    (input.session_id === undefined || input.session_id.trim().length === 0)
  ) {
    throw new Error('session_id must not be empty');
  }
  if (Number.isNaN(Date.parse(input.declared_at))) {
    throw new Error('declared_at must be an ISO-compatible timestamp');
  }
  if (input.source === 'cli-flag') {
    return {
      kind: 'human',
      role: input.role,
      declaration: { source: 'cli-flag', declared_at: input.declared_at },
    };
  }
  return {
    kind: 'human',
    role: input.role,
    declaration: {
      source: 'session-state',
      session_id: input.session_id,
      declared_at: input.declared_at,
    },
  };
}

export function isCallerDeclarablePrincipal(
  principal: Principal,
): principal is CallerDeclarablePrincipal {
  return principal.kind === 'human';
}
