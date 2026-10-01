// ADR-AUT-0002 inspector acceptance IA-002 and IA-004 at the sensor: site_drift reads the
// Pages journal only through the two admitted gh api GET shapes, reports a refused argv
// verbatim, reads REVIEW journal-not-verified (never SITE_DRIFT_PROVENANCE_ADAPTER_REQUIRED)
// when the journal holds no verified deployment, and reads FAIL when the local gh-pages tip
// is ahead of the verified identity. Every process request is answered by the injected
// authority scope; no gh process and no network call is ever started.
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

const NOW = '2026-09-30T12:00:00.000Z';
const REPOSITORY = 'aarusso-nyx/devai';
const ENVIRONMENT = 'devai-pages-publication';
const IDENT = [
  '-c',
  'user.name=DEVAI Test',
  '-c',
  'user.email=test@example.com',
  '-c',
  'commit.gpgsign=false',
] as const;
const DEPLOYMENTS_PATH = `/repos/${REPOSITORY}/deployments?environment=${ENVIRONMENT}&per_page=100`;
const statusesPath = (id: number): string =>
  `/repos/${REPOSITORY}/deployments/${id}/statuses?per_page=100`;

/** The two shapes templates gh-api-pages-deployments and -statuses declare, as exact argv. */
const ADMITTED_GH_ARGV = [
  /^api \/repos\/aarusso-nyx\/devai\/deployments\?environment=devai-pages-publication&per_page=100$/u,
  /^api \/repos\/aarusso-nyx\/devai\/deployments\/[0-9]+\/statuses\?per_page=100$/u,
];

function admittedGhArgv(args: readonly unknown[]): boolean {
  return (
    args.length === 2 &&
    args.every((argument) => typeof argument === 'string') &&
    ADMITTED_GH_ARGV.some((shape) => shape.test(args.join(' ')))
  );
}

function deployment(
  id: number,
  commitSha: string,
  repository = REPOSITORY,
): Record<string, unknown> {
  return {
    id,
    sha: commitSha,
    environment: ENVIRONMENT,
    task: 'devai:pages-publication',
    payload: {
      kind: 'devai-pages-publication-intent',
      schemaVersion: '1.0.0',
      identity: { repository, commit: commitSha, tag: 'v1.8.0' },
    },
  };
}

function status(id: number, state: string, description: string): Record<string, unknown> {
  return { id, state, environment: ENVIRONMENT, description };
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

interface Journal {
  readonly deployments?: readonly Record<string, unknown>[];
  readonly statuses?: Readonly<Record<number, readonly Record<string, unknown>[]>>;
}

interface ScopeOptions {
  /** Refuse every gh argv, as a broker without the ADR-AUT-0002 literal would. */
  readonly refuseAll?: boolean;
  /** Refuse only the statuses shape, as a broker that admitted one template would. */
  readonly refuseStatuses?: boolean;
}

/**
 * An authority scope that admits the git reads the sensor documents and answers gh api
 * requests from the journal fixture only when the argv is exactly one of the two admitted
 * shapes; any other gh argv is refused with the broker's code before anything starts.
 */
function run(
  journal: Journal,
  options: ScopeOptions = {},
): { readonly reading: ReturnType<typeof senseSiteDrift>; readonly gh: readonly string[][] } {
  const gh: string[][] = [];
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'sensors-site-drift-provenance',
    issuer_version: '1.0.0',
    invocation_id: 'site-drift-provenance-1',
    canonicalSha256: (value: unknown) =>
      createHash('sha256')
        .update(JSON.stringify(value) ?? '')
        .digest('hex'),
    randomId: () => 'site-drift-provenance-receipt',
    now: () => NOW,
    receipt_ttl_ms: 30_000,
  }) as { dispose: () => unknown };
  const scope: AuthorityHostEffectScope = {
    action_id: 'sense run',
    invocation_id: 'site-drift-provenance-1',
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
      if (executable === 'gh') {
        gh.push(args.map(String));
        const statusesCall = String(args[1]).includes('/statuses');
        if (
          options.refuseAll === true ||
          (options.refuseStatuses === true && statusesCall) ||
          !admittedGhArgv(args)
        ) {
          throw new Error('AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED');
        }
        if (!statusesCall) {
          return { status: 0, stdout: JSON.stringify(journal.deployments ?? []), stderr: '' };
        }
        const id = Number(/deployments\/([0-9]+)\//u.exec(String(args[1]))?.[1]);
        return { status: 0, stdout: JSON.stringify(journal.statuses?.[id] ?? []), stderr: '' };
      }
      throw new Error('SENSORS_TEST_PROCESS_NOT_READ_ONLY');
    },
  };
  try {
    return {
      reading: runWithAuthorityHostEffects(scope, () =>
        senseSiteDrift({ repoRoot: root, now: NOW }),
      ),
      gh,
    };
  } finally {
    issuer.dispose();
  }
}

