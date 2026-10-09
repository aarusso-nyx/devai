// ADR-CHK-0008 IA-009: the update-branch workflow is the one repository-write job. Its rebase
// step changes this repository's own pull-request branches through the API, so the job proves
// repository-write; the credentials probe and the App token mint prove read-only. A
// repository-write job is superseded by a newer run like a read-only one, under a lock keyed by
// the workflow and the ref with cancel-in-progress true, and harness_coherence (F5:T3) flags any
// other lock: a serializing one, or a group missing github.workflow or github.ref.
// The 2026-10-09 amendment restates IA-009: the workflow also accepts pull_request_target, so
// the group is keyed by the subject of each accepted event, github.ref on push and
// github.event.pull_request.number on pull_request_target, and a ref-only key is a finding.
// harness_security reads no pwn-request pattern, since no step checks out a ref.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { senseHarnessCoherence } from '../../src/harness-coherence.js';
import { senseHarnessSecurity } from '../../src/harness-security.js';
import { jobEffectFacts, workflowStepInventory } from '../../src/harness/workflow-parser.js';
import { REVIEWED_WORKFLOW_STEPS } from '../../src/harness/reviewed-workflow-steps.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const WORKFLOWS = join(ROOT, '.github/workflows');
const FILE = 'update-pull-request-branches.yml';
const JOB = 'update-branches';
const NOW = '2026-10-08T12:00:00.000Z';
/** The conditional key ADR-CHK-0008 accepts: the pull request on its event, else the ref. */
const SUBJECT =
  "github.event_name == 'pull_request_target' && format('pr-{0}', github.event.pull_request.number) || github.ref";
const ACCEPTED = `\${{ github.workflow }}-\${{ ${SUBJECT} }}`;
const CHECKOUT = 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true });
});

const update = (): string => readFileSync(join(WORKFLOWS, FILE), 'utf8');

function entry(index: number) {
  const occurrence = `${FILE}#${JOB}[${String(index)}]`;
  return REVIEWED_WORKFLOW_STEPS.find((candidate) =>
    candidate.workflow.split(', ').includes(occurrence),
  );
}

/**
 * A scratch tree holding every workflow, the shared actions, and every repository file a
 * workflow step executes, so the sensor proves the same effects it proves on the repository.
 */
function workflowTree(): string {
  const tree = mkdtempSync(join(tmpdir(), 'devai-update-branch-effects-'));
  roots.push(tree);
  cpSync(join(ROOT, '.github'), join(tree, '.github'), { recursive: true });
  const bound = new Set<string>();
  for (const name of readdirSync(WORKFLOWS).filter((file) => /\.ya?ml$/u.test(file))) {
    for (const step of workflowStepInventory(readFileSync(join(WORKFLOWS, name), 'utf8'), ROOT)) {
      for (const path of step.files ?? []) bound.add(path);
    }
  }
  for (const path of bound) {
    mkdirSync(dirname(join(tree, path)), { recursive: true });
    cpSync(join(ROOT, path), join(tree, path));
  }
  return tree;
}

type Document = ReturnType<typeof parseDocument>;

function editWorkflow(tree: string, edit: (document: Document) => void): void {
  const path = join(tree, '.github/workflows', FILE);
  const document = parseDocument(readFileSync(path, 'utf8'));
  edit(document);
  writeFileSync(path, String(document));
}

/** The concurrency block's path: the workflow level when declared there, else the job. */
function lockPath(document: Document): string[] {
  return document.hasIn(['concurrency']) ? ['concurrency'] : ['jobs', JOB, 'concurrency'];
}

function withConcurrency(tree: string, group: string, cancelInProgress: boolean): void {
  editWorkflow(tree, (document) => {
    document.setIn([...lockPath(document), 'group'], group);
    document.setIn([...lockPath(document), 'cancel-in-progress'], cancelInProgress);
  });
}

const issues = (tree: string): unknown =>
  policyFindings(tree).reading.metrics?.['concurrency_semantic_issues'];

function policyFindings(tree: string) {
  const reading = senseHarnessCoherence({ repoRoot: tree, now: NOW });
  return {
    reading,
    flagged: (reading.findings ?? []).filter(
      (finding) =>
        finding.code === 'HARNESS_COHERENCE_CONCURRENCY_POLICY' && finding.message.includes(FILE),
    ),
  };
}

