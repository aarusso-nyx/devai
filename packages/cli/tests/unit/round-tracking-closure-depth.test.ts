import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CAC } from 'cac';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import {
  recordRoundCloseTracking,
  roundTrackingStatus,
} from '../../src/commands/round/tracking.js';
import {
  listGovernanceSegments,
  readGovernanceEvents,
  type RoundTrackingActivation,
} from '../../../loop/src/tracking/index.js';
import { canonicalSha256 } from '@devai-nyx/utils';

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};

const ROUND = 'R-0042';
const SESSION = 'AUTH-SESSION-0f1e2d3c4b5a69788796';
const DIRECT = 'DIRECT-CLI-0f1e2d3c4b5a697887960f1e2d3c4b5a';
const roots: string[] = [];

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-cli-round-tracking-'));
  roots.push(root);
  return root;
}

function put(root: string, path: string, value: unknown): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
}

function activate(root: string, authoritySession = SESSION): void {
  const activation: RoundTrackingActivation = {
    schemaVersion: '1.0.0',
    round_id: ROUND,
    repository_id: 'portable-adopter',
    state: 'active',
    adapter: {
      id: 'github-issues',
      adapter_version: '1.0.0',
      package_version: '1.5.0',
      config_digest_sha256: 'a'.repeat(64),
      workflow_digest_sha256: 'b'.repeat(64),
    },
    target: { repository: 'example/portable-adopter', issue_number: null },
    authorization: {
      authority_session_id: authoritySession,
      role: 'owner',
      publish_flag: true,
      authorized_at: '2026-09-09T12:00:00.000Z',
    },
    disclosure_profile: 'public-safe-v1',
    pending_policy: 'freeze',
    disabled: null,
  };
  put(root, `.devai/state/tracking/${ROUND}/activation.json`, activation);
}

async function invokeStatus(argv: readonly string[]) {
  const cli = cac('devai-round-tracking-test');
  roundTrackingStatus.register(cli);
  const previous = {
    argv: process.argv,
    exitCode: process.exitCode,
    stdout: process.stdout.write,
    stderr: process.stderr.write,
  };
  let stdout = '';
  let stderr = '';
  try {
    process.argv = ['node', 'devai', ...argv];
    process.exitCode = undefined;
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    cli.parse(process.argv, { run: false });
    await cli.runMatchedCommand();
    return { exit: process.exitCode ?? 0, stdout, stderr };
  } finally {
    process.argv = previous.argv;
    process.exitCode = previous.exitCode;
    process.stdout.write = previous.stdout;
    process.stderr.write = previous.stderr;
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.sequential('round tracking status and closure seam', () => {
  it('keeps an unactivated round inert and reports disabled idle status', async () => {
    const root = repository();
    expect(
      recordRoundCloseTracking({ repoRoot: root, round: ROUND, verdict: 'pass' }),
    ).toBeUndefined();

    const result = await invokeStatus([
      'round-tracking-status',
      '--repo-root',
      root,
      '--round',
      ROUND,
    ]);
    expect(result).toMatchObject({ exit: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: 'disabled',
      activation: 'absent',
      round_id: ROUND,
      canonical_events: 0,
      projected_events: 0,
      pending_events: 0,
      projection: 'idle',
    });
  });

  it('records and seals the final verdict using the recorded authority session', async () => {
    const root = repository();
    activate(root);

    const status = await withAuthorityHostTestScope(() =>
      recordRoundCloseTracking({ repoRoot: root, round: ROUND, verdict: 'accepted' }),
    );
    expect(status).toMatchObject({
      mode: 'github-issues',
      activation: 'active',
      canonical_events: 1,
      projected_events: 0,
      pending_events: 1,
      projection: 'pending',
    });

    const events = readGovernanceEvents({ repoRoot: root, round: ROUND });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      repository_id: 'portable-adopter',
      round_id: ROUND,
      authority_session_id: SESSION,
      session_source: 'session-state',
      role: 'owner',
      kind: 'round_verdict',
      coverage: { mediated: true, adapter_id: 'github-issues' },
      public_safe_summary: `Round ${ROUND} closed with phase closure accepted.`,
    });
    expect(events[0]?.payload_digest_sha256).toBe(
      canonicalSha256({ round: ROUND, closure: 'accepted' }),
    );

    const segments = listGovernanceSegments({ repoRoot: root, round: ROUND });
    expect(segments).toHaveLength(1);
    expect(segments[0]?.event_ids).toEqual([events[0]?.event_id]);
  });

  it('labels a derived activation identity as direct CLI', async () => {
    const root = repository();
    activate(root, DIRECT);

    await withAuthorityHostTestScope(() =>
      recordRoundCloseTracking({ repoRoot: root, round: ROUND, verdict: 'rejected' }),
    );
    expect(readGovernanceEvents({ repoRoot: root, round: ROUND })[0]).toMatchObject({
      authority_session_id: DIRECT,
      session_source: 'direct-cli',
      public_safe_summary: `Round ${ROUND} closed with phase closure rejected.`,
    });
  });

  it('reports local status without changing the closure result when recording is refused', () => {
    const root = repository();
    activate(root);

    const status = recordRoundCloseTracking({ repoRoot: root, round: ROUND, verdict: 'pass' });
    expect(status).toMatchObject({
      mode: 'github-issues',
      activation: 'active',
      canonical_events: 0,
      pending_events: 0,
      projection: 'idle',
    });
    expect(readGovernanceEvents({ repoRoot: root, round: ROUND })).toEqual([]);
  });

  it('renders human status and refuses missing or malformed round identities', async () => {
    const root = repository();
    activate(root);

    const human = await invokeStatus([
      'round-tracking-status',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--human',
    ]);
    expect(human).toEqual({
      exit: 0,
      stdout:
        `round tracking status: ${ROUND}; mode github-issues, activation active, ` +
        '0 canonical / 0 projected / 0 pending; projection idle\n',
      stderr: '',
    });

    const missing = await invokeStatus(['round-tracking-status', '--repo-root', root]);
    expect(missing.exit).toBe(2);
    expect(JSON.parse(missing.stderr)).toEqual({
      code: 'TRACKING_ROUND_REQUIRED',
      operation: 'tracking status',
      exit: 2,
    });

    const malformed = await invokeStatus([
      'round-tracking-status',
      '--repo-root',
      root,
      '--round',
      'round-42',
    ]);
    expect(malformed.exit).toBe(2);
    expect(JSON.parse(malformed.stderr)).toEqual({
      code: 'TRACKING_ROUND_INVALID',
      operation: 'tracking status',
      exit: 2,
    });
  });
});
