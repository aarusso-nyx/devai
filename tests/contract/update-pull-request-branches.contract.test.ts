// ADR-CHK-0008, Inspector Adversarial Acceptance IA-001 to IA-005 (checker side): the
// update-pull-request-branches workflow rebases every open, non-draft, same-repository pull
// request behind main when main moves, with a SHA-pinned GitHub App token, the rebase update
// method, and the expected head sha. scripts/check-workflows.mjs pins each of those, so every
// mutation below must make checkWorkflowTree fail. Each mutation is applied to a scratch copy
// of the workflow tree, so only the mutation can add a finding. The 2026-10-09 amendment
// (IA-009 restated, IA-010) adds the pull_request_target path: its types and base branch, the
// job guard that skips fork and draft pull requests, no checkout and no event expression
// expanded into a script, and a lock keyed by the pull request on that event.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';

const ROOT = resolve(import.meta.dirname, '../..');
const FILE = 'update-pull-request-branches.yml';
const JOB = 'update-branches';

interface WorkflowFinding {
  readonly code: string;
  readonly file: string;
  readonly detail: string;
}
const { checkWorkflowTree } = (await import(
  pathToFileURL(join(ROOT, 'scripts/check-workflows.mjs')).href
)) as { checkWorkflowTree: (root: string) => { ok: boolean; findings: WorkflowFinding[] } };

type Document = ReturnType<typeof parseDocument>;

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true });
});

function workflowTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-update-branches-check-'));
  roots.push(root);
  cpSync(join(ROOT, '.github/workflows'), join(root, '.github/workflows'), { recursive: true });
  cpSync(join(ROOT, '.github/actions'), join(root, '.github/actions'), { recursive: true });
  for (const path of ['.devai/config/toolchain.json', 'law/policy/credential-requirements.json']) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), readFileSync(join(ROOT, path)));
  }
  return root;
}

/** Edits the update workflow through the YAML document, keeping its comments and layout. */
function mutate(root: string, edit: (document: Document) => void): void {
  const path = join(root, '.github/workflows', FILE);
  const before = readFileSync(path, 'utf8');
  const document = parseDocument(before);
  edit(document);
  const after = String(document);
  expect(after, 'the mutation changed the workflow').not.toBe(before);
  writeFileSync(path, after);
}

function stepIndex(document: Document, id: string): number {
  const steps = (document.toJS() as { jobs: Record<string, { steps: { id?: string }[] }> }).jobs[
    JOB
  ]?.steps;
  const index = (steps ?? []).findIndex((step) => step.id === id);
  if (index < 0) throw new Error(`fixture: no step ${id} in ${JOB}`);
  return index;
}

/** Rewrites the rebase step's script. */
function editRun(document: Document, edit: (run: string) => string): void {
  const path = ['jobs', JOB, 'steps', stepIndex(document, 'rebase'), 'run'];
  const run = String(document.getIn(path));
  const next = edit(run);
  expect(next, 'the mutation changed the rebase script').not.toBe(run);
  document.setIn(path, next);
}

const TARGET = ['on', 'pull_request_target'];
const ACCEPTED_KEY =
  "${{ github.workflow }}-${{ github.event_name == 'pull_request_target' && format('pr-{0}', github.event.pull_request.number) || github.ref }}";
const CHECKOUT = 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683';

/** The concurrency block's path: the workflow level when declared there, else the job. */
function lockPath(document: Document): (string | number)[] {
  return document.hasIn(['concurrency']) ? ['concurrency'] : ['jobs', JOB, 'concurrency'];
}

/** Inserts a step ahead of the step with `id`. */
function insertStepBefore(document: Document, id: string, step: Record<string, unknown>): void {
  const steps = document.getIn(['jobs', JOB, 'steps']) as { items: unknown[] };
  steps.items.splice(stepIndex(document, id), 0, document.createNode(step));
}

function findings(root: string): readonly WorkflowFinding[] {
  return checkWorkflowTree(root).findings.filter((finding) => finding.file === FILE);
}

