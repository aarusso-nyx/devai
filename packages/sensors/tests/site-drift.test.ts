import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseSiteDrift } from '../src/site-drift.js';

const NOW = '2026-09-27T12:00:00.000Z';
const IDENT = [
  '-c',
  'user.name=DEVAI Test',
  '-c',
  'user.email=test@example.com',
  '-c',
  'commit.gpgsign=false',
] as const;
const DEPLOYMENTS_PATH =
  '/repos/aarusso-nyx/devai/deployments?environment=devai-pages-publication&per_page=100';

function statusesPath(id: number): string {
  return `/repos/aarusso-nyx/devai/deployments/${id}/statuses?per_page=100`;
}

function deployment(id: number, commitSha: string, tag = 'v1.6.0'): Record<string, unknown> {
  return {
    id,
    sha: commitSha,
    environment: 'devai-pages-publication',
    task: 'devai:pages-publication',
    payload: {
      kind: 'devai-pages-publication-intent',
      schemaVersion: '1.0.0',
      identity: { repository: 'aarusso-nyx/devai', commit: commitSha, tag },
    },
  };
}

function verifiedStatus(id: number, pagesId = 'pages-1'): Record<string, unknown> {
  return {
    id,
    state: 'success',
    environment: 'devai-pages-publication',
    description: `devai-pages:verified:${pagesId}`,
  };
}

function submittedStatus(id: number, pagesId = 'pages-1'): Record<string, unknown> {
  return {
    id,
    state: 'in_progress',
    environment: 'devai-pages-publication',
    description: `devai-pages:submitted:${pagesId}`,
  };
}

let root: string;

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commit(message: string): string {
  git(...IDENT, 'commit', '--quiet', '--allow-empty', '-m', message);
  return git('rev-parse', 'HEAD');
}

function publishTip(message: string): string {
  const emptyTree = execFileSync('git', ['mktree'], {
    cwd: root,
    encoding: 'utf8',
    input: '',
  }).trim();
  const tip = git(...IDENT, 'commit-tree', emptyTree, '-m', message);
  git('update-ref', 'refs/remotes/origin/gh-pages', tip);
  return tip;
}

interface GhFixture {
  readonly status: number;
  readonly stdout: string;
}

/**
 * Grants the git reads the sensor already documents, plus a `gh api` read
 * for the exact devai-pages-publication journal paths under test. Any other
 * process request (including an unrecognized gh path) is refused, mirroring
 * the authority broker's exact-argv admission model.
 */
