import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['packages/cli/tests/unit/reconciliation-package-witness.test.ts'], maxWorkers: 1 } });
