import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveLayoutInputs } from '../../src/commands/sense/layout-inputs.js';
import { sensorAdapter } from '../../src/commands/sense/adapters.js';

const parents: string[] = [];
afterEach(() => {
  for (const parent of parents.splice(0)) rmSync(parent, { recursive: true, force: true });
});
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'devai-adopter-layout-'));
  parents.push(parent);
  const root = join(parent, 'checkout');
  mkdirSync(root);
  mkdirSync(join(parent, 'sibling'));
  symlinkSync(join(parent, 'sibling'), join(root, 'escape'));
  return root;
}
function file(root: string, name: string, content: string) {
  mkdirSync(dirname(join(root, name)), { recursive: true });
  writeFileSync(join(root, name), content);
}
const kinds = [
  ['spec_alignment', 'sourceRoots'],
  ['plant_depth', 'sourceRoots'],
  ['plant_coherence', 'sourceRoots'],
  ['test_coherence', 'packageRoots'],
  ['spec_security_coverage', 'threatModelDirs'],
  ['spec_security_coverage', 'piiMigrationDirs'],
  ['spec_robustness_targets', 'errorContractDirs'],
] as const;

describe('declared adopter layout populations', () => {
  it.each(kinds)('preserves defaults and resolves %s %s', (kind, key) => {
    const root = fixture();
    expect(resolveLayoutInputs(root, kind)).toEqual({});
    const declared = { [key]: ['backend/domain'] };
    file(
      root,
      '.devai/config/sensor-inputs.json',
      JSON.stringify({ schemaVersion: '1.0.0', inputs: { [kind]: declared } }),
    );
    expect(resolveLayoutInputs(root, kind)).toEqual(declared);
    expect(resolveLayoutInputs(root, kind, { [key]: ['apps/portal'] })).toEqual({
      [key]: ['apps/portal'],
    });
  });

  it.each(kinds)('refuses malformed or escaping %s %s', (kind, key) => {
    const root = fixture();
    for (const value of [
      [],
      ['../sibling'],
      ['/tmp'],
      ['escape'],
      ['escape/missing'],
      ['backend', 'backend'],
      [false],
      'backend',
    ]) {
      expect(() => resolveLayoutInputs(root, kind, { [key]: value })).toThrow();
    }
  });

  it('measures authored backend sources and preserves the original depth thresholds', async () => {
    const root = fixture();
    file(root, 'backend/domain/large.ts', 'export {};\n'.repeat(1100));
    file(root, 'packages/generated/src/client.ts', 'export {};\n');
    const reading = await sensorAdapter('plant_depth')({
      repoRoot: root,
      inputs: { sourceRoots: ['backend/domain'] },
    });
    expect(reading.status).toBe('fail');
    expect(reading.metrics).toMatchObject({
      files_count: 1,
      threshold_pass: 500,
      threshold_review: 1000,
    });
    const alignment = await sensorAdapter('spec_alignment')({
      repoRoot: root,
      inputs: { sourceRoots: ['backend/domain'] },
    });
    expect(alignment.metrics?.source_files_scanned).toBe(1);
    const coherence = await sensorAdapter('plant_coherence')({
      repoRoot: root,
      inputs: { sourceRoots: ['backend/domain'] },
    });
    expect(coherence.metrics?.dirs_scanned).toBe(1);
  });

  it('counts the complete explicit package population and discovers existing error contracts', async () => {
    const root = fixture();
    file(root, 'backend/domain/service.ts', 'export const value = 1;');
    file(root, 'apps/portal/ui.ts', 'export const value = 1;');
    file(root, 'docs/framework/errors-domain.json', '{}');
    const reading = await sensorAdapter('test_coherence')({
      repoRoot: root,
      inputs: { packageRoots: ['backend/domain', 'apps/portal'] },
    });
    expect(reading.metrics).toMatchObject({ packages_scanned: 2, source_files: 2, test_files: 0 });
    const robustness = await sensorAdapter('spec_robustness_targets')({
      repoRoot: root,
      inputs: { errorContractDirs: ['docs/framework'] },
    });
    expect(robustness.metrics?.error_contract_files).toBe(1);
  });
  it('finds threat and PII signals in the declared specification and SQL directories', async () => {
    const root = fixture();
    file(root, 'docs/security/threat-model.md', '# Existing threat model');
    file(root, 'backend/database/ddl/privacy.sql', "insert into core.pii_map values ('fixture');");
    const reading = await sensorAdapter('spec_security_coverage')({
      repoRoot: root,
      inputs: { threatModelDirs: ['docs/security'], piiMigrationDirs: ['backend/database/ddl'] },
    });
    expect(reading.metrics).toMatchObject({ threat_model_present: 1, pii_registry_present: 1 });
  });
});
