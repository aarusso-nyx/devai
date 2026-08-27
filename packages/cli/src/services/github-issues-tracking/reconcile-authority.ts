/**
 * Derived authority for CI reconciliation.
 *
 * The problem this solves: projecting a batch is a `remote-write` effect, and
 * the authority layer requires a human role declaration for those. CI has no
 * human, and declaring `--as-role owner` from a workflow would be exactly the
 * silent role elevation Article 7 forbids.
 *
 * The resolution is that CI does not need a *new* authority decision. The Owner
 * already made one, at activation, and it is explicit about being standing:
 * activation authorizes automatic publication of that round's validated
 * public-safe events. Reconciliation replays that recorded decision. It never
 * grants one.
 *
 * This mirrors the pattern `round close --post-merge-receipt` already
 * establishes: caller-declared identity is forbidden outright, authority is
 * derived from a verified artifact, and the resulting effect scope is bounded
 * to exactly what that artifact covers. Nothing here widens a fail-closed
 * property — the derived scope is strictly narrower than a live Owner session,
 * which could write anywhere Owner authority reaches. This one can append to a
 * single round's delivery state and talk to `gh`. That is all.
 */
import {
  createAuthorityDecisionIssuer,
  existsSync,
  readFileSync,
  type AuthorityHostEffectRequest,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { randomUUID } from 'node:crypto';
import { validators } from '@devai-nyx/schemas';
import { canonicalSha256 } from '@devai-nyx/utils';
import type { RoundTrackingActivation } from '@devai-nyx/loop';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  readBoundTrackingConfig,
  TRACKING_WORKFLOW_RELATIVE,
  verifyTrackingBinding,
} from './config.js';

export class TrackingAuthorityError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'TrackingAuthorityError';
  }
}

function refuse(code: string): never {
  throw new TrackingAuthorityError(code);
}

export interface ReconcileAuthorization {
  readonly round: string;
  readonly repository: string;
  readonly issue: number | null;
  readonly activation: RoundTrackingActivation;
}

export interface VerifyReconcileAuthorizationOptions {
  readonly repoRoot: string;
  readonly round: string;
  /**
   * The repository the runner reports it is executing in. Checking it stops a
   * fork, or a repository that merely copied the committed activation, from
   * replaying an authorization that was never granted for it.
   */
  readonly observedRepository?: string;
}

/**
 * Resolve the Owner authorization a reconciliation may replay, or refuse.
 *
 * Every check is fail-closed and none of them can be satisfied by the caller:
 * they are satisfied only by committed state that an Architect binding and an
 * Owner activation already produced.
 */
export function verifyReconcileAuthorization(
  options: VerifyReconcileAuthorizationOptions,
): ReconcileAuthorization {
  const repoRoot = resolve(options.repoRoot);

  const config = readBoundTrackingConfig(repoRoot);
  if (config === undefined) refuse('TRACKING_RECONCILE_BINDING_ABSENT');

  const workflowPath = join(repoRoot, TRACKING_WORKFLOW_RELATIVE);
  const workflow = existsSync(workflowPath) ? readFileSync(workflowPath, 'utf8') : undefined;
  if (verifyTrackingBinding({ repoRoot, config, workflow }).length > 0) {
    refuse('TRACKING_RECONCILE_BINDING_INVALID');
  }

  const activationPath = join(repoRoot, '.devai/state/tracking', options.round, 'activation.json');
  if (!existsSync(activationPath)) refuse('TRACKING_RECONCILE_ACTIVATION_ABSENT');

  let activation: RoundTrackingActivation;
  try {
    const parsed: unknown = JSON.parse(readFileSync(activationPath, 'utf8'));
    if (!validators.roundTrackingActivation(parsed)) {
      refuse('TRACKING_RECONCILE_ACTIVATION_INVALID');
    }
    activation = parsed as RoundTrackingActivation;
  } catch (error) {
    if (error instanceof TrackingAuthorityError) throw error;
    refuse('TRACKING_RECONCILE_ACTIVATION_INVALID');
  }

  if (activation.round_id !== options.round) refuse('TRACKING_RECONCILE_ROUND_MISMATCH');
  // `frozen` deliberately stops projecting; `disabled` ends it. Neither is a
  // standing authorization to publish.
  if (activation.state !== 'active') refuse('TRACKING_RECONCILE_ACTIVATION_INACTIVE');
  if (
    activation.authorization.role !== 'owner' ||
    activation.authorization.publish_flag !== true ||
    activation.disclosure_profile !== 'public-safe-v1'
  ) {
    refuse('TRACKING_RECONCILE_ACTIVATION_INVALID');
  }

  // A re-binding is an Architect act. An older Owner authorization must never
  // be carried across one silently.
  if (activation.adapter.config_digest_sha256 !== canonicalSha256(config.defaults)) {
    refuse('TRACKING_RECONCILE_BINDING_STALE');
  }
  if (activation.adapter.workflow_digest_sha256 !== config.digests.workflow_sha256) {
    refuse('TRACKING_RECONCILE_BINDING_STALE');
  }

  const repository = config.binding.repository;
  if (activation.target?.repository !== undefined && activation.target.repository !== repository) {
    refuse('TRACKING_RECONCILE_REPOSITORY_MISMATCH');
  }
  if (options.observedRepository !== undefined && options.observedRepository !== repository) {
    refuse('TRACKING_RECONCILE_REPOSITORY_MISMATCH');
  }

  return {
    round: options.round,
    repository,
    issue: activation.target?.issue_number ?? null,
    activation,
  };
}

