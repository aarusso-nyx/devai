import { resolve } from 'node:path';

import { runWithAuthorityHostEffects, type AuthorityHostEffectScope } from '@devai-nyx/authority';
import type { Command } from 'cac';

import {
  createPostMergeHostScope,
  verifyPostMergeHostReceipt,
} from '@devai-nyx/skills/post-merge-auditor';
import type { RegistryEntry } from '../define-command.js';

import { invocationIsNonMutating } from '../command-router.js';
import { createAuthorityHostBroker } from './broker.js';
import { resolveInvocationEntry } from './sense-selection.js';
import {
  runWithAuthorityPolicyMaterialization,
  runWithAuthoritySessionOperation,
} from './command-capabilities.js';

import { trackGovernanceEvent } from '@devai-nyx/loop';
import {
  createTrackingReconcileScope,
  TrackingAuthorityError,
  verifyReconcileAuthorization,
} from '../services/github-issues-tracking/reconcile-authority.js';
import { resolveCliVersion } from '../version.js';
import {
  type HumanRole,
  ROLES,
  flagValue,
  type FailureCategory,
  taggedFailure,
  handleBoundaryError,
  type CliResult,
  formatFor,
  renderAuthorityResult,
  authorityErrorCode,
  SESSION_ID,
} from './authority-results.js';
import { entryForArgv, routeRoles } from './authority-registry.js';
import {
  targetRoot,
  authorityDecisionRecordable,
  taggedAuthorityFailure,
  sessionRole,
  authorityBindingMissing,
} from './authority-session.js';
export { createAuthorityCliHarness, stripAuthorityArgv } from './authority-harness.js';
export { authorityDecisionRecordable } from './authority-session.js';
export {
  buildAuthorityActionRegistry,
  validateLiveAuthorityActionRegistry,
  actionId,
  allowedRoles,
  entryForArgv,
  routeRoles,
  targetFor,
} from './authority-registry.js';
export {
  renderAuthorityResult,
  authorityErrorCode,
  authorityErrorContext,
  authorityRemediation,
  canonical,
  flagValue,
  formatFor,
  taggedFailure,
} from './authority-results.js';
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
      experimental: false;
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
        experimental: false;
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

function rememberResolvedInvocationAuthority(
  role: HumanRole,
  declarationSource: 'cli-flag' | 'session-state',
  argv: readonly string[],
): void {
  // A stable action cannot acquire experimental consent. Keeping the context
  // absent fails closed if a caller somehow routes that undeclared flag past
  // command parsing instead of letting a handler reinterpret it.
  if (argv.includes('--experimental')) return;
  resolvedInvocationRole = role;
  resolvedInvocationDeclarationSource = declarationSource;
  resolvedInvocationConsent = Object.freeze({
    write: true,
    allow_publish: argv.includes('--publish'),
    experimental: false,
  });
}

let pendingHostScope: AuthorityHostEffectScope | undefined;
let pendingHostDispose: (() => void) | undefined;
let pendingHostDryRun = false;
let pendingSessionOperation: (() => unknown) | undefined;
let pendingPolicyMaterialization: (() => unknown) | undefined;
let pendingExactCommit: (() => void) | undefined;
let invocationDisposalFailed = false;

function guardedInvocationDisposal(dispose: () => void): () => void {
  return () => {
    try {
      dispose();
    } catch (error) {
      invocationDisposalFailed = true;
      throw error;
    }
  };
}

/** End one CLI invocation, including authorization followed by a parser failure.
 * Clear every capability reference before disposal, even when disposal throws. */
export function disposeCliInvocationAuthority(): void {
  const dispose = pendingHostDispose;
  pendingHostScope = undefined;
  pendingHostDispose = undefined;
  pendingHostDryRun = false;
  pendingSessionOperation = undefined;
  pendingPolicyMaterialization = undefined;
  pendingExactCommit = undefined;
  resolvedInvocationRole = undefined;
  resolvedInvocationDeclarationSource = undefined;
  resolvedInvocationConsent = undefined;
  dispose?.();
  if (invocationDisposalFailed) throw new Error('AUTHORITY_INVOCATION_DISPOSAL_FAILED');
}

