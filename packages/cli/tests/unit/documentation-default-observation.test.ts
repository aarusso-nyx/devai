import _assert from 'node:assert/strict';
import { it, expect } from 'vitest';
import { article6Role } from '../../src/services/write-scope/index.js';
import { classifyTranslationPath } from '@devai-nyx/spec';
import { article6Role as originalRole } from '../fixtures/documentation-authority-baseline/default/scope/index.js';
import { classifyTranslationPath as originalClassification } from '../fixtures/documentation-authority-baseline/default/path-authority.js';
it('records original role divergence while preserving both classifiers without context', () => {
  const paths = [
    'docs/test/probe.ts',
    'docs/probe.spec.ts',
    'docs/e2e/probe.js',
    'docs/vitest.config.ts',
    'docs/site/docusaurus.config.js',
  ];
  const rows = paths.map((path) => {
    const before = originalRole(path),
      after = article6Role(path);
    expect(after).toBe(before);
    const roles = ['owner', 'architect', 'inspector', 'engineer', 'auditor'] as const;
    const spec = roles.map((role) => {
      const previous = originalClassification(role, path),
        current = classifyTranslationPath(role, path);
      expect(current).toEqual(previous);
      return { role, previous, current };
    });
    return { path, originalScope: before, currentScope: after, spec };
  });
  expect(rows[0]?.currentScope).toBe('architect');
  expect(rows[0]?.spec.find((row) => row.role === 'inspector')?.current.allowed).toBe(true);
});
