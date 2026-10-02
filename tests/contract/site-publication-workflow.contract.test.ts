// ADR-REL-0034 splits read-only preparation from the serialized publisher.
// ADR-REL-0030 publication environment, permissions and credential safeguards
// remain binding. Mutation cases live in site-publish-workflow.contract.test.ts.
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
  readonly concurrency?: { readonly group: string; readonly 'cancel-in-progress': boolean };
}
interface Workflow {
  readonly on: Record<string, unknown>;
  readonly permissions: Record<string, string>;
  readonly concurrency?: { readonly group: string; readonly 'cancel-in-progress': boolean };
  readonly jobs: Record<string, Job>;
}

const text = readFileSync(resolve(ROOT, WORKFLOW_PATH), 'utf8');
const workflow = parse(text) as Workflow;

describe('site publication workflow (ADR-REL-0030 and ADR-REL-0034)', () => {
  it('declares exactly preparation without a dependency and publication after preparation', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['prepare-site', 'publish-site']);
    expect(workflow.jobs['prepare-site']?.needs).toBeUndefined();
    expect(workflow.jobs['publish-site']?.needs).toBe('prepare-site');
  });

  it('keeps the dispatch-only trigger, read permissions and the Pages concurrency group', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.on.workflow_dispatch).toEqual({});
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs['publish-site']?.concurrency?.group).toBe('devai-pages-publication');
    expect(workflow.jobs['publish-site']?.concurrency?.['cancel-in-progress']).toBe(false);
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

  it('declares only publication and read-only preparation checkout token consumers', () => {
    const policy = JSON.parse(
      readFileSync(resolve(ROOT, 'law/policy/credential-requirements.json'), 'utf8'),
    ) as {
      entries: { id: string; consumer: { workflow: string; job: string }[] }[];
    };
    const entry = policy.entries.find((item) => item.id === 'GITHUB_TOKEN');
    const site = (entry?.consumer ?? []).filter((item) => item.workflow === WORKFLOW_PATH);
    expect(site).toEqual([
      { workflow: WORKFLOW_PATH, job: 'publish-site' },
      { workflow: WORKFLOW_PATH, job: 'prepare-site' },
    ]);
  });
});

// Trace annotation deferred to Architect TASK-06216: no exact canonical staged topology invariant.
// Named original topology operands/access paths follow the adopted TASK-0625
// exception. Every other original safeguard remains unchanged.
describe('staged publication source contract (ADR-REL-0034)', () => {
  const staged = parse(text) as {
    concurrency?: unknown;
    jobs: Record<
      string,
      {
        needs?: unknown;
        if?: string;
        permissions?: Record<string, string>;
        environment?: unknown;
        concurrency?: { group: string; 'cancel-in-progress': boolean };
        steps?: { id?: string; uses?: string; run?: string; with?: Record<string, unknown> }[];
      }
    >;
  };
  it('separates exact read-only preparation from the serialized publisher', () => {
    expect(Object.keys(staged.jobs)).toEqual(['prepare-site', 'publish-site']);
    expect(staged.concurrency).toBeUndefined();
    const prepare = staged.jobs['prepare-site'];
    const publish = staged.jobs['publish-site'];
    expect(prepare?.permissions).toEqual({ contents: 'read' });
    expect(prepare?.environment).toBeUndefined();
    expect(prepare?.concurrency?.['cancel-in-progress']).toBe(true);
    expect(prepare?.concurrency?.group).toContain('github.ref');
    expect(publish?.needs).toBe('prepare-site');
    expect(publish?.concurrency).toEqual({
      group: 'devai-pages-publication',
      'cancel-in-progress': false,
    });
    expect(prepare?.concurrency?.group.toLowerCase()).not.toBe(
      publish?.concurrency?.group.toLowerCase(),
    );
  });
  it('guards preparation success and never rebuilds in publication', () => {
    const prepare = staged.jobs['prepare-site'];
    const publish = staged.jobs['publish-site'];
    // GitHub needs applies the default success guard to the unchanged main/manual if.
    // Failure, skip and cancellation cannot bypass it through a status function.
    expect(publish?.needs).toBe('prepare-site');
    expect(publish?.if).not.toMatch(/\b(?:always|failure|cancelled)\s*\(/u);
    const preparation = (prepare?.steps ?? []).map((step) => step.run ?? '').join('\n');
    const publication = (publish?.steps ?? []).map((step) => step.run ?? '').join('\n');
    expect(preparation).toMatch(/build/u);
    expect(preparation).not.toMatch(
      /publish-site|publishPages|deploy-pages|produce-ci-invariant-evidence/u,
    );
    expect(publication).not.toMatch(/pnpm(?:[^\n]*)(?:build|install)|docs:(?:build|install)/u);
    expect(publication).toContain('verify-site-preparation-artifact');
  });
  it('retains the exact main/manual guard on preparation as well as publication', () => {
    const prepare = staged.jobs['prepare-site'];
    const publish = staged.jobs['publish-site'];
    expect(prepare?.if).toBe(
      "${{ github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' }}",
    );
    expect(publish?.if).not.toMatch(/\b(?:always|failure|cancelled)\s*\(/u);
  });
  it('does not persist checkout credentials or select the newest artifact by name', () => {
    const steps = staged.jobs['prepare-site']?.steps ?? [];
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.['persist-credentials']).toBe(false);
    expect(checkout?.with?.ref).toBe('${{ github.sha }}');
    expect(text).not.toMatch(/latest.*artifact|artifact.*latest|listArtifactsForRepo/u);
  });
});
