// ADR-CHK-0008, Inspector Adversarial Acceptance IA-001 to IA-005 (checker side): the
// update-pull-request-branches workflow rebases every open, non-draft, same-repository pull
// request behind main when main moves, with a SHA-pinned GitHub App token, the rebase update
// method, and the expected head sha. scripts/check-workflows.mjs pins each of those, so every
// mutation below must make checkWorkflowTree fail. Each mutation is applied to a scratch copy
// of the workflow tree, so only the mutation can add a finding.
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
      (d) => d.setIn(['concurrency', 'cancel-in-progress'], false),
    ],
    [
      'the lock group is a constant',
      (d) => d.setIn(['concurrency', 'group'], 'update-pull-request-branches'),
    ],
    ['the workflow concurrency is removed', (d) => d.deleteIn(['concurrency'])],
  ];

  it.each(mutations)('fails when %s', (_label, edit) => {
    const root = workflowTree();
    mutate(root, edit);
    expect(checkWorkflowTree(root).ok).toBe(false);
    expect(findings(root)).not.toEqual([]);
  });
});
