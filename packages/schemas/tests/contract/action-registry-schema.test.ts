import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkSchema, validators } from '../../src/index.js';

const ROOT = resolve(import.meta.dirname, '../../../..');

interface RegistryEntry {
  readonly action_id: string;
  readonly authority_contract: {
    capabilities: string[];
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

  it('pins release prepare to its sink-only non-process authority contract', () => {
    const malformed = structuredClone(registry);
    const prepare = malformed.entries.find((entry) => entry.action_id === 'release prepare');
    expect(prepare, 'current registry must contain release prepare').toBeDefined();
    if (prepare === undefined) return;

    prepare.authority_contract.capabilities = [
      'fs:f5-state',
      'fs:proofs',
      'artifact-sink:write',
      'proc:npm',
    ];
    expect(validators.actionRegistry(malformed)).toBe(false);
  });

  it('pins release certify to the protected provider and certification-evidence sink', () => {
    const malformed = structuredClone(registry);
    const certify = malformed.entries.find((entry) => entry.action_id === 'release certify');
    expect(certify, 'current registry must contain release certify').toBeDefined();
    if (certify === undefined) return;

    certify.authority_contract.capabilities = ['fs:f5-state', 'fs:proofs', 'proc:git'];
    expect(validators.actionRegistry(malformed)).toBe(false);
  });

  it('pins preflight to its execution-only protected provider boundary', () => {
    const malformed = structuredClone(registry);
    const preflight = malformed.entries.find((entry) => entry.action_id === 'release preflight');
    expect(preflight, 'current registry must contain release preflight').toBeDefined();
    if (preflight === undefined) return;

    expect(preflight.authority_contract).toMatchObject({
      capabilities: [
        'fs:f5-state',
        'fs:proofs',
        'proc:git',
        'protected-certification-provider-v3:execute',
      ],
      subject: { kind: 'derived-machine', actor: 'harness', transition: 'harness-write' },
      consent: { write: true, allow_publish: false, experimental: false },
      planner: { target_kinds: ['fs', 'protected-certification-provider'] },
      boundary: {
        adapter_ids: ['fs-authority-boundary', 'protected-certification-provider-v3'],
        final_reverification: true,
      },
    });
    preflight.authority_contract.capabilities = [
      'fs:f5-state',
      'fs:proofs',
      'proc:git',
      'protected-certification-provider-v3:execute',
      'certification-evidence-sink:write',
    ];
    expect(validators.actionRegistry(malformed)).toBe(false);
  });
});
