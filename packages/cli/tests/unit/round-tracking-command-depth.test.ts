import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CAC } from 'cac';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';

const remote = vi.hoisted(() => ({
  issue: null as number | null,
  nextIssue: 101,
  nextComment: 1001,
  commentPosts: 0,
  failCommentPost: 0,
  failAll: false,
  overrideActivation: false,
  activation: undefined as unknown,
  calls: [] as string[][],
  comments: [] as { id: number; body: string }[],
}));

const sessions = vi.hoisted(() => ({ failUnexpectedly: false }));

vi.mock('#runtime-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime-core.js')>();
  return {
    ...actual,
    readRoundTrackingActivation(options: Parameters<typeof actual.readRoundTrackingActivation>[0]) {
      return remote.overrideActivation
        ? (remote.activation as ReturnType<typeof actual.readRoundTrackingActivation>)
        : actual.readRoundTrackingActivation(options);
    },
    defaultGhTransport(args: readonly string[]) {
      const call = [...args];
      remote.calls.push(call);
      if (remote.failAll) return { status: 1, stdout: '', stderr: 'service unavailable' };
      const route = call[3] ?? '';
      const method = call[2];
      if (route === 'search/issues') {
        return {
          status: 0,
          stdout: JSON.stringify({
            items: remote.issue === null ? [] : [{ number: remote.issue }],
          }),
          stderr: '',
        };
      }
      if (method === 'POST' && route.endsWith('/issues')) {
        remote.issue = remote.nextIssue;
        return { status: 0, stdout: JSON.stringify({ number: remote.issue }), stderr: '' };
      }
      if (method === 'GET' && route.endsWith('/comments')) {
        return { status: 0, stdout: JSON.stringify(remote.comments), stderr: '' };
      }
      if (method === 'POST' && route.endsWith('/comments')) {
        remote.commentPosts += 1;
        if (remote.commentPosts === remote.failCommentPost) {
          return { status: 1, stdout: '', stderr: 'service unavailable' };
        }
        const body = call.find((part) => part.startsWith('body='))?.slice('body='.length) ?? '';
        const comment = { id: remote.nextComment, body };
        remote.nextComment += 1;
        remote.comments.push(comment);
        return { status: 0, stdout: JSON.stringify({ id: comment.id }), stderr: '' };
      }
      throw new Error(`unexpected gh call: ${call.join(' ')}`);
    },
  };
});

vi.mock('../../src/commands/round/tracking-session.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/commands/round/tracking-session.js')>();
  return {
    ...actual,
    resolveTrackingChain(options: Parameters<typeof actual.resolveTrackingChain>[0]) {
      if (sessions.failUnexpectedly) throw new Error('TRACKING_SESSION_BACKEND_FAILED');
      return actual.resolveTrackingChain(options);
    },
  };
});

import {
  canonicalSha256,
  listGovernanceSegments,
  loadTrackingPolicyDefaults,
  readDeliveryState,
  readGovernanceEvents,
  readRoundTrackingActivation,
  recordGovernanceEvent,
  renderTrackingWorkflow,
  sealGovernanceSegments,
  trackingWorkflowDigest,
  type RoundTrackingActivation,
} from '../../src/runtime-core.js';
import {
  roundTrackingDisable,
  roundTrackingEnable,
  roundTrackingCommands,
  roundTrackingStatus,
  roundTrackingSync,
  recordRoundCloseTracking,
  trackingWorkflowArtifact,
} from '../../src/commands/round/tracking.js';

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};

const ROUND = 'R-4242';
const REPOSITORY = 'example/adopter';
const SESSION = 'AUTH-SESSION-0123456789abcdef0123';
const roots: string[] = [];

function repository(): string {
  const value = mkdtempSync(join(tmpdir(), 'devai-round-tracking-command-'));
  roots.push(value);
  return value;
}

function put(root: string, path: string, value: unknown): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(
    absolute,
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
}

