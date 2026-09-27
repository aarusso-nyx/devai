import { canonicalJson } from '@devai-nyx/utils';
import { types } from 'node:util';
import type { ReleaseProviderResult } from './release-lifecycle-execution-types.js';

export function immutableProviderData<T>(value: T): T {
  const snapshot = JSON.parse(canonicalJson(value)) as T;
  const freeze = (entry: unknown): void => {
    if (entry !== null && typeof entry === 'object') {
      for (const child of Object.values(entry)) freeze(child);
      Object.freeze(entry);
    }
  };
  freeze(snapshot);
  return snapshot;
}

export function captureExportProviderResult(value: unknown): ReleaseProviderResult {
  const invalid = () => new Error('release-adapter-output-invalid');
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set([
    'outcome',
    'dispatch_status',
    'provider_handle',
    'material',
    'code',
    'transaction',
  ]);
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !allowed.has(key)) ||
    Object.values(descriptors).some((entry) => !entry.enumerable || !('value' in entry)) ||
    !['success', 'failure', 'unknown'].includes(descriptors['outcome']?.value as string)
  )
    throw invalid();
  // Capture disposition before any state validation or cleanup decision.
  return Object.freeze(
    Object.fromEntries(Object.entries(descriptors).map(([key, entry]) => [key, entry.value])),
  ) as unknown as ReleaseProviderResult;
}
