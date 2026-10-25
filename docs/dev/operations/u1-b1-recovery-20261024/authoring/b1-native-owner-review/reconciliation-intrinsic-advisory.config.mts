import { defineConfig } from 'vitest/config';
export default defineConfig({test:{include:['docs/dev/operations/u1-b1-recovery-20261024/authoring/b1-native-owner-review/reconciliation-intrinsic-advisory.test.ts','packages/effects-check/tests/contract/effect-advisory-boundaries.contract.test.ts','packages/effects-check/tests/contract/effect-advisories.contract.test.ts'],maxWorkers:1}});