export type ReconcileEffectRequest =
  | Readonly<{ kind: 'filesystem'; target: string }>
  | Readonly<{ kind: 'process'; executable: string; args: readonly string[] }>;

function contained(candidate: string, root: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path.length > 0 && !path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path);
}

/**
 * The exact effect envelope a reconciliation may act within.
 *
 * Reconciliation is a replayer, so it may only record what the remote
 * acknowledged. Canonical events and sealed proofs are read-only to it: the
 * whole point of projecting from sealed evidence is that projection cannot
 * reach back and change what it is projecting.
 */
export function reconcileEffectPermitted(options: {
  readonly repoRoot: string;
  readonly round: string;
  readonly request: ReconcileEffectRequest;
}): boolean {
  const { repoRoot, round, request } = options;
  if (request.kind === 'filesystem') {
    const roundState = join(resolve(repoRoot), '.devai/state/tracking', round);
    if (!contained(request.target, roundState)) return false;
    // Delivery state and the outbox are mutable; the canonical event log and
    // the activation record are not.
    const segments = relative(roundState, resolve(request.target)).split(sep);
    return segments[0] === 'delivery.json' || (segments[0] === 'outbox' && segments.length > 1);
  }
  if (request.executable !== 'gh') return false;
  // Only the read/write API surface the projector actually uses.
  return request.args[0] === 'api';
}

/**
 * Build the bounded host-effect scope a reconciliation executes inside.
 *
 * Mirrors the post-merge derived scope: its own issuer, and an apply gate that
 * admits only the effects the replayed authorization actually covers. Anything
 * else — another round, the canonical event log, the activation record, any
 * process other than `gh api` — is refused at the boundary rather than trusted
 * to be avoided by the caller.
 */
export function createTrackingReconcileScope(
  repoRoot: string,
  round: string,
): { readonly scope: AuthorityHostEffectScope; readonly dispose: () => void } {
  const invocationId = `tracking-reconcile-${round}-${randomUUID()}`;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'devai-tracking-reconcile-adapter',
    issuer_version: '1.0.0',
    invocation_id: invocationId,
    canonicalSha256,
    randomId: randomUUID,
    now: () => new Date().toISOString(),
    receipt_ttl_ms: 30_000,
  });
  const applyEffect = (request: AuthorityHostEffectRequest, apply: () => unknown): unknown => {
    const permitted =
      request.kind === 'filesystem'
        ? reconcileEffectPermitted({
            repoRoot,
            round,
            request: {
              kind: 'filesystem',
              target: String(
                request.symbol === 'renameSync' ? request.arguments[1] : request.arguments[0],
              ),
            },
          })
        : reconcileEffectPermitted({
            repoRoot,
            round,
            request: {
              kind: 'process',
              executable: String(request.arguments[0]),
              args: (request.arguments[1] as readonly string[] | undefined) ?? [],
            },
          });
    if (!permitted) {
      throw new Error(
        request.kind === 'filesystem'
          ? 'TRACKING_RECONCILE_EFFECT_OUT_OF_SCOPE'
          : 'TRACKING_RECONCILE_PROCESS_FORBIDDEN',
      );
    }
    return apply();
  };
  return {
    scope: Object.freeze({
      action_id: 'round tracking sync',
      invocation_id: invocationId,
      effect: 'remote-write',
      receipt_store: issuer,
      apply_effect: applyEffect,
    }) as AuthorityHostEffectScope,
    dispose: () => {
      issuer.dispose();
    },
  };
}
