import { createNativeServiceFixtures as capturedFactory } from './native-input-provenance.js';
import type { NativeServiceFixtures } from './native-service-fixtures-types.js';

export const createNativeServiceFixtures: () => NativeServiceFixtures = capturedFactory;
export type {
  NativeServiceFixtures,
  NativePostgresFixture,
  NativeRedisFixture,
  NativeLocalstackFixture,
} from './native-service-fixtures-types.js';
