import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getValidator } from '@devai-nyx/schemas';
import {
  loadModelRuntimeRegistry,
  ModelRuntimeRegistryError,
  validateModelRuntimeRegistry,
} from '../../src/loop/model-runtime.js';

// Invariants: INV-DEVAI-001
const ROOT = resolve(import.meta.dirname, '../../../..');
const original = JSON.parse(
  readFileSync(resolve(ROOT, 'law/policy/model-runtime-registry.json'), 'utf8'),
) as Record<string, unknown>;
const schema = getValidator('model-runtime-registry.schema.json');
function changedEntry(change: Record<string, unknown>) {
  const candidate = structuredClone(original);
  const entries = candidate.runtimes as Record<string, unknown>[];
  const entry = entries.find((value) => value.transport === 'provider-api');
  if (entry === undefined) throw new Error('canonical registry has no provider fixture');
  Object.assign(entry, change);
  return candidate;
}

describe('model runtime registry schema closure', () => {
  it.each([
    { id: 'UPPERCASE' },
    { id: 'runtime/other' },
    { adapter_id: 'invalid adapter' },
    { adapter_id: 'adapter/other' },
    { adapter_module: 'outside-package.ts' },
    { adapter_module: 'packages/adapter with spaces.ts' },
    { credential_binding: 17 },
    { credential_binding: { environment: 'DECLARATION_ONLY' } },
    { executable: '' },
    { executable: 17 },
    { undeclared_capability: true },
  ])('rejects a schema-invalid provider bridge %j', (change) => {
    const candidate = changedEntry(change);
    expect(schema(candidate)).toBe(false);
    expect(() => validateModelRuntimeRegistry(candidate)).toThrow();
  });

  it('rejects unrecognized top-level declarations rather than carrying them into routing', () => {
    const candidate = { ...structuredClone(original), undeclared_capability: true };
    expect(schema(candidate)).toBe(false);
    expect(() => validateModelRuntimeRegistry(candidate)).toThrow();
  });

  it.each([undefined, null, '', 'EXAMPLE_CREDENTIAL_BINDING'])(
    'retains allowed credential declaration %j without resolving a credential',
    (credential) => {
      const candidate = changedEntry({ credential_binding: credential });
      if (credential === undefined) {
        for (const entry of candidate.runtimes as Record<string, unknown>[]) {
          if (entry.transport === 'provider-api') delete entry.credential_binding;
        }
      }
      expect(schema(candidate)).toBe(true);
      expect(validateModelRuntimeRegistry(candidate)).toEqual(candidate);
    },
  );
});

describe('model runtime actionable refusal diagnostics', () => {
  it.each([
    ['vendor', '', 'vendor is required'],
    ['family', 17, 'family is required'],
    ['adapter_id', '', 'adapter_id is required'],
    ['adapter_module', '', 'adapter_module is required'],
    ['adapter_module', '/outside.ts', 'adapter_module is not a contained TypeScript path'],
    ['adapter_module', '../outside.ts', 'adapter_module is not a contained TypeScript path'],
    [
      'adapter_module',
      'packages/../../outside.ts',
      'adapter_module is not a contained TypeScript path',
    ],
    ['adapter_module', 'packages/bridge.js', 'adapter_module is not a contained TypeScript path'],
    ['transport', 'unknown', 'transport is invalid'],
    ['efforts', [], 'efforts are invalid'],
    ['efforts', ['high', 'high'], 'efforts are invalid'],
    ['efforts', [''], 'efforts are invalid'],
    ['efforts', ['high', ''], 'efforts are invalid'],
    ['efforts', [17], 'efforts are invalid'],
    ['efforts', 'high', 'efforts are invalid'],
    ['capabilities', [], 'capabilities are invalid'],
    ['capabilities', ['text-generation', 'text-generation'], 'capabilities are invalid'],
    ['eligible_agent_classes', [], 'agent classes are invalid'],
    ['eligible_agent_classes', ['coding-agent', 'coding-agent'], 'agent classes are invalid'],
    ['eligible_agent_classes', ['administrator'], 'has an unknown agent class'],
    ['available', 'true', 'availability is invalid'],
    ['availability_basis', '', 'availability basis is required'],
  ])('identifies malformed %s declaration %j', (field, value, detail) => {
    const candidate = changedEntry({ [field as string]: value });
    expect(() => validateModelRuntimeRegistry(candidate)).toThrow(
      new ModelRuntimeRegistryError(
        'TASK_MODEL_REGISTRY_INVALID',
        `runtime anthropic-api ${String(detail)}`,
      ),
    );
  });

  it.each([null, [], 'runtime', 17])('identifies a malformed runtime entry %j', (value) => {
    expect(() =>
      validateModelRuntimeRegistry({ ...structuredClone(original), runtimes: [value] }),
    ).toThrow('TASK_MODEL_REGISTRY_INVALID: runtime entry must be an object');
  });

  it.each(['id', 'status', 'authority', 'schemaVersion', '$schema'])(
    'preserves the identity refusal for an invalid %s',
    (field) => {
      expect(() =>
        validateModelRuntimeRegistry({ ...structuredClone(original), [field]: 'wrong' }),
      ).toThrow(
        'TASK_MODEL_REGISTRY_IDENTITY_MISMATCH: registry identity does not match the runtime-bridge contract',
      );
    },
  );

  it('reads exactly the host-selected candidate and pinned registry path', () => {
    const candidate = { opaque: 'candidate-handle' };
    const calls: unknown[][] = [];
    const result = loadModelRuntimeRegistry({
      repoRoot: ROOT,
      candidate,
      readCandidate: (...args) => {
        calls.push(args);
        return JSON.stringify(original);
      },
    });
    expect(calls).toEqual([[ROOT, candidate, 'law/policy/model-runtime-registry.json']]);
    expect(result).toEqual(original);
  });

  it('refuses an implicit repository before invoking the candidate reader', () => {
    let reads = 0;
    expect(() =>
      loadModelRuntimeRegistry({
        repoRoot: '',
        candidate: original,
        readCandidate: () => {
          reads++;
          return JSON.stringify(original);
        },
      }),
    ).toThrow('TASK_MODEL_REGISTRY_SOURCE_INVALID: repoRoot must be explicit');
    expect(reads).toBe(0);
  });

  it('preserves a candidate-reader failure without falling back to supplied data', () => {
    const failure = new Error('fixture candidate unavailable');
    expect(() =>
      loadModelRuntimeRegistry({
        repoRoot: ROOT,
        candidate: original,
        readCandidate: () => {
          throw failure;
        },
      }),
    ).toThrow(failure);
  });

  it('reports malformed candidate JSON before attempting registry interpretation', () => {
    expect(() => loadModelRuntimeRegistry({ repoRoot: ROOT, candidate: '{' })).toThrow(
      'TASK_MODEL_REGISTRY_INVALID: candidate is not valid JSON:',
    );
  });
});