function bind(root: string): { defaultsDigest: string; workflowDigest: string } {
  const defaults = loadTrackingPolicyDefaults();
  const workflow = renderTrackingWorkflow(defaults);
  const defaultsDigest = canonicalSha256(defaults);
  const workflowDigest = trackingWorkflowDigest(workflow);
  put(root, '.github/workflows/devai-issue-tracking.yml', workflow);
  put(root, '.devai/config/github-issues-tracking.json', {
    schemaVersion: '1.0.0',
    id: 'github-issues-tracking',
    binding: {
      repository: REPOSITORY,
      repository_id: 'adopter',
      package_version: '1.5.0',
      bound_at: '2026-09-09T12:00:00.000Z',
      bound_by_role: 'architect',
    },
    defaults,
    digests: {
      policy_defaults_sha256: defaultsDigest,
      workflow_sha256: workflowDigest,
    },
  });
  return { defaultsDigest, workflowDigest };
}

function activate(
  root: string,
  overrides: Partial<RoundTrackingActivation> = {},
): RoundTrackingActivation {
  const digests = bind(root);
  const value: RoundTrackingActivation = {
    schemaVersion: '1.0.0',
    round_id: ROUND,
    repository_id: 'adopter',
    state: 'active',
    adapter: {
      id: 'github-issues',
      adapter_version: '1.0.0',
      package_version: '1.5.0',
      config_digest_sha256: digests.defaultsDigest,
      workflow_digest_sha256: digests.workflowDigest,
    },
    target: { repository: REPOSITORY, issue_number: 101 },
    authorization: {
      authority_session_id: SESSION,
      role: 'owner',
      publish_flag: true,
      authorized_at: '2026-09-09T12:00:00.000Z',
    },
    disclosure_profile: 'public-safe-v1',
    pending_policy: 'freeze',
    disabled: null,
    ...overrides,
  };
  put(root, `.devai/state/tracking/${ROUND}/activation.json`, value);
  return value;
}

async function recordAndSeal(root: string, count: number): Promise<void> {
  await withAuthorityHostTestScope(() => {
    for (let index = 0; index < count; index += 1) {
      recordGovernanceEvent({
        repoRoot: root,
        repositoryId: 'adopter',
        recordedAt: '2026-09-09T12:30:00.000Z',
        draft: {
          round_id: ROUND,
          authority_session_id: SESSION,
          session_source: 'session-state',
          role: 'engineer',
          kind: 'action_completed',
          status: 'pass',
          coverage: { mediated: true, adapter_id: 'github-issues' },
          summary: `Action ${String(index + 1)} completed.`,
          payload: { index },
        },
      });
    }
    sealGovernanceSegments({ repoRoot: root, round: ROUND, reason: 'checkpoint' });
  });
}

async function invoke(definition: { register(cli: CAC): void }, argv: readonly string[]) {
  const cli = cac('devai-round-tracking-command-test');
  definition.register(cli);
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
    await withAuthorityHostTestScope(() => cli.runMatchedCommand());
    return { exit: process.exitCode ?? 0, stdout, stderr };
  } finally {
    process.argv = previous.argv;
    process.exitCode = previous.exitCode;
    process.stdout.write = previous.stdout;
    process.stderr.write = previous.stderr;
  }
}