describe('the update-branch workflow effects (ADR-CHK-0008 IA-009)', () => {
  it('reviews the probe and the token mint read-only and the rebase repository-write', () => {
    expect(entry(0)?.effect).toBe('read-only');
    expect(entry(1)?.effect).toBe('read-only');
    expect(entry(2)?.effect).toBe('repository-write');
    // No other reviewed step anywhere writes the repository.
    expect(
      REVIEWED_WORKFLOW_STEPS.filter((candidate) => candidate.effect === 'repository-write').map(
        (candidate) => candidate.workflow,
      ),
    ).toEqual([`${FILE}#${JOB}[2]`]);
  });

  it('proves the update job repository-write', () => {
    expect(jobEffectFacts(update(), ROOT, JOB).effect).toBe('repository-write');
  });

  it('reads F5:T3 PASS on the committed workflows, with the superseding lock accepted', () => {
    const reading = senseHarnessCoherence({ repoRoot: ROOT, now: NOW });
    expect(reading.findings?.filter((finding) => finding.severity !== 'info')).toEqual([]);
    expect(reading.status).toBe('pass');
  });

  it('accepts the committed lock in a scratch copy of the workflow tree', () => {
    expect(policyFindings(workflowTree()).flagged).toEqual([]);
  });

  it('accepts the conditional key that names the pull request on its event and the ref on push', () => {
    const tree = workflowTree();
    withConcurrency(tree, ACCEPTED, true);
    expect(policyFindings(tree).flagged).toEqual([]);
  });

  it('accepts a ref-only key once the workflow accepts push alone, as before the amendment', () => {
    const tree = workflowTree();
    editWorkflow(tree, (document) => {
      document.deleteIn(['on', 'pull_request_target']);
      document.deleteIn(['jobs', JOB, 'if']);
    });
    withConcurrency(tree, '${{ github.workflow }}-${{ github.ref }}', true);
    expect(policyFindings(tree).flagged).toEqual([]);
  });

  it.each([
    ['a serializing lock', ACCEPTED, false],
    ['a group without github.workflow', `update-branches-\${{ ${SUBJECT} }}`, true],
    // github.ref names the base branch on pull_request_target, so every pull request's run
    // would share one group with the push run (IA-009 restated).
    [
      'a group keyed by github.ref alone while pull_request_target is accepted',
      '${{ github.workflow }}-${{ github.ref }}',
      true,
    ],
    [
      'a group keyed by the pull request number alone, unkeyed on push',
      '${{ github.workflow }}-${{ github.event.pull_request.number }}',
      true,
    ],
    [
      'a group whose pr- key is never empty, so push runs share one group',
      "${{ github.workflow }}-${{ format('pr-{0}', github.event.pull_request.number) }}",
      true,
    ],
    ['a group without github.ref', '${{ github.workflow }}-updates', true],
    ['a fixed group', 'update-pull-request-branches', true],
    ['the shared publication group', 'devai-pages-publication', true],
    // Both contexts appear, but format() never uses the workflow argument (#363 review).
    [
      'a format() group that ignores its workflow argument',
      `\${{ format('updates-{0}', ${SUBJECT}, github.workflow) }}`,
      true,
    ],
  ] as const)('flags %s on the repository-write job', (_label, group, cancelInProgress) => {
    // The scratch tree is compared with its own unmutated reading, so an issue another
    // workflow raises there for lack of a repository file cannot mask or fake this one.
    const baseline = Number(issues(workflowTree()));
    const tree = workflowTree();
    withConcurrency(tree, group, cancelInProgress);
    const { flagged } = policyFindings(tree);
    expect(flagged).toHaveLength(1);
    expect(issues(tree)).toBe(baseline + 1);
  });
});

describe('the update-branch workflow under harness_security (ADR-CHK-0008 IA-010)', () => {
  const pwn = (tree: string) =>
    senseHarnessSecurity({ repoRoot: tree, now: NOW }).reading.findings?.filter(
      (finding) =>
        finding.code === 'HARNESS_SECURITY_PWN_REQUEST_PATTERN' &&
        (finding.file ?? '').endsWith(FILE),
    ) ?? [];

  it('accepts pull_request_target and reads no pwn-request pattern, with no checkout', () => {
    expect(update()).toMatch(/^\s*pull_request_target\s*:/mu);
    const reading = senseHarnessSecurity({ repoRoot: ROOT, now: NOW }).reading;
    expect(pwn(ROOT)).toEqual([]);
    expect(reading.metrics?.['pwn_request_count']).toBe(0);
  });

  it('reads the pwn-request pattern once a checkout joins the pull_request_target workflow', () => {
    const tree = workflowTree();
    editWorkflow(tree, (document) => {
      const steps = document.getIn(['jobs', JOB, 'steps']) as { items: unknown[] };
      steps.items.unshift(document.createNode({ uses: CHECKOUT }));
    });
    expect(pwn(tree)).toHaveLength(1);
  });
});
