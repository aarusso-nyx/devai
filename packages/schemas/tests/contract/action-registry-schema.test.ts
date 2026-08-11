import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkSchema, validators } from '../../src/index.js';

const ROOT = resolve(import.meta.dirname, '../../../..');

interface RegistryEntry {
  readonly action_id: string;
  readonly authority_contract: {
    subject: {
      kind: string;
      actor?: string;
      transition?: string;
    };
  };
}

interface ActionRegistry {
  readonly entries: RegistryEntry[];
}

const registry = JSON.parse(
  readFileSync(resolve(ROOT, 'law/policy/action-registry.json'), 'utf8'),
) as ActionRegistry;
const registrySchema = JSON.parse(
  readFileSync(resolve(ROOT, 'law/schemas/action-registry.schema.json'), 'utf8'),
) as unknown;

describe('action registry schema', () => {
  it('accepts the current registry and rejects the removed upgrade machine identity', () => {
    expect(
      validators.actionRegistry(registry),
      JSON.stringify(validators.actionRegistry.errors),
    ).toBe(true);

    const removedIdentity = structuredClone(registry);
    const binding = removedIdentity.entries.find(
      (entry) => entry.authority_contract.subject.actor === 'binding',
    );
    expect(binding, 'current registry must contain a binding machine subject').toBeDefined();
    if (binding === undefined) return;

    binding.authority_contract.subject.actor = 'upgrade';
    binding.authority_contract.subject.transition = 'upgrade';

    expect(validators.actionRegistry(removedIdentity)).toBe(false);
  });

  it('treats allOf branches as predicate fragments while retaining closed-object checks', () => {
    expect(checkSchema('action-registry.schema.json', registrySchema)).toEqual([]);
    expect(
      checkSchema('example.schema.json', {
        type: 'object',
        additionalProperties: false,
        properties: {
          nested: {
            type: 'object',
            properties: { value: { type: 'string' } },
          },
        },
      }),
    ).toEqual([
      {
        schema: 'example.schema.json',
        rule: 'open-world-object',
        path: '$root/properties/nested',
      },
    ]);
  });
});
