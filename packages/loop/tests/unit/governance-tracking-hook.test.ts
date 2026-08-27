// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-020
// Inspector acceptance for the runtime recording seam: it is completely inert
// for a repository that never opted in, it can never fail the action it is
// observing, it inherits the round's chain identity instead of starting new
// ones, and it reports unmediated activity as explicitly uncovered.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  readGovernanceEvents,
  trackGovernanceEvent,
  trackUncoveredActivity,
  type RoundTrackingActivation,
} from '../../src/tracking/index.js';

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const ROUND = 'R-0042';
const SESSION = 'AUTH-SESSION-0f1e2d3c4b5a69788796';
const DERIVED = 'DIRECT-CLI-0f1e2d3c4b5a697887960f1e2d3c4b5a';

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-tracking-hook-'));
  roots.push(root);
  return root;
}

function activate(
  root: string,
  overrides: Partial<RoundTrackingActivation> = {},
  identity = SESSION,
): void {
  const activation: RoundTrackingActivation = {
    schemaVersion: '1.0.0',
    round_id: ROUND,
    repository_id: 'adopter',
    state: 'active',
    adapter: {
      id: 'github-issues',
      adapter_version: '1.0.0',
      package_version: '1.3.0',
      config_digest_sha256: 'a'.repeat(64),
      workflow_digest_sha256: 'b'.repeat(64),
    },
    target: { repository: 'example/adopter', issue_number: null },
    authorization: {
      authority_session_id: identity,
      role: 'owner',
      publish_flag: true,
      authorized_at: '2026-08-27T12:00:00.000Z',
    },
    disclosure_profile: 'public-safe-v1',
    pending_policy: 'freeze',
    disabled: null,
    ...overrides,
  };
  const directory = join(root, '.devai/state/tracking', ROUND);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'activation.json'), `${JSON.stringify(activation, null, 2)}\n`);
}

function track(root: string, summary = 'Mediated action completed.') {
  return withAuthorityHostTestScope(() =>
    trackGovernanceEvent({
      repoRoot: root,
      round: ROUND,
      role: 'engineer',
      kind: 'action_completed',
      summary,
      payload: { detail: 'local-only' },
    }),
  );
}

describe('inert without activation', () => {
  it('records nothing and writes nothing for a repository that never opted in', async () => {
    const root = repository();
    expect(await track(root)).toBeUndefined();
    expect(existsSync(join(root, '.devai/state/tracking'))).toBe(false);
    expect(existsSync(join(root, 'record/proofs/governance'))).toBe(false);
  });

  it('stops recording once the round is disabled, but keeps recording while frozen', async () => {
    const disabled = repository();
    activate(disabled, { state: 'disabled' });
    expect(await track(disabled)).toBeUndefined();

    const frozen = repository();
    activate(frozen, { state: 'frozen' });
    expect(await track(frozen)).toBeDefined();
    expect(readGovernanceEvents({ repoRoot: frozen, round: ROUND })).toHaveLength(1);
  });
});

describe('never fatal to the observed action', () => {
  it('returns undefined instead of throwing when the activation is malformed', async () => {
    const root = repository();
    const directory = join(root, '.devai/state/tracking', ROUND);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'activation.json'), '{ "schemaVersion": "wrong" }\n');
    expect(await track(root)).toBeUndefined();
  });

  it('returns undefined instead of throwing when the event log is corrupt', async () => {
    const root = repository();
    activate(root);
    await track(root);
    const path = join(root, '.devai/state/tracking', ROUND, 'events.jsonl');
    writeFileSync(path, 'not json at all\nalso not json\n');
    expect(await track(root)).toBeUndefined();
  });
});

describe('chain identity is inherited', () => {
  it('joins the round chain rather than starting a new one per call', async () => {
    const root = repository();
    activate(root);
    await track(root, 'First mediated action.');
    await track(root, 'Second mediated action.');
    await track(root, 'Third mediated action.');

    const events = readGovernanceEvents({ repoRoot: root, round: ROUND });
    expect(events.map((event) => event.session_sequence)).toEqual([1, 2, 3]);
    expect(new Set(events.map((event) => event.authority_session_id))).toEqual(new Set([SESSION]));
    expect(events[0]?.previous_event_digest_sha256).toBeNull();
    expect(events[1]?.previous_event_digest_sha256).not.toBeNull();
  });

  it('keeps a derived activation identity labelled as direct-cli on every event', async () => {
    const root = repository();
    activate(root, {}, DERIVED);
    await track(root);
    const event = readGovernanceEvents({ repoRoot: root, round: ROUND })[0];
    expect(event?.authority_session_id).toBe(DERIVED);
    expect(event?.session_source).toBe('direct-cli');
  });
});

describe('host-boundary disclosure', () => {
  it('records unmediated activity as explicitly uncovered, never as tracked work', async () => {
    const root = repository();
    activate(root);
    await withAuthorityHostTestScope(() =>
      trackUncoveredActivity({
        repoRoot: root,
        round: ROUND,
        role: 'engineer',
        summary: 'An editor wrote to the working tree outside DEVAI mediation.',
        reason: 'no declared host-enforcement adapter for editor writes',
        payload: { source: 'editor' },
      }),
    );
    const event = readGovernanceEvents({ repoRoot: root, round: ROUND })[0];
    expect(event?.coverage.mediated).toBe(false);
    expect(event?.coverage.uncovered_reason).toContain('host-enforcement adapter');
  });

  it('seals only at declared checkpoints, not on every recorded event', async () => {
    const root = repository();
    activate(root);
    await track(root);
    const proofs = join(root, 'record/proofs/governance', ROUND);
    expect(existsSync(proofs)).toBe(false);

    await withAuthorityHostTestScope(() =>
      trackGovernanceEvent({
        repoRoot: root,
        round: ROUND,
        role: 'engineer',
        kind: 'action_completed',
        summary: 'Checkpoint reached.',
        payload: {},
        checkpoint: true,
      }),
    );
    expect(existsSync(proofs)).toBe(true);
    const segments = readdirSync(proofs).sort();
    expect(segments).toHaveLength(1);
    const sealed = JSON.parse(readFileSync(join(proofs, segments[0] ?? ''), 'utf8')) as {
      event_ids: readonly string[];
    };
    // One segment covers both events: sealing is a checkpoint, not per-event.
    expect(sealed.event_ids).toHaveLength(2);
  });
});
