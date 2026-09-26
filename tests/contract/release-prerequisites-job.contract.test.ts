// ADR-SEC-0001, Inspector Adversarial Acceptance IA-004: the release workflow
// fails at the prerequisites job when one declared secret is absent, before
// any build or verification step runs. The job-graph contract that makes
// that possible is that the workflow's first job runs
// scripts/process/release-prerequisites.mjs, and every other job needs it
// directly or transitively.
//
// Red today: neither .github/workflows/release.yml nor
// .github/workflows/devai-ledger-verify.yml references
// scripts/process/release-prerequisites.mjs anywhere (grep across .github and
// scripts turns up nothing outside the script's own file). The job-graph
// ("every other job needs the first, directly or transitively") assertion
// already holds structurally in both files today; the run-the-script
// assertion is what is red, and it makes the whole `it` red because both are
// asserted together per file.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..', '..');
const PREREQUISITES_SCRIPT = 'scripts/process/release-prerequisites.mjs';

interface WorkflowStep {
  readonly run?: string;
}

interface WorkflowJob {
  readonly needs?: string | readonly string[];
  readonly steps?: readonly WorkflowStep[];
}

interface Workflow {
  readonly jobs: Record<string, WorkflowJob>;
}

function loadWorkflow(relativePath: string): Workflow {
  return parse(readFileSync(resolve(ROOT, relativePath), 'utf8')) as Workflow;
}

function jobRunsPrerequisites(job: WorkflowJob): boolean {
  return (job.steps ?? []).some((step) => step.run?.includes(PREREQUISITES_SCRIPT) === true);
}

function directNeeds(job: WorkflowJob): readonly string[] {
  if (job.needs === undefined) return [];
  return typeof job.needs === 'string' ? [job.needs] : job.needs;
}

function transitivelyNeeds(
  jobs: Record<string, WorkflowJob>,
  jobName: string,
  target: string,
  seen: Set<string> = new Set(),
): boolean {
  if (seen.has(jobName)) return false;
  seen.add(jobName);
  const job = jobs[jobName];
  if (job === undefined) return false;
  const needs = directNeeds(job);
  if (needs.includes(target)) return true;
  return needs.some((need) => transitivelyNeeds(jobs, need, target, seen));
}

function assertFirstJobGatesOnPrerequisites(relativePath: string): void {
  const workflow = loadWorkflow(relativePath);
  const jobNames = Object.keys(workflow.jobs);
  expect(jobNames.length, `${relativePath} must declare at least one job`).toBeGreaterThan(0);
  const [firstJobName, ...otherJobNames] = jobNames as [string, ...string[]];
  const firstJob = workflow.jobs[firstJobName];
  expect(firstJob, `${relativePath} job ${firstJobName}`).toBeDefined();

  expect(
    jobRunsPrerequisites(firstJob as WorkflowJob),
    `${relativePath}: first job "${firstJobName}" must run ${PREREQUISITES_SCRIPT}`,
  ).toBe(true);

  for (const otherJobName of otherJobNames) {
    expect(
      transitivelyNeeds(workflow.jobs, otherJobName, firstJobName),
      `${relativePath}: job "${otherJobName}" must need "${firstJobName}" directly or transitively`,
    ).toBe(true);
  }
}

it('release.yml: the first job runs release-prerequisites.mjs and every other job needs it', () => {
  assertFirstJobGatesOnPrerequisites('.github/workflows/release.yml');
});

it('devai-ledger-verify.yml: the first job runs release-prerequisites.mjs and every other job needs it', () => {
  assertFirstJobGatesOnPrerequisites('.github/workflows/devai-ledger-verify.yml');
});
