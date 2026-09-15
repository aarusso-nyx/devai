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
import { senseSiteDrift } from '../../src/site-drift.js';

const NOW = '2026-09-08T12:00:00.000Z';
const IDENT = [
  '-c',
  'user.name=DEVAI Test',
  '-c',
  'user.email=test@example.com',
  '-c',
  'commit.gpgsign=false',
] as const;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-site-drift-release-tags-'));
  git('init', '--quiet');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

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

function withGitReadScope<T>(callback: () => T): T {
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'sensors-site-drift-release-tags',
    issuer_version: '1.0.0',
    invocation_id: 'site-drift-release-tags-1',
    canonicalSha256: (value: unknown) =>
      createHash('sha256')
        .update(JSON.stringify(value) ?? '')
        .digest('hex'),
    randomId: () => 'site-drift-release-tags-receipt',
    now: () => NOW,
    receipt_ttl_ms: 30_000,
  });
  const scope: AuthorityHostEffectScope = {
    action_id: 'sense site drift',
    invocation_id: 'site-drift-release-tags-1',
    effect: 'read',
    receipt_store: issuer,
    apply_effect: (request, apply) => {
      const [executable, args] = request.arguments;
      if (
        request.kind !== 'process' ||
        executable !== 'git' ||
        !Array.isArray(args) ||
        !['log', 'ls-tree', 'merge-base', 'rev-parse', 'show', 'tag'].includes(String(args[0]))
      )
        throw new Error('SENSORS_TEST_PROCESS_NOT_READ_ONLY');
      return apply();
    },
  };
  try {
    return runWithAuthorityHostEffects(scope, callback);
  } finally {
    issuer.dispose();
  }
}

describe('site drift release-tag boundaries', () => {
  it('recognizes complete semver tags while rejecting prefixes, suffixes, and narrow digits', () => {
    const published = commit('published base');
    const tagged = commit('tagged release');
    commit('current head');
    for (const tag of ['1.2.3', '10.2.3', '1.10.3', '1.2.30', 'v1.2.3-alpha.1'])
      git('tag', tag, tagged);
    for (const tag of ['release-1.2.3', 'v1.2.3_junk', 'v1.2', 'v1.2.3-']) git('tag', tag, tagged);
    // The publication marker points at the published base; release tags are on its descendants.
    const emptyTree = execFileSync('git', ['mktree'], {
      cwd: root,
      encoding: 'utf8',
      input: '',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const tip = git(
      '-c',
      'user.name=DEVAI Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit-tree',
      emptyTree,
      '-m',
      `docs: publish from ${published}`,
    );
    git('update-ref', 'refs/remotes/origin/gh-pages', tip);
    const reading = withGitReadScope(() => senseSiteDrift({ repoRoot: root, now: NOW }));

    expect(reading.status).toBe('fail');
    expect(reading.metrics?.package_release_count).toBe(5);
    expect(reading.findings?.map((finding) => finding.message)).toEqual(
      expect.arrayContaining([
        'Package release tag 1.2.3 follows the published source.',
        'Package release tag 10.2.3 follows the published source.',
        'Package release tag 1.10.3 follows the published source.',
        'Package release tag 1.2.30 follows the published source.',
        'Package release tag v1.2.3-alpha.1 follows the published source.',
      ]),
    );

    const malformedTip = git(
      ...IDENT,
      'commit-tree',
      emptyTree,
      '-m',
      `prefix docs: publish from ${published}`,
    );
    git('update-ref', 'refs/remotes/origin/gh-pages', malformedTip);
    const malformed = withGitReadScope(() => senseSiteDrift({ repoRoot: root, now: NOW }));
    expect(malformed).toMatchObject({
      status: 'unknown',
      findings: [expect.objectContaining({ code: 'SITE_DRIFT_PROVENANCE_MALFORMED' })],
    });
  });
});