function withScope<T>(
  callback: () => T,
  options: { readonly ghDenied?: boolean; readonly gh?: Readonly<Record<string, GhFixture>> } = {},
): T {
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'sensors-site-drift-journal',
    issuer_version: '1.0.0',
    invocation_id: 'site-drift-journal-1',
    canonicalSha256: (value: unknown) =>
      createHash('sha256')
        .update(JSON.stringify(value) ?? '')
        .digest('hex'),
    randomId: () => 'site-drift-journal-receipt',
    now: () => NOW,
    receipt_ttl_ms: 30_000,
  }) as { dispose: () => unknown };
  const scope: AuthorityHostEffectScope = {
    action_id: 'sense site drift',
    invocation_id: 'site-drift-journal-1',
    effect: 'read',
    receipt_store: issuer,
    apply_effect: (request, apply) => {
      const [executable, args] = request.arguments;
      if (request.kind !== 'process' || !Array.isArray(args)) {
        throw new Error('SENSORS_TEST_PROCESS_NOT_READ_ONLY');
      }
      if (
        executable === 'git' &&
        ['log', 'ls-tree', 'merge-base', 'rev-parse', 'show', 'tag'].includes(String(args[0]))
      ) {
        return apply();
      }
      if (executable === 'gh' && args[0] === 'api') {
        if (options.ghDenied) throw new Error('AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED');
        const path = String(args[1]);
        const fixture = options.gh?.[path];
        if (fixture === undefined) throw new Error(`SENSORS_TEST_UNEXPECTED_GH_PATH:${path}`);
        return { status: fixture.status, stdout: fixture.stdout, stderr: '' };
      }
      throw new Error('SENSORS_TEST_PROCESS_NOT_READ_ONLY');
    },
  };
  try {
    return runWithAuthorityHostEffects(scope, callback);
  } finally {
    issuer.dispose();
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-site-drift-journal-'));
  git('init', '--quiet');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('senseSiteDrift journal-based provenance (ADR-SCR-0005 IA-005)', () => {
  it('reports a precise adapter-required finding when no gh-pages ref exists and gh api is refused', () => {
    const head = commit('base');

    const reading = withScope(() => senseSiteDrift({ repoRoot: root, now: NOW }), {
      ghDenied: true,
    });

    expect(reading.status).toBe('unknown');
    expect(reading.findings).toHaveLength(1);
    expect(reading.findings?.[0]).toMatchObject({
      severity: 'warning',
      code: 'SITE_DRIFT_PROVENANCE_ADAPTER_REQUIRED',
    });
    expect(reading.findings?.[0]?.message).toContain(`gh api ${DEPLOYMENTS_PATH}`);
    expect(reading.findings?.[0]?.message).toContain('AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED');
    expect(reading.metrics).toEqual({ repository_head: head });
  });

  it('reports adapter-required rather than the malformed-tip finding when the tip is malformed and gh api is refused', () => {
    const head = commit('base');
    const tip = publishTip(`prefix docs: publish from ${'a'.repeat(40)}`);

    const reading = withScope(() => senseSiteDrift({ repoRoot: root, now: NOW }), {
      ghDenied: true,
    });

    expect(reading.status).toBe('unknown');
    expect(reading.findings).toHaveLength(1);
    expect(reading.findings?.[0]?.code).toBe('SITE_DRIFT_PROVENANCE_ADAPTER_REQUIRED');
    expect(reading.metrics).toEqual({ repository_head: head, published_tip: tip });
  });

  it('falls back to the malformed-tip finding when the journal has no matching intent', () => {
    const head = commit('base');
    const tip = publishTip('not a provenance message');

    const reading = withScope(() => senseSiteDrift({ repoRoot: root, now: NOW }), {
      gh: { [DEPLOYMENTS_PATH]: { status: 0, stdout: '[]' } },
    });

    expect(reading.status).toBe('unknown');
    expect(reading.findings).toEqual([
      {
        severity: 'warning',
        code: 'SITE_DRIFT_PROVENANCE_MALFORMED',
        message: 'The gh-pages tip message must be exactly "docs: publish from <40-hex-sha>".',
      },
    ]);
    expect(reading.metrics).toEqual({ repository_head: head, published_tip: tip });
  });

  it('falls back to the unavailable finding when the gh CLI call itself fails', () => {
    const head = commit('base');

    const reading = withScope(() => senseSiteDrift({ repoRoot: root, now: NOW }), {
      gh: { [DEPLOYMENTS_PATH]: { status: 1, stdout: '' } },
    });

    expect(reading.status).toBe('unknown');
    expect(reading.findings).toEqual([
      {
        severity: 'warning',
        code: 'SITE_DRIFT_PROVENANCE_UNAVAILABLE',
        message:
          'Local refs/remotes/origin/gh-pages is unavailable; fetch or live verification is required.',
      },
    ]);
    expect(reading.metrics).toEqual({ repository_head: head });
  });

  it('treats a submitted-but-unverified intent as absent provenance', () => {
    const head = commit('base');

    const reading = withScope(() => senseSiteDrift({ repoRoot: root, now: NOW }), {
      gh: {
        [DEPLOYMENTS_PATH]: { status: 0, stdout: JSON.stringify([deployment(9, head)]) },
        [statusesPath(9)]: { status: 0, stdout: JSON.stringify([submittedStatus(1)]) },
      },
    });

    expect(reading.status).toBe('unknown');
    expect(reading.findings?.[0]?.code).toBe('SITE_DRIFT_PROVENANCE_UNAVAILABLE');
    expect(reading.metrics).toEqual({ repository_head: head });
  });

  it('rejects a journal record whose payload commit does not match the deployment sha', () => {
    const head = commit('base');
    const mismatched = { ...deployment(9, head), sha: 'f'.repeat(40) };

    const reading = withScope(() => senseSiteDrift({ repoRoot: root, now: NOW }), {
      gh: {
        [DEPLOYMENTS_PATH]: { status: 0, stdout: JSON.stringify([mismatched]) },
      },
    });

    expect(reading.status).toBe('unknown');
    expect(reading.findings?.[0]?.code).toBe('SITE_DRIFT_PROVENANCE_UNAVAILABLE');
  });

  it('reads the journal-verified commit as the published source and passes when it matches HEAD', () => {
    const head = commit('base');

    const reading = withScope(() => senseSiteDrift({ repoRoot: root, now: NOW }), {
      gh: {
        [DEPLOYMENTS_PATH]: { status: 0, stdout: JSON.stringify([deployment(9, head)]) },
        [statusesPath(9)]: { status: 0, stdout: JSON.stringify([verifiedStatus(9)]) },
      },
    });

    expect(reading.status).toBe('pass');
    expect(reading.findings).toEqual([]);
    expect(reading.metrics).toEqual({
      repository_head: head,
      published_source_provenance: 'journal',
      journal_intent_id: '9',
      published_source: head,
      changed_path_count: 0,
      published_input_count: 0,
      package_version_drift_count: 0,
      package_release_count: 0,
    });
  });

  it('picks the highest-id (most recent) matching deployment when several are journaled', () => {
    const base = commit('base');
    const head = commit('advance');

    const reading = withScope(() => senseSiteDrift({ repoRoot: root, now: NOW }), {
      gh: {
        [DEPLOYMENTS_PATH]: {
          status: 0,
          stdout: JSON.stringify([deployment(3, base, 'v1.5.0'), deployment(9, head, 'v1.6.0')]),
        },
        [statusesPath(9)]: { status: 0, stdout: JSON.stringify([verifiedStatus(9)]) },
      },
    });

    expect(reading.status).toBe('pass');
    expect(reading.metrics).toMatchObject({ published_source: head, journal_intent_id: '9' });
  });

  it('reads a verified site-only publication with the highest id as the published source (ADR-REL-0029)', () => {
    const base = commit('base');
    const head = commit('site change');
    const siteOnly = deployment(12, head, 'v1.6.0');
    const payload = siteOnly.payload as { identity: Record<string, unknown> };
    payload.identity = {
      repository: 'aarusso-nyx/devai',
      mode: 'site-only',
      tag: 'v1.6.0',
      commit: head,
      tree: 'b'.repeat(40),
      siteSha256: 'd'.repeat(64),
      sourceRun: '789',
      sourceAttempt: '1',
      controlCommit: head,
    };

    const reading = withScope(() => senseSiteDrift({ repoRoot: root, now: NOW }), {
      gh: {
        [DEPLOYMENTS_PATH]: {
          status: 0,
          stdout: JSON.stringify([deployment(9, base, 'v1.6.0'), siteOnly]),
        },
        [statusesPath(12)]: { status: 0, stdout: JSON.stringify([verifiedStatus(2, 'pages-2')]) },
      },
    });

    expect(reading.status).toBe('pass');
    expect(reading.metrics).toMatchObject({
      published_source_provenance: 'journal',
      published_source: head,
      journal_intent_id: '12',
    });
  });
});
