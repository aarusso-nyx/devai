import { describe, expect, it } from 'vitest';
import {
  buildExpectedDiffManifest,
  classifyTranslationPath,
  type TranslationAuthorityRole,
} from '../../src/translation-validation/index.js';

const roles: TranslationAuthorityRole[] = [
  'owner',
  'architect',
  'inspector',
  'engineer',
  'auditor',
];
describe('translation role boundaries', () => {
  it.each([
    ['product/journeys/login.json', 'owner', 'fs:owner-spec'],
    ['product', 'owner', 'fs:owner-spec'],
    ['law/invariants/INV-AUTH-001.json', 'architect', 'fs:architect-spec'],
    ['law', 'architect', 'fs:architect-spec'],
    ['docs/guide.md', 'architect', 'fs:architect-spec'],
    ['docs', 'architect', 'fs:architect-spec'],
    ['README.md', 'architect', 'fs:architect-spec'],
    ['AGENTS.md', 'architect', 'fs:architect-spec'],
    ['CLAUDE.md', 'architect', 'fs:architect-spec'],
    ['packages/a/src/main.ts', 'engineer', 'fs:plant'],
    ['package.json', 'engineer', 'fs:plant'],
    ['packages/a/tests/unit.test.ts', 'inspector', 'fs:tests'],
    ['tests/helper.ts', 'inspector', 'fs:tests'],
    ['packages/a/src/main.spec.mjs', 'inspector', 'fs:tests'],
    ['e2e/login.ts', 'inspector', 'fs:tests'],
    ['vitest.config.ts', 'inspector', 'fs:tests'],
    ['packages/a/jest.config.js', 'inspector', 'fs:tests'],
  ])('restricts %s to %s', (path, owner, effect) => {
    for (const role of roles)
      expect(classifyTranslationPath(role, path)).toEqual({ allowed: role === owner, effect });
  });

  it.each(['law/glossary', 'law/glossary/terms.json'])(
    'preserves joint Owner/Architect authority for %s',
    (path) => {
      for (const role of roles)
        expect(classifyTranslationPath(role, path)).toEqual({
          allowed: role === 'owner' || role === 'architect',
          effect: role === 'owner' ? 'fs:owner-spec' : 'fs:architect-spec',
        });
    },
  );

  it.each([
    ['law/constitution.md', 'fs:f5-config'],
    ['.devai/config/project.json', 'fs:f5-config'],
    ['.devai/state/tasks/task.json', 'fs:f5-state'],
    ['.devai/inventory/blueprint.json', 'fs:inventory'],
    ['.devai/worktrees/candidate/file', 'fs:worktree-admin'],
    ['record/proofs/result.json', 'fs:proofs'],
    ['scratch/report.json', 'fs:worktree-admin'],
  ])('does not grant direct role mutation of %s', (path, effect) => {
    for (const role of roles)
      expect(classifyTranslationPath(role, path)).toEqual({ allowed: false, effect });
  });

  it.each([
    'product-extra/file.ts',
    'docs-extra/file.ts',
    'law-extra/file.ts',
    'record-extra/file.ts',
    'scratch-extra/file.ts',
    'src/README.md',
  ])('does not confuse similar names with governed root %s', (path) => {
    expect(classifyTranslationPath('engineer', path)).toEqual({
      allowed: true,
      effect: 'fs:plant',
    });
  });
});

const input = {
  validation_id: 'VR-0123456789abcdef',
  witness_id: 'TW-fedcba9876543210',
  lease_id: 'TVL-aaaaaaaaaaaaaaaa',
  recipe_name: 'devai-verify',
  recipe_variant: 'default',
  recipe_record_path: 'record/proofs/work/recipe-runs/devai-verify/default/run-1.json',
};
describe('trusted expected-diff manifest', () => {
  it('declares the exact lease lifecycle, witness, result and append-only records in order', () => {
    expect(buildExpectedDiffManifest(input)).toEqual([
      {
        path: '.devai/state/translation-validation/leases/TVL-aaaaaaaaaaaaaaaa.json',
        operation: 'create',
      },
      {
        path: '.devai/state/translation-validation/leases/TVL-aaaaaaaaaaaaaaaa.json',
        operation: 'retire',
      },
      {
        path: 'record/proofs/compliance/translation-validation/witnesses/TW-fedcba9876543210.json',
        operation: 'create',
      },
      {
        path: 'record/proofs/compliance/translation-validation/results/VR-0123456789abcdef.json',
        operation: 'create',
      },
      { path: input.recipe_record_path, operation: 'append' },
      { path: 'record/proofs/chain.json', operation: 'append' },
    ]);
  });

  it.each([
    ['validation_id', 'VR-0123456789abcde', 'VALIDATION ID_INVALID'],
    ['validation_id', 'VR-0123456789abcdef0', 'VALIDATION ID_INVALID'],
    ['validation_id', 'VR-0123456789abcdeG', 'VALIDATION ID_INVALID'],
    ['witness_id', 'VR-fedcba9876543210', 'WITNESS ID_INVALID'],
    ['lease_id', 'TVL-AAAAAAAAAAAAAAAA', 'LEASE ID_INVALID'],
    ['recipe_name', 'devai-publish', 'RECIPE NAME_INVALID'],
    ['recipe_name', 'prefix-devai-verify', 'RECIPE NAME_INVALID'],
    ['recipe_variant', '../default', 'RECIPE VARIANT_INVALID'],
    ['recipe_variant', 'Default', 'RECIPE VARIANT_INVALID'],
    ['recipe_variant', '', 'RECIPE VARIANT_INVALID'],
  ])('rejects invalid %s: %s', (key, value, error) => {
    expect(() => buildExpectedDiffManifest({ ...input, [key]: value })).toThrow(error);
  });

  it.each([
    '../escape.json',
    'a/child.json',
    'a\\child.json',
    '.hidden.json',
    'a..b.json',
    'run.txt',
    '',
    'run.json/extra',
  ])('refuses unsafe record filename %j', (filename) => {
    expect(() =>
      buildExpectedDiffManifest({
        ...input,
        recipe_record_path: `record/proofs/work/recipe-runs/devai-verify/default/${filename}`,
      }),
    ).toThrow('RECIPE_RECORD_PATH_INVALID');
  });

  it.each([
    'record/proofs/work/recipe-runs/devai-fix/default/run.json',
    'record/proofs/work/recipe-runs/devai-verify/other/run.json',
    '/record/proofs/work/recipe-runs/devai-verify/default/run.json',
  ])('binds the record path to the exact recipe and variant: %s', (recipe_record_path) => {
    expect(() => buildExpectedDiffManifest({ ...input, recipe_record_path })).toThrow(
      'RECIPE_RECORD_PATH_INVALID',
    );
  });
});

describe('auditor observation authorization', () => {
  it.each(['work/audit', 'work/audit/report.json', 'work/audit/post-merge/abc/report.json'])(
    'does not authorize legacy observation path %s for an auditor',
    (path) => {
      expect(classifyTranslationPath('auditor', path)).toEqual({
        allowed: false,
        effect: 'fs:auditor-observation',
      });
    },
  );
  it.each([
    '.devai/local/rounds/R-0001/audit/report.json',
    '.devai/local/rounds/R-0002/audit/report.json',
  ])(
    'does not substitute a path-only classification for active-round authorization: %s',
    (path) => {
      expect(classifyTranslationPath('auditor', path).allowed).toBe(false);
    },
  );
});
