import type { ProjectionBatch, ProjectionFailureClass } from '@devai-nyx/loop';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawnSync: spawnSyncMock,
}));

import {
  backoffDelays,
  classifyGhFailure,
  createRoundIssue,
  defaultGhTransport,
  isRetryable,
  projectBatch,
  ProjectorError,
  renderBatchComment,
  renderIssueBody,
  roundIssueMarker,
  type GhTransport,
} from '../../src/services/github-issues-tracking/projector.js';

function projectionBatch(): ProjectionBatch {
  return {
    schemaVersion: '1.0.0',
    batch_id: 'GBAT-0123456789abcdef',
    marker: 'devai-governance-batch:0123456789abcdef',
    repository_id: 'projector-fixture',
    round_id: 'R-0127',
    adapter: {
      id: 'github-issues',
      adapter_version: '1.2.3',
      package_version: '1.5.0',
    },
    disclosure_profile: 'public-safe-v1',
    reason: 'checkpoint',
    sessions: [
      {
        authority_session_id: 'AUTH-SESSION-0123456789abcdef0123',
        first: 1,
        last: 2,
      },
    ],
    event_ids: ['GEV-1111111111111111', 'GEV-2222222222222222'],
    entries: [
      {
        event_id: 'GEV-1111111111111111',
        role: 'engineer',
        kind: 'action_completed',
        status: 'pass',
        public_safe_summary: 'Built | verified.',
        commit: null,
        tree: null,
        evidence_digests_sha256: [],
        payload_digest_sha256: '1234567890abcdef'.repeat(4),
        mediated: true,
      },
      {
        event_id: 'GEV-2222222222222222',
        role: 'inspector',
        kind: 'observation',
        status: null,
        public_safe_summary: 'Observed safely.',
        commit: 'abcdef0123456789'.repeat(3),
        tree: null,
        evidence_digests_sha256: [],
        payload_digest_sha256: 'fedcba9876543210'.repeat(4),
        mediated: false,
      },
    ],
    segment_digests_sha256: ['a'.repeat(64), '0123456789abcdef'.repeat(4)],
    projected_at: null,
    batch_digest_sha256: 'd'.repeat(64),
  };
}

beforeEach(() => spawnSyncMock.mockReset());

