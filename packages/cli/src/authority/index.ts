import { dirname, join, resolve } from 'node:path';
import {
  existsSync,
  lstatSync,
  realpathSync,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
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
  flagValue,
  type FailureCategory,
  taggedFailure,
  handleBoundaryError,
  type CliResult,
  formatFor,
  renderAuthorityResult,
  authorityErrorCode,
} from './authority-results.js';
import { entryForArgv } from './authority-registry.js';
import {
  targetRoot,
  authorityDecisionRecordable,
  taggedAuthorityFailure,
  sessionRole,
} from './authority-session.js';
import {
  declaredRoleConsentRefusal,
  governedRenderDeclarationRefusal,
  mutatingDeclarationRefusal,
  planOnlyAuthorityAllow,
  readDeclarationRefusal,
} from './authority-declarations.js';
import {
  clearResolvedInvocationAuthority,
  declaredInvocationRole,
  rememberResolvedInvocationAuthority,
} from './invocation-authority.js';
export { declaredInvocationAuthority, declaredInvocationRole } from './invocation-authority.js';

export { createAuthorityCliHarness, stripAuthorityArgv } from './authority-harness.js';
export { authorityDecisionRecordable } from './authority-session.js';
export {
  compileAdopterAuthorityExtension,
  DEFAULT_ADOPTER_TEST_SELECTORS,
  type AdopterAuthorityBlock,
  type AdopterAuthorityExtension,
} from './policy-adopter-extension.js';
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

let pendingHostScope: AuthorityHostEffectScope | undefined;
let pendingHostDispose: (() => void) | undefined;
let pendingHostDryRun = false;
let pendingSessionOperation: (() => unknown) | undefined;
let pendingPolicyMaterialization: (() => unknown) | undefined;
let pendingExactCommit: (() => void) | undefined;
let pendingProofBaselineGate = false;
let invocationDisposalFailed = false;

/** ADR-EVI-0002: the one path the gated `evidence verify --scope chain --write` may write. */
const PROOF_ANCHOR_BASELINE_PATH = 'record/proofs/anchor-baseline.json';

/**
 * Owner decision of 2026-10-01: `evidence verify` stays `read`, and its one conditional write,
 * the anchor baseline, is authorized only by `--write` consent at invocation, following the
 * `docs decisions render --out` precedent below.
 */
function proofAnchorBaselineWrite(entry: RegistryEntry, argv: readonly string[]): boolean {
  return (
    entry.name === 'evidence verify' &&
    flagValue(argv, '--scope') === 'chain' &&
    argv.includes('--write')
  );
}

/**
 * Derives, from the ordinary read scope, a scope that admits exactly the baseline file (and the
 * creation of its `record/proofs` directory) and nothing broader. Every other filesystem effect is
 * refused as a read-action mutation; process effects keep the read broker's admission.
 */
