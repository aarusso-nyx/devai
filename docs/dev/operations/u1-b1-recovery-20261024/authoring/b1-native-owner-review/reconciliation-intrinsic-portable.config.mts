import { defineConfig } from 'vitest/config';
export default defineConfig({test:{include:['packages/effects-check/tests/contract/effect-reconciliation-intrinsics.contract.test.ts'],maxWorkers:1}});
