/**
 * Chain-identity resolution for governance tracking.
 *
 * Every governance event belongs to a hash chain, and the chain identity is
 * what makes per-session ordering meaningful. Two failure modes have to be
 * avoided at once:
 *
 *  - Minting a fresh identity per invocation. That would leave every chain one
 *    event long and turn the ordering guarantee into decoration.
 *  - Presenting a derived identity as though it were a real authority session.
 *    Article 39 requires the weaker fact be stated, not dressed up.
 *
 * So a declared `--authority-session` is validated against the same session
 * state the authority layer uses, and a failed validation is a refusal — never
 * a silent downgrade to a derived chain. An invocation that declared only a
 * role gets a deterministic `DIRECT-CLI-` chain, stable across invocations for
 * the same repository, role, and round, and labelled `direct-cli`.
 */
import { existsSync, readFileSync } from '@devai-nyx/authority';
import { validators } from '@devai-nyx/schemas';
import { canonicalSha256, type GovernanceSessionSource } from '#runtime-core';
import { join, resolve } from 'node:path';

export interface TrackingChain {
  readonly id: string;
  readonly source: GovernanceSessionSource;
}

export class TrackingSessionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'TrackingSessionError';
  }
}

interface AuthoritySessionRecord {
  readonly session_id?: unknown;
  readonly role?: unknown;
  readonly status?: unknown;
  readonly expires_at?: unknown;
  readonly repository_id?: unknown;
  readonly session_digest_sha256?: unknown;
}

/**
 * Validate a declared authority session the same way the authority layer does:
 * schema, self-digest, status, expiry, and declared role must all agree.
 */
function validateDeclaredSession(options: {
  readonly repoRoot: string;
  readonly sessionId: string;
  readonly role: string;
  readonly now: number;
}): string {
  const path = join(
    resolve(options.repoRoot),
    '.devai/state/authority-sessions',
    `${options.sessionId}.json`,
  );
  if (!existsSync(path)) throw new TrackingSessionError('AUTHORITY_SESSION_NOT_FOUND');

  let session: AuthoritySessionRecord;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!validators.authoritySession(parsed)) {
      throw new TrackingSessionError('AUTHORITY_SESSION_SCHEMA_INVALID');
    }
    session = parsed as AuthoritySessionRecord;
  } catch (error) {
    if (error instanceof TrackingSessionError) throw error;
    throw new TrackingSessionError('AUTHORITY_SESSION_SCHEMA_INVALID');
  }

  const { session_digest_sha256: digest, ...unsigned } = session as Record<string, unknown>;
  if (canonicalSha256(unsigned) !== digest) {
    throw new TrackingSessionError('AUTHORITY_SESSION_DIGEST_MISMATCH');
  }
  if (session.status === 'revoked') throw new TrackingSessionError('AUTHORITY_SESSION_REVOKED');
  if (session.status === 'stale') throw new TrackingSessionError('AUTHORITY_SESSION_STALE');
  if (session.status === 'expired' || Date.parse(String(session.expires_at)) <= options.now) {
    throw new TrackingSessionError('AUTHORITY_SESSION_EXPIRED');
  }
  if (session.session_id !== options.sessionId) {
    throw new TrackingSessionError('AUTHORITY_SESSION_IDENTITY_MISMATCH');
  }
  // Recording under a session that belongs to another role would attribute the
  // event to an authority that never acted.
  if (session.role !== options.role) {
    throw new TrackingSessionError('AUTHORITY_SESSION_ROLE_MISMATCH');
  }
  return options.sessionId;
}

/**
 * Derive the stable direct-CLI chain identity. It is a pure function of the
 * repository, role, and round, so repeated invocations extend one chain instead
 * of scattering single-event chains.
 */
export function directCliChainId(options: {
  readonly repositoryId: string;
  readonly role: string;
  readonly round: string;
}): string {
  const digest = canonicalSha256({
    repository_id: options.repositoryId,
    role: options.role,
    round: options.round,
  });
  return `DIRECT-CLI-${digest.slice(0, 32)}`;
}

export interface ResolveTrackingChainOptions {
  readonly repoRoot: string;
  readonly repositoryId: string;
  readonly round: string;
  readonly role: string;
  readonly declaredSession?: string;
  readonly now?: number;
}

export function resolveTrackingChain(options: ResolveTrackingChainOptions): TrackingChain {
  const declared = options.declaredSession?.trim();
  if (declared !== undefined && declared.length > 0) {
    return {
      id: validateDeclaredSession({
        repoRoot: options.repoRoot,
        sessionId: declared,
        role: options.role,
        now: options.now ?? Date.now(),
      }),
      source: 'session-state',
    };
  }
  return {
    id: directCliChainId({
      repositoryId: options.repositoryId,
      role: options.role,
      round: options.round,
    }),
    source: 'direct-cli',
  };
}
