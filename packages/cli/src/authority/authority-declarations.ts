import type { RegistryEntry } from '../define-command.js';
import {
  type HumanRole,
  ROLES,
  taggedFailure,
  type CliResult,
  formatFor,
  renderAuthorityResult,
  SESSION_ID,
} from './authority-results.js';
import { routeRoles } from './authority-registry.js';
import {
  targetRoot,
  taggedAuthorityFailure,
  sessionRole,
  authorityBindingMissing,
} from './authority-session.js';

/**
 * The conditional --out write of a governance render: one declaration, write consent,
 * and the Architect role; the refusal it earns, or undefined when it is admitted.
 */
export function governedRenderDeclarationRefusal(
  argv: readonly string[],
  entry: RegistryEntry,
  asRole: string | undefined,
  sessionId: string | undefined,
  format: ReturnType<typeof formatFor>,
  entries: readonly RegistryEntry[],
): CliResult | undefined {
  if (asRole !== undefined && sessionId !== undefined) {
    return renderAuthorityResult(
      taggedFailure('usage-error', 'AUTHORITY_DECLARATION_CONFLICT'),
      format,
    );
  }
  if (asRole === undefined && sessionId === undefined) {
    return renderAuthorityResult(
      taggedFailure('usage-error', 'AUTHORITY_DECLARATION_MISSING'),
      format,
    );
  }
  if (!argv.includes('--write')) {
    return renderAuthorityResult(
      taggedFailure('usage-error', 'AUTHORITY_WRITE_CONSENT_REQUIRED'),
      format,
    );
  }
  const resolvedSession =
    sessionId === undefined ? undefined : sessionRole(sessionId, targetRoot(entry, argv), entries);
  if (resolvedSession && resolvedSession.ok !== true) {
    return renderAuthorityResult(resolvedSession, format);
  }
  const role =
    asRole === undefined ? (resolvedSession as { role: HumanRole } | undefined)?.role : asRole;
  if (role !== 'architect') {
    return renderAuthorityResult(
      taggedFailure('refused', 'AUTHORITY_HUMAN_ROLE_DENIED', {
        action_id: entry.name,
        allowed_roles: ['architect'],
        supplied_role: role ?? null,
      }),
      format,
    );
  }
  return undefined;
}

/** A read-only action takes no human declaration or consent flag; the refusal if one is present. */
export function readDeclarationRefusal(
  argv: readonly string[],
  entry: RegistryEntry,
  asRole: string | undefined,
  sessionId: string | undefined,
  format: ReturnType<typeof formatFor>,
): CliResult | undefined {
  if (
    asRole !== undefined ||
    sessionId !== undefined ||
    argv.includes('--write') ||
    argv.includes('--publish') ||
    argv.includes('--experimental')
  ) {
    return renderAuthorityResult(
      taggedFailure('usage-error', 'AUTHORITY_DECLARATION_NOT_APPLICABLE', {
        action_id: entry.name,
        effect: entry.effects,
        declared: {
          as_role: asRole !== undefined,
          authority_session: sessionId !== undefined,
          write: argv.includes('--write'),
          allow_publish: argv.includes('--publish'),
          experimental: argv.includes('--experimental'),
        },
        required: entry.authority_contract.consent,
      }),
      format,
    );
  }
  return undefined;
}

