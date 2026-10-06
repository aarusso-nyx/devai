// #325: the reviewed-step registry stays exactly the population the workflows need. Every
// entry matches a current step, every committed job has a proved effect, and removing a
// reviewed step's entry makes its job unknown again, so an edited step reads unknown until it
// is reviewed anew.
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { senseHarnessCoherence } from '../../src/harness-coherence.js';
import { jobEffectFacts, workflowStepInventory } from '../../src/harness/workflow-parser.js';
import { REVIEWED_WORKFLOW_STEPS } from '../../src/harness/reviewed-workflow-steps.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const WORKFLOWS = join(ROOT, '.github/workflows');
const PUBLICATION_STEPS = [
  'release.yml#deploy-pages[6]',
  'release.yml#finalize-release[7]',
  'release.yml#finalize-release[8]',
  'site-publish.yml#publish-site[2]',
];

function workflows(): readonly { file: string; text: string }[] {
  return readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith('.yml'))
    .sort()
    .map((file) => ({ file, text: readFileSync(join(WORKFLOWS, file), 'utf8') }));
}

describe('reviewed workflow step registry', () => {
  it('has no stale or duplicate entry, and each entry names where it occurs', () => {
    const occurrences = new Map<string, string[]>();
    for (const { file, text } of workflows()) {
      for (const step of workflowStepInventory(text)) {
        if (step.sha256 === undefined) continue;
        const list = occurrences.get(step.sha256) ?? [];
        list.push(`${file}#${step.job}[${String(step.index)}]`);
        occurrences.set(step.sha256, list);
      }
    }
    for (const entry of REVIEWED_WORKFLOW_STEPS) {
      expect(occurrences.get(entry.sha256), entry.workflow).toEqual(entry.workflow.split(', '));
    }
    const digests = REVIEWED_WORKFLOW_STEPS.map((entry) => entry.sha256);
    expect(new Set(digests).size).toBe(digests.length);
  });

  it('proves the effect of every committed job', () => {
    const unknown = workflows().flatMap(({ file, text }) =>
      [...new Set(workflowStepInventory(text).map((step) => step.job))]
        .filter((job) => jobEffectFacts(text, ROOT, job).effect === 'unknown')
        .map((job) => `${file}#${job}`),
    );
    expect(unknown).toEqual([]);
  });

  it('marks exactly the external release writes as publication', () => {
    const publication = REVIEWED_WORKFLOW_STEPS.filter((entry) => entry.effect === 'publication')
      .flatMap((entry) => entry.workflow.split(', '))
      .sort();
    expect(publication).toEqual(PUBLICATION_STEPS);
  });

  it('reads unknown again for a reviewed step whose bytes change', () => {
    const release = readFileSync(join(WORKFLOWS, 'release.yml'), 'utf8');
    expect(jobEffectFacts(release, ROOT, 'finalize-release').effect).toBe('publication');
    const edited = release.replace('Verify canonical asset set', 'Verify the canonical asset set');
    expect(edited).not.toBe(release);
    expect(jobEffectFacts(edited, ROOT, 'finalize-release').effect).toBe('unknown');
  });

  it('reads F5:T3 PASS on the committed workflows', () => {
    const reading = senseHarnessCoherence({ repoRoot: ROOT, now: '2026-10-06T12:00:00.000Z' });
    expect(reading.findings?.filter((finding) => finding.severity !== 'info')).toEqual([]);
    expect(reading.status).toBe('pass');
  });
});
