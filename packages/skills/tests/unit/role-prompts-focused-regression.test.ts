// ADR-GOV-0026 (issue #412): the role prompts describe the authority the enforcement grants, in
// the same release. The Engineer prompt drops its "not yet active" marker and bounds the
// focused-regression verb as Article 7 does; the Inspector prompt states its mandate as
// counterexamples, sensor configuration and independent assurance, and keeps the verbs the
// Engineer never holds.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROLES = join(import.meta.dirname, '..', '..', 'resources', 'roles');
const engineer = readFileSync(join(ROLES, 'engineer.md'), 'utf8');
const inspector = readFileSync(join(ROLES, 'inspector.md'), 'utf8');

describe('Engineer role prompt', () => {
  it('no longer marks its test authority as inactive', () => {
    expect(engineer).not.toMatch(/takes effect only once|until ADR-GOV-0026|<!--/u);
  });

  it('bounds the focused-regression verb by adjacency to its own change', () => {
    expect(engineer).toMatch(/imports? .*source.* this task changed/u);
    expect(engineer).toContain('`packages/*/tests/`');
    expect(engineer).toContain('`tests/`');
  });

  it('keeps deletion, existing assertions and thresholds out of its reach', () => {
    expect(engineer).toMatch(/never delete a test/iu);
    expect(engineer).toMatch(/assertion of a test this task did not add/u);
    expect(engineer).toMatch(/coverage or mutation threshold/u);
  });

  it('names the independent-assurance designation that withholds the verb', () => {
    expect(engineer).toMatch(/independent-assurance/u);
  });
});

describe('Inspector role prompt', () => {
  it('states its mandate as counterexamples, sensor configuration and independent assurance', () => {
    expect(inspector).toMatch(/counterexamples, sensor configuration, and independent assurance/u);
  });

  it('keeps the verbs the Engineer never holds', () => {
    expect(inspector).toMatch(/[Dd]eleting a test/u);
    expect(inspector).toMatch(/assertion of a test the current task did not add/u);
    expect(inspector).toMatch(/coverage or mutation threshold/u);
  });
});