/** The shape refusals of a mutating declaration before any session is resolved. */
export function mutatingDeclarationRefusal(
  argv: readonly string[],
  entry: RegistryEntry,
  asRole: string | undefined,
  sessionId: string | undefined,
  format: ReturnType<typeof formatFor>,
): CliResult | undefined {
  if (argv.includes('--machine-actor')) {
    return renderAuthorityResult(
      taggedFailure('usage-error', 'AUTHORITY_MACHINE_DECLARATION_FORBIDDEN'),
      format,
    );
  }
  if (asRole !== undefined && sessionId !== undefined) {
    return renderAuthorityResult(
      taggedFailure('usage-error', 'AUTHORITY_DECLARATION_CONFLICT'),
      format,
    );
  }
  if (asRole === undefined && sessionId === undefined) {
    if (entry.name === 'check' && authorityBindingMissing(entry, argv)) {
      return renderAuthorityResult(
        taggedAuthorityFailure('refused', 'AUTHORITY_POLICY_MISSING', entry, argv),
        format,
      );
    }
    return renderAuthorityResult(
      taggedFailure('usage-error', 'AUTHORITY_DECLARATION_MISSING'),
      format,
    );
  }
  if (sessionId !== undefined && !SESSION_ID.test(sessionId)) {
    return renderAuthorityResult(
      taggedFailure('usage-error', 'AUTHORITY_SESSION_ID_INVALID'),
      format,
    );
  }
  if (asRole !== undefined && !ROLES.has(asRole as HumanRole)) {
    return renderAuthorityResult(
      taggedFailure('usage-error', 'AUTHORITY_DECLARATION_INVALID'),
      format,
    );
  }
  return undefined;
}

/** The route role, write consent and publish consent refusals of a resolved declaration. */
export function declaredRoleConsentRefusal(
  argv: readonly string[],
  entry: RegistryEntry,
  asRole: string | undefined,
  sessionId: string | undefined,
  format: ReturnType<typeof formatFor>,
  role: string | undefined,
): CliResult | undefined {
  if (!role || !routeRoles(entry, argv).includes(role as HumanRole)) {
    return renderAuthorityResult(
      taggedFailure('refused', 'AUTHORITY_HUMAN_ROLE_DENIED', {
        action_id: entry.name,
        allowed_roles: routeRoles(entry, argv),
        supplied_role: role ?? null,
      }),
      format,
    );
  }
  if (!argv.includes('--write')) {
    return renderAuthorityResult(
      taggedFailure('usage-error', 'AUTHORITY_WRITE_CONSENT_REQUIRED'),
      format,
    );
  }
  if (
    entry.effects === 'remote-write' &&
    !argv.includes('--dry-run') &&
    !argv.includes('--publish')
  ) {
    return renderAuthorityResult(
      taggedFailure('usage-error', 'AUTHORITY_PUBLISH_CONSENT_REQUIRED'),
      format,
    );
  }
  // Experimental consent is explicit and exact (ADR-MDL-0005 D-1, ADR-MDL-0006): an
  // experimental action needs --experimental, and no other action may receive it.
  const experimental = entry.authority_contract.consent.experimental === true;
  if (experimental && !argv.includes('--experimental')) {
    return renderAuthorityResult(
      taggedFailure('usage-error', 'AUTHORITY_EXPERIMENTAL_CONSENT_REQUIRED', {
        action_id: entry.name,
      }),
      format,
    );
  }
  if (!experimental && argv.includes('--experimental')) {
    return renderAuthorityResult(
      taggedFailure('usage-error', 'AUTHORITY_DECLARATION_NOT_APPLICABLE', {
        action_id: entry.name,
        effect: entry.effects,
        declared: { experimental: true },
        required: entry.authority_contract.consent,
      }),
      format,
    );
  }
  return undefined;
}

/** The plan-only allow result of a declaration that requested no effect. */
export function planOnlyAuthorityAllow(role: string, sessionId: string | undefined) {
  return {
    ok: true,
    authority: {
      code: 'POLICY_ALLOW',
      principal: {
        kind: 'human',
        role,
        declaration_source: sessionId === undefined ? 'cli-flag' : 'session-state',
        ...(sessionId === undefined ? {} : { session_id: sessionId }),
      },
      origin:
        sessionId === undefined
          ? { kind: 'direct-cli' }
          : { kind: 'interactive-session', session_id: sessionId },
      readiness_eligible: false,
    },
    applied: false,
  };
}
