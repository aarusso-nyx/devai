import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { recordGovernanceEvent, type GovernanceEventDraft } from '../../src/tracking/index.js';

const roots: string[] = [];
const ROUND = 'R-0042';
const EVENTS = join('.devai/state/tracking', ROUND, 'events.jsonl');
const SESSION = 'AUTH-SESSION-0f1e2d3c4b5a69788796';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-tracking-supersession-refusal-'));
  roots.push(root);
  return root;
}

function draft(overrides: Partial<GovernanceEventDraft> = {}): GovernanceEventDraft {
  return {
    round_id: ROUND,
    authority_session_id: SESSION,
    session_source: 'session-state',
    role: 'engineer',
    kind: 'action_completed',
    summary: 'Mediated action completed.',
    coverage: { mediated: true },
    payload: { detail: 'local-only payload' },
    ...overrides,
  };
}

function record(root: string, overrides: Partial<GovernanceEventDraft> = {}) {
  return recordGovernanceEvent({
    repoRoot: root,
    repositoryId: 'devai',
    draft: draft(overrides),
    recordedAt: '2026-09-08T12:00:00.000Z',
  });
}

async function refusal(
  root: string,
  expected: string,
  overrides: Partial<GovernanceEventDraft>,
): Promise<void> {
  await withAuthorityHostTestScope(async () => {
    const original = record(root, { summary: 'Original event remains intact.' });
    const path = join(root, EVENTS);
    const before = readFileSync(path, 'utf8');

    expect(() =>
      record(root, {
        ...overrides,
        ...(overrides.supersedes_event_id === '$original' && {
          supersedes_event_id: original.event_id,
        }),
      }),
    ).toThrow(expected);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
}

describe('tracking supersession refusal boundaries', () => {
  it('rejects an unregistered event kind without appending', async () => {
    const root = repository();
    await refusal(root, 'GOVERNANCE_EVENT_KIND_UNREGISTERED:totally_unregistered_kind', {
      kind: 'totally_unregistered_kind' as GovernanceEventDraft['kind'],
    });
  });

  it('requires a target for evidence supersession without appending', async () => {
    const root = repository();
    await refusal(root, 'GOVERNANCE_SUPERSESSION_TARGET_REQUIRED', {
      kind: 'evidence_superseded',
    });
  });

  it('rejects a target on a non-supersession event without appending', async () => {
    const root = repository();
    await refusal(root, 'GOVERNANCE_SUPERSESSION_KIND_INVALID', {
      kind: 'action_completed',
      supersedes_event_id: '$original',
    });
  });

  it('rejects an unknown supersession target with its diagnostic without appending', async () => {
    const root = repository();
    await refusal(root, 'GOVERNANCE_SUPERSESSION_TARGET_UNKNOWN:GEV-0000000000000000', {
      kind: 'evidence_superseded',
      supersedes_event_id: 'GEV-0000000000000000',
    });
  });
});
