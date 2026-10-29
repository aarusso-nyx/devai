import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getValidator, ROSTER } from '../../src/index.js';

const ROOT = resolve(import.meta.dirname, '../../../..');

// ADR-MDL-0002: model-tiers.schema.json moves from the check command's source-only
// catalogue into the runtime roster (TASK-0353). ADR-AUT-0003 adds
// path-authority-classes.schema.json (TASK-0523), and ADR-SCR-0008 adds
// observation-backlog.schema.json (TASK-0423). ADR-EVI-0002 adds proof-anchor-baseline.schema.json
// and proof-orphan-declaration.schema.json (TASK-0436). CMP-0006 adds the four soft-gate
// schemas and thresholds.schema.json. ADR-MDL-0005 adds experimental-execution,
// experimental-activation and dispatch-journal-event, and promotes the source-only
// prompt-composition schema to the runtime roster for the prompt composer. init upgrade (#264)
// adds adopter-migrations.schema.json for the shipped migration manifest, and ADR-GOV-0025
// promotes campaign.schema.json for the campaign projection and materializer. The pack resolver
// validates every stack-adapter.json through the roster, so stack-adapter.schema.json leaves the
// source-only catalogue (#235); a source-only name throws in the packed runtime and no pack would
// ever resolve. ADR-CHK-0007 adds test-task-exclusivity.schema.json, which the check runner
// validates its scheduling declarations against. ADR-SCR-0015 promotes the reviewed task
// descriptor and its preflight-probe reference closure. ADR-SCR-0017 adds the declared
// invariant/workflow producers and complete native result population. ADR-SCR-0018 adds the opt-in workflow inventory schema. ADR-SCR-0020 adds the three owned native service schemas.
// ADR-EVI-0007 adds the closed Owner record schema. The read-only B1 plan adds one runtime schema; four bounded B1 action-output schemas bring the current count to 127.
describe('schema roster', () => {
  it('holds the previous roster and the reviewed sensor task descriptor reference closure', () => {
    const sourceAdditions = [
      'source-apply-manifest.schema.json',
      'source-apply-result.schema.json',
    ];
    expect(ROSTER.filter((name) => !sourceAdditions.includes(name))).toHaveLength(127);
    expect(ROSTER).toHaveLength(129);
    expect(ROSTER.filter((name) => sourceAdditions.includes(name)).sort()).toEqual(
      [...sourceAdditions].sort(),
    );
    expect(ROSTER).toContain('reconciliation-owner.schema.json');
    expect(ROSTER).toContain('test-task-descriptor.schema.json');
    expect(ROSTER).toContain('preflight-probe.schema.json');
    expect(ROSTER).toContain('invariant-producers.schema.json');
    expect(ROSTER).toContain('reviewed-workflow-steps.schema.json');
    expect(ROSTER).toContain('test-result-population.schema.json');
    expect(ROSTER).toContain('workflow-step-inventory.schema.json');
    expect(ROSTER).toContain('native-service-profile.schema.json');
    expect(ROSTER).toContain('native-service-profiles-policy.schema.json');
    expect(ROSTER).toContain('native-service-backends-policy.schema.json');
    expect(ROSTER).toContain('test-task-exclusivity.schema.json');
    expect(ROSTER).toContain('stack-adapter.schema.json');
    expect(ROSTER).toContain('model-tiers.schema.json');
    expect(ROSTER).toContain('path-authority-classes.schema.json');
    expect(ROSTER).toContain('observation-backlog.schema.json');
    expect(ROSTER).toContain('proof-anchor-baseline.schema.json');
    expect(ROSTER).toContain('proof-orphan-declaration.schema.json');
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
