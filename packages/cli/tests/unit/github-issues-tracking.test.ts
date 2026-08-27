// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-020
// Inspector acceptance for the opt-in github-issues tracking adapter:
// the generated workflow is minimal-permission, trusted-main-only and
// SHA-pinned; binding drift is detected rather than tolerated; the projector
// is idempotent under retries and ambiguous responses; and remote state is
// never treated as authority.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { canonicalSha256 } from '@devai-nyx/utils';
import { PUBLIC_SAFE_PROFILE, renderPublicSafe, type ProjectionBatch } from '@devai-nyx/loop';
import {
  loadTrackingPolicyDefaults,
  normalizeTrackingRepository,
  TrackingConfigError,
  trackingDefaultsDigest,
  verifyTrackingBinding,
  type BoundTrackingConfig,
} from '../../src/services/github-issues-tracking/config.js';
import {
  renderTrackingWorkflow,
  trackingWorkflowDigest,
} from '../../src/services/github-issues-tracking/workflow.js';
import {
  backoffDelays,
  classifyGhFailure,
  findBatchComment,
  projectBatch,
  ProjectorError,
  renderBatchComment,
  renderIssueBody,
  type GhResponse,
  type GhTransport,
} from '../../src/services/github-issues-tracking/projector.js';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../../..');

function canonicalPolicy(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(REPOSITORY_ROOT, 'law/policy/github-issues-tracking.json'), 'utf8'),
  ) as Record<string, unknown>;
}

