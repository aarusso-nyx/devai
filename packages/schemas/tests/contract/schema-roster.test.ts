import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getValidator, ROSTER } from '../../src/index.js';

const ROOT = resolve(import.meta.dirname, '../../../..');

// ADR-MDL-0002: model-tiers.schema.json moves from the check command's source-only
// catalogue into the runtime roster (TASK-0353). ADR-AUT-0003 adds
// path-authority-classes.schema.json (TASK-0523), and ADR-SCR-0008 adds
// observation-backlog.schema.json (TASK-0423), so the count is 97.
describe('schema roster', () => {
  it('holds the previous roster plus model-tiers, path-authority-classes and observation-backlog', () => {
    expect(ROSTER).toHaveLength(97);
    expect(ROSTER).toContain('model-tiers.schema.json');
    expect(ROSTER).toContain('path-authority-classes.schema.json');
    expect(ROSTER).toContain('observation-backlog.schema.json');
  });

  it('has no duplicate names and a law source file for every entry', () => {
    expect(new Set(ROSTER).size).toBe(ROSTER.length);
    for (const name of ROSTER) {
      expect(existsSync(resolve(ROOT, 'law/schemas', name)), name).toBe(true);
    }
  });

  it('validates the default tier policy through the roster validator', () => {
    const validate = getValidator('model-tiers.schema.json');
    const policy = JSON.parse(
      readFileSync(resolve(ROOT, 'law/policy/model-tiers.json'), 'utf8'),
    ) as unknown;
    expect(validate(policy), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ schemaVersion: '1.0.0' })).toBe(false);
  });
});
