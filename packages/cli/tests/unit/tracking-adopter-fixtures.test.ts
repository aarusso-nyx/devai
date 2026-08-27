// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
// Inspector acceptance: a clean adopter fixture for every tracking mode.
// Absent, bound-but-inactive, active-and-offline, active-and-reconciled, and
// disabled must each report a coherent posture, and none of them may make a
// network call or let projection health leak into the adoption verdict.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CAC } from 'cac';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { runWithAuthorityPolicyMaterialization } from '../../src/authority/command-capabilities.js';
import { doctor } from '../../src/commands/doctor.js';
import { initBind } from '../../src/commands/init/index.js';
import { roundTrackingStatus } from '../../src/commands/round/tracking.js';
import {
  governanceTrackingStatus,
  readGovernanceEvents,
  trackGovernanceEvent,
  type RoundTrackingActivation,
} from '@devai-nyx/loop';
import {
  loadTrackingPolicyDefaults,
  TRACKING_CONFIG_RELATIVE,
  TRACKING_WORKFLOW_RELATIVE,
} from '../../src/services/github-issues-tracking/config.js';
import { renderTrackingWorkflow } from '../../src/services/github-issues-tracking/workflow.js';

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};

const roots: string[] = [];
const ROUND = 'R-0042';
const REPOSITORY = 'example/adopter';
const SESSION = 'AUTH-SESSION-0f1e2d3c4b5a69788796';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The minimum an adopter repository needs before any tracking mode applies. */
function adopter(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-tracking-fixture-'));
  roots.push(root);
  put(root, '.devai/config/project.json', {
    schemaVersion: '1.0.0',
    project_type: 'platform-package',
    name: 'adopter',
    profile: 'tier1',
  });
  return root;
}

