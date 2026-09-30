import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
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
import {
  closeGovernedRound,
  declareGovernedRound,
  scaffoldGovernedRound,
} from '../../../loop/src/round-lifecycle/index.js';
import { withAuthorityHostTestScope as withSkillsHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { roundRun, roundStatus } from '../../src/commands/round/workflow.js';
import { taskStart } from '../../src/commands/task/index.js';

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

function putText(root: string, path: string, text: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
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

async function invokeCommand(command: { register(cli: CAC): void }, argv: readonly string[]) {
  const cli = cac('devai-round-tracking-test');
  command.register(cli);
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

function invokeStatus(argv: readonly string[]) {
  return invokeCommand(roundTrackingStatus, argv);
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

const SEALED_ROUND = 'R-0005';
const CLOSE_STATE = `work/rounds/${SEALED_ROUND}/close-state.jsonl`;

function sealedRoundRecord(): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    id: SEALED_ROUND,
    title: `${SEALED_ROUND} fixture`,
    type: 'round-record',
    status: 'closed',
    date: '2026-07-24',
    authority: 'Architect',
    kind: 'round',
    goal: 'Exercise the sealed round precondition',
    declared_by: 'DII-1',
    closed_by: 'DII-2',
    phase_closure: 'PC-0001',
    merged_as: 'b'.repeat(40),
    isolation: { kind: 'worktree', branch: 'fixture', base_sha: 'a'.repeat(40) },
    waves: [
      {
        id: 'W1',
        title: 'Verify',
        roles: ['Inspector'],
        type: 'serial',
        lock_scopes: ['tests/**'],
        gates: ['unit'],
      },
    ],
    gates: ['unit'],
    orchestrator_prompt: 'prompts/00-orchestrator.md',
    plan_path: 'plan.md',
  };
}

/** A declared closed round with an active task authorization, not yet sealed. */
function declareSealable(root: string): void {
  scaffoldGovernedRound({ repoRoot: root, round: 5 });
  put(root, 'record.json', sealedRoundRecord());
  declareGovernedRound({ repoRoot: root, round: 5, recordPath: join(root, 'record.json') });
  putText(
    root,
    'law/register/DECISIONS.md',
    '### DII-1 — Declare fixture\n\n### DII-2 — Close fixture\n',
  );
  put(root, 'record/proofs/compliance/closures/PC-0001.json', {
    schemaVersion: '1.0.0',
    id: 'PC-0001',
    round_id: SEALED_ROUND,
    declaring_decision: 'DII-1',
    closing_decision: 'DII-2',
    batches: [{ id: 'B1', roles: ['Architect'], headline: 'fixture' }],
    gates: { unit: { status: 'pass' } },
    source_repo_deleted: false,
    validation_criteria: [{ criterion: 'fixture', verdict: 'pass', evidence: 'unit' }],
    closed_at: '2026-07-26T00:00:00.000Z',
    merged_as: 'b'.repeat(40),
    release_disposition: 'none-needed',
  });
  putText(root, 'record/derived/indexes/rounds.md', 'PC-0001\n');
  putText(root, `work/rounds/${SEALED_ROUND}/AUTHORIZATION.md`, 'status: active\nGRANTED\n');
}

function sha(root: string, path: string): string {
  return createHash('sha256')
    .update(readFileSync(join(root, path)))
    .digest('hex');
}

function argvFor(name: string, root: string, round: string, extra: string[] = []): string[] {
  return [name, '--repo-root', root, '--round', round, ...extra];
}

describe.sequential('round status and dispatch on a sealed round (ADR-EVI-0003)', () => {
  it('IA-001 reads lifecycle closed with exit 0 after the seal and leaves the seal bytes unchanged', async () => {
    const root = repository();
    await withSkillsHostTestScope(() => {
      declareSealable(root);
      closeGovernedRound({ repoRoot: root, round: 5 });
    });
    const before = sha(root, CLOSE_STATE);

    const result = await invokeCommand(roundStatus, argvFor('round-status', root, SEALED_ROUND));
    expect(result.stderr).toBe('');
    expect(result.exit).toBe(0);
    const body = JSON.parse(result.stdout) as {
      lifecycle: { id: string; location: string };
      tasks?: unknown;
    };
    expect(body.lifecycle).toMatchObject({ id: SEALED_ROUND, location: 'closed' });
    expect(body).not.toHaveProperty('tasks');
    expect(sha(root, CLOSE_STATE)).toBe(before);
  });

  it('IA-002 keeps the task summary on the same round before the seal', async () => {
    const root = repository();
    await withSkillsHostTestScope(() => {
      declareSealable(root);
    });
    const result = await invokeCommand(roundStatus, argvFor('round-status', root, SEALED_ROUND));
    expect(result).toMatchObject({ exit: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toMatchObject({
      lifecycle: { id: SEALED_ROUND },
      tasks: { round_id: SEALED_ROUND, count: 0, tasks: [] },
    });
  });

  it('IA-003 refuses round run and task start on the sealed round with TASK_ROUND_INACTIVE', async () => {
    const root = repository();
    await withSkillsHostTestScope(() => {
      declareSealable(root);
    });
    // Control: the unsealed round accepts the dispatch preconditions.
    const control = await invokeCommand(roundRun, argvFor('round-run', root, SEALED_ROUND));
    expect(control.stderr).not.toContain('TASK_ROUND_INACTIVE');
    const controlStart = await invokeCommand(
      taskStart,
      argvFor('task-start', root, SEALED_ROUND, ['--task', 'TASK-0001']),
    );
    expect(controlStart.stderr).not.toContain('TASK_ROUND_INACTIVE');

    await withSkillsHostTestScope(() => {
      closeGovernedRound({ repoRoot: root, round: 5 });
    });
    const before = sha(root, CLOSE_STATE);

    const run = await invokeCommand(roundRun, argvFor('round-run', root, SEALED_ROUND));
    expect(run.exit).toBe(5);
    expect(JSON.parse(run.stderr)).toEqual({
      code: 'TASK_ROUND_INACTIVE',
      operation: 'run',
      exit: 5,
    });
    const start = await invokeCommand(
      taskStart,
      argvFor('task-start', root, SEALED_ROUND, ['--task', 'TASK-0001']),
    );
    expect(start.exit).toBe(5);
    expect(JSON.parse(start.stderr)).toMatchObject({ code: 'TASK_ROUND_INACTIVE', exit: 5 });
    expect(sha(root, CLOSE_STATE)).toBe(before);
  });

  it('IA-004 fails an unknown round with ROUND_RECORD_NOT_FOUND without reporting closed', async () => {
    const root = repository();
    const result = await invokeCommand(roundStatus, argvFor('round-status', root, 'R-0099'));
    expect(result.exit).not.toBe(0);
    expect(result.stdout).not.toMatch(/closed/u);
    expect(JSON.parse(result.stderr)).toEqual({
      code: 'ROUND_RECORD_NOT_FOUND',
      operation: 'status',
      exit: 2,
    });
    expect(result.exit).toBe(2);
  });
});