function stageHostScope(
  entry: RegistryEntry,
  entries: readonly RegistryEntry[],
  argv: readonly string[],
  role: HumanRole,
  declaration: Readonly<{ as_role: HumanRole } | { authority_session: string }>,
  dryRun = false,
): void {
  const root = targetRoot(entry, argv);
  const bootstrapPolicy =
    dryRun ||
    entry.effects === 'read' ||
    entry.name === 'init apply owner' ||
    entry.name === 'init apply architect' ||
    entry.name === 'init apply harness' ||
    entry.name === 'init bind';
  const broker = createAuthorityHostBroker({
    entry,
    entries,
    argv,
    role,
    declaration,
    repository_root: root,
    package_version: resolveCliVersion(),
    bootstrap_policy: bootstrapPolicy,
  });
  pendingHostScope = dryRun ? Object.freeze({ ...broker.scope, effect: 'read' }) : broker.scope;
  pendingHostDispose = guardedInvocationDisposal(broker.dispose);
  pendingHostDryRun = dryRun;
  pendingSessionOperation = broker.session_operation;
  pendingPolicyMaterialization = broker.policy_materialization;
  pendingExactCommit = broker.commit_exact;
}

/**
 * Record that authority allowed this invocation.
 *
 * Only granted decisions are recorded. A refused invocation has, by
 * definition, no authorized scope to write in, and manufacturing one so the
 * harness could note the refusal would grant an effect the decision just
 * denied. That boundary is deliberate, and it is stated in the adopter docs
 * rather than left for a reader to discover as missing coverage.
 */
function recordAuthorityDecision(entry: RegistryEntry, dryRun: boolean): void {
  const round = flagValue(process.argv, '--round');
  const role = declaredInvocationRole();
  if (!authorityDecisionRecordable(entry, { dryRun, round, role })) return;
  trackGovernanceEvent({
    repoRoot: targetRoot(entry, process.argv),
    round: round as string,
    role: role as HumanRole,
    kind: 'authorization_recorded',
    summary: `Authority allowed ${entry.name} for role ${String(role)} with effect ${entry.effects}.`,
    payload: { action_id: entry.name, effect: entry.effects, role },
  });
}

export function attachAuthorityCommandBoundaries(
  commands: readonly Command[],
  entries: readonly RegistryEntry[],
): void {
  for (const entry of entries) {
    const command = commands.find((candidate) => candidate.name === entry.internal_name);
    const original = command?.commandAction;
    if (!command || !original) continue;
    if (entry.effects !== 'read') {
      command.option('--as-role <role>', 'Declare the initiating human role.');
      command.option(
        '--authority-session <id>',
        'Use a live repository-bound authority session instead of --as-role.',
      );
    }
    command.commandAction = function governedCommandAction(...args: unknown[]) {
      const invocationEntry = resolveInvocationEntry(entry, process.argv);
      const scope = pendingHostScope;
      const dispose = pendingHostDispose;
      const dryRun = pendingHostDryRun;
      const sessionOperation = pendingSessionOperation;
      const policyMaterialization = pendingPolicyMaterialization;
      const exactCommit = pendingExactCommit;
      pendingHostScope = undefined;
      pendingHostDispose = undefined;
      pendingHostDryRun = false;
      pendingSessionOperation = undefined;
      pendingPolicyMaterialization = undefined;
      pendingExactCommit = undefined;
      if (
        !scope ||
        !dispose ||
        scope.action_id !== entry.name ||
        scope.effect !== (dryRun ? 'read' : invocationEntry.effects)
      ) {
        dispose?.();
        throw new Error('AUTHORITY_FINAL_BOUNDARY_REQUIRED');
      }
      try {
        const result = runWithAuthoritySessionOperation(sessionOperation, () =>
          runWithAuthorityPolicyMaterialization(policyMaterialization, () =>
            runWithAuthorityHostEffects(scope, () => {
              // Inside the authorized scope, so the write is legal, and before
              // the handler, so the decision is recorded even if the handler
              // then fails.
              recordAuthorityDecision(invocationEntry, dryRun);
              return Reflect.apply(original, this, args);
            }),
          ),
        );
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
          return Promise.resolve(result).then(
            (value) => {
              if (!dryRun) exactCommit?.();
              dispose();
              return value;
            },
            (error: unknown) => {
              dispose();
              return handleBoundaryError(error);
            },
          );
        }
        if (!dryRun) exactCommit?.();
        dispose();
        return result;
      } catch (error) {
        dispose();
        return handleBoundaryError(error);
      }
    };
  }
}

