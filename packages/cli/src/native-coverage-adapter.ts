// The canonical preload owns all privileged IO and immutable native context.
import { createNativeCoverageAdapter as capturedFactory } from './native-input-provenance.js';
import type {
  NativeCoverageAdapter,
  NativeCoverageAdapterOptions,
} from './native-coverage-types.js';

export const createNativeCoverageAdapter: (
  options: NativeCoverageAdapterOptions,
) => NativeCoverageAdapter = capturedFactory;
export { isProxy, sameNativeData } from './native-coverage-data.js';
export type { NativeCoverageAdapterOptions } from './native-coverage-types.js';