function put(repo: string, path: string, value: unknown): void {
  const absolute = join(repo, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(
    absolute,
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
}

async function invoke(definition: { register(cli: CAC): void }, argv: readonly string[]) {
  const cli = cac('devai-tracking-fixture');
  definition.register(cli);
  const previous = {
    argv: process.argv,
    exit: process.exit,
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
    process.exit = ((code?: string | number | null) => {
      process.exitCode = typeof code === 'number' ? code : 0;
      throw new Error(`TEST_PROCESS_EXIT:${String(process.exitCode)}`);
    }) as typeof process.exit;
    cli.parse(process.argv, { run: false });
    try {
      await withAuthorityHostTestScope(() =>
        runWithAuthorityPolicyMaterialization(
          () => ({
            path: '.devai/config/authority-policy.json',
            operation: 'unchanged',
            digest_sha256: 'a'.repeat(64),
          }),
          () => cli.runMatchedCommand(),
        ),
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('TEST_PROCESS_EXIT:')) throw error;
    }
    await new Promise<void>((done) => setImmediate(done));
    return { exit: process.exitCode ?? 0, stdout, stderr };
  } finally {
    process.argv = previous.argv;
    process.exit = previous.exit;
    process.exitCode = previous.exitCode;
    process.stdout.write = previous.stdout;
    process.stderr.write = previous.stderr;
  }
}

interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly info?: Record<string, unknown>;
  readonly errors?: readonly string[];
}

/** Run the real Doctor and return only the tracking check. */
async function trackingCheck(root: string): Promise<DoctorCheck> {
  // Doctor emits JSON by default; --skip keeps the fixture off the docs-governance
  // path, which is unrelated to tracking.
  const result = await invoke(doctor, ['doctor', '--repo-root', root, '--skip', 'docs-governance']);
  const report = JSON.parse(result.stdout) as { checks: readonly DoctorCheck[] };
  const check = report.checks.find((entry) => entry.name === 'governance-tracking-binding');
  if (check === undefined) throw new Error('tracking check missing from doctor report');
  return check;
}

/** Materialize the repository capability through the real registered action. */
async function bind(root: string): Promise<void> {
  const result = await invoke(initBind, [
    'init-bind',
    '--tracking-adapter',
    'github-issues',
    '--tracking-repository',
    REPOSITORY,
    '--target',
    root,
    '--write',
  ]);
  expect(result.stderr, result.stderr).toBe('');
}

function activation(
  root: string,
  overrides: Partial<RoundTrackingActivation> = {},
): RoundTrackingActivation {
  const config = JSON.parse(readFileSync(join(root, TRACKING_CONFIG_RELATIVE), 'utf8')) as {
    digests: { policy_defaults_sha256: string; workflow_sha256: string };
  };
  return {
    schemaVersion: '1.0.0',
    round_id: ROUND,
    repository_id: 'adopter',
    state: 'active',
    adapter: {
      id: 'github-issues',
      adapter_version: '1.0.0',
      package_version: '1.3.0',
      config_digest_sha256: config.digests.policy_defaults_sha256,
      workflow_digest_sha256: config.digests.workflow_sha256,
    },
    target: { repository: REPOSITORY, issue_number: null },
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

async function recordEvents(root: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await withAuthorityHostTestScope(() =>
      trackGovernanceEvent({
        repoRoot: root,
        round: ROUND,
        role: 'engineer',
        kind: 'action_completed',
        status: 'pass',
        summary: `Mediated action ${String(index + 1)} completed.`,
        payload: { index },
        checkpoint: index === count - 1,
      }),
    );
  }
}

describe('mode: tracking absent', () => {
  it('reports a clean opt-out and makes no network call', async () => {
    const root = adopter();
    const check = await trackingCheck(root);

    expect(check.ok).toBe(true);
    expect(check.info).toMatchObject({ mode: 'disabled', opt_out: true, network_calls: 0 });
    expect(check.errors).toBeUndefined();
    expect(governanceTrackingStatus({ repoRoot: root, round: ROUND })).toMatchObject({
      mode: 'disabled',
      activation: 'absent',
      canonical_events: 0,
      projection: 'idle',
    });
  });

  it('leaves no tracking state behind at all', async () => {
    const root = adopter();
    await trackingCheck(root);
    expect(existsSync(join(root, '.devai/state/tracking'))).toBe(false);
    expect(existsSync(join(root, TRACKING_CONFIG_RELATIVE))).toBe(false);
    expect(existsSync(join(root, TRACKING_WORKFLOW_RELATIVE))).toBe(false);
  });
});

describe('mode: bound but inactive', () => {
  it('materializes the exact generated bytes through init bind --write', async () => {
    const root = adopter();
    await bind(root);

    const workflow = readFileSync(join(root, TRACKING_WORKFLOW_RELATIVE), 'utf8');
    expect(workflow).toBe(renderTrackingWorkflow(loadTrackingPolicyDefaults()));

    const config = JSON.parse(readFileSync(join(root, TRACKING_CONFIG_RELATIVE), 'utf8')) as {
      binding: { repository: string; bound_by_role: string };
      defaults: unknown;
    };
    expect(config.binding.repository).toBe(REPOSITORY);
    expect(config.binding.bound_by_role).toBe('architect');
    expect(config.defaults).toEqual(loadTrackingPolicyDefaults());

    const project = JSON.parse(readFileSync(join(root, '.devai/config/project.json'), 'utf8')) as {
      governance_tracking?: Record<string, string>;
    };
    expect(project.governance_tracking).toEqual({
      adapter: 'github-issues',
      config: TRACKING_CONFIG_RELATIVE,
      workflow: TRACKING_WORKFLOW_RELATIVE,
    });
  });

  it('passes Doctor while activating no round and recording nothing', async () => {
    const root = adopter();
    await bind(root);

    const check = await trackingCheck(root);
    expect(check.ok).toBe(true);
    expect(check.info).toMatchObject({
      mode: 'github-issues',
      repository: REPOSITORY,
      readiness_impact: 'best-effort',
      coverage: 'devai-mediated-actions-only',
      network_calls: 0,
    });

    const status = governanceTrackingStatus({ repoRoot: root, round: ROUND, bound: true });
    expect(status.activation).toBe('bound-inactive');
    expect(status.canonical_events).toBe(0);
    expect(existsSync(join(root, '.devai/state/tracking', ROUND, 'events.jsonl'))).toBe(false);
  });

  it('fails Doctor when the generated workflow is edited by hand', async () => {
    const root = adopter();
    await bind(root);
    const path = join(root, TRACKING_WORKFLOW_RELATIVE);
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n# hand edit\n`);

    const check = await trackingCheck(root);
    expect(check.ok).toBe(false);
    expect(check.errors?.join(' ')).toContain('TRACKING_WORKFLOW_DRIFT');
  });
});

describe('mode: active and offline', () => {
  it('keeps recording and reports pending projection with no issue and no divergence', async () => {
    const root = adopter();
    await bind(root);
    put(root, join('.devai/state/tracking', ROUND, 'activation.json'), activation(root));
    await recordEvents(root, 3);

    const status = governanceTrackingStatus({ repoRoot: root, round: ROUND, bound: true });
    expect(status).toMatchObject({
      mode: 'github-issues',
      activation: 'active',
      canonical_events: 3,
      projected_events: 0,
      pending_events: 3,
      projection: 'pending',
      issue: null,
      divergence: false,
    });

    // Adoption posture stays clean: an unprojected outbox is not a defect.
    expect((await trackingCheck(root)).ok).toBe(true);
  });

  it('seals the offline round into proof storage so it stays rebuildable', async () => {
    const root = adopter();
    await bind(root);
    put(root, join('.devai/state/tracking', ROUND, 'activation.json'), activation(root));
    await recordEvents(root, 2);

    expect(existsSync(join(root, 'record/proofs/governance', ROUND))).toBe(true);
    expect(readGovernanceEvents({ repoRoot: root, round: ROUND })).toHaveLength(2);
  });
});

describe('mode: active and reconciled', () => {
  it('reports a synced projection with the bound issue and nothing pending', async () => {
    const root = adopter();
    await bind(root);
    put(root, join('.devai/state/tracking', ROUND, 'activation.json'), activation(root));
    await recordEvents(root, 3);

    const events = readGovernanceEvents({ repoRoot: root, round: ROUND });
    put(root, join('.devai/state/tracking', ROUND, 'delivery.json'), {
      issue: 123,
      projected_event_ids: events.map((event) => event.event_id),
      receipts: [],
      divergence: false,
      divergence_detail: null,
      last_error: null,
    });

    const status = governanceTrackingStatus({ repoRoot: root, round: ROUND, bound: true });
    expect(status).toMatchObject({
      activation: 'active',
      canonical_events: 3,
      projected_events: 3,
      pending_events: 0,
      projection: 'synced',
      issue: 123,
      divergence: false,
    });
    expect((await trackingCheck(root)).ok).toBe(true);
  });

  it('reports an unreachable remote without disturbing the adoption verdict', async () => {
    const root = adopter();
    await bind(root);
    put(root, join('.devai/state/tracking', ROUND, 'activation.json'), activation(root));
    await recordEvents(root, 2);
    put(root, join('.devai/state/tracking', ROUND, 'delivery.json'), {
      issue: null,
      projected_event_ids: [],
      receipts: [],
      divergence: false,
      divergence_detail: null,
      last_error: {
        classification: 'service',
        observed_at: '2026-08-27T12:30:00.000Z',
        attempts: 3,
        public_safe_detail: null,
      },
    });

    const status = governanceTrackingStatus({ repoRoot: root, round: ROUND, bound: true });
    expect(status.projection).toBe('unreachable');
    expect(status.canonical_events).toBe(2);
    // Readiness and tracking health are independent axes.
    expect((await trackingCheck(root)).ok).toBe(true);
  });
});

describe('mode: disabled', () => {
  it('reports the round as disabled and stops recording without deleting evidence', async () => {
    const root = adopter();
    await bind(root);
    put(root, join('.devai/state/tracking', ROUND, 'activation.json'), activation(root));
    await recordEvents(root, 2);

    put(
      root,
      join('.devai/state/tracking', ROUND, 'activation.json'),
      activation(root, {
        state: 'disabled',
        disabled: {
          disabled_at: '2026-08-27T13:00:00.000Z',
          authority_session_id: SESSION,
          pending_events: 2,
        },
      }),
    );

    const status = governanceTrackingStatus({ repoRoot: root, round: ROUND, bound: true });
    expect(status.activation).toBe('disabled');
    // Recorded evidence survives disabling; nothing is deleted.
    expect(status.canonical_events).toBe(2);

    await recordEvents(root, 1);
    expect(readGovernanceEvents({ repoRoot: root, round: ROUND })).toHaveLength(2);
    expect((await trackingCheck(root)).ok).toBe(true);
  });
});

describe('the status action itself', () => {
  it('emits a schema-valid payload for a bound, active round', async () => {
    const root = adopter();
    await bind(root);
    put(root, join('.devai/state/tracking', ROUND, 'activation.json'), activation(root));
    await recordEvents(root, 1);

    const result = await invoke(roundTrackingStatus, [
      'round-tracking-status',
      '--repo-root',
      root,
      '--round',
      ROUND,
    ]);
    expect(result.exit).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      schemaVersion: '1.0.0',
      mode: 'github-issues',
      activation: 'active',
      canonical_events: 1,
      projection: 'pending',
    });
    expect(payload['coverage_disclosure']).toMatchObject({ mediated_only: true });
  });
});
