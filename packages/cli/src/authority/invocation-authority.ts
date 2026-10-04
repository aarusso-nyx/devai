import type { HumanRole } from './authority-results.js';

/**
 * The human authority the pre-dispatch layer resolved for this invocation,
 * from either `--as-role` or a validated session, together with the consent it
 * admitted. Handlers cannot read the declaration themselves — it is stripped
 * before dispatch — so anything that must attribute work or bind consent reads
 * it here rather than re-parsing argv and risking a different answer than the
 * one authority actually allowed.
 */
let resolvedInvocationRole: HumanRole | undefined;
let resolvedInvocationDeclarationSource: 'cli-flag' | 'session-state' | undefined;
let resolvedInvocationConsent:
  | Readonly<{
      write: true;
      allow_publish: boolean;
      experimental: boolean;
    }>
  | undefined;

export function declaredInvocationRole(): HumanRole | undefined {
  return resolvedInvocationRole;
}

export function declaredInvocationAuthority():
  | Readonly<{
      actor: Readonly<{
        kind: 'human';
        role: HumanRole;
        declaration_source: 'cli-flag' | 'session-state';
      }>;
      consent: Readonly<{
        write: true;
        allow_publish: boolean;
        experimental: boolean;
      }>;
    }>
  | undefined {
  return resolvedInvocationRole === undefined ||
    resolvedInvocationDeclarationSource === undefined ||
    resolvedInvocationConsent === undefined
    ? undefined
    : Object.freeze({
        actor: Object.freeze({
          kind: 'human',
          role: resolvedInvocationRole,
          declaration_source: resolvedInvocationDeclarationSource,
        }),
        consent: resolvedInvocationConsent,
      });
}

export function rememberResolvedInvocationAuthority(
  role: HumanRole,
  declarationSource: 'cli-flag' | 'session-state',
  argv: readonly string[],
): void {
  // Only an action whose registry consent requires it reaches this point with
  // --experimental: every other action refuses the flag before dispatch.
  resolvedInvocationRole = role;
  resolvedInvocationDeclarationSource = declarationSource;
  resolvedInvocationConsent = Object.freeze({
    write: true,
    allow_publish: argv.includes('--publish'),
    experimental: argv.includes('--experimental'),
  });
}

/** Forget the resolved human authority of the previous or refused invocation. */
export function clearResolvedInvocationAuthority(): void {
  resolvedInvocationRole = undefined;
  resolvedInvocationDeclarationSource = undefined;
  resolvedInvocationConsent = undefined;
}
