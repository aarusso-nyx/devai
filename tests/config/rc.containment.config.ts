import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'RC containment',
    environment: 'node',
    // Containment tests remain with the authority and recipe code they constrain.
    include: [
      'packages/authority/tests/unit/authority-resource-boundaries.red.test.ts',
      'packages/skills/tests/recipes/adapters.test.ts',
    ],
    passWithNoTests: false,
  },
});