function admitProofAnchorBaselineWrite(
  scope: AuthorityHostEffectScope,
  root: string,
): AuthorityHostEffectScope {
  const baseline = resolve(root, PROOF_ANCHOR_BASELINE_PATH);
  const directory = dirname(baseline);
  const physicalDirectory = (): boolean =>
    existsSync(root) &&
    (!existsSync(directory) ||
      realpathSync(directory) === join(realpathSync(root), 'record/proofs'));
  return Object.freeze({
    ...scope,
    effect: 'harness-write' as const,
    apply_effect: (
      request: Parameters<AuthorityHostEffectScope['apply_effect']>[0],
      apply: () => unknown,
    ) => {
      if (request.kind !== 'filesystem') return scope.apply_effect(request, apply);
      const target = request.arguments[0];
      if (
        request.symbol === 'writeFileSync' &&
        typeof target === 'string' &&
        resolve(target) === baseline &&
        physicalDirectory() &&
        (!existsSync(baseline) || lstatSync(baseline).isFile())
      ) {
        return apply();
      }
      if (
        request.symbol === 'mkdirSync' &&
        typeof target === 'string' &&
        resolve(target) === directory &&
        !existsSync(directory)
      ) {
        return apply();
      }
      throw new Error('AUTHORITY_READ_ACTION_MUTATION_FORBIDDEN');
    },
  });
}

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
  pendingProofBaselineGate = false;
  clearResolvedInvocationAuthority();
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
    entry.name === 'init bind' ||
    entry.name === 'init upgrade';
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
      const proofBaselineGate = pendingProofBaselineGate;
      pendingHostScope = undefined;
      pendingHostDispose = undefined;
      pendingHostDryRun = false;
      pendingSessionOperation = undefined;
      pendingPolicyMaterialization = undefined;
      pendingExactCommit = undefined;
      pendingProofBaselineGate = false;
      const expectedEffect = proofBaselineGate
        ? 'harness-write'
        : dryRun
          ? 'read'
          : invocationEntry.effects;
      if (
        !scope ||
        !dispose ||
        scope.action_id !== entry.name ||
        scope.effect !== expectedEffect ||
        (proofBaselineGate && !proofAnchorBaselineWrite(invocationEntry, process.argv))
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
  clearResolvedInvocationAuthority();
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
      argv.includes('--experimental') ||
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
      argv.includes('--experimental') ||
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
    const refusal = governedRenderDeclarationRefusal(
      argv,
      entry,
      asRole,
      sessionId,
      format,
      entries,
    );
    if (refusal !== undefined) return refusal;
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
  if (proofAnchorBaselineWrite(entry, argv)) {
    // The registry remains read. `--write` is the consent for the one baseline write; every other
    // declaration a read action refuses is still refused.
    const refusal = readDeclarationRefusal(
      argv.filter((value) => value !== '--write'),
      entry,
      asRole,
      sessionId,
      format,
    );
    if (refusal !== undefined) return refusal;
    try {
      stageHostScope(entry, entries, argv, 'owner', { as_role: 'owner' });
      if (pendingHostScope === undefined) throw new Error('AUTHORITY_FINAL_BOUNDARY_REQUIRED');
      pendingHostScope = admitProofAnchorBaselineWrite(pendingHostScope, targetRoot(entry, argv));
      pendingProofBaselineGate = true;
    } catch (error) {
      const code = authorityErrorCode(error);
      if (code === undefined) throw error;
      return renderAuthorityResult(taggedAuthorityFailure('refused', code, entry, argv), format);
    }
    return undefined;
  }
  if (entry.effects === 'read') {
    const refusal = readDeclarationRefusal(argv, entry, asRole, sessionId, format);
    if (refusal !== undefined) return refusal;
    try {
      stageHostScope(entry, entries, argv, 'owner', { as_role: 'owner' });
    } catch (error) {
      const code = authorityErrorCode(error);
      if (code === undefined) throw error;
      return renderAuthorityResult(taggedAuthorityFailure('refused', code, entry, argv), format);
    }
    return undefined;
  }
  const declarationRefusal = mutatingDeclarationRefusal(argv, entry, asRole, sessionId, format);
  if (declarationRefusal !== undefined) return declarationRefusal;
  const resolvedSession =
    sessionId === undefined ? undefined : sessionRole(sessionId, targetRoot(entry, argv), entries);
  if (resolvedSession && resolvedSession.ok !== true) {
    return renderAuthorityResult(resolvedSession, format);
  }
  const role =
    asRole === undefined ? (resolvedSession as { role: HumanRole } | undefined)?.role : asRole;
  const roleRefusal = declaredRoleConsentRefusal(argv, entry, asRole, sessionId, format, role);
  if (roleRefusal !== undefined) return roleRefusal;
  const handlerSupportsDryRun = entry.runtime_options?.some(
    (option) => option.flags === '--dry-run',
  );
  if (argv.includes('--plan') || (argv.includes('--dry-run') && !handlerSupportsDryRun)) {
    return renderAuthorityResult(planOnlyAuthorityAllow(role as string, sessionId), format);
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
