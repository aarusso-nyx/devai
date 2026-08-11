import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'RC performance',
    environment: 'node',
    include: [
      'tests/e2e/inventory-sensors.smoke.test.ts',
      'tests/regression/**/*.test.ts',
    ],
    passWithNoTests: false,
  },
});