export function authorizeCliArgv(
  argv: readonly string[],
  entries: readonly RegistryEntry[],
): CliResult | undefined {
  resolvedInvocationRole = undefined;
  resolvedInvocationDeclarationSource = undefined;
  resolvedInvocationConsent = undefined;
  if (argv.some((value) => value === '--help' || value === '-h')) {
    return undefined;
  }
  const registeredEntry = entryForArgv(argv, entries);
  if (!registeredEntry) return undefined;
  const entry = resolveInvocationEntry(registeredEntry, argv);
  if (entry.name === 'round close' && argv.includes('--post-merge-receipt')) {
    const format = formatFor(argv);
    if (
      argv.includes('--as-role') ||
      argv.includes('--authority-session') ||
      argv.includes('--write') ||
      argv.includes('--machine-actor')
    ) {
      return renderAuthorityResult(
        taggedFailure('usage-error', 'HOST_RECEIPT_CALLER_AUTHORITY_FORBIDDEN'),
        format,
      );
    }
    if (flagValue(argv, '--host-receipt') === undefined) {
      return renderAuthorityResult(taggedFailure('usage-error', 'HOST_RECEIPT_MISSING'), format);
    }
    try {
      // Verify through a temporary read boundary, then replace it with the
      // exact derived harness-write scope. No caller-selected human identity
      // survives into the post-merge transition.
      stageHostScope(entry, entries, argv, 'owner', { as_role: 'owner' }, true);
      const readScope = pendingHostScope;
      const readDispose = pendingHostDispose;
      pendingHostScope = undefined;
      pendingHostDispose = undefined;
      pendingHostDryRun = false;
      if (readScope === undefined || readDispose === undefined) {
        throw new Error('HOST_RECEIPT_READ_BOUNDARY_MISSING');
      }
      let verified: ReturnType<typeof verifyPostMergeHostReceipt>;
      try {
        verified = runWithAuthorityHostEffects(readScope, () =>
          verifyPostMergeHostReceipt({
            repoRoot: targetRoot(entry, argv),
            hostReceiptPath: resolve(flagValue(argv, '--host-receipt') ?? ''),
            devaiVersion: resolveCliVersion(),
          }),
        );
      } finally {
        readDispose();
      }
      const derived = createPostMergeHostScope(targetRoot(entry, argv), verified.mergeSha);
      pendingHostScope = derived.scope;
      pendingHostDispose = guardedInvocationDisposal(derived.dispose);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const code =
        authorityErrorCode(error) ??
        (/^(?:HOST_RECEIPT_|POST_MERGE_)[A-Z0-9_]+$/u.test(message) ? message : undefined);
      if (code === undefined) throw error;
      return renderAuthorityResult(taggedAuthorityFailure('refused', code, entry, argv), format);
    }
    return undefined;
  }
  if (entry.name === 'round tracking sync' && argv.includes('--reconcile')) {
    const format = formatFor(argv);
    // Reconciliation replays an authorization the Owner already recorded. A
    // caller-supplied identity or consent flag would be claiming an authority
    // no one is present to hold, so all of them are refused outright — the same
    // rule the post-merge receipt path applies.
    if (
      argv.includes('--as-role') ||
      argv.includes('--authority-session') ||
      argv.includes('--write') ||
      argv.includes('--publish') ||
      argv.includes('--machine-actor')
    ) {
      return renderAuthorityResult(
        taggedFailure('usage-error', 'TRACKING_RECONCILE_CALLER_AUTHORITY_FORBIDDEN'),
        format,
      );
    }
    const round = flagValue(argv, '--round');
    if (round === undefined) {
      return renderAuthorityResult(taggedFailure('usage-error', 'TRACKING_ROUND_REQUIRED'), format);
    }
    try {
      const repoRoot = targetRoot(entry, argv);
      // The runner's own repository identity is checked against the binding, so
      // a fork that merely copied the committed activation cannot replay it.
      const observed = process.env['GITHUB_REPOSITORY'];
      verifyReconcileAuthorization({
        repoRoot,
        round,
        ...(observed === undefined ? {} : { observedRepository: observed }),
      });
      const derived = createTrackingReconcileScope(repoRoot, round);
      pendingHostScope = derived.scope;
      pendingHostDispose = guardedInvocationDisposal(derived.dispose);
      pendingHostDryRun = false;
    } catch (error) {
      const code =
        error instanceof TrackingAuthorityError
          ? error.code
          : (authorityErrorCode(error) ?? 'TRACKING_RECONCILE_REFUSED');
      return renderAuthorityResult(taggedAuthorityFailure('refused', code, entry, argv), format);
    }
    return undefined;
  }
  if (invocationIsNonMutating(entry.internal_name, argv)) {
    try {
      stageHostScope(entry, entries, argv, 'owner', { as_role: 'owner' }, true);
    } catch (error) {
      const code = authorityErrorCode(error);
      if (code === undefined) throw error;
      const format = formatFor(argv);
      return renderAuthorityResult(taggedAuthorityFailure('refused', code, entry, argv), format);
    }
    return undefined;
  }
  const asRole = flagValue(argv, '--as-role');
  const sessionId = flagValue(argv, '--authority-session');
  const format = formatFor(argv);
  const governedRenderWrite =
    ['docs decisions render', 'docs rounds render'].includes(entry.name) &&
    flagValue(argv, '--out') !== undefined;
  if (governedRenderWrite) {
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
      sessionId === undefined
        ? undefined
        : sessionRole(sessionId, targetRoot(entry, argv), entries);
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
    try {
      // The registry remains read for stdout generation. The conditional
      // --out branch has completed its separate Architect/write-consent
      // check above and still installs the ordinary read scope so the command
      // wrapper cannot execute outside the final boundary.
      stageHostScope(entry, entries, argv, 'owner', { as_role: 'owner' });
    } catch (error) {
      const code = authorityErrorCode(error);
      if (code === undefined) throw error;
      return renderAuthorityResult(taggedAuthorityFailure('refused', code, entry, argv), format);
    }
    return undefined;
  }
  if (entry.effects === 'read') {
    if (
      asRole !== undefined ||
      sessionId !== undefined ||
      argv.includes('--write') ||
      argv.includes('--publish')
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
          },
          required: entry.authority_contract.consent,
        }),
        format,
      );
    }
    try {
      stageHostScope(entry, entries, argv, 'owner', { as_role: 'owner' });
    } catch (error) {
      const code = authorityErrorCode(error);
      if (code === undefined) throw error;
      return renderAuthorityResult(taggedAuthorityFailure('refused', code, entry, argv), format);
    }
    return undefined;
  }
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
  const resolvedSession =
    sessionId === undefined ? undefined : sessionRole(sessionId, targetRoot(entry, argv), entries);
  if (resolvedSession && resolvedSession.ok !== true) {
    return renderAuthorityResult(resolvedSession, format);
  }
  const role =
    asRole === undefined ? (resolvedSession as { role: HumanRole } | undefined)?.role : asRole;
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
  const handlerSupportsDryRun = entry.runtime_options?.some(
    (option) => option.flags === '--dry-run',
  );
  if (argv.includes('--plan') || (argv.includes('--dry-run') && !handlerSupportsDryRun)) {
    return renderAuthorityResult(
      {
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
      },
      format,
    );
  }
  if (argv.includes('--dry-run')) {
    try {
      stageHostScope(
        entry,
        entries,
        argv,
        role as HumanRole,
        sessionId === undefined ? { as_role: role as HumanRole } : { authority_session: sessionId },
        true,
      );
    } catch (error) {
      const code = authorityErrorCode(error);
      if (code === undefined) throw error;
      return renderAuthorityResult(taggedAuthorityFailure('refused', code, entry, argv), format);
    }
    rememberResolvedInvocationAuthority(
      role as HumanRole,
      sessionId === undefined ? 'cli-flag' : 'session-state',
      argv,
    );
    return undefined;
  }
  try {
    stageHostScope(
      entry,
      entries,
      argv,
      role as HumanRole,
      sessionId === undefined ? { as_role: role as HumanRole } : { authority_session: sessionId },
    );
  } catch (error) {
    const code = authorityErrorCode(error);
    if (code === undefined) throw error;
    const category: FailureCategory = code.endsWith('_UNAVAILABLE')
      ? 'dependency-error'
      : 'refused';
    return renderAuthorityResult(taggedAuthorityFailure(category, code, entry, argv), format);
  }
  rememberResolvedInvocationAuthority(
    role as HumanRole,
    sessionId === undefined ? 'cli-flag' : 'session-state',
    argv,
  );
  return undefined;
}

// Explicit test seams for small deterministic authority-state and routing helpers.
export { guardedInvocationDisposal, rememberResolvedInvocationAuthority };
