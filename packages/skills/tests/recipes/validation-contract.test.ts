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

describe('recipe manifest structural and effect boundaries', () => {
  it.each([
    [{ schemaVersion: '2' }, 'schemaVersion must equal "1"'],
    [{ name: 'undeclared-recipe' }, 'name is not one of the seven RC recipes'],
    [{ status: 'unknown' }, 'status must be stable or preview'],
    [{ description: ' \t ' }, 'description must be a non-empty string'],
    [{ description: 1 }, 'description must be a non-empty string'],
    [{ permissions: ['publish'] }, 'unsupported top-level field: permissions'],
    [{ variants: {} }, 'variants must be a non-empty object'],
    [{ variants: [] }, 'variants must be a non-empty object'],
    [{ variants: null }, 'variants must be a non-empty object'],
    [{ name: 'devai-round', status: 'stable' }, 'devai-round must remain preview'],
    [{ status: 'preview' }, 'devai-fix must remain stable'],
  ])('rejects invalid root fields %j', (changes, error) => {
    expect(validateRecipeManifest({ ...canonical.manifest, ...changes })).toContain(error);
  });

  it.each(['_lint', 'lint!', 'Lint'])('rejects the complete invalid variant name %s', (name) => {
    expect(
      validateRecipeManifest({
        ...canonical.manifest,
        variants: { [name]: canonical.manifest.variants.lint },
      }),
    ).toContain(`variants.${name} has an invalid name`);
  });

  it.each([null, [], 'lint'])('rejects a non-object variant %j', (variant) => {
    expect(
      validateRecipeManifest({ ...canonical.manifest, variants: { lint: variant } }),
    ).toContain('variants.lint must be an object');
  });

  it.each([
    [{ description: ' \t ' }, 'variants.lint.description must be a non-empty string'],
    [{ description: null }, 'variants.lint.description must be a non-empty string'],
    [{ permissions: ['publish'] }, 'variants.lint has unsupported field: permissions'],
    [{ effect: 'remote-write' }, 'variants.lint.effect is invalid'],
    [{ operations: [] }, 'variants.lint.operations must be a non-empty array'],
    [{ operations: 'check' }, 'variants.lint.operations must be a non-empty array'],
    [{ operations: ['check', 'check'] }, 'variants.lint.operations contains duplicates'],
    [{ write_policy: null }, 'variants.lint.write_policy must be an object'],
    [{ write_policy: { mode: 'anything' } }, 'variants.lint.write_policy.mode is invalid'],
    [
      { write_policy: { mode: 'explicit-files', scopes: [] } },
      'variants.lint.write_policy.scopes must contain at least one bounded scope',
    ],
    [
      { effect: 'local-write', write_policy: { mode: 'none' } },
      'variants.lint.write_policy.mode=none requires effect=read',
    ],
    [
      { effect: 'read', write_policy: { mode: 'none', scopes: ['src/**'] } },
      'variants.lint.write_policy.scopes is forbidden when mode=none',
    ],
    [
      { effect: 'read', write_policy: { mode: 'explicit-files', scopes: ['src/file.ts'] } },
      'variants.lint.write_policy.explicit-files is forbidden for effect=read',
    ],
  ])('rejects inconsistent variant fields %j', (changes, error) => {
    expect(
      validateRecipeManifest({
        ...canonical.manifest,
        variants: { lint: { ...canonical.manifest.variants.lint, ...changes } },
      }),
    ).toContain(error);
  });

  it.each(['_check', 'check!', 'Check', 7, true, ['check']])(
    'rejects the complete invalid operation %j',
    (operation) => {
      expect(
        validateRecipeManifest({
          ...canonical.manifest,
          variants: { lint: { ...canonical.manifest.variants.lint, operations: [operation] } },
        }),
      ).toContain('variants.lint.operations[0] is invalid');
    },
  );
});
