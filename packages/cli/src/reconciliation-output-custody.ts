import { types } from 'node:util';

// Diagnostic projection only: never publish arbitrary native data, plan bodies,
// keys or caller-supplied extra properties when terminal validation fails.
const scalars = new Set([
  'kind',
  'phase',
  'outcome',
  'approval_id',
  'action_id',
  'approval_sha256',
  'sequence',
  'plan_sha256',
  'record_sha256',
  'intent_sha256',
  'completion_sha256',
  'outputs_manifest_sha256',
  'expected_lease_sha256',
  'operation',
  'object_count',
  'target',
  'path',
  'dev',
  'ino',
  'birthtime_ns',
  'schema',
  'sha256',
  'bytes',
  'grants_authority',
]);
const nested = new Set(['owned', 'custody', 'selection', 'lease_witness', 'outputs']);
export function reconciliationOutputCustody(value: unknown): Readonly<Record<string, unknown>> {
  let remaining = 1000000;
  function copy(input: unknown, depth: number): unknown {
    if (
      --remaining < 0 ||
      depth > 5 ||
      input === null ||
      typeof input !== 'object' ||
      types.isProxy(input)
    )
      return null;
    if (Array.isArray(input)) {
      if (input.length > 100000) return null;
      const result: unknown[] = [];
      for (let index = 0; index < input.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
        result.push(copy(descriptor.value, depth + 1));
      }
      return result;
    }
    const result: Record<string, unknown> = {};
    for (const key of [...scalars, ...nested]) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) continue;
      const field: unknown = descriptor.value;
      if (nested.has(key)) result[key] = copy(field, depth + 1);
      else if (
        field === null ||
        typeof field === 'boolean' ||
        (typeof field === 'number' && Number.isSafeInteger(field) && field >= 0) ||
        (typeof field === 'string' &&
          field.length <= 16384 &&
          [...field].every(
            (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
          ))
      )
        result[key] = field;
    }
    return result;
  }
  return Object.freeze({
    ...(copy(value, 0) as Record<string, unknown>),
    outcome: 'indeterminate',
    grants_authority: false,
  });
}
