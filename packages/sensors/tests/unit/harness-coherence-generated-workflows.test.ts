// #383: an adopter that holds only the two workflows DEVAI generates, the attested-RC verifier
// and the main observation, reads harness_coherence with no action-version drift, no mixed
// permissions, and no mixed concurrency: the generators share one pin set and both declare
// permissions and concurrency blocks. #390: both generated jobs prove publication through the
// reviewed-step registry, so their serializing, commit-keyed groups raise no semantic issue.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { attestedRcVerificationWorkflow } from '../../../cli/src/services/ci-scaffold/index.js';
import { buildGithubActionsAdapterPlan } from '../../../cli/src/services/github-actions-adapter/index.js';
import { senseHarnessCoherence } from '../../src/harness-coherence.js';
import { jobEffectFacts } from '../../src/harness/workflow-parser.js';

const NOW = '2026-10-09T12:00:00.000Z';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function adopter(edit: (observation: string) => string = (text) => text): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-coherence-generated-'));
  roots.push(root);
  mkdirSync(join(root, '.git'));
  writeFileSync(
    join(root, '.git/config'),
    '[remote "origin"]\n\turl = https://github.com/example/adopter.git\n',
  );
  const workflows = join(root, '.github/workflows');
  mkdirSync(workflows, { recursive: true });
  writeFileSync(join(workflows, 'devai-local-rc-verify.yml'), attestedRcVerificationWorkflow());
  writeFileSync(
    join(workflows, 'devai-main-observation.yml'),
    edit(buildGithubActionsAdapterPlan(root, '2.3.1').workflowBytes),
  );
  return root;
}

describe('#383: harness_coherence on an adopter with only the generated workflows', () => {
  it('reads no action drift, mixed permissions, or mixed concurrency', () => {
    const root = adopter();
    expect(readdirSync(join(root, '.github/workflows')).sort()).toEqual([
      'devai-local-rc-verify.yml',
      'devai-main-observation.yml',
    ]);
    const reading = senseHarnessCoherence({ repoRoot: root, now: NOW });
    expect(reading.metrics).toMatchObject({
      workflow_count: 2,
      action_version_drift_count: 0,
      permissions_mixed: 0,
      concurrency_mixed: 0,
    });
    const codes = (reading.findings ?? []).map((finding) => finding.code);
    expect(codes).not.toContain('HARNESS_COHERENCE_ACTION_VERSION_DRIFT');
    expect(codes).not.toContain('HARNESS_COHERENCE_PERMISSIONS_MIXED');
    expect(codes).not.toContain('HARNESS_COHERENCE_CONCURRENCY_MIXED');
  });

  it('#390: proves both generated jobs publication and reads no concurrency semantic issue', () => {
    const root = adopter();
    const workflows = join(root, '.github/workflows');
    for (const [file, job] of [
      ['devai-local-rc-verify.yml', 'verify-attested-rc'],
      ['devai-main-observation.yml', 'observe'],
    ] as const) {
      const text = readFileSync(join(workflows, file), 'utf8');
      expect(jobEffectFacts(text, root, job).effect, file).toBe('publication');
    }
    const reading = senseHarnessCoherence({ repoRoot: root, now: NOW });
    expect(reading.metrics).toMatchObject({ concurrency_semantic_issues: 0 });
    const codes = (reading.findings ?? []).map((finding) => finding.code);
    expect(codes).not.toContain('HARNESS_COHERENCE_CONCURRENCY_POLICY');
  });

  it('#390: names the job read unknown instead of a superseding requirement', () => {
    // An adopter edit to one generated step leaves the observation job unproved.
    const root = adopter((text) =>
      text.replace('Verify bound posture', 'Verify the bound posture'),
    );
    const reading = senseHarnessCoherence({ repoRoot: root, now: NOW });
    const policy = (reading.findings ?? []).filter(
      (finding) => finding.code === 'HARNESS_COHERENCE_CONCURRENCY_POLICY',
    );
    expect(policy).toHaveLength(1);
    const message = policy[0]?.message ?? '';
    expect(message).toContain('devai-main-observation.yml');
    expect(message).toContain('observe');
    expect(message).toMatch(/unknown/u);
    expect(message).not.toMatch(/superseding|serialized/u);
    expect(reading.metrics).toMatchObject({ concurrency_semantic_issues: 1 });
  });
});