function findingsText(reading: ReturnType<typeof senseSiteDrift>): string {
  return JSON.stringify(reading.findings ?? []);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-site-drift-provenance-'));
  git('init', '--quiet');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('site_drift journal requests (ADR-AUT-0002 IA-002)', () => {
  it('issues only the two admitted gh api shapes, with no option, in order', () => {
    const head = commit('base');

    const { reading, gh } = run({
      deployments: [deployment(9, head)],
      statuses: { 9: [status(3, 'success', 'devai-pages:verified:pages-1')] },
    });

    expect(gh).toEqual([
      ['api', DEPLOYMENTS_PATH],
      ['api', statusesPath(9)],
    ]);
    for (const args of gh) {
      expect(args.slice(1).some((argument) => argument.startsWith('-'))).toBe(false);
    }
    expect(reading.status).toBe('pass');
  });

  it('reports the refused deployments argv verbatim as adapter-required', () => {
    const head = commit('base');

    const { reading, gh } = run({}, { refuseAll: true });

    expect(gh).toEqual([['api', DEPLOYMENTS_PATH]]);
    expect(reading.status).toBe('unknown');
    expect(reading.findings).toHaveLength(1);
    expect(reading.findings?.[0]?.code).toBe('SITE_DRIFT_PROVENANCE_ADAPTER_REQUIRED');
    expect(reading.findings?.[0]?.message).toContain(`"gh api ${DEPLOYMENTS_PATH}"`);
    expect(reading.metrics).toMatchObject({ repository_head: head });
  });

  it('reports the refused statuses argv verbatim when only that shape is refused', () => {
    const head = commit('base');

    const { reading } = run({ deployments: [deployment(9, head)] }, { refuseStatuses: true });

    expect(reading.status).toBe('unknown');
    expect(reading.findings?.[0]?.code).toBe('SITE_DRIFT_PROVENANCE_ADAPTER_REQUIRED');
    expect(reading.findings?.[0]?.message).toContain(`"gh api ${statusesPath(9)}"`);
  });

  it('never reads adapter-required for an admitted call whose gh process fails', () => {
    commit('base');
    const issuer = createAuthorityDecisionIssuer({
      issuer_id: 'sensors-site-drift-provenance',
      issuer_version: '1.0.0',
      invocation_id: 'site-drift-provenance-2',
      canonicalSha256: (value: unknown) =>
        createHash('sha256')
          .update(JSON.stringify(value) ?? '')
          .digest('hex'),
      randomId: () => 'site-drift-provenance-receipt-2',
      now: () => NOW,
      receipt_ttl_ms: 30_000,
    }) as { dispose: () => unknown };
    const scope: AuthorityHostEffectScope = {
      action_id: 'sense run',
      invocation_id: 'site-drift-provenance-2',
      effect: 'read',
      receipt_store: issuer,
      apply_effect: (request, apply) => {
        const [executable] = request.arguments;
        if (executable === 'gh') return { status: 1, stdout: '', stderr: 'HTTP 502' };
        return apply();
      },
    };
    let reading: ReturnType<typeof senseSiteDrift>;
    try {
      reading = runWithAuthorityHostEffects(scope, () =>
        senseSiteDrift({ repoRoot: root, now: NOW }),
      );
    } finally {
      issuer.dispose();
    }
    expect(findingsText(reading)).not.toContain('SITE_DRIFT_PROVENANCE_ADAPTER_REQUIRED');
    expect(reading.status).not.toBe('pass');
  });
});

describe('site_drift journal readings (ADR-AUT-0002 IA-004)', () => {
  it('reads REVIEW journal-not-verified for an empty journal without a gh-pages ref', () => {
    commit('base');

    const { reading } = run({ deployments: [] });

    expect(reading.status).toBe('review');
    expect(findingsText(reading)).toContain('journal-not-verified');
    expect(findingsText(reading)).not.toContain('SITE_DRIFT_PROVENANCE_ADAPTER_REQUIRED');
  });

  it('reads REVIEW journal-not-verified for an empty journal beside a malformed gh-pages tip', () => {
    commit('base');
    publishTip('Deploy to GitHub Pages');

    const { reading } = run({ deployments: [] });

    expect(reading.status).toBe('review');
    expect(findingsText(reading)).toContain('journal-not-verified');
    expect(findingsText(reading)).not.toContain('SITE_DRIFT_PROVENANCE_ADAPTER_REQUIRED');
  });

  it('reads REVIEW journal-not-verified when the intent carries only a submitted status', () => {
    const head = commit('base');

    const { reading } = run({
      deployments: [deployment(9, head)],
      statuses: { 9: [status(2, 'in_progress', 'devai-pages:submitted:pages-1')] },
    });

    expect(reading.status).toBe('review');
    expect(findingsText(reading)).toContain('journal-not-verified');
  });

  it('reads REVIEW journal-no-matching-intent when no deployment carries the declared intent', () => {
    const head = commit('base');

    const { reading } = run({ deployments: [deployment(9, head, 'aarusso-nyx/detran')] });

    expect(reading.status).toBe('review');
    expect(findingsText(reading)).toContain('journal-no-matching-intent');
  });

  it('reads PASS when the verified identity is HEAD and no gh-pages ref exists', () => {
    const head = commit('base');

    const { reading } = run({
      deployments: [deployment(9, head)],
      statuses: { 9: [status(3, 'success', 'devai-pages:verified:pages-1')] },
    });

    expect(reading.status).toBe('pass');
    expect(reading.metrics).toMatchObject({ published_source: head });
  });

  it('reads PASS when the local gh-pages tip matches the verified identity', () => {
    const head = commit('base');
    publishTip(`docs: publish from ${head}`);

    const { reading } = run({
      deployments: [deployment(9, head)],
      statuses: { 9: [status(3, 'success', 'devai-pages:verified:pages-1')] },
    });

    expect(reading.status).toBe('pass');
  });

  it('reads FAIL when the local gh-pages tip is ahead of the verified identity', () => {
    const verified = commit('base');
    const ahead = commit('unverified publication source');
    publishTip(`docs: publish from ${ahead}`);

    const { reading } = run({
      deployments: [deployment(9, verified)],
      statuses: { 9: [status(3, 'success', 'devai-pages:verified:pages-1')] },
    });

    expect(reading.status).toBe('fail');
    expect(findingsText(reading)).not.toContain('SITE_DRIFT_PROVENANCE_ADAPTER_REQUIRED');
  });
});
