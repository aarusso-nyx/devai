// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-020
// Inspector acceptance for governance chain-identity resolution: a declared
// authority session is validated exactly as the authority layer validates it,
// a failed validation refuses instead of silently downgrading, and an
// invocation with no session gets a deterministic chain rather than a fresh
// identity per invocation.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@devai-nyx/utils';
import {
  directCliChainId,
  resolveTrackingChain,
  TrackingSessionError,
} from '../../src/commands/round/tracking-session.js';

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2020-01-01T00:00:00.000Z';

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-tracking-session-'));
  roots.push(root);
  mkdirSync(join(root, '.devai/state/authority-sessions'), { recursive: true });
  return root;
}

function writeSession(
  root: string,
  overrides: Record<string, unknown> = {},
  options: { readonly resign?: boolean } = {},
): string {
  const sessionId = 'AUTH-SESSION-0f1e2d3c4b5a69788796';
  const unsigned = {
    schemaVersion: '1.0.0',
    session_id: sessionId,
    repository_id: 'adopter',
    role: 'owner',
    declaration_source: 'cli-flag',
    status: 'active',
    created_at: '2026-08-27T12:00:00.000Z',
    expires_at: FUTURE,
    created_by_invocation_id: 'invocation-1',
    policy_binding: {
      policy_id: 'authority-policy',
      policy_version: '1.0.0',
      resolved_digest_sha256: 'a'.repeat(64),
    },
    constitution_binding: { version: '1.0.0', digest_sha256: 'b'.repeat(64) },
    package_binding: { name: '@aarusso-nyx/devai', version: '1.3.0' },
    ...overrides,
  };
  const record = {
    ...unsigned,
    session_digest_sha256: options.resign === false ? 'c'.repeat(64) : canonicalSha256(unsigned),
  };
  writeFileSync(
    join(root, '.devai/state/authority-sessions', `${String(record.session_id)}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return sessionId;
}

function resolve(root: string, declaredSession?: string, role = 'owner') {
  return resolveTrackingChain({
    repoRoot: root,
    repositoryId: 'adopter',
    round: 'R-0042',
    role,
    declaredSession,
  });
}

describe('declared authority session', () => {
  it('uses a valid session and labels the chain as session state', () => {
    const root = repository();
    const sessionId = writeSession(root);
    expect(resolve(root, sessionId)).toEqual({ id: sessionId, source: 'session-state' });
  });

  it('refuses rather than downgrading when the declared session is unusable', () => {
    const cases: readonly [string, Record<string, unknown>, string][] = [
      [
        'revoked',
        {
          status: 'revoked',
          revocation: {
            revoked_at: '2026-08-27T13:00:00.000Z',
            revoked_by_invocation_id: 'invocation-2',
            reason: 'owner ended the session',
          },
        },
        'AUTHORITY_SESSION_REVOKED',
      ],
      ['stale', { status: 'stale', stale_reason: 'policy-changed' }, 'AUTHORITY_SESSION_STALE'],
      ['expired by status', { status: 'expired' }, 'AUTHORITY_SESSION_EXPIRED'],
      ['expired by clock', { expires_at: PAST }, 'AUTHORITY_SESSION_EXPIRED'],
      ['role mismatch', { role: 'engineer' }, 'AUTHORITY_SESSION_ROLE_MISMATCH'],
    ];
    for (const [label, overrides, code] of cases) {
      const root = repository();
      const sessionId = writeSession(root, overrides);
      try {
        resolve(root, sessionId);
        expect.unreachable(`${label} must refuse`);
      } catch (error) {
        expect(error, label).toBeInstanceOf(TrackingSessionError);
        expect((error as TrackingSessionError).code, label).toBe(code);
      }
    }
  });

  it('refuses a session whose stored digest does not cover its own bytes', () => {
    const root = repository();
    const sessionId = writeSession(root, {}, { resign: false });
    expect(() => resolve(root, sessionId)).toThrow(TrackingSessionError);
  });

  it('refuses a tampered session rather than accepting the edited fields', () => {
    const root = repository();
    const sessionId = writeSession(root);
    // Re-write the role without re-signing, exactly as an editor edit would.
    const path = join(root, '.devai/state/authority-sessions', `${sessionId}.json`);
    writeFileSync(
      path,
      JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), role: 'engineer' }, null, 2),
    );
    try {
      resolve(root, sessionId);
      expect.unreachable('a tampered session must refuse');
    } catch (error) {
      expect((error as TrackingSessionError).code).toBe('AUTHORITY_SESSION_DIGEST_MISMATCH');
    }
  });

  it('refuses a session that is not on disk instead of inventing one', () => {
    const root = repository();
    try {
      resolve(root, 'AUTH-SESSION-ffffffffffffffffffff');
      expect.unreachable('a missing session must refuse');
    } catch (error) {
      expect((error as TrackingSessionError).code).toBe('AUTHORITY_SESSION_NOT_FOUND');
    }
  });
});

describe('derived direct-CLI chain', () => {
  it('is stable across invocations so repeated commands extend one chain', () => {
    const root = repository();
    const first = resolve(root);
    const second = resolve(root);
    expect(first).toEqual(second);
    expect(first.source).toBe('direct-cli');
    expect(first.id).toMatch(/^DIRECT-CLI-[0-9a-f]{32}$/u);
  });

  it('separates chains by repository, role, and round', () => {
    const base = { repositoryId: 'adopter', role: 'owner', round: 'R-0042' };
    const ids = new Set([
      directCliChainId(base),
      directCliChainId({ ...base, repositoryId: 'other' }),
      directCliChainId({ ...base, role: 'engineer' }),
      directCliChainId({ ...base, round: 'R-0043' }),
    ]);
    expect(ids.size).toBe(4);
  });

  it('never claims to be an authority session', () => {
    const root = repository();
    const chain = resolve(root);
    expect(chain.id.startsWith('AUTH-SESSION-')).toBe(false);
    expect(chain.source).toBe('direct-cli');
  });
});
