import { defineConfig } from 'vitest/config';

// External historical custody and exact installed package are explicit inputs.
// This lane must be invoked deliberately; portable CI uses self-contained tests.
export default defineConfig({
  test: {
    include: ['packages/cli/tests/installed/reconciliation-detran.manual.ts'],
    maxWorkers: 1,
  },
});