describe('GitHub Issues projector public boundaries', () => {
  it('normalizes transport failures and missing optional process fields', () => {
    spawnSyncMock.mockReturnValueOnce({ error: new Error('gh executable missing') });
    expect(defaultGhTransport(['api', 'user'])).toEqual({
      status: 127,
      stdout: '',
      stderr: 'gh executable missing',
    });

    spawnSyncMock.mockReturnValueOnce({ status: null });
    expect(defaultGhTransport(['api', 'rate_limit'])).toEqual({
      status: 1,
      stdout: '',
      stderr: '',
    });
    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      2,
      'gh',
      ['api', 'rate_limit'],
      expect.objectContaining({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });

  it('preserves the public ProjectorError identity', () => {
    const error = new ProjectorError(
      'TRACKING_FIXTURE_FAILED',
      'service',
      'fixture transport failed',
    );

    expect(error).toMatchObject({
      name: 'ProjectorError',
      message: 'TRACKING_FIXTURE_FAILED',
      code: 'TRACKING_FIXTURE_FAILED',
      classification: 'service',
      detail: 'fixture transport failed',
    });
  });

  it.each([
    ['rate limit exceeded', '', 'rate-limit'],
    ['secondary rate warning', '', 'rate-limit'],
    ['abuse detection triggered', '', 'rate-limit'],
    ['HTTP 429', '', 'rate-limit'],
    ['gh auth login first', '', 'authentication'],
    ['not logged into github.com', '', 'authentication'],
    ['authentication required', '', 'authentication'],
    ['Bad credentials', '', 'authentication'],
    ['HTTP 401', '', 'authentication'],
    ['HTTP 403', '', 'permission'],
    ['Forbidden', '', 'permission'],
    ['Resource not accessible by integration', '', 'permission'],
    ['permission denied', '', 'permission'],
    ['HTTP 404', '', 'missing-resource'],
    ['Not Found', '', 'missing-resource'],
    ['HTTP 422', '', 'validation'],
    ['Validation Failed', '', 'validation'],
    ['unprocessable request', '', 'validation'],
    ['gateway unavailable', '', 'service'],
    ['', 'HTTP 404 from stdout', 'missing-resource'],
  ] as const)('classifies stderr %j and stdout %j as %s', (stderr, stdout, expected) => {
    expect(classifyGhFailure({ status: 1, stderr, stdout })).toBe(expected);
  });

  it.each([
    ['authentication', false],
    ['permission', false],
    ['rate-limit', true],
    ['validation', false],
    ['missing-resource', false],
    ['service', true],
    ['ambiguous-response', false],
  ] satisfies readonly (readonly [ProjectionFailureClass, boolean])[])(
    'reports %s retryability as %s',
    (classification, expected) => {
      expect(isRetryable(classification)).toBe(expected);
    },
  );

  it('returns the exact bounded backoff schedule and round marker', () => {
    expect(
      backoffDelays({
        max_attempts: 6,
        initial_delay_ms: 750,
        max_delay_ms: 5000,
        multiplier: 3,
      }),
    ).toEqual([750, 2250, 5000, 5000, 5000]);
    expect(
      backoffDelays({ max_attempts: 1, initial_delay_ms: 750, max_delay_ms: 5000, multiplier: 3 }),
    ).toEqual([]);
    expect(roundIssueMarker('R-0127')).toBe('devai-governance-round:R-0127');
  });

  it('renders the exact durable issue body', () => {
    expect(
      renderIssueBody({
        round: 'R-0127',
        repository: 'example/projector',
        adapterVersion: '1.2.3',
      }),
    ).toBe(`<!-- devai-governance-round:R-0127 -->
# Governed round R-0127

This issue is a **read-only projection** of DEVAI governance events recorded
locally in \`example/projector\`. It is rebuildable from sealed local evidence.

Comments, labels, and edits on this issue are untrusted output state. They
cannot authorize, route, close, merge, or publish anything in DEVAI.

Only DEVAI-mediated actions appear here. Editor and shell activity outside
the DEVAI runtime is **not** covered and is never implied to be.

Adapter: \`github-issues\` v1.2.3 · disclosure profile: \`public-safe-v1\`
`);
  });

  it('renders the exact batch comment, including absent values and escaped cells', () => {
    expect(renderBatchComment(projectionBatch(), '2026-09-10T12:34:56.000Z'))
      .toBe(`<!-- devai-governance-batch:0123456789abcdef -->
### Batch \`GBAT-0123456789abcdef\` · checkpoint · 2 event(s)

| Event | Role | Kind | Status | Coverage | Summary | Commit | Payload digest |
| --- | --- | --- | --- | --- | --- | --- | --- |
| \`GEV-1111111111111111\` | engineer | action_completed | pass | mediated | Built \\| verified. | — | \`1234567890ab\` |
| \`GEV-2222222222222222\` | inspector | observation | — | **unmediated** | Observed safely. | \`abcdef012345\` | \`fedcba987654\` |

- Session \`AUTH-SESSION-0123456789abcdef0123\` sequence 1–2

Segment digests: \`aaaaaaaaaaaa\`, \`0123456789ab\`
Batch digest: \`dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\`
Projected at 2026-09-10T12:34:56.000Z by \`github-issues\` v1.2.3.

Payload content is withheld by the \`public-safe-v1\` disclosure profile;
the digests above bind what was withheld.
`);
  });

  it('preserves the issue-creation ambiguity identity', () => {
    const transport: GhTransport = () => ({ status: 0, stdout: '{}', stderr: '' });

    expect(() =>
      createRoundIssue(
        { transport, repository: 'example/projector' },
        { round: 'R-0127', adapterVersion: '1.2.3' },
      ),
    ).toThrowError(
      expect.objectContaining({
        name: 'ProjectorError',
        code: 'TRACKING_ISSUE_CREATE_AMBIGUOUS',
        classification: 'ambiguous-response',
        detail: 'issue creation returned no number',
      }),
    );
  });

  it('reconciles a comment creation response that omits the comment id', () => {
    const target = projectionBatch();
    let call = 0;
    const transport: GhTransport = () => {
      call += 1;
      if (call === 1) return { status: 0, stdout: '[]', stderr: '' };
      if (call === 2) return { status: 0, stdout: '{}', stderr: '' };
      return {
        status: 0,
        stdout: JSON.stringify([{ id: 127, body: `<!-- ${target.marker} -->` }]),
        stderr: '',
      };
    };

    expect(
      projectBatch(
        { transport, repository: 'example/projector' },
        { issue: 127, batch: target, projectedAt: '2026-09-10T12:34:56.000Z' },
      ),
    ).toEqual({ comment_id: 127, already_present: true });
  });

  it('preserves the comment-creation ambiguity identity after reconciliation misses', () => {
    let call = 0;
    const transport: GhTransport = () => {
      call += 1;
      return { status: 0, stdout: call === 2 ? '{}' : '[]', stderr: '' };
    };

    expect(() =>
      projectBatch(
        { transport, repository: 'example/projector' },
        { issue: 127, batch: projectionBatch(), projectedAt: '2026-09-10T12:34:56.000Z' },
      ),
    ).toThrowError(
      expect.objectContaining({
        name: 'ProjectorError',
        code: 'TRACKING_COMMENT_CREATE_AMBIGUOUS',
        classification: 'ambiguous-response',
        detail: 'comment creation returned no id',
      }),
    );
  });
});
