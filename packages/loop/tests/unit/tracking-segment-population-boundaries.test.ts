import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  listGovernanceSegments,
  recordGovernanceEvent,
  sealGovernanceSegments,
} from '../../src/tracking/index.js';

const roots: string[] = [];
const ROUND = 'R-0042';
const SESSION_A = 'AUTH-SESSION-0f1e2d3c4b5a69788796';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-tracking-segment-population-'));
  roots.push(root);
  return root;
}

function record(root: string, sessionId: string, summary: string): void {
  recordGovernanceEvent({
    repoRoot: root,
    repositoryId: 'devai',
    recordedAt: '2026-09-08T00:00:00.000Z',
    draft: {
      round_id: ROUND,
      authority_session_id: sessionId,
      session_source: 'session-state',
      role: 'engineer',
      kind: 'action_completed',
      summary,
      coverage: { mediated: true },
      payload: { summary },
    },
  });
}

function segmentDirectory(root: string): string {
  return join(root, 'record/proofs/governance', ROUND);
}

describe('tracking segment population boundaries', () => {
  it('ignores files whose names only resemble canonical segment names', () => {
    const root = repository();

    withAuthorityHostTestScope(() => {
      record(root, SESSION_A, 'canonical segment');
      expect(
        sealGovernanceSegments({
          repoRoot: root,
          round: ROUND,
          reason: 'checkpoint',
          sealedAt: '2026-09-08T12:00:00.000Z',
        }),
      ).toHaveLength(1);
    });

    const directory = segmentDirectory(root);
    writeFileSync(join(directory, 'prefix-GSEG-0000000000000000.json'), '{}\n');
    writeFileSync(join(directory, 'GSEG-0000000000000000.json.bak'), '{}\n');
    writeFileSync(join(directory, 'GSEG-0000000000000000.JSON'), '{}\n');

    const segments = listGovernanceSegments({ repoRoot: root, round: ROUND });
    expect(segments).toHaveLength(1);
    expect(segments[0]?.seal_reason).toBe('checkpoint');
  });

  it('refuses a schema-invalid segment with a canonical filename', () => {
    const root = repository();
    const directory = segmentDirectory(root);
    mkdirSync(directory, { recursive: true });
    const name = 'GSEG-0000000000000000.json';
    writeFileSync(join(directory, name), '{}\n');

    expect(() => listGovernanceSegments({ repoRoot: root, round: ROUND })).toThrow(
      `GOVERNANCE_SEGMENT_INVALID:${name}`,
    );
  });

  it('orders valid segments by sealed_at rather than filename', () => {
    const root = repository();

    withAuthorityHostTestScope(() => {
      for (let index = 0; index < 16; index += 1) {
        record(
          root,
          `AUTH-SESSION-${String(index).padStart(20, '0')}`,
          `segment-${String(index).padStart(2, '0')}`,
        );
        expect(
          sealGovernanceSegments({
            repoRoot: root,
            round: ROUND,
            reason: index === 15 ? 'round_close' : 'checkpoint',
            sealedAt: `2026-09-08T00:${String(index).padStart(2, '0')}:00.000Z`,
          }),
        ).toHaveLength(1);
      }
    });

    const directory = segmentDirectory(root);
    const names = readdirSync(directory).sort();
    expect(names).toHaveLength(16);
    const filenameOrder = names.map(
      (name) =>
        (JSON.parse(readFileSync(join(directory, name), 'utf8')) as { sealed_at: string })
          .sealed_at,
    );
    expect(filenameOrder).not.toEqual(
      Array.from(
        { length: 16 },
        (_, index) => `2026-09-08T00:${String(index).padStart(2, '0')}:00.000Z`,
      ),
    );
    expect(
      listGovernanceSegments({ repoRoot: root, round: ROUND }).map((segment) => segment.sealed_at),
    ).toEqual(
      Array.from(
        { length: 16 },
        (_, index) => `2026-09-08T00:${String(index).padStart(2, '0')}:00.000Z`,
      ),
    );
  });
});
