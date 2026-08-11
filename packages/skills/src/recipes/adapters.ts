import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { mkdirSync, writeFileSync } from '@devai-nyx/authority';
import { listOperations } from '../operations/catalog.js';
import { loadRecipes } from './loader.js';
import type { LoadedRecipe } from './types.js';

export type RecipeHost = 'codex' | 'claude';

export interface RecipeAdapterFile {
  readonly host: RecipeHost;
  readonly path: string;
  readonly content: string;
}

export interface RecipeAdapterPlan {
  readonly files: readonly RecipeAdapterFile[];
}

function yamlString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function openAiMetadata(recipe: LoadedRecipe): string {
  const implicit = recipe.manifest.status === 'stable' ? 'true' : 'false';
  return [
    'interface:',
    `  display_name: ${yamlString(recipe.manifest.name)}`,
    `  short_description: ${yamlString(recipe.manifest.description)}`,
    'policy:',
    `  allow_implicit_invocation: ${implicit}`,
    '',
  ].join('\n');
}

export function buildRecipeAdapterPlan(
  resourcesRoot?: string,
  hosts: readonly RecipeHost[] = ['codex', 'claude'],
): RecipeAdapterPlan {
  const uniqueHosts = [...new Set(hosts)];
  if (
    uniqueHosts.length !== hosts.length ||
    uniqueHosts.some((host) => !['codex', 'claude'].includes(host))
  ) {
    throw new Error('INVALID_RECIPE_HOSTS');
  }
  const recipes = loadRecipes(resourcesRoot);
  const files: RecipeAdapterFile[] = [];
  for (const host of uniqueHosts) {
    const root = host === 'codex' ? '.agents/skills' : '.claude/skills';
    for (const recipe of recipes) {
      const base = `${root}/${recipe.manifest.name}`;
      const manifest = readFileSync(join(recipe.resource_dir, 'devai.recipe.json'), 'utf8');
      const referenced = new Set(
        Object.values(recipe.manifest.variants).flatMap((variant) => variant.operations),
      );
      const operations = `${JSON.stringify(
        {
          schemaVersion: '1',
          recipe: recipe.manifest.name,
          operations: listOperations().filter((operation) => referenced.has(operation.id)),
        },
        null,
        2,
      )}\n`;
      files.push(
        { host, path: `${base}/SKILL.md`, content: recipe.skill_markdown },
        { host, path: `${base}/devai.recipe.json`, content: manifest },
        { host, path: `${base}/devai.operations.json`, content: operations },
      );
      if (host === 'codex') {
        files.push({
          host,
          path: `${base}/agents/openai.yaml`,
          content: openAiMetadata(recipe),
        });
      }
    }
  }
  return { files };
}

function assertSafeInstallPath(repoRoot: string, relativePath: string): string {
  const root = resolve(repoRoot);
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`RECIPE_INSTALL_ESCAPE: ${relativePath}`);
  }
  let cursor = root;
  for (const segment of relativePath.split('/').slice(0, -1)) {
    cursor = join(cursor, segment);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`RECIPE_INSTALL_SYMLINK_REFUSED: ${relativePath}`);
    }
  }
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new Error(`RECIPE_INSTALL_SYMLINK_REFUSED: ${relativePath}`);
  }
  return target;
}

export function installRecipeAdapters(opts: {
  readonly repoRoot: string;
  readonly resourcesRoot?: string;
  readonly hosts?: readonly RecipeHost[];
}): { readonly written: readonly string[]; readonly unchanged: readonly string[] } {
  const plan = buildRecipeAdapterPlan(opts.resourcesRoot, opts.hosts);
  const resolved = plan.files.map((file) => ({
    ...file,
    absolutePath: assertSafeInstallPath(opts.repoRoot, file.path),
  }));
  const conflicts = resolved.filter(
    (file) =>
      existsSync(file.absolutePath) && readFileSync(file.absolutePath, 'utf8') !== file.content,
  );
  if (conflicts.length > 0) {
    throw new Error(`RECIPE_ADAPTER_CONFLICT: ${conflicts.map((file) => file.path).join(', ')}`);
  }
  const written: string[] = [];
  const unchanged: string[] = [];
  for (const file of resolved) {
    if (existsSync(file.absolutePath)) {
      unchanged.push(file.path);
      continue;
    }
    mkdirSync(dirname(file.absolutePath), { recursive: true });
    writeFileSync(file.absolutePath, file.content, 'utf8');
    written.push(file.path);
  }
  return { written, unchanged };
}