describe('workflow checker pins the update-pull-request-branches workflow (ADR-CHK-0008 IA-005)', () => {
  it('accepts the committed workflow tree, also after a no-op document round trip', () => {
    expect(checkWorkflowTree(workflowTree()).findings).toEqual([]);
    const root = workflowTree();
    const path = join(root, '.github/workflows', FILE);
    writeFileSync(path, String(parseDocument(readFileSync(path, 'utf8'))));
    expect(checkWorkflowTree(root).findings).toEqual([]);
  });

  const mutations: readonly (readonly [string, (document: Document) => void])[] = [
    // Trigger: every push to main, and nothing else.
    ['the push-to-main trigger is removed', (d) => d.deleteIn(['on', 'push'])],
    [
      'the push trigger covers another branch',
      (d) => d.setIn(['on', 'push', 'branches'], ['main', 'develop']),
    ],
    [
      'a pull_request trigger is added',
      (d) => d.setIn(['on', 'pull_request'], { branches: ['main'] }),
    ],
    // Least privilege: the workflow token reads contents only; the App token does the writing.
    ['the workflow token may write contents', (d) => d.setIn(['permissions', 'contents'], 'write')],
    [
      'the workflow token gains pull-requests: write',
      (d) => d.setIn(['permissions', 'pull-requests'], 'write'),
    ],
    ['the workflow permissions are removed', (d) => d.deleteIn(['permissions'])],
    [
      'the job widens its own permissions',
      (d) => d.setIn(['jobs', JOB, 'permissions'], { contents: 'write' }),
    ],
    // No soft failure.
    ['the job continues on error', (d) => d.setIn(['jobs', JOB, 'continue-on-error'], true)],
    [
      'the rebase step continues on error',
      (d) => d.setIn(['jobs', JOB, 'steps', stepIndex(d, 'rebase'), 'continue-on-error'], true),
    ],
    // Never GITHUB_TOKEN: a push made with it starts no gate run.
    [
      'the rebase step uses secrets.GITHUB_TOKEN',
      (d) =>
        d.setIn(
          ['jobs', JOB, 'steps', stepIndex(d, 'rebase'), 'env', 'GH_TOKEN'],
          '${{ secrets.GITHUB_TOKEN }}',
        ),
    ],
    [
      'the rebase step uses github.token',
      (d) =>
        d.setIn(
          ['jobs', JOB, 'steps', stepIndex(d, 'rebase'), 'env', 'GH_TOKEN'],
          '${{ github.token }}',
        ),
    ],
    // The SHA-pinned App token step with both secrets.
    [
      'the App token action is not pinned to a commit',
      (d) =>
        d.setIn(
          ['jobs', JOB, 'steps', stepIndex(d, 'app-token'), 'uses'],
          'actions/create-github-app-token@v3',
        ),
    ],
    [
      'the App token step loses its app id secret',
      (d) => d.deleteIn(['jobs', JOB, 'steps', stepIndex(d, 'app-token'), 'with', 'app-id']),
    ],
    [
      'the App token step loses its private key secret',
      (d) => d.deleteIn(['jobs', JOB, 'steps', stepIndex(d, 'app-token'), 'with', 'private-key']),
    ],
    [
      'the App token step is removed',
      (d) => d.deleteIn(['jobs', JOB, 'steps', stepIndex(d, 'app-token')]),
    ],
    // The credentials presence probe, and the presence gate on the steps that use the App.
    [
      'the credentials presence probe is removed',
      (d) => d.deleteIn(['jobs', JOB, 'steps', stepIndex(d, 'credentials')]),
    ],
    [
      'the App token step is no longer gated on presence',
      (d) => d.deleteIn(['jobs', JOB, 'steps', stepIndex(d, 'app-token'), 'if']),
    ],
    [
      'the App token step is gated on something else',
      (d) =>
        d.setIn(
          ['jobs', JOB, 'steps', stepIndex(d, 'app-token'), 'if'],
          "github.event_name == 'push'",
        ),
    ],
    // The rebase update method only.
    [
      'the update method becomes merge',
      (d) => editRun(d, (run) => run.replace('update_method=rebase', 'update_method=merge')),
    ],
    [
      'the update method is dropped',
      (d) => editRun(d, (run) => run.replace('-f update_method=rebase ', '')),
    ],
    // The expected head sha guard.
    [
      'the expected head sha is dropped',
      (d) => editRun(d, (run) => run.replace(' -f expected_head_sha="$head"', '')),
    ],
    // The draft and fork filters.
    [
      'the draft filter is dropped',
      (d) => editRun(d, (run) => run.replace(' | select(.draft == false)', '')),
    ],
    [
      'the fork filter is dropped',
      (d) =>
        editRun(d, (run) => run.replace(' | select(.head.repo.full_name == $ENV.REPOSITORY)', '')),
    ],
    // A security marker kept only in a shell comment proves nothing: the executed command
    // decides (#363 review).
    [
      'a merge update runs while update_method=rebase survives in a comment',
      (d) =>
        editRun(
          d,
          (run) =>
            `# update_method=rebase\n${run.replace('update_method=rebase', 'update_method=merge')}`,
        ),
    ],
    [
      'the expected head sha is dropped while it survives in a comment',
      (d) =>
        editRun(
          d,
          (run) =>
            `# -f expected_head_sha="$head"\n${run.replace(' -f expected_head_sha="$head"', '')}`,
        ),
    ],
    [
      'the draft filter is dropped while it survives in a comment',
      (d) =>
        editRun(
          d,
          (run) => `# select(.draft == false)\n${run.replace(' | select(.draft == false)', '')}`,
        ),
    ],
    [
      'the fork filter is dropped while it survives in a comment',
      (d) =>
        editRun(
          d,
          (run) =>
            `# select(.head.repo.full_name == $ENV.REPOSITORY)\n${run.replace(
              ' | select(.head.repo.full_name == $ENV.REPOSITORY)',
              '',
            )}`,
        ),
    ],
    // The superseding lock keyed by workflow and ref.
    [
      'the lock stops cancelling superseded runs',
      (d) => d.setIn([...lockPath(d), 'cancel-in-progress'], false),
    ],
    [
      'the lock group is a constant',
      (d) => d.setIn([...lockPath(d), 'group'], 'update-pull-request-branches'),
    ],
    ['the workflow concurrency is removed', (d) => d.deleteIn(lockPath(d))],
    // IA-010: the pull_request_target trigger, exactly as accepted.
    ['the pull_request_target trigger is removed', (d) => d.deleteIn(TARGET)],
    [
      'pull_request_target becomes pull_request',
      (d) => {
        const target = d.getIn(TARGET);
        d.deleteIn(TARGET);
        d.setIn(['on', 'pull_request'], target);
      },
    ],
    ['the pull_request_target types are dropped', (d) => d.deleteIn([...TARGET, 'types'])],
    [
      'the pull_request_target types gain synchronize',
      (d) =>
        d.setIn([...TARGET, 'types'], ['opened', 'reopened', 'ready_for_review', 'synchronize']),
    ],
    [
      'the pull_request_target types lose ready_for_review',
      (d) => d.setIn([...TARGET, 'types'], ['opened', 'reopened']),
    ],
    [
      'the pull_request_target base branches are dropped',
      (d) => d.deleteIn([...TARGET, 'branches']),
    ],
    [
      'the pull_request_target base branches widen',
      (d) => d.setIn([...TARGET, 'branches'], ['main', 'release/**']),
    ],
    // IA-010: no pull-request content is checked out or run.
    [
      'a checkout step is added before the rebase',
      (d) => insertStepBefore(d, 'rebase', { name: 'Check out', uses: CHECKOUT }),
    ],
    [
      'a checkout of the pull request head is added before the probe',
      (d) =>
        insertStepBefore(d, 'credentials', {
          uses: CHECKOUT,
          with: { ref: '${{ github.event.pull_request.head.sha }}' },
        }),
    ],
    [
      'the rebase script expands the pull request head ref',
      (d) => editRun(d, (run) => `echo "\${{ github.event.pull_request.head.ref }}"\n${run}`),
    ],
    [
      'the rebase script expands the pull request title',
      (d) => editRun(d, (run) => `echo '\${{ github.event.pull_request.title }}'\n${run}`),
    ],
    [
      'the rebase script expands the pull request number',
      (d) => editRun(d, (run) => `echo "\${{ github.event.pull_request.number }}" >&2\n${run}`),
    ],
    // IA-010: the job guard skips fork and draft pull requests before any credential.
    ['the job guard is dropped', (d) => d.deleteIn(['jobs', JOB, 'if'])],
    ['the job guard always runs', (d) => d.setIn(['jobs', JOB, 'if'], 'true')],
    [
      'the job guard drops the fork check',
      (d) =>
        d.setIn(
          ['jobs', JOB, 'if'],
          "github.event_name == 'push' || github.event.pull_request.draft == false",
        ),
    ],
    [
      'the job guard drops the draft check',
      (d) =>
        d.setIn(
          ['jobs', JOB, 'if'],
          "github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository",
        ),
    ],
    [
      'the job guard skips pushes',
      (d) =>
        d.setIn(
          ['jobs', JOB, 'if'],
          'github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.draft == false',
        ),
    ],
    // IA-009: the lock follows the run's subject on each accepted event.
    [
      'the lock group is keyed by the ref alone while pull_request_target is accepted',
      (d) => d.setIn([...lockPath(d), 'group'], '${{ github.workflow }}-${{ github.ref }}'),
    ],
    [
      'the lock group is keyed by the pull request number alone',
      (d) =>
        d.setIn(
          [...lockPath(d), 'group'],
          '${{ github.workflow }}-${{ github.event.pull_request.number }}',
        ),
    ],
    [
      'the lock group drops the workflow',
      (d) =>
        d.setIn(
          [...lockPath(d), 'group'],
          ACCEPTED_KEY.replace('${{ github.workflow }}-', 'update-branches-'),
        ),
    ],
    [
      'the lock serializes',
      (d) => {
        d.setIn([...lockPath(d), 'group'], ACCEPTED_KEY);
        d.setIn([...lockPath(d), 'cancel-in-progress'], false);
      },
    ],
  ];

  it('keeps pull_request_target scoped to the update workflow: the gate workflow may not take it', () => {
    const root = workflowTree();
    const path = join(root, '.github/workflows/pull-request-checks.yml');
    const document = parseDocument(readFileSync(path, 'utf8'));
    document.setIn(['on', 'pull_request_target'], { types: ['opened'], branches: ['main'] });
    writeFileSync(path, String(document));
    expect(checkWorkflowTree(root).ok).toBe(false);
  });

  it.each(mutations)('fails when %s', (_label, edit) => {
    const root = workflowTree();
    mutate(root, edit);
    expect(checkWorkflowTree(root).ok).toBe(false);
    expect(findings(root)).not.toEqual([]);
  });
});
