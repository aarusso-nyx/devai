import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRecipes } from '../../src/recipes/loader.js';

const recipes = loadRecipes();
const first = recipes[0];
if (first === undefined) throw new Error('canonical recipes missing');
const sample = first;
const source = dirname(sample.resource_dir);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function copyResources() {
  const root = mkdtempSync(join(tmpdir(), 'devai recipe headers ç '));
  roots.push(root);
  cpSync(source, root, { recursive: true });
  return root;
}
describe('recipe skill header integrity', () => {
  it.each(['CRLF', 'mixed'] as const)(
    'loads %s headers without changing recipe identities or file bytes',
    (style) => {
      const root = copyResources();
      const inputs = new Map<string, Buffer>();
      for (const recipe of recipes) {
        const path = join(root, recipe.manifest.name, 'SKILL.md');
        const original = readFileSync(path, 'utf8');
        const text = original.replace(/\r?\n/gu, (_match, offset: number) =>
          style === 'CRLF' || offset % 2 === 0 ? '\r\n' : '\n',
        );
        writeFileSync(path, text);
        inputs.set(path, Buffer.from(text));
      }
      expect(loadRecipes(root).map((recipe) => recipe.manifest)).toEqual(
        recipes.map((recipe) => recipe.manifest),
      );
      for (const [path, bytes] of inputs) expect(readFileSync(path)).toEqual(bytes);
    },
  );

  it.each([
    [
      'missing opening delimiter',
      `name: ${sample.manifest.name}\ndescription: ${sample.manifest.description}\n---\n`,
      'SKILL_HEADER_MISSING',
    ],
    [
      'missing closing delimiter',
      `---\nname: ${sample.manifest.name}\ndescription: ${sample.manifest.description}\n`,
      'SKILL_HEADER_MISSING',
    ],
    [
      'missing name',
      `---\ndescription: ${sample.manifest.description}\n---\n`,
      'SKILL_HEADER_INVALID',
    ],
    ['missing description', `---\nname: ${sample.manifest.name}\n---\n`, 'SKILL_HEADER_INVALID'],
    [
      'empty description',
      `---\nname: ${sample.manifest.name}\ndescription: \n---\n`,
      'SKILL_HEADER_INVALID',
    ],
    [
      'wrong name',
      `---\nname: other-recipe\ndescription: ${sample.manifest.description}\n---\n`,
      'RECIPE_SKILL_HEADER_MISMATCH',
    ],
    [
      'wrong description',
      `---\nname: ${sample.manifest.name}\ndescription: a different contract\n---\n`,
      'RECIPE_SKILL_HEADER_MISMATCH',
    ],
  ])('refuses %s before returning a recipe catalog', (_name, markdown, code) => {
    const root = copyResources();
    const path = join(root, sample.manifest.name, 'SKILL.md');
    writeFileSync(path, markdown);
    const before = readFileSync(path);
    expect(() => loadRecipes(root)).toThrow(code);
    expect(readFileSync(path)).toEqual(before);
  });
});
