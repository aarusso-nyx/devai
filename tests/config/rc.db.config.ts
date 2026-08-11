import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'RC database',
    environment: 'node',
    include: [
      'tests/integration/authority-effect-postgres.db.test.ts',
      'tests/integration/runtime-probe-data.integration.test.ts',
    ],
    passWithNoTests: false,
  },
});
