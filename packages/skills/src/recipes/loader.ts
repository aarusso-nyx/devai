import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRecipeManifest } from './validate.js';
import { RECIPE_NAMES, type LoadedRecipe } from './types.js';

const DEFAULT_RESOURCES_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../resources/recipes',
);

function parseSkillHeader(markdown: string): { name: string; description: string } {
  const normalized = markdown.replaceAll('\r\n', '\n');
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(normalized);
  if (match === null) throw new Error('SKILL_HEADER_MISSING');
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? '').split('\n')) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const name = fields.get('name');
  const description = fields.get('description');
  if (name === undefined || description === undefined || description.length === 0) {
    throw new Error('SKILL_HEADER_INVALID');
  }
  return { name, description };
}

export function loadRecipes(resourcesRoot = DEFAULT_RESOURCES_ROOT): readonly LoadedRecipe[] {
  const directories = readdirSync(resourcesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const expected = [...RECIPE_NAMES].sort();
  if (JSON.stringify(directories) !== JSON.stringify(expected)) {
    throw new Error(
      `RECIPE_POPULATION_MISMATCH: expected ${expected.join(', ')}, got ${directories.join(', ')}`,
    );
  }
  return RECIPE_NAMES.map((name) => {
    const resourceDir = join(resourcesRoot, name);
    const manifestRaw: unknown = JSON.parse(
      readFileSync(join(resourceDir, 'devai.recipe.json'), 'utf8'),
    );
    assertRecipeManifest(manifestRaw);
    const skillMarkdown = readFileSync(join(resourceDir, 'SKILL.md'), 'utf8');
    const header = parseSkillHeader(skillMarkdown);
    if (header.name !== manifestRaw.name || header.description !== manifestRaw.description) {
      throw new Error(`RECIPE_SKILL_HEADER_MISMATCH: ${name}`);
    }
    return {
      manifest: manifestRaw,
      skill_markdown: skillMarkdown,
      resource_dir: resourceDir,
    };
  });
}

export function loadRecipe(
  name: (typeof RECIPE_NAMES)[number],
  resourcesRoot = DEFAULT_RESOURCES_ROOT,
): LoadedRecipe {
  const recipe = loadRecipes(resourcesRoot).find((candidate) => candidate.manifest.name === name);
  if (recipe === undefined) throw new Error(`RECIPE_UNKNOWN:${name}`);
  return recipe;
}
