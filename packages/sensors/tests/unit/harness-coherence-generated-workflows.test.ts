// #383: an adopter that holds only the two workflows DEVAI generates, the attested-RC verifier
// and the main observation, reads harness_coherence with no action-version drift, no mixed
// permissions, and no mixed concurrency: the generators share one pin set and both declare
// permissions and concurrency blocks. Semantic concurrency issues are recorded as observed.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { attestedRcVerificationWorkflow } from '../../../cli/src/services/ci-scaffold/index.js';
import { buildGithubActionsAdapterPlan } from '../../../cli/src/services/github-actions-adapter/index.js';
import { senseHarnessCoherence } from '../../src/harness-coherence.js';

const NOW = '2026-10-09T12:00:00.000Z';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function adopter(): string {
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
    buildGithubActionsAdapterPlan(root, '2.3.1').workflowBytes,
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
    // Recorded, not asserted: a semantic concurrency issue here is a follow-up, not #383.
    expect(typeof reading.metrics?.['concurrency_semantic_issues']).toBe('number');
  });
});
