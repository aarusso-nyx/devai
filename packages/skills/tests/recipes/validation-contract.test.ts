import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import type { AnySchema } from 'ajv';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRecipeAdapterPlan } from '../../src/recipes/adapters.js';
import { loadRecipes } from '../../src/recipes/loader.js';
import { validateRecipeManifest } from '../../src/recipes/validate.js';

const canonical = (() => {
  const recipe = loadRecipes().find((item) => item.manifest.name === 'devai-fix');
  if (recipe === undefined) throw new Error('canonical fix recipe missing');
  return recipe;
})();
const resources = dirname(canonical.resource_dir);
const schema = new Ajv2020({ allErrors: true, strict: true }).compile(
  JSON.parse(readFileSync(join(resources, 'recipe.schema.json'), 'utf8')) as AnySchema,
);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function alteredVariant(field: 'effect' | 'write_policy', value: unknown) {
  return {
    ...canonical.manifest,
    variants: {
      ...canonical.manifest.variants,
      lint: { ...canonical.manifest.variants.lint, [field]: value },
    },
  };
}

const invalidCases = [
  ['array effect', 'effect', ['runtime-write']],
  ['array write mode', 'write_policy', { mode: ['explicit-files'], scopes: ['packages/**'] }],
  ['array none mode with writes', 'write_policy', { mode: ['none'], scopes: ['packages/**'] }],
  [
    'undeclared permission',
    'write_policy',
    { mode: 'explicit-files', scopes: ['packages/**'], permissions: { publish: true } },
  ],
] as const;

describe('recipe validation retains the declared schema boundary', () => {
  it('accepts the unchanged canonical recipe in both validators', () => {
    expect(schema(canonical.manifest)).toBe(true);
    expect(validateRecipeManifest(canonical.manifest)).toEqual([]);
  });

  it.each(invalidCases)('refuses %s before producing adopter adapters', (_name, field, value) => {
    const manifest = alteredVariant(field, value);
    expect(schema(manifest)).toBe(false);

    const root = mkdtempSync(join(tmpdir(), 'devai recipe validation ç '));
    roots.push(root);
    cpSync(resources, root, { recursive: true });
    const path = join(root, 'devai-fix/devai.recipe.json');
    writeFileSync(path, JSON.stringify(manifest));
    const bytes = readFileSync(path);
    expect(() => buildRecipeAdapterPlan(root)).toThrow(/INVALID_RECIPE_MANIFEST/u);
    expect(readFileSync(path)).toEqual(bytes);
    expect(validateRecipeManifest(manifest)).not.toEqual([]);
  });
});

describe('recipe effects stay within their declared local scopes', () => {
  it.each(['/outside', '../outside', 'packages/../outside', 'packages\\outside', '.', '**'])(
    'refuses an unbounded scope %s',
    (scope) => {
      const value = alteredVariant('write_policy', { mode: 'bounded-patterns', scopes: [scope] });
      expect(validateRecipeManifest(value)).toContain(
        'variants.lint.write_policy.scopes[0] is not a bounded repository-relative scope',
      );
    },
  );

  it.each([null, '', 4])('refuses a non-path scope %s', (scope) => {
    const value = alteredVariant('write_policy', { mode: 'explicit-files', scopes: [scope] });
    expect(validateRecipeManifest(value)).toContain(
      'variants.lint.write_policy.scopes[0] must be a non-empty string',
    );
  });

  it.each([
    [
      'runtime-write',
      ['.devai/state/round/**', 'packages/**'],
      'runtime-write scopes must stay under .devai/state/',
    ],
    [
      'local-write',
      ['packages/**', '.devai/state/round/**'],
      'local-write scopes cannot target runtime state',
    ],
  ] as const)('checks every scope for %s', (effect, scopes, message) => {
    const manifest = alteredVariant('write_policy', { mode: 'bounded-patterns', scopes });
    manifest.variants.lint.effect = effect;
    expect(validateRecipeManifest(manifest)).toContain(`variants.lint.write_policy ${message}`);
  });

  it('requires unique scope declarations', () => {
    const value = alteredVariant('write_policy', {
      mode: 'explicit-files',
      scopes: ['packages/**', 'packages/**'],
    });
    expect(validateRecipeManifest(value)).toContain(
      'variants.lint.write_policy.scopes contains duplicates',
    );
  });

  it.each([
    'push',
    'publish',
    'git.push',
    'package.publish',
    'git.push.branch',
    'package.publish.release',
  ])('refuses remote operation %s', (operation) => {
    const value = {
      ...canonical.manifest,
      variants: {
        ...canonical.manifest.variants,
        lint: {
          ...canonical.manifest.variants.lint,
          operations: [operation],
        },
      },
    };
    expect(schema(value)).toBe(false);
    expect(validateRecipeManifest(value)).toContain(
      'variants.lint.operations[0] is a forbidden remote operation',
    );
  });
});
