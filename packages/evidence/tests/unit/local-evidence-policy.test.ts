import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { resolveLocalEvidencePolicy } from '../../src/local-evidence/config.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(config?: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'evidence-policy-'));
  roots.push(root);
  if (config !== undefined) {
    mkdirSync(join(root, '.devai/config'), { recursive: true });
    writeFileSync(join(root, '.devai/config/project.json'), JSON.stringify(config));
  }
  return root;
}
it.each([undefined, {}, null, { ci_economy: {} }, { ci_economy: { local_evidence: null } }])(
  'declines absent or null policy %j without throwing',
  (config) => {
    expect(resolveLocalEvidencePolicy(fixture(config))).toBeNull();
  },
);
it.each([undefined, [], 'unit'])(
  'declines a policy without a nonempty job array %j',
  (required_jobs) => {
    expect(
      resolveLocalEvidencePolicy(fixture({ ci_economy: { local_evidence: { required_jobs } } })),
    ).toBeNull();
  },
);
it.each([undefined, []])(
  'uses the complete default policy with platform override %j',
  (allowed_platforms) => {
    expect(
      resolveLocalEvidencePolicy(
        fixture({ ci_economy: { local_evidence: { required_jobs: ['unit'], allowed_platforms } } }),
      ),
    ).toEqual({
      manifestPath: 'record/proofs/work/local-evidence/local-ci.json',
      maxAgeHours: 24,
      requiredJobs: ['unit'],
      allowedPlatforms: ['linux/arm64', 'linux/amd64'],
      forbiddenPaths: ['.github/workflows/', '.devai/config/', 'law/policy/'],
      requireDocker: false,
    });
  },
);
