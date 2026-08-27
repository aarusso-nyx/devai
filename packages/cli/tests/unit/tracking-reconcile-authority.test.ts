// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-020
// Inspector acceptance for CI reconciliation authority.
//
// Reconcile-only replays an authorization an Owner already recorded; it never
// grants one. These tests pin the boundary: the recorded activation must still
// match the live binding and the observed repository, every mismatch refuses
// rather than downgrading, and the derived effect scope is narrower than any
// live Owner session — local delivery state and `gh api` only.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@devai-nyx/utils';
import type { RoundTrackingActivation } from '@devai-nyx/loop';
import {
  loadTrackingPolicyDefaults,
  TRACKING_CONFIG_RELATIVE,
  TRACKING_WORKFLOW_RELATIVE,
  trackingDefaultsDigest,
} from '../../src/services/github-issues-tracking/config.js';
import {
  renderTrackingWorkflow,
  trackingWorkflowDigest,
} from '../../src/services/github-issues-tracking/workflow.js';
import {
  reconcileEffectPermitted,
  TrackingAuthorityError,
  verifyReconcileAuthorization,
} from '../../src/services/github-issues-tracking/reconcile-authority.js';

const roots: string[] = [];
const ROUND = 'R-0042';
const REPOSITORY = 'example/adopter';
const SESSION = 'AUTH-SESSION-0f1e2d3c4b5a69788796';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(repo: string, path: string, value: unknown): void {
  const absolute = join(repo, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(
    absolute,
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
}

/** A repository bound exactly as `init bind --tracking-adapter --write` leaves it. */
function bound(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-reconcile-authority-'));
  roots.push(root);
  const defaults = loadTrackingPolicyDefaults();
  const workflow = renderTrackingWorkflow(defaults);
  put(root, TRACKING_WORKFLOW_RELATIVE, workflow);
  put(root, TRACKING_CONFIG_RELATIVE, {
    schemaVersion: '1.0.0',
    id: 'github-issues-tracking',
    binding: {
      repository: REPOSITORY,
      repository_id: 'adopter',
      package_version: '1.3.0',
      bound_at: '2026-08-27T12:00:00.000Z',
      bound_by_role: 'architect',
    },
    defaults,
    digests: {
      policy_defaults_sha256: trackingDefaultsDigest(defaults),
      workflow_sha256: trackingWorkflowDigest(workflow),
    },
  });
  return root;
}

function activation(overrides: Partial<RoundTrackingActivation> = {}): RoundTrackingActivation {
  const defaults = loadTrackingPolicyDefaults();
  return {
    schemaVersion: '1.0.0',
    round_id: ROUND,
    repository_id: 'adopter',
    state: 'active',
    adapter: {
      id: 'github-issues',
      adapter_version: '1.0.0',
      package_version: '1.3.0',
      config_digest_sha256: canonicalSha256(defaults),
      workflow_digest_sha256: trackingWorkflowDigest(renderTrackingWorkflow(defaults)),
    },
    target: { repository: REPOSITORY, issue_number: 123 },
    authorization: {
      authority_session_id: SESSION,
      role: 'owner',
      publish_flag: true,
      authorized_at: '2026-08-27T12:00:00.000Z',
    },
    disclosure_profile: 'public-safe-v1',
    pending_policy: 'freeze',
    disabled: null,
    ...overrides,
  };
}

function activate(root: string, overrides: Partial<RoundTrackingActivation> = {}): void {
  put(root, join('.devai/state/tracking', ROUND, 'activation.json'), activation(overrides));
}

function verify(root: string, observedRepository = REPOSITORY) {
  return verifyReconcileAuthorization({ repoRoot: root, round: ROUND, observedRepository });
}

function expectRefusal(fn: () => unknown, code: string, label: string): void {
  try {
    fn();
    expect.unreachable(`${label} must refuse`);
  } catch (error) {
    expect(error, label).toBeInstanceOf(TrackingAuthorityError);
    expect((error as TrackingAuthorityError).code, label).toBe(code);
  }
}

describe('replaying a recorded Owner authorization', () => {
  it('accepts an activation that still matches the live binding and repository', () => {
    const root = bound();
    activate(root);
    const authorization = verify(root);

    expect(authorization.round).toBe(ROUND);
    expect(authorization.repository).toBe(REPOSITORY);
    expect(authorization.issue).toBe(123);
    // The authority is the Owner's recorded decision, not a live declaration.
    expect(authorization.activation.authorization.role).toBe('owner');
    expect(authorization.activation.authorization.publish_flag).toBe(true);
  });

  it('refuses a round that was never activated instead of assuming consent', () => {
    expectRefusal(() => verify(bound()), 'TRACKING_RECONCILE_ACTIVATION_ABSENT', 'no activation');
  });

  it('refuses when tracking is not currently active for the round', () => {
    for (const [state, label] of [
      ['frozen', 'frozen'],
      ['disabled', 'disabled'],
    ] as const) {
      const root = bound();
      activate(root, { state });
      expectRefusal(
        () => verify(root),
        'TRACKING_RECONCILE_ACTIVATION_INACTIVE',
        label,
      );
    }
  });

  it('refuses an activation that does not carry explicit Owner publication consent', () => {
    const root = bound();
    activate(root, {
      authorization: {
        authority_session_id: SESSION,
        role: 'owner',
        publish_flag: true,
        authorized_at: '2026-08-27T12:00:00.000Z',
      },
    });
    // Strip the recorded consent the way a hand-edited record would.
    const path = join(root, '.devai/state/tracking', ROUND, 'activation.json');
    const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    (record['authorization'] as Record<string, unknown>)['publish_flag'] = false;
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);

    expectRefusal(
      () => verify(root),
      'TRACKING_RECONCILE_ACTIVATION_INVALID',
      'publish flag cleared',
    );
  });
});

describe('the recorded authorization cannot outlive its bindings', () => {
  it('refuses when the adapter binding has moved under the activation', () => {
    const root = bound();
    activate(root, {
      adapter: {
        ...activation().adapter,
        config_digest_sha256: 'f'.repeat(64),
      },
    });
    expectRefusal(() => verify(root), 'TRACKING_RECONCILE_BINDING_STALE', 'stale config digest');
  });

  it('refuses when the generated workflow has drifted', () => {
    const root = bound();
    activate(root);
    const path = join(root, TRACKING_WORKFLOW_RELATIVE);
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n# hand edit\n`);
    expectRefusal(() => verify(root), 'TRACKING_RECONCILE_BINDING_INVALID', 'workflow drift');
  });

  it('refuses when the repository CI is running in is not the bound one', () => {
    const root = bound();
    activate(root);
    expectRefusal(
      () => verify(root, 'someone-else/fork'),
      'TRACKING_RECONCILE_REPOSITORY_MISMATCH',
      'foreign repository',
    );
  });

  it('refuses when the activation names a different round than the one requested', () => {
    const root = bound();
    activate(root, { round_id: 'R-0099' });
    expectRefusal(() => verify(root), 'TRACKING_RECONCILE_ROUND_MISMATCH', 'round mismatch');
  });

  it('refuses when the repository capability was never bound', () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-reconcile-unbound-'));
    roots.push(root);
    put(root, join('.devai/state/tracking', ROUND, 'activation.json'), activation());
    expectRefusal(() => verify(root), 'TRACKING_RECONCILE_BINDING_ABSENT', 'no binding');
  });
});

