import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'RC containment',
    environment: 'node',
    include: [
      'packages/authority/tests/unit/authority-resource-boundaries.red.test.ts',
      'packages/skills/tests/recipes/adapters.test.ts',
    ],
    passWithNoTests: false,
  },
});
