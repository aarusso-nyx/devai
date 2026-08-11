import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'RC E2E',
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/inventory-sensors.smoke.test.ts'],
    passWithNoTests: false,
  },
});
