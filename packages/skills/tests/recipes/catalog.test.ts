import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { listOperations, OPERATION_IDS } from '../../src/operations/index.js';
import { loadRecipes } from '../../src/recipes/loader.js';
import { RECIPE_NAMES } from '../../src/recipes/types.js';
import { validateRecipeManifest } from '../../src/recipes/validate.js';

describe('v1 RC recipe catalog', () => {
  it('loads exactly six stable recipes and one preview round recipe', () => {
    const recipes = loadRecipes();

    expect(recipes.map((recipe) => recipe.manifest.name)).toEqual(RECIPE_NAMES);
    expect(recipes.filter((recipe) => recipe.manifest.status === 'stable')).toHaveLength(6);
    expect(recipes.filter((recipe) => recipe.manifest.status === 'preview')).toHaveLength(1);
    expect(recipes.find((recipe) => recipe.manifest.status === 'preview')?.manifest.name).toBe(
      'devai-round',
    );
  });

  it('keeps manifest operation IDs in exact bijection with the typed catalog', () => {
    const manifestIds = [
      ...new Set(
        loadRecipes().flatMap((recipe) =>
          Object.values(recipe.manifest.variants).flatMap((variant) => variant.operations),
        ),
      ),
    ].sort();
    expect(manifestIds).toEqual([...OPERATION_IDS].sort());
    expect(
      listOperations()
        .map((operation) => operation.id)
        .sort(),
    ).toEqual(manifestIds);
  });

  it('validates every canonical manifest against the self-contained recipe schema', () => {
    const recipes = loadRecipes();
    const first = recipes[0];
    if (first === undefined) throw new Error('recipe catalog is empty');
    const schema: unknown = JSON.parse(
      readFileSync(join(first.resource_dir, '..', 'recipe.schema.json'), 'utf8'),
    );
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

    for (const recipe of recipes) {
      expect(validate(recipe.manifest), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it('keeps effect and write policy on variants instead of unioning them at recipe level', () => {
    for (const recipe of loadRecipes()) {
      expect(recipe.manifest).not.toHaveProperty('effect');
      expect(recipe.manifest).not.toHaveProperty('write_policy');
      for (const variant of Object.values(recipe.manifest.variants)) {
        expect(variant.operations.join('.')).not.toMatch(/(?:^|\.)(?:publish|push)(?:\.|$)/u);
        if (variant.effect === 'read') {
          expect(variant.write_policy).toEqual({ mode: 'none' });
        } else {
          expect(variant.write_policy.mode).not.toBe('none');
        }
      }
    }
  });

  it('has host-neutral shared instructions and no provider or lifecycle metadata', () => {
    for (const recipe of loadRecipes()) {
      expect(recipe.skill_markdown).not.toMatch(/\b(?:Claude|Codex|Anthropic|OpenAI)\b/u);
      const manifestText = readFileSync(join(recipe.resource_dir, 'devai.recipe.json'), 'utf8');
      expect(manifestText).not.toMatch(
        /"(?:provider|default_family|lifecycle|migration|alias|tombstone|history)"/u,
      );
    }
  });

  it('rejects top-level permission fields and unsafe write scopes', () => {
    const base = {
      schemaVersion: '1',
      name: 'devai-fix',
      status: 'stable',
      description: 'test',
      variants: {
        lint: {
          description: 'test',
          effect: 'local-write',
          write_policy: { mode: 'explicit-files', scopes: ['../outside'] },
          operations: ['check'],
        },
      },
      write_policy: { mode: 'bounded-patterns', scopes: ['**'] },
    };

    expect(validateRecipeManifest(base)).toEqual(
      expect.arrayContaining([
        'unsupported top-level field: write_policy',
        'variants.lint.write_policy.scopes[0] is not a bounded repository-relative scope',
      ]),
    );
  });

  it('binds every docs variant to one exact output path', () => {
    const docs = loadRecipes().find((recipe) => recipe.manifest.name === 'devai-docs');
    expect(docs).toBeDefined();
    expect(Object.keys(docs?.manifest.variants ?? {})).toHaveLength(14);
    for (const variant of Object.values(docs?.manifest.variants ?? {})) {
      expect(variant.write_policy.mode).toBe('bounded-patterns');
      if (variant.write_policy.mode !== 'bounded-patterns') continue;
      expect(variant.write_policy.scopes).toHaveLength(1);
      expect(variant.write_policy.scopes[0]).toMatch(/^docs\/[^*]+\.md$/u);
    }
  });

  it('confines preview round writes to runtime state', () => {
    const round = loadRecipes().find((recipe) => recipe.manifest.name === 'devai-round');
    expect(round?.manifest.status).toBe('preview');
    for (const variant of Object.values(round?.manifest.variants ?? {})) {
      if (variant.effect === 'read') continue;
      expect(variant.effect).toBe('runtime-write');
      if (variant.write_policy.mode === 'none') throw new Error('write variant has no scopes');
      expect(variant.write_policy.scopes.every((scope) => scope.startsWith('.devai/state/'))).toBe(
        true,
      );
    }
  });
});