function json(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

beforeEach(() => {
  Object.assign(remote, {
    issue: null,
    nextIssue: 101,
    nextComment: 1001,
    commentPosts: 0,
    failCommentPost: 0,
    failAll: false,
    overrideActivation: false,
    activation: undefined,
    calls: [],
    comments: [],
  });
  sessions.failUnexpectedly = false;
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.sequential('round tracking command depth', () => {
  it('materializes the canonical workflow artifact without repository state', () => {
    const defaults = loadTrackingPolicyDefaults();
    const content = renderTrackingWorkflow(defaults);
    expect(trackingWorkflowArtifact()).toEqual({
      path: `.github/workflows/${defaults.workflow.file}`,
      content,
      digest: trackingWorkflowDigest(content),
    });
    expect(roundTrackingCommands).toEqual([
      roundTrackingDisable,
      roundTrackingEnable,
      roundTrackingStatus,
      roundTrackingSync,
    ]);
    expect(
      roundTrackingCommands.map(({ name, authority, description }) => ({
        name,
        authority,
        hasDescription: description.length > 40,
      })),
    ).toEqual([
      { name: 'round tracking disable', authority: 'mesh_controller', hasDescription: true },
      { name: 'round tracking enable', authority: 'mesh_controller', hasDescription: true },
      { name: 'round tracking status', authority: 'mesh_controller', hasDescription: true },
      { name: 'round tracking sync', authority: 'mesh_controller', hasDescription: true },
    ]);
  });

  it('normalizes a padded round and distinguishes missing from malformed identities', async () => {
    const root = repository();
    bind(root);
    const padded = await invoke(roundTrackingEnable, [
      'round-tracking-enable',
      '--repo-root',
      root,
      '--round',
      `  ${ROUND}  `,
      '--publish',
      '--human',
    ]);
    expect(padded.stdout).toContain(`dry run for ${ROUND} on ${REPOSITORY}`);

    const missing = await invoke(roundTrackingStatus, [
      'round-tracking-status',
      '--repo-root',
      root,
    ]);
    expect(json(missing.stderr)).toMatchObject({ code: 'TRACKING_ROUND_REQUIRED', exit: 2 });
    const malformed = await invoke(roundTrackingStatus, [
      'round-tracking-status',
      '--repo-root',
      root,
      '--round',
      'round-4242',
    ]);
    expect(json(malformed.stderr)).toMatchObject({ code: 'TRACKING_ROUND_INVALID', exit: 2 });
    for (const value of [`prefix-${ROUND}`, `${ROUND}-suffix`]) {
      const bounded = await invoke(roundTrackingStatus, [
        'round-tracking-status',
        '--repo-root',
        root,
        '--round',
        value,
      ]);
      expect(json(bounded.stderr)).toMatchObject({ code: 'TRACKING_ROUND_INVALID', exit: 2 });
    }

    const boundInactive = await invoke(roundTrackingStatus, [
      'round-tracking-status',
      '--repo-root',
      root,
      '--round',
      ROUND,
    ]);
    expect(json(boundInactive.stdout)).toMatchObject({
      mode: 'github-issues',
      activation: 'bound-inactive',
    });

    const unboundRoot = repository();
    const unbound = await invoke(roundTrackingStatus, [
      'round-tracking-status',
      '--repo-root',
      unboundRoot,
      '--round',
      ROUND,
    ]);
    expect(json(unbound.stdout)).toMatchObject({ mode: 'disabled', activation: 'absent' });
  });

  it('renders exact human status for an active round', async () => {
    const root = repository();
    activate(root);
    const result = await invoke(roundTrackingStatus, [
      'round-tracking-status',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--human',
    ]);
    expect(result).toEqual({
      exit: 0,
      stdout:
        `round tracking status: ${ROUND}; mode github-issues, activation active, ` +
        '0 canonical / 0 projected / 0 pending; projection idle\n',
      stderr: '',
    });
  });

  it('refuses enable without consent, a binding, or an intact workflow', async () => {
    const root = repository();
    const noConsent = await invoke(roundTrackingEnable, [
      'round-tracking-enable',
      '--repo-root',
      root,
      '--round',
      ROUND,
    ]);
    expect(json(noConsent.stderr)).toMatchObject({
      code: 'TRACKING_PUBLISH_CONSENT_REQUIRED',
      operation: 'tracking enable',
      exit: 2,
    });

    const noBinding = await invoke(roundTrackingEnable, [
      'round-tracking-enable',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--publish',
    ]);
    expect(json(noBinding.stderr)).toMatchObject({ code: 'TRACKING_BINDING_ABSENT', exit: 5 });

    bind(root);
    writeFileSync(join(root, '.github/workflows/devai-issue-tracking.yml'), 'drifted\n');
    const stale = await invoke(roundTrackingEnable, [
      'round-tracking-enable',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--publish',
    ]);
    expect(json(stale.stderr)).toMatchObject({
      code: 'TRACKING_BINDING_STALE:TRACKING_WORKFLOW_DRIFT',
      exit: 5,
    });
    expect(remote.calls).toEqual([]);
  });

  it('keeps enable dry runs local and explains the exact write boundary', async () => {
    const root = repository();
    bind(root);
    const result = await invoke(roundTrackingEnable, [
      'round-tracking-enable',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--publish',
      '--human',
    ]);
    expect(result).toEqual({
      exit: 0,
      stdout: `round tracking enable: dry run for ${ROUND} on ${REPOSITORY}; re-run with --write\n`,
      stderr: '',
    });
    expect(readRoundTrackingActivation({ repoRoot: root, round: ROUND })).toBeUndefined();
    expect(remote.calls).toEqual([]);
  });

  it('refuses a declared authority session that cannot be validated instead of deriving one', async () => {
    const root = repository();
    bind(root);
    const result = await invoke(roundTrackingEnable, [
      'round-tracking-enable',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--publish',
      '--write',
      '--authority-session',
      'AUTH-SESSION-missing',
    ]);
    expect(json(result.stderr)).toMatchObject({
      code: 'AUTHORITY_SESSION_NOT_FOUND',
      operation: 'tracking enable',
      exit: 5,
    });
    expect(readRoundTrackingActivation({ repoRoot: root, round: ROUND })).toBeUndefined();
    expect(remote.calls).toEqual([]);
  });

  it('preserves an unexpected session resolver failure without relabeling it', async () => {
    const root = repository();
    bind(root);
    sessions.failUnexpectedly = true;
    const result = await invoke(roundTrackingEnable, [
      'round-tracking-enable',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--publish',
      '--write',
    ]);
    expect(json(result.stderr)).toEqual({
      code: 'TRACKING_SESSION_BACKEND_FAILED',
      operation: 'tracking enable',
      exit: 2,
    });
    expect(readRoundTrackingActivation({ repoRoot: root, round: ROUND })).toBeUndefined();
  });

  it('activates, creates an issue, projects one batch once, and durably records it', async () => {
    const root = repository();
    bind(root);
    const result = await invoke(roundTrackingEnable, [
      'round-tracking-enable',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--publish',
      '--write',
    ]);
    expect(result.stderr).toBe('');
    expect(json(result.stdout)).toMatchObject({
      activation: 'active',
      canonical_events: 2,
      projected_events: 2,
      pending_events: 0,
      projection: 'synced',
      issue: 101,
    });
    expect(remote.commentPosts).toBe(1);
    expect(readDeliveryState({ repoRoot: root, round: ROUND })).toMatchObject({
      issue: 101,
      projected_event_ids: expect.arrayContaining(
        readGovernanceEvents({ repoRoot: root, round: ROUND }).map((event) => event.event_id),
      ),
      receipts: [{ state: 'delivered', comment_id: 1001, attempts: 1 }],
      last_error: null,
    });
    expect(readRoundTrackingActivation({ repoRoot: root, round: ROUND })?.target).toEqual({
      repository: REPOSITORY,
      issue_number: 101,
    });
  });

  it('keeps local activation and records projection failure when enable cannot reach GitHub', async () => {
    const root = repository();
    bind(root);
    remote.failAll = true;
    const result = await invoke(roundTrackingEnable, [
      'round-tracking-enable',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--publish',
      '--write',
    ]);
    expect(result.stderr).toBe('');
    expect(json(result.stdout)).toMatchObject({
      activation: 'active',
      canonical_events: 2,
      projected_events: 0,
      pending_events: 2,
      projection: 'unreachable',
    });
    expect(readRoundTrackingActivation({ repoRoot: root, round: ROUND })).toBeDefined();
    expect(readDeliveryState({ repoRoot: root, round: ROUND }).last_error).toMatchObject({
      classification: 'service',
      attempts: 1,
      public_safe_detail: 'service unavailable',
    });
  });

  it('keeps closure inert when tracking was never activated', () => {
    const root = repository();
    expect(
      recordRoundCloseTracking({ repoRoot: root, round: ROUND, verdict: 'accepted' }),
    ).toBeUndefined();
    expect(readGovernanceEvents({ repoRoot: root, round: ROUND })).toEqual([]);
  });

  it('records and seals closure with the activation session identity', async () => {
    const root = repository();
    activate(root);
    const status = await withAuthorityHostTestScope(() =>
      recordRoundCloseTracking({ repoRoot: root, round: ROUND, verdict: 'accepted' }),
    );
    expect(status).toMatchObject({
      activation: 'active',
      canonical_events: 1,
      projected_events: 0,
      pending_events: 1,
    });
    expect(readGovernanceEvents({ repoRoot: root, round: ROUND })).toMatchObject([
      {
        authority_session_id: SESSION,
        session_source: 'session-state',
        role: 'owner',
        kind: 'round_verdict',
        coverage: { mediated: true, adapter_id: 'github-issues' },
        public_safe_summary: `Round ${ROUND} closed with phase closure accepted.`,
        payload_digest_sha256: canonicalSha256({ round: ROUND, closure: 'accepted' }),
      },
    ]);
    const segments = listGovernanceSegments({ repoRoot: root, round: ROUND });
    expect(segments).toHaveLength(1);
    expect(segments[0]?.event_ids).toEqual([
      readGovernanceEvents({ repoRoot: root, round: ROUND })[0]?.event_id,
    ]);
  });

  it('labels direct closure identities and keeps recording faults best-effort', async () => {
    const root = repository();
    const current = activate(root);
    put(root, `.devai/state/tracking/${ROUND}/activation.json`, {
      ...current,
      authorization: {
        ...current.authorization,
        authority_session_id: 'DIRECT-CLI-0123456789abcdef0123456789abcdef',
      },
    });
    await withAuthorityHostTestScope(() =>
      recordRoundCloseTracking({ repoRoot: root, round: ROUND, verdict: 'rejected' }),
    );
    expect(readGovernanceEvents({ repoRoot: root, round: ROUND })[0]).toMatchObject({
      session_source: 'direct-cli',
      public_safe_summary: `Round ${ROUND} closed with phase closure rejected.`,
    });

    const refusedRoot = repository();
    activate(refusedRoot);
    expect(
      recordRoundCloseTracking({ repoRoot: refusedRoot, round: ROUND, verdict: 'accepted' }),
    ).toMatchObject({ activation: 'active', canonical_events: 0, projection: 'idle' });
    expect(readGovernanceEvents({ repoRoot: refusedRoot, round: ROUND })).toEqual([]);
  });

  it('persists all confirmed batches and terminates after a multi-batch drain', async () => {
    const root = repository();
    activate(root);
    remote.issue = 101;
    await recordAndSeal(root, 129);
    const result = await invoke(roundTrackingSync, [
      'round-tracking-sync',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--write',
    ]);
    expect(result.stderr).toBe('');
    expect(json(result.stdout)).toMatchObject({
      canonical_events: 129,
      projected_events: 129,
      pending_events: 0,
      projection: 'synced',
    });
    expect(remote.commentPosts).toBe(2);
    const delivery = readDeliveryState({ repoRoot: root, round: ROUND });
    expect(delivery.projected_event_ids).toHaveLength(129);
    expect(delivery.receipts.map((receipt) => receipt.state)).toEqual(['delivered', 'delivered']);
  });

  it('resumes after an interrupted multi-batch drain without repeating the confirmed effect', async () => {
    const root = repository();
    activate(root);
    remote.issue = 101;
    remote.failCommentPost = 2;
    await recordAndSeal(root, 129);

    const interrupted = await invoke(roundTrackingSync, [
      'round-tracking-sync',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--write',
    ]);
    expect(interrupted.stderr).toBe('');
    expect(json(interrupted.stdout)).toMatchObject({
      projected_events: 128,
      pending_events: 1,
      projection: 'unreachable',
    });
    expect(readDeliveryState({ repoRoot: root, round: ROUND })).toMatchObject({
      projected_event_ids: expect.any(Array),
      receipts: [{ state: 'delivered', comment_id: 1001 }],
      last_error: {
        classification: 'service',
        attempts: 1,
        public_safe_detail: 'service unavailable',
      },
    });
    expect(readDeliveryState({ repoRoot: root, round: ROUND }).projected_event_ids).toHaveLength(
      128,
    );

    remote.failCommentPost = 0;
    const resumed = await invoke(roundTrackingSync, [
      'round-tracking-sync',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--write',
    ]);
    expect(resumed.stderr).toBe('');
    expect(json(resumed.stdout)).toMatchObject({
      projected_events: 129,
      pending_events: 0,
      projection: 'synced',
    });
    expect(remote.commentPosts).toBe(3);
    expect(remote.comments).toHaveLength(2);
    expect(readDeliveryState({ repoRoot: root, round: ROUND }).receipts).toHaveLength(2);
  });

  it('makes an already-projected outbox a remote no-op', async () => {
    const root = repository();
    activate(root);
    await recordAndSeal(root, 1);
    const event = readGovernanceEvents({ repoRoot: root, round: ROUND })[0];
    put(root, `.devai/state/tracking/${ROUND}/delivery.json`, {
      issue: 101,
      projected_event_ids: [event?.event_id],
      receipts: [],
      divergence: false,
      divergence_detail: null,
      last_error: null,
    });
    const result = await invoke(roundTrackingSync, [
      'round-tracking-sync',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--write',
    ]);
    expect(result.stderr).toBe('');
    expect(json(result.stdout)).toMatchObject({ pending_events: 0, projection: 'synced' });
    expect(remote.calls).toEqual([]);
  });

  it('reconciles an already-present remote batch without posting it again', async () => {
    const root = repository();
    activate(root);
    remote.issue = 101;
    await recordAndSeal(root, 1);
    const first = await invoke(roundTrackingSync, [
      'round-tracking-sync',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--write',
    ]);
    expect(first.stderr).toBe('');
    expect(remote.commentPosts).toBe(1);
    const existing = readDeliveryState({ repoRoot: root, round: ROUND });
    put(root, `.devai/state/tracking/${ROUND}/delivery.json`, {
      ...existing,
      projected_event_ids: [],
      receipts: [],
    });

    const reconciled = await invoke(roundTrackingSync, [
      'round-tracking-sync',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--reconcile',
    ]);
    expect(reconciled.stderr).toBe('');
    expect(remote.commentPosts).toBe(1);
    expect(readDeliveryState({ repoRoot: root, round: ROUND }).receipts).toMatchObject([
      { state: 'reconciled', comment_id: 1001, attempts: 1 },
    ]);
  });

  it('records divergence and refuses an implicit replacement for a missing issue', async () => {
    const root = repository();
    activate(root, { target: { repository: REPOSITORY, issue_number: null } });
    await recordAndSeal(root, 1);
    const result = await invoke(roundTrackingSync, [
      'round-tracking-sync',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--write',
    ]);
    expect(json(result.stderr)).toMatchObject({ code: 'TRACKING_ISSUE_MISSING', exit: 5 });
    expect(readDeliveryState({ repoRoot: root, round: ROUND })).toMatchObject({
      divergence: true,
      divergence_detail: expect.stringContaining('--replace-missing-issue'),
    });
    expect(remote.commentPosts).toBe(0);
  });

  it('allows an explicitly authorized replacement and binds the new issue', async () => {
    const root = repository();
    activate(root, { target: { repository: REPOSITORY, issue_number: null } });
    await recordAndSeal(root, 1);
    const result = await invoke(roundTrackingSync, [
      'round-tracking-sync',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--write',
      '--replace-missing-issue',
    ]);
    expect(result.stderr).toBe('');
    expect(json(result.stdout)).toMatchObject({ pending_events: 0, issue: 101 });
    expect(remote.commentPosts).toBe(1);
    expect(
      readRoundTrackingActivation({ repoRoot: root, round: ROUND })?.target?.issue_number,
    ).toBe(101);
    expect(readDeliveryState({ repoRoot: root, round: ROUND }).divergence).toBe(false);
  });

  it('rejects reconcile replacement, stale activation bindings, and disabled freeze rounds', async () => {
    const root = repository();
    const active = activate(root);
    const replacement = await invoke(roundTrackingSync, [
      'round-tracking-sync',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--reconcile',
      '--replace-missing-issue',
    ]);
    expect(json(replacement.stderr)).toMatchObject({
      code: 'TRACKING_RECONCILE_REPLACEMENT_FORBIDDEN',
      exit: 2,
    });

    put(root, `.devai/state/tracking/${ROUND}/activation.json`, {
      ...active,
      adapter: { ...active.adapter, config_digest_sha256: 'f'.repeat(64) },
    });
    const stale = await invoke(roundTrackingSync, [
      'round-tracking-sync',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--write',
    ]);
    expect(json(stale.stderr)).toMatchObject({
      code: 'TRACKING_ACTIVATION_BINDING_STALE',
      exit: 5,
    });

    put(root, `.devai/state/tracking/${ROUND}/activation.json`, {
      ...active,
      target: { repository: 'other/adopter', issue_number: 101 },
    });
    const foreign = await invoke(roundTrackingSync, [
      'round-tracking-sync',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--write',
    ]);
    expect(json(foreign.stderr)).toMatchObject({
      code: 'TRACKING_ACTIVATION_REPOSITORY_MISMATCH',
      exit: 5,
    });

    put(root, `.devai/state/tracking/${ROUND}/activation.json`, {
      ...active,
      state: 'disabled',
      disabled: {
        disabled_at: '2026-09-09T13:00:00.000Z',
        authority_session_id: SESSION,
        pending_events: 0,
      },
    });
    const disabled = await invoke(roundTrackingSync, [
      'round-tracking-sync',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--write',
    ]);
    expect(json(disabled.stderr)).toMatchObject({ code: 'TRACKING_ROUND_DISABLED', exit: 5 });
    expect(remote.calls).toEqual([]);
  });

  it('accepts an activation without a repository target when the current binding still matches', async () => {
    const root = repository();
    const active = activate(root);
    remote.overrideActivation = true;
    remote.activation = { ...active, target: undefined };
    remote.issue = 101;
    const result = await invoke(roundTrackingSync, [
      'round-tracking-sync',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--write',
    ]);
    expect(result.stderr).toBe('');
    expect(json(result.stdout)).toMatchObject({ activation: 'active', pending_events: 0 });
    expect(remote.calls[0]?.[3]).toBe('search/issues');
  });

  it('reports a sync dry run with the exact pending count and no remote call', async () => {
    const root = repository();
    activate(root);
    await recordAndSeal(root, 2);
    const result = await invoke(roundTrackingSync, [
      'round-tracking-sync',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--human',
    ]);
    expect(result).toEqual({
      exit: 0,
      stdout: `round tracking sync: dry run for ${ROUND}; 2 event(s) would project; re-run with --write\n`,
      stderr: '',
    });
    expect(remote.calls).toEqual([]);
  });

  it('validates disable policy and drain consent before changing the activation', async () => {
    const root = repository();
    activate(root);
    const invalid = await invoke(roundTrackingDisable, [
      'round-tracking-disable',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--pending',
      'discard',
    ]);
    expect(json(invalid.stderr)).toMatchObject({
      code: 'TRACKING_PENDING_POLICY_INVALID',
      exit: 2,
    });

    const noConsent = await invoke(roundTrackingDisable, [
      'round-tracking-disable',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--pending',
      'drain',
    ]);
    expect(json(noConsent.stderr)).toMatchObject({
      code: 'TRACKING_DRAIN_CONSENT_REQUIRED',
      exit: 2,
    });
    expect(readRoundTrackingActivation({ repoRoot: root, round: ROUND })?.state).toBe('active');
  });

  it('refuses sync and disable when activation authority is absent or unpublished', async () => {
    const root = repository();
    bind(root);
    const absent = await invoke(roundTrackingSync, [
      'round-tracking-sync',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--write',
    ]);
    expect(json(absent.stderr)).toMatchObject({ code: 'TRACKING_ROUND_NOT_ACTIVATED', exit: 5 });

    const active = activate(root);
    remote.overrideActivation = true;
    remote.activation = {
      ...active,
      authorization: { ...active.authorization, publish_flag: false },
    };
    const unpublished = await invoke(roundTrackingDisable, [
      'round-tracking-disable',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--write',
    ]);
    expect(json(unpublished.stderr)).toMatchObject({
      code: 'TRACKING_PUBLICATION_UNAUTHORIZED',
      exit: 5,
    });
    expect(remote.calls).toEqual([]);
  });

  it('keeps disable dry runs local and reports the selected pending policy', async () => {
    const root = repository();
    activate(root);
    const result = await invoke(roundTrackingDisable, [
      'round-tracking-disable',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--pending',
      'freeze',
      '--human',
    ]);
    expect(result).toEqual({
      exit: 0,
      stdout: `round tracking disable: dry run for ${ROUND} with --pending freeze; re-run with --write\n`,
      stderr: '',
    });
    expect(readRoundTrackingActivation({ repoRoot: root, round: ROUND })?.state).toBe('active');
    expect(remote.calls).toEqual([]);
  });

  it('freezes locally with an exact pending count and no remote call', async () => {
    const root = repository();
    activate(root);
    await recordAndSeal(root, 2);
    const result = await invoke(roundTrackingDisable, [
      'round-tracking-disable',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--write',
      '--human',
    ]);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(`${ROUND} frozen; 3 pending event(s) frozen`);
    expect(readRoundTrackingActivation({ repoRoot: root, round: ROUND })).toMatchObject({
      state: 'frozen',
      pending_policy: 'freeze',
      disabled: { pending_events: 2 },
    });
    expect(readGovernanceEvents({ repoRoot: root, round: ROUND }).at(-1)).toMatchObject({
      kind: 'tracking_disabled',
      session_source: 'direct-cli',
    });
    expect(remote.calls).toEqual([]);
  });

  it('drains pending evidence before reporting a disabled round', async () => {
    const root = repository();
    activate(root);
    remote.issue = 101;
    await recordAndSeal(root, 2);
    const result = await invoke(roundTrackingDisable, [
      'round-tracking-disable',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--pending',
      'drain',
      '--publish',
      '--write',
    ]);
    expect(result.stderr).toBe('');
    expect(json(result.stdout)).toMatchObject({
      activation: 'disabled',
      canonical_events: 3,
      projected_events: 3,
      pending_events: 0,
      projection: 'synced',
    });
    expect(remote.commentPosts).toBe(1);
  });

  it('records a drain failure while preserving the disabled local decision', async () => {
    const root = repository();
    activate(root);
    await recordAndSeal(root, 1);
    remote.failAll = true;
    const result = await invoke(roundTrackingDisable, [
      'round-tracking-disable',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--pending',
      'drain',
      '--publish',
      '--write',
    ]);
    expect(result.stderr).toBe('');
    expect(json(result.stdout)).toMatchObject({
      activation: 'disabled',
      pending_events: 2,
      projection: 'unreachable',
    });
    expect(readDeliveryState({ repoRoot: root, round: ROUND }).last_error).toMatchObject({
      classification: 'service',
      attempts: 1,
      public_safe_detail: 'service unavailable',
    });
  });

  it('disables with zero pending when delivery already contains more ids than canonical events', async () => {
    const root = repository();
    activate(root);
    put(root, `.devai/state/tracking/${ROUND}/delivery.json`, {
      issue: 101,
      projected_event_ids: ['GEV-extra-1', 'GEV-extra-2'],
      receipts: [],
      divergence: false,
      divergence_detail: null,
      last_error: null,
    });
    const result = await invoke(roundTrackingDisable, [
      'round-tracking-disable',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--write',
    ]);
    expect(result.stderr).toBe('');
    expect(readRoundTrackingActivation({ repoRoot: root, round: ROUND })?.disabled).toMatchObject({
      pending_events: 0,
    });
  });

  it('does not create an issue while draining a round that has no discoverable remote issue', async () => {
    const root = repository();
    activate(root, { target: { repository: REPOSITORY, issue_number: null } });
    await recordAndSeal(root, 1);
    const result = await invoke(roundTrackingDisable, [
      'round-tracking-disable',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--pending',
      'drain',
      '--publish',
      '--write',
    ]);
    expect(result.stderr).toBe('');
    expect(json(result.stdout)).toMatchObject({
      activation: 'disabled',
      projected_events: 0,
      pending_events: 2,
      projection: 'pending',
    });
    expect(remote.calls.filter((call) => call[2] === 'POST')).toEqual([]);
  });

  it('retains bounded public-safe failure details and increments retry attempts', async () => {
    const root = repository();
    activate(root);
    await recordAndSeal(root, 1);
    remote.failAll = true;
    await invoke(roundTrackingSync, [
      'round-tracking-sync',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--write',
    ]);
    const first = readDeliveryState({ repoRoot: root, round: ROUND });
    expect(first.last_error).toMatchObject({
      classification: 'service',
      attempts: 1,
      public_safe_detail: 'service unavailable',
    });
    await invoke(roundTrackingSync, [
      'round-tracking-sync',
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--write',
    ]);
    expect(readDeliveryState({ repoRoot: root, round: ROUND }).last_error).toMatchObject({
      classification: 'service',
      attempts: 2,
    });
  });
});
