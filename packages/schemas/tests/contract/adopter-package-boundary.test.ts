import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getValidator, ROSTER, validators } from '../../src/index.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const blueprint = JSON.parse(
  readFileSync(joinFixture('packages/skills/tests/operations/fixtures/blueprint.json'), 'utf8'),
) as unknown;

function joinFixture(path: string): string {
  return resolve(ROOT, path);
}

describe('installed adopter schema boundary', () => {
  it('registers and exposes module-blueprint with structured invalid findings', () => {
    expect(ROSTER).toContain('module-blueprint.schema.json');
    expect(validators.moduleBlueprint).toBeTypeOf('function');
    expect(
      validators.moduleBlueprint(blueprint),
      JSON.stringify(validators.moduleBlueprint.errors),
    ).toBe(true);

    expect(validators.moduleBlueprint({ schemaVersion: '1.0.0' })).toBe(false);
    expect(validators.moduleBlueprint.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instancePath: expect.any(String),
          schemaPath: expect.stringMatching(/^#/u),
          keyword: expect.any(String),
        }),
      ]),
    );
  });

  it('uses one closed documentation shape for adopter policy and project configuration', () => {
    const docs = {
      builder: 'docusaurus',
      publish_target: 'gh-pages',
      gh_pages_branch: 'gh-pages',
    };
    const adopter = {
      schemaVersion: '1.0.0',
      policy_id: 'teat.devai-adoption',
      policy_version: '1.2.1',
      project: { docs },
    };
    const project = {
      schemaVersion: '1.0.0',
      project_type: 'runtime-host',
      authority_enforcement: { mode: 'cli-only' },
      profile: 'tier3',
      docs,
    };
    const validateAdopter = getValidator('adopter-policy.schema.json');
    const validateProject = getValidator('project-config.schema.json');
    expect(validateAdopter(adopter), JSON.stringify(validateAdopter.errors)).toBe(true);
    expect(validateProject(project), JSON.stringify(validateProject.errors)).toBe(true);
    expect(validateAdopter({ ...adopter, project: { docs: { ...docs, surprise: true } } })).toBe(
      false,
    );
  });
});