function boundConfig(overrides: Partial<BoundTrackingConfig> = {}): BoundTrackingConfig {
  const defaults = loadTrackingPolicyDefaults();
  const workflow = renderTrackingWorkflow(defaults);
  return {
    schemaVersion: '1.0.0',
    id: 'github-issues-tracking',
    binding: {
      repository: 'example/adopter',
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
    ...overrides,
  };
}

describe('canonical policy binding', () => {
  it('mirrors the runtime disclosure profile from the canonical policy without drift', () => {
    const policy = canonicalPolicy() as { defaults: { disclosure: Record<string, number> } };
    expect(policy.defaults.disclosure['profile']).toBe(PUBLIC_SAFE_PROFILE.profile);
    expect(policy.defaults.disclosure['max_summary_chars']).toBe(
      PUBLIC_SAFE_PROFILE.max_summary_chars,
    );
    expect(policy.defaults.disclosure['max_events_per_batch']).toBe(
      PUBLIC_SAFE_PROFILE.max_events_per_batch,
    );
    expect(policy.defaults.disclosure['max_batch_chars']).toBe(PUBLIC_SAFE_PROFILE.max_batch_chars);
  });

  it('accepts owner/name, https, and ssh remotes and refuses anything else', () => {
    for (const value of [
      'example/adopter',
      'https://github.com/example/adopter.git',
      'git@github.com:example/adopter.git',
    ]) {
      expect(normalizeTrackingRepository(value)).toBe('example/adopter');
    }
    for (const value of ['adopter', 'a/b/c', '']) {
      expect(() => normalizeTrackingRepository(value)).toThrow(TrackingConfigError);
    }
  });

  it('passes a byte-identical binding and fails every drift class', () => {
    const workflow = renderTrackingWorkflow(loadTrackingPolicyDefaults());
    expect(
      verifyTrackingBinding({ repoRoot: REPOSITORY_ROOT, config: boundConfig(), workflow }),
    ).toEqual([]);

    const wrongRepository = verifyTrackingBinding({
      repoRoot: REPOSITORY_ROOT,
      config: boundConfig(),
      workflow,
      expectedRepository: 'someone-else/fork',
    });
    expect(wrongRepository.map((finding) => finding.code)).toContain(
      'TRACKING_BINDING_REPOSITORY_MISMATCH',
    );

    const workflowDrift = verifyTrackingBinding({
      repoRoot: REPOSITORY_ROOT,
      config: boundConfig(),
      workflow: `${workflow}\n# edited by hand\n`,
    });
    expect(workflowDrift.map((finding) => finding.code)).toContain('TRACKING_WORKFLOW_DRIFT');

    const missingWorkflow = verifyTrackingBinding({
      repoRoot: REPOSITORY_ROOT,
      config: boundConfig(),
      workflow: undefined,
    });
    expect(missingWorkflow.map((finding) => finding.code)).toContain('TRACKING_WORKFLOW_MISSING');
  });

  it('fails a binding that carries credential material or a non-Architect role', () => {
    const withToken = boundConfig({
      binding: {
        ...boundConfig().binding,
        repository_id: 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB',
      },
    });
    const findings = verifyTrackingBinding({
      repoRoot: REPOSITORY_ROOT,
      config: withToken,
      workflow: renderTrackingWorkflow(loadTrackingPolicyDefaults()),
    });
    expect(findings.map((finding) => finding.code)).toContain(
      'TRACKING_BINDING_CREDENTIAL_PRESENT',
    );

    const wrongRole = boundConfig({
      binding: {
        ...boundConfig().binding,
        bound_by_role: 'owner' as BoundTrackingConfig['binding']['bound_by_role'],
      },
    });
    expect(
      verifyTrackingBinding({
        repoRoot: REPOSITORY_ROOT,
        config: wrongRole,
        workflow: renderTrackingWorkflow(loadTrackingPolicyDefaults()),
      }).map((finding) => finding.code),
    ).toContain('TRACKING_BINDING_ROLE_INVALID');
  });
});

describe('generated reconciliation workflow', () => {
  it('generates identical bytes on two independent generations', () => {
    expect(renderTrackingWorkflow(loadTrackingPolicyDefaults())).toBe(
      renderTrackingWorkflow(loadTrackingPolicyDefaults()),
    );
  });

  it('runs only on the trusted ref, never through pull_request_target', () => {
    const source = renderTrackingWorkflow(loadTrackingPolicyDefaults());
    const workflow = parseDocument(source, { uniqueKeys: true }).toJS() as Record<string, unknown>;

    expect(Object.keys(workflow['on'] as object).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(source).not.toContain('pull_request_target');
    expect(source).toContain("if: github.ref == 'refs/heads/main'");
    expect((workflow['on'] as { push: { branches: string[] } }).push.branches).toEqual(['main']);
  });

  it('grants exactly contents:read and issues:write with no credential fallback', () => {
    const source = renderTrackingWorkflow(loadTrackingPolicyDefaults());
    const workflow = parseDocument(source, { uniqueKeys: true }).toJS() as {
      permissions: Record<string, string>;
    };
    expect(workflow.permissions).toEqual({ contents: 'read', issues: 'write' });
    expect(source).not.toMatch(/PACKAGES_READ_TOKEN|\bPAT\b|personal access token/iu);
    expect(source).toContain('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
  });

  it('pins every action to an immutable commit and uses a per-round concurrency group', () => {
    const defaults = loadTrackingPolicyDefaults();
    const source = renderTrackingWorkflow(defaults);
    const uses = [...source.matchAll(/uses:\s*(\S+)/gu)].flatMap((match) => match.slice(1, 2));
    expect(uses.length).toBeGreaterThan(0);
    for (const reference of uses) expect(reference).toMatch(/@[0-9a-f]{40}$/u);
    expect(uses).toContain(`actions/checkout@${defaults.workflow.pinned_actions.checkout}`);
    expect(source).toContain('group: devai-issue-tracking-${{ github.event.inputs.round');
  });

  it('never invokes a round-scoped command without a selected round', () => {
    const source = renderTrackingWorkflow(loadTrackingPolicyDefaults());
    // A plain push carries no dispatch input, so the reconcile step must be
    // guarded rather than invoked with a placeholder round.
    expect(source).toContain("if: github.event.inputs.round != ''");
    expect(source).toContain('--round "${DEVAI_TRACKING_ROUND}"');
    expect(source).not.toContain(':-all');
  });

  it('reconciles without passing any role or consent flag', () => {
    const source = renderTrackingWorkflow(loadTrackingPolicyDefaults());
    expect(source).toContain('--reconcile');
    // Authority comes from the committed Owner activation. Supplying a role or
    // consent flag from CI would be claiming an authority nobody holds, and the
    // authority layer refuses it.
    expect(source).not.toMatch(/--as-role|--authority-session|--publish/u);
    expect(source).not.toMatch(/^\s*--write/mu);
  });

  it('passes the runner repository so a fork cannot replay a copied activation', () => {
    const source = renderTrackingWorkflow(loadTrackingPolicyDefaults());
    expect(source).toContain('GITHUB_REPOSITORY: ${{ github.repository }}');
  });

  it('states that projection is not a required readiness context', () => {
    expect(renderTrackingWorkflow(loadTrackingPolicyDefaults())).toContain('not a required check');
  });
});

describe('projector failure classification', () => {
  it('separates retryable transport faults from refusals that retrying cannot fix', () => {
    const cases: readonly [string, string, boolean][] = [
      ['API rate limit exceeded', 'rate-limit', true],
      ['HTTP 429 secondary rate limit', 'rate-limit', true],
      ['gh: Bad credentials (HTTP 401)', 'authentication', false],
      ['HTTP 403: Resource not accessible by integration', 'permission', false],
      ['HTTP 404: Not Found', 'missing-resource', false],
      ['HTTP 422: Validation Failed', 'validation', false],
      ['upstream connect error', 'service', true],
    ];
    for (const [stderr, expected, retryable] of cases) {
      const classification = classifyGhFailure({ status: 1, stdout: '', stderr });
      expect(classification, stderr).toBe(expected);
      expect(['rate-limit', 'service'].includes(classification)).toBe(retryable);
    }
  });

  it('produces a bounded exponential backoff schedule', () => {
    expect(
      backoffDelays({
        max_attempts: 5,
        initial_delay_ms: 1000,
        max_delay_ms: 30_000,
        multiplier: 2,
      }),
    ).toEqual([1000, 2000, 4000, 8000]);
    expect(
      backoffDelays({ max_attempts: 6, initial_delay_ms: 1000, max_delay_ms: 4000, multiplier: 2 }),
    ).toEqual([1000, 2000, 4000, 4000, 4000]);
  });
});

function batch(overrides: Partial<ProjectionBatch> = {}): ProjectionBatch {
  const base = {
    schemaVersion: '1.0.0' as const,
    repository_id: 'adopter',
    round_id: 'R-0042',
    adapter: { id: 'github-issues' as const, adapter_version: '1.0.0', package_version: '1.3.0' },
    disclosure_profile: 'public-safe-v1' as const,
    reason: 'checkpoint' as const,
    sessions: [{ authority_session_id: 'AUTH-SESSION-0f1e2d3c4b5a69788796', first: 1, last: 1 }],
    event_ids: ['GEV-3f2a91c40b7d5e68'],
    entries: [
      {
        event_id: 'GEV-3f2a91c40b7d5e68',
        role: 'engineer' as const,
        kind: 'action_completed',
        status: 'pass',
        public_safe_summary: 'Mediated action completed.',
        commit: null,
        tree: null,
        evidence_digests_sha256: [],
        payload_digest_sha256: 'a'.repeat(64),
        mediated: true,
      },
    ],
    segment_digests_sha256: ['b'.repeat(64)],
    projected_at: null,
  };
  const digest = canonicalSha256(base);
  return {
    ...base,
    batch_id: `GBAT-${digest.slice(0, 16)}`,
    marker: `devai-governance-batch:${digest.slice(0, 16)}`,
    batch_digest_sha256: digest,
    ...overrides,
  };
}

function transportFor(
  responses: ReadonlyMap<string, GhResponse | (() => GhResponse)>,
  calls: string[],
): GhTransport {
  return (args) => {
    const key = args.includes('POST') ? 'POST' : 'GET';
    calls.push(args.join(' '));
    const response = responses.get(key);
    if (response === undefined) return { status: 1, stdout: '', stderr: 'unexpected call' };
    return typeof response === 'function' ? response() : response;
  };
}

describe('idempotent projection', () => {
  it('does not repost a batch whose marker is already present', () => {
    const target = batch();
    const calls: string[] = [];
    const transport = transportFor(
      new Map([
        [
          'GET',
          {
            status: 0,
            stdout: JSON.stringify([{ id: 77, body: `<!-- ${target.marker} -->\nrows` }]),
            stderr: '',
          },
        ],
      ]),
      calls,
    );

    const result = projectBatch(
      { transport, repository: 'example/adopter' },
      { issue: 5, batch: target, projectedAt: '2026-08-27T12:00:00.000Z' },
    );
    expect(result).toEqual({ comment_id: 77, already_present: true });
    expect(calls.filter((call) => call.includes('POST'))).toHaveLength(0);
  });

  it('reconciles instead of duplicating after a timeout that actually landed', () => {
    const target = batch();
    let posted = false;
    const calls: string[] = [];
    const transport: GhTransport = (args) => {
      calls.push(args.join(' '));
      if (args.includes('POST')) {
        // The write lands, then the response is lost.
        posted = true;
        return { status: 0, stdout: '<html>gateway timeout</html>', stderr: '' };
      }
      return {
        status: 0,
        stdout: JSON.stringify(posted ? [{ id: 91, body: `<!-- ${target.marker} -->` }] : []),
        stderr: '',
      };
    };

    const result = projectBatch(
      { transport, repository: 'example/adopter' },
      { issue: 5, batch: target, projectedAt: '2026-08-27T12:00:00.000Z' },
    );
    expect(result).toEqual({ comment_id: 91, already_present: true });
    expect(calls.filter((call) => call.includes('POST'))).toHaveLength(1);
  });

  it('surfaces a classified failure rather than a verdict when the remote refuses', () => {
    const transport: GhTransport = () => ({
      status: 1,
      stdout: '',
      stderr: 'HTTP 403: Resource not accessible by integration',
    });
    try {
      projectBatch(
        { transport, repository: 'example/adopter' },
        { issue: 5, batch: batch(), projectedAt: '2026-08-27T12:00:00.000Z' },
      );
      expect.unreachable('projection must not silently succeed');
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectorError);
      expect((error as ProjectorError).classification).toBe('permission');
    }
  });

  it('finds a marker across a paginated comment listing', () => {
    const target = batch();
    const transport: GhTransport = () => ({
      status: 0,
      stdout: JSON.stringify([
        { id: 1, body: 'unrelated human comment' },
        { id: 2, body: `noise\n<!-- ${target.marker} -->\nmore` },
      ]),
      stderr: '',
    });
    expect(findBatchComment({ transport, repository: 'example/adopter' }, 5, target.marker)).toBe(
      2,
    );
  });
});

describe('output-only disclosure', () => {
  it('states in the issue body that remote state carries no authority and coverage is partial', () => {
    const body = renderIssueBody({
      round: 'R-0042',
      repository: 'example/adopter',
      adapterVersion: '1.0.0',
    });
    expect(body).toContain('devai-governance-round:R-0042');
    expect(body).toMatch(/cannot authorize, route, close, merge, or publish/u);
    expect(body).toMatch(/not\*\* covered/u);
  });

  it('renders every event exactly once and publishes digests for withheld payloads', () => {
    const target = batch();
    const comment = renderBatchComment(target, '2026-08-27T12:00:00.000Z');
    for (const id of target.event_ids) {
      expect(comment.split(id).length - 1).toBe(1);
    }
    expect(comment).toContain(target.marker);
    expect(comment).toContain(target.batch_digest_sha256);
    expect(comment).toMatch(/Payload content is withheld/u);
  });

  it('marks unmediated coverage visibly instead of letting it read as tracked work', () => {
    const target = batch();
    const head = target.entries.at(0);
    if (head === undefined) expect.unreachable('fixture batch must carry an entry');
    const unmediated = batch({ entries: [{ ...head, mediated: false }] });
    expect(renderBatchComment(unmediated, '2026-08-27T12:00:00.000Z')).toContain('**unmediated**');
  });

  it('redacts credentials, environment values, paths, and mentions from a summary', () => {
    const rendered = renderPublicSafe(
      'Failed for @octocat using ghp_0123456789abcdefghijklmnopqrstuvwxyzAB ' +
        'and GITHUB_TOKEN=abcdef12345 at /Users/someone/.ssh/id_rsa <img src=x>',
      { maxChars: PUBLIC_SAFE_PROFILE.max_summary_chars },
    );
    expect(rendered).not.toContain('ghp_0123456789abcdefghijklmnopqrstuvwxyzAB');
    expect(rendered).not.toContain('abcdef12345');
    expect(rendered).not.toContain('/Users/someone');
    expect(rendered).not.toContain('<img');
    expect(rendered).not.toContain('@octocat');
  });

  it('marks truncation explicitly so a clipped summary never reads as complete', () => {
    const rendered = renderPublicSafe('word '.repeat(400), { maxChars: 64 });
    expect(rendered.length).toBeLessThanOrEqual(64);
    expect(rendered).toContain('[TRUNCATED]');
  });
});
