import { describe, expect, it } from 'vitest';
import { getValidator, ROSTER } from '../../src/index.js';
import { readJson, schemaExample } from '../fixtures/governance-v15.js';

const GOVERNANCE_SCHEMAS = [
  'adr-v2.schema.json',
  'adr-validation-policy.schema.json',
  'effect-authorization-event.schema.json',
  'effect-authorization-ledger.schema.json',
  'mutation-assurance-policy-v2.schema.json',
  'mutation-assurance-v2.schema.json',
  'release-lifecycle-observation.schema.json',
  'release-lifecycle-policy.schema.json',
  'release-lifecycle-state.schema.json',
  'release-offline-verification-receipt.schema.json',
  'release-plan-receipt.schema.json',
  'release-publication-receipt.schema.json',
  'self-dogfood-policy.schema.json',
] as const;

const POLICY_EXAMPLES = [
  ['adr-validation-policy.schema.json', 'law/policy/adr-validation.json'],
  ['mutation-assurance-policy-v2.schema.json', 'law/policy/mutation-assurance-v2.json'],
  ['mutation-evidence-policy-v2.schema.json', 'law/policy/mutation-evidence-v2.json'],
  ['release-lifecycle-policy.schema.json', 'law/policy/release-lifecycle.json'],
  ['self-dogfood-policy.schema.json', 'law/policy/self-dogfood.json'],
] as const;

describe('DEVAI 1.5 governance schema closure', () => {
  it.each(GOVERNANCE_SCHEMAS)('compiles and accepts the example in %s', (schemaName) => {
    expect(getValidator(schemaName)(schemaExample(schemaName))).toBe(true);
  });

  it.each(POLICY_EXAMPLES)('%s accepts its canonical policy document', (schemaName, policyPath) => {
    expect(getValidator(schemaName)(readJson(policyPath))).toBe(true);
  });

  it('makes every governance contract reachable from the packaged schema roster', () => {
    const policySchemaNames = POLICY_EXAMPLES.map(([schemaName]) => schemaName);
    expect(
      [...new Set([...GOVERNANCE_SCHEMAS, ...policySchemaNames])].filter(
        (name) => !ROSTER.includes(name),
      ),
    ).toEqual([]);
  });
});