describe('the derived effect scope is narrower than an Owner session', () => {
  it('permits only this round-s delivery state and the gh boundary', () => {
    const root = '/repo';
    const permitted = [
      { kind: 'filesystem' as const, target: '/repo/.devai/state/tracking/R-0042/delivery.json' },
      { kind: 'process' as const, executable: 'gh', args: ['api', 'search/issues'] },
    ];
    for (const request of permitted) {
      expect(reconcileEffectPermitted({ repoRoot: root, round: ROUND, request })).toBe(true);
    }
  });

  it('refuses writes outside the round, and every process except gh', () => {
    const root = '/repo';
    const forbidden = [
      // Another round's evidence is outside what this activation authorized.
      { kind: 'filesystem' as const, target: '/repo/.devai/state/tracking/R-0099/delivery.json' },
      // Canonical events and sealed proofs are read-only to a replayer.
      { kind: 'filesystem' as const, target: '/repo/record/proofs/governance/R-0042/x.json' },
      { kind: 'filesystem' as const, target: '/repo/.devai/config/project.json' },
      { kind: 'filesystem' as const, target: '/repo/packages/cli/src/index.ts' },
      { kind: 'filesystem' as const, target: '/etc/passwd' },
      { kind: 'process' as const, executable: 'git', args: ['push'] },
      { kind: 'process' as const, executable: 'sh', args: ['-c', 'curl evil'] },
      { kind: 'process' as const, executable: 'gh', args: ['pr', 'merge'] },
    ];
    for (const request of forbidden) {
      expect(
        reconcileEffectPermitted({ repoRoot: root, round: ROUND, request }),
        JSON.stringify(request),
      ).toBe(false);
    }
  });

  it('never permits mutating the canonical event log itself', () => {
    expect(
      reconcileEffectPermitted({
        repoRoot: '/repo',
        round: ROUND,
        request: {
          kind: 'filesystem',
          target: '/repo/.devai/state/tracking/R-0042/events.jsonl',
        },
      }),
    ).toBe(false);
  });
});
