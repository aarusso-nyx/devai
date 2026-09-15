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
      resolveLocalEvidencePolicy(
        fixture({
          schemaVersion: '1.0.0',
          project_type: 'runtime-host',
          ci_economy: { local_evidence: { required_jobs } },
        }),
      ),
    ).toBeNull();
  },
);
it.each([undefined])(
  'uses the complete default policy when no platform override is declared %j',
  (allowed_platforms) => {
    expect(
      resolveLocalEvidencePolicy(
        fixture({
          schemaVersion: '1.0.0',
          project_type: 'runtime-host',
          ci_economy: { local_evidence: { required_jobs: ['unit'], allowed_platforms } },
        }),
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

it.each([
  { max_age_hours: 'unbounded' },
  { max_age_hours: {} },
  { max_age_hours: 0 },
  { max_age_hours: 169 },
  { max_age_hours: 1.5 },
  { required_jobs: [''] },
  { required_jobs: ['unit', 'unit'] },
  { required_jobs: [42] },
  { allowed_platforms: 'linux/arm64' },
  { allowed_platforms: [] },
  { allowed_platforms: ['linux/arm64', 'linux/arm64'] },
  { allowed_platforms: ['unsupported/arm64'] },
  { forbidden_paths: 'law/' },
  { forbidden_paths: [false] },
  { manifest_path: '' },
  { require_docker: 'true' },
  { unexpected: true },
])('declines schema-invalid policy %j without accepting coerced controls', (override) => {
  expect(
    resolveLocalEvidencePolicy(
      fixture({
        schemaVersion: '1.0.0',
        project_type: 'runtime-host',
        ci_economy: { local_evidence: { required_jobs: ['unit'], ...override } },
      }),
    ),
  ).toBeNull();
});

it.each([1, 168])('accepts the schema age boundary %i with explicit strict controls', (hours) => {
  expect(
    resolveLocalEvidencePolicy(
      fixture({
        schemaVersion: '1.0.0',
        project_type: 'runtime-host',
        ci_economy: {
          local_evidence: {
            required_jobs: ['unit', 'coverage'],
            max_age_hours: hours,
            allowed_platforms: ['linux/arm64'],
            forbidden_paths: ['secrets/'],
            manifest_path: 'record/local.json',
            require_docker: true,
          },
        },
      }),
    ),
  ).toEqual({
    manifestPath: 'record/local.json',
    maxAgeHours: hours,
    requiredJobs: ['unit', 'coverage'],
    allowedPlatforms: ['linux/arm64'],
    forbiddenPaths: ['.github/workflows/', '.devai/config/', 'law/policy/', 'secrets/'],
    requireDocker: true,
  });
});
