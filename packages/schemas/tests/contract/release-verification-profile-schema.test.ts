import { describe, expect, it } from 'vitest';
import { getValidator } from '../../src/index.js';

const profile = {
  schemaVersion: '1.0.0',
  policy_id: 'example.release-verification',
  policy_version: '1.0.0',
  release_unit: '@example/package',
  version_source: 'package.json',
  default_support: 'current',
  capability_tasks: { lint: ['lint'], 'type-integrity': ['typecheck'] },
  risk_capabilities: { authorization: ['security', 'integration'] },
  mutation_roster: [
    {
      id: 'example',
      package: '@example/package',
      task_node: 'test:mutation:example',
      risk_classes: ['authorization'],
      source_selectors: ['src/'],
      test_selectors: ['tests/'],
      manifest_path: 'package.json',
      config_paths: ['mutation.config.ts'],
      sanitizer_paths: ['scripts/sanitize.mjs'],
      orchestration_paths: ['scripts/run-mutation.mjs'],
      lockfile_path: 'pnpm-lock.yaml',
      toolchain_keys: ['node', 'pnpm', 'mutation-engine'],
      thresholds: { high: 100, low: 90, break: 90 },
    },
  ],
} as const;

describe('release-verification-profile schema', () => {
  it('accepts a bounded generic capability and mutation declaration', () => {
    expect(getValidator('release-verification-profile.schema.json')(profile)).toBe(true);
  });

  it('rejects absolute mutation paths', () => {
    expect(
      getValidator('release-verification-profile.schema.json')({
        ...profile,
        mutation_roster: [{ ...profile.mutation_roster[0], manifest_path: '/tmp/package.json' }],
      }),
    ).toBe(false);
  });

  it.each(['../package.json', 'packages/../package.json', String.raw`packages\\cli\\package.json`])(
    'rejects non-portable mutation path %s',
    (manifestPath) => {
      expect(
        getValidator('release-verification-profile.schema.json')({
          ...profile,
          mutation_roster: [{ ...profile.mutation_roster[0], manifest_path: manifestPath }],
        }),
      ).toBe(false);
    },
  );
});
