// ADR-CHK-0004, Inspector Adversarial Acceptance IA-001 and IA-003 (preflight
// side): under merge_group the lane passes github.event.merge_group.base_sha,
// a raw commit id with no named reference behind it, as --base. The preflight
// resolves that base exactly and the base-up-to-date probe passes when the
// queue base is an ancestor of the queue head. A base that is not an ancestor
// of the entry reads BLOCKED, and its dependents never execute: the entry is
// refused (evicted), never retried (docs/dev/operations/remote-preflight-contract.md,
// Queue admission).
//
// The fixture is a two-entry queue built from one base: pull request A and pull
// request B both branch from main; entry 1 is A on main, entry 2 is B rebased
// onto entry 1's head, whose base is entry 1's head.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  evaluatePreflightProbes,
  resolveBaseCommit,
  type PreflightEvaluation,
} from '../../src/services/check-runner/preflight.js';
import type { PreflightProbe, TaskExecutionResult } from '../../src/services/check-runner/types.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const PROBES_PATH = join(REPO_ROOT, '.devai/config/preflight-probes.json');
const RAW_COMMIT = /^[0-9a-f]{40}$/u;

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Queue Fixture',
      GIT_AUTHOR_EMAIL: 'queue@example.invalid',
      GIT_COMMITTER_NAME: 'Queue Fixture',
      GIT_COMMITTER_EMAIL: 'queue@example.invalid',
      GIT_AUTHOR_DATE: '2026-09-29T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-09-29T00:00:00Z',
    },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${String(result.stderr)}`);
  return String(result.stdout).trim();
}

function commit(root: string, path: string, content: string, message: string): string {
  writeFileSync(join(root, path), content, 'utf8');
  git(root, ['add', path]);
  git(root, ['commit', '-q', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

interface QueueFixture {
  readonly root: string;
  readonly main: string;
  /** Pull request A on main: the first queue entry's head. */
  readonly entry1: Readonly<{ head: string; base: string }>;
  /** Pull request B rebased onto entry 1: the second queue entry's head. */
  readonly entry2: Readonly<{ head: string; base: string }>;
  /** Pull request B on main alone, never rebased onto entry 1. */
  readonly staleB: string;
}

const roots: string[] = [];

function queueFixture(): QueueFixture {
  const root = mkdtempSync(join(tmpdir(), 'devai-merge-group-base-'));
  roots.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  const main = commit(root, 'README.md', 'base\n', 'docs(repo): base');
  git(root, ['switch', '-q', '-c', 'pr-a']);
  const a = commit(root, 'a.txt', 'a\n', 'test(cli): entry a');
  git(root, ['switch', '-q', '-c', 'pr-b', main]);
  const staleB = commit(root, 'b.txt', 'b\n', 'test(cli): entry b');
  // The queue rebases entry 2 onto entry 1's head; the rebased commit is new.
  git(root, ['switch', '-q', '--detach', a]);
  git(root, ['cherry-pick', staleB]);
  const b = git(root, ['rev-parse', 'HEAD']);
  // The queue's temporary heads carry no local branch or remote-tracking ref,
  // so the lane can name the base only by its raw commit id.
  git(root, ['branch', '-q', '-D', 'main', 'pr-a', 'pr-b']);
  return { root, main, entry1: { head: a, base: main }, entry2: { head: b, base: a }, staleB };
}

function checkoutCandidate(root: string, head: string): void {
  git(root, ['switch', '-q', '--detach', head]);
}

function descriptorProbes(ids: readonly string[]): readonly PreflightProbe[] {
  const probes = JSON.parse(readFileSync(PROBES_PATH, 'utf8')) as readonly PreflightProbe[];
  return ids.map((id) => {
    const probe = probes.find((candidate) => candidate.id === id);
    if (probe === undefined) throw new Error(`descriptor probe ${id} missing`);
    return probe;
  });
}

/** Drives the probe generator, answering every yielded command with exit 0. */
function evaluate(
  root: string,
  base: string,
  ids: readonly string[] = ['base-up-to-date', 'commit-range'],
): Readonly<{ evaluation: PreflightEvaluation; executed: readonly (readonly string[])[] }> {
  const executed: (readonly string[])[] = [];
  const generator = evaluatePreflightProbes(descriptorProbes(ids), {
    repoRoot: root,
    baseCommit: base,
    environment: {},
  });
  const passing: TaskExecutionResult = { status: 0, signal: null, stdout: '', stderr: '' };
  let step = generator.next();
  while (step.done !== true) {
    executed.push(step.value);
    step = generator.next(passing);
  }
  return { evaluation: step.value, executed };
}

function statusOf(evaluation: PreflightEvaluation, id: string): string | undefined {
  return evaluation.observations.find((entry) => entry.id === id)?.status;
}

let fixture: QueueFixture;
beforeAll(() => {
  fixture = queueFixture();
  return () => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe('merge_group base resolution (ADR-CHK-0004 IA-003)', () => {
  it('names the merge_group base as an admitted source of the base-up-to-date probe', () => {
    const [probe] = descriptorProbes(['base-up-to-date']);
    expect(probe?.class, 'a stale base is an environment fact, never a candidate FAIL').toBe(
      'extrinsic',
    );
    expect(probe?.expected).toContain('github.event.merge_group.base_sha');
    expect(probe?.remediation, 'a blocked queue probe evicts the entry').toMatch(/evict/u);
    expect(probe?.remediation).toMatch(/instead of being retried|never retried|not retried/u);
  });

  it('resolves a raw merge_group base_sha to itself, with no named reference behind it', () => {
    for (const entry of [fixture.entry1, fixture.entry2]) {
      checkoutCandidate(fixture.root, entry.head);
      expect(entry.base).toMatch(RAW_COMMIT);
      expect(
        git(fixture.root, ['for-each-ref', '--points-at', entry.base, '--format=%(refname)']),
      ).toBe('');
      expect(resolveBaseCommit(fixture.root, entry.base)).toBe(entry.base);
    }
  });

  it('passes base-up-to-date for each queue entry measured against its own queue base', () => {
    for (const entry of [fixture.entry1, fixture.entry2]) {
      checkoutCandidate(fixture.root, entry.head);
      const { evaluation, executed } = evaluate(fixture.root, entry.base);
      expect(statusOf(evaluation, 'base-up-to-date'), JSON.stringify(evaluation.observations)).toBe(
        'pass',
      );
      expect(evaluation.outcome).toBe('PASS');
      // The commit range the queue measures runs from the queue base to the entry head.
      expect(executed).toEqual([['node', 'scripts/check-commit-range.mjs', entry.base, 'HEAD']]);
    }
  });

  it('measures the second entry against the first entry head, not the original main', () => {
    checkoutCandidate(fixture.root, fixture.entry2.head);
    expect(fixture.entry2.base).toBe(fixture.entry1.head);
    expect(fixture.entry2.base).not.toBe(fixture.main);
    const { executed } = evaluate(fixture.root, fixture.entry2.base);
    expect(executed[0]?.[2], 'the range excludes entry 1 commits').toBe(fixture.entry1.head);
  });
});

describe('merge_group eviction on a base that is not an ancestor (ADR-CHK-0004)', () => {
  it('reads BLOCKED when the queue base is not an ancestor of the queue head', () => {
    // Pull request B was never rebased onto entry 1, yet the queue names entry 1's
    // head as its base: the candidate does not contain the base.
    checkoutCandidate(fixture.root, fixture.staleB);
    const { evaluation } = evaluate(fixture.root, fixture.entry1.head);
    expect(statusOf(evaluation, 'base-up-to-date')).toBe('blocked');
    expect(evaluation.outcome).toBe('BLOCKED');
    expect(evaluation.reason).toContain('base-up-to-date');
  });

  it('refuses rather than retries: no dependent of the blocked probe executes', () => {
    checkoutCandidate(fixture.root, fixture.staleB);
    const { evaluation, executed } = evaluate(fixture.root, fixture.entry1.head);
    expect(executed, 'the commit range never runs against a base the head lacks').toEqual([]);
    const range = evaluation.observations.find((entry) => entry.id === 'commit-range');
    expect(range?.status).toBe('blocked');
    expect(range?.observed).toBe('blocked-environment');
    expect(evaluation.remediation.some((line) => /evict/u.test(line))).toBe(true);
  });

  it('reads BLOCKED when the queue base was never fetched into the checkout', () => {
    checkoutCandidate(fixture.root, fixture.entry2.head);
    const unfetched = 'e'.repeat(40);
    expect(resolveBaseCommit(fixture.root, unfetched)).toBe(unfetched);
    const { evaluation, executed } = evaluate(fixture.root, unfetched);
    expect(statusOf(evaluation, 'base-up-to-date')).toBe('blocked');
    expect(evaluation.outcome).toBe('BLOCKED');
    expect(executed).toEqual([]);
  });

  it('reads BLOCKED when the queue head is behind its base', () => {
    // A base ahead of the candidate (entry 2's head as the base of entry 1) is
    // equally not an ancestor.
    checkoutCandidate(fixture.root, fixture.entry1.head);
    const { evaluation } = evaluate(fixture.root, fixture.entry2.head);
    expect(statusOf(evaluation, 'base-up-to-date')).toBe('blocked');
    expect(evaluation.outcome).toBe('BLOCKED');
  });
});
