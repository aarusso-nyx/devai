// ADR-REL-0030: the site-only lane keeps one job, publish-site, bound to the
// github-pages environment with no reviewer expectation, and is the single
// site-publish.yml consumer of GITHUB_TOKEN. Pinned to the "After" matrix in
// docs/dev/operations/release-discipline.md. scripts/check-workflows.mjs
// mutation cases live in site-publish-workflow.contract.test.ts.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..', '..');
const WORKFLOW_PATH = '.github/workflows/site-publish.yml';

interface Step {
  readonly name?: string;
  readonly run?: string;
}
interface Job {
  readonly if?: string;
  readonly needs?: unknown;
  readonly environment?: string | { readonly name: string; readonly url?: string };
  readonly permissions?: Record<string, string>;
  readonly steps?: readonly Step[];
}
interface Workflow {
  readonly on: Record<string, unknown>;
  readonly permissions: Record<string, string>;
  readonly concurrency: { readonly group: string; readonly 'cancel-in-progress': boolean };
  readonly jobs: Record<string, Job>;
}

const text = readFileSync(resolve(ROOT, WORKFLOW_PATH), 'utf8');
const workflow = parse(text) as Workflow;

describe('site publication workflow (ADR-REL-0030)', () => {
  it('declares exactly the publish-site job with no dependency', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['publish-site']);
    expect(workflow.jobs['publish-site']?.needs).toBeUndefined();
  });

  it('keeps the dispatch-only trigger, read permissions and the Pages concurrency group', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.on.workflow_dispatch).toEqual({});
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.concurrency.group).toBe('devai-pages-publication');
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
  });

  it('guards on a dispatch from main and binds the github-pages environment name and url', () => {
    const job = workflow.jobs['publish-site'] as Job;
    expect(job.if).toBe(
      "${{ github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' }}",
    );
    const environment = job.environment as { name: string; url: string };
    expect(environment).toEqual({
      name: 'github-pages',
      url: '${{ steps.deployment.outputs.page_url }}',
    });
    expect(job.permissions).toEqual({
      contents: 'read',
      pages: 'write',
      deployments: 'write',
      'id-token': 'write',
    });
  });

  it('reads no secret and no variable; github.token is the only credential', () => {
    expect(text).not.toMatch(/secrets\./);
    expect(text).not.toMatch(/vars\./);
    expect(text.match(/github\.token/g)).toHaveLength(1);
  });

  it('is the only GITHUB_TOKEN consumer of site-publish.yml in the credential policy', () => {
    const policy = JSON.parse(
      readFileSync(resolve(ROOT, 'law/policy/credential-requirements.json'), 'utf8'),
    ) as {
      entries: { id: string; consumer: { workflow: string; job: string }[] }[];
    };
    const entry = policy.entries.find((item) => item.id === 'GITHUB_TOKEN');
    const site = (entry?.consumer ?? []).filter((item) => item.workflow === WORKFLOW_PATH);
    expect(site).toEqual([{ workflow: WORKFLOW_PATH, job: 'publish-site' }]);
  });
});
