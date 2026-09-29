// Record: ADR-GOV-0020 (recipe front matter converges on the Agent Skills core set).
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { buildRecipeAdapterPlan } from '../../src/recipes/adapters.js';
import { loadRecipes } from '../../src/recipes/loader.js';
import { RECIPE_NAMES } from '../../src/recipes/types.js';

const CORE_KEYS = ['name', 'description', 'license', 'compatibility', 'metadata'] as const;
const METADATA_KEYS = ['devai-status', 'devai-recipe-schema'] as const;

/** A host invocation glyph: a slash command or a Codex skill mention naming a recipe. */
const INVOCATION_GLYPH = /(?:^|[^\w./-])[/$]devai-[a-z]+/mu;

const recipes = loadRecipes();
const source = dirname(recipes[0]?.resource_dir ?? '');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function split(markdown: string): { header: string; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(markdown.replaceAll('\r\n', '\n'));
  if (match === null) throw new Error('front matter missing');
  return { header: match[1] ?? '', body: match[2] ?? '' };
}

function frontMatter(markdown: string): Record<string, unknown> {
  return parseYaml(split(markdown).header) as Record<string, unknown>;
}

function sentences(text: string): number {
  return text.split(/[.!?](?:\s+|$)/u).filter((part) => part.trim().length > 0).length;
}

describe('canonical recipe front matter', () => {
  it('loads all seven recipes from their own directories', () => {
    const directories = readdirSync(source, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(directories).toEqual([...RECIPE_NAMES].sort());
    expect(recipes).toHaveLength(7);
  });

  it.each(recipes.map((recipe) => [recipe.manifest.name, recipe] as const))(
    '%s carries exactly the Agent Skills core keys, bound to its manifest',
    (_name, recipe) => {
      const directory = recipe.resource_dir.split(/[\\/]/u).pop();
      const header = frontMatter(recipe.skill_markdown);
      expect(Object.keys(header)).toEqual([...CORE_KEYS]);
      expect(header['name']).toBe(directory);
      expect(header['name']).toBe(recipe.manifest.name);
      expect(header['name']).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
      expect(String(header['name']).length).toBeLessThanOrEqual(64);
      expect(header['description']).toBe(recipe.manifest.description);
      expect(String(header['description']).length).toBeLessThanOrEqual(1024);
      expect(header['license']).toBe('Apache-2.0');
      const compatibility = header['compatibility'];
      expect(typeof compatibility).toBe('string');
      expect(String(compatibility).length).toBeGreaterThan(0);
      expect(String(compatibility).length).toBeLessThan(500);
      expect(sentences(String(compatibility))).toBe(1);
      expect(header['metadata']).toStrictEqual({
        'devai-status': recipe.manifest.status,
        'devai-recipe-schema': recipe.manifest.schemaVersion,
      });
      expect(Object.keys(header['metadata'] as object)).toEqual([...METADATA_KEYS]);
    },
  );

  it.each(recipes.map((recipe) => [recipe.manifest.name, recipe] as const))(
    '%s writes the recipe schema as a quoted string, never a YAML number',
    (_name, recipe) => {
      expect(split(recipe.skill_markdown).header).toMatch(
        /^ {2}devai-recipe-schema: (?:'1'|"1")$/mu,
      );
    },
  );

  it.each(recipes.map((recipe) => [recipe.manifest.name, recipe] as const))(
    '%s body carries no host invocation glyph',
    (_name, recipe) => {
      expect(split(recipe.skill_markdown).body).not.toMatch(INVOCATION_GLYPH);
    },
  );
});

describe('generated host projections of the front matter (IA-004)', () => {
  it('plans both host projections of every recipe with identical bodies and core front matter', () => {
    const files = buildRecipeAdapterPlan().files;
    for (const recipe of recipes) {
      const name = recipe.manifest.name;
      const claude = files.find((file) => file.path === `.claude/skills/${name}/SKILL.md`);
      const codex = files.find((file) => file.path === `.agents/skills/${name}/SKILL.md`);
      if (claude === undefined || codex === undefined)
        throw new Error(`projection missing: ${name}`);
      expect(split(codex.content).body).toBe(split(claude.content).body);
      expect(frontMatter(codex.content)).toStrictEqual(frontMatter(claude.content));
      expect(Object.keys(frontMatter(claude.content))).toEqual([...CORE_KEYS]);
      expect(split(claude.content).body).not.toMatch(INVOCATION_GLYPH);
    }
  });
});

type Mutation = (header: string, body: string, name: string) => { header: string; body: string };

function mutateHeader(replace: (header: string, name: string) => string): Mutation {
  return (header, body, name) => ({ header: replace(header, name), body });
}

describe('recipe loader refuses front matter outside the core contract', () => {
  function copyResources(): string {
    const root = mkdtempSync(join(tmpdir(), 'devai recipe front matter '));
    roots.push(root);
    cpSync(source, root, { recursive: true });
    return root;
  }

  const target = recipes.find((recipe) => recipe.manifest.status === 'stable');
  if (target === undefined) throw new Error('stable recipe missing');
  const recipeName = target.manifest.name;

  it('accepts an unmodified copy of the canonical sources', () => {
    const root = copyResources();
    expect(loadRecipes(root).map((recipe) => recipe.manifest)).toEqual(
      recipes.map((recipe) => recipe.manifest),
    );
  });

  it.each<[string, Mutation]>([
    ['a missing license', mutateHeader((h) => h.replace(/^license: .*\n/mu, ''))],
    [
      'a license other than Apache-2.0',
      mutateHeader((h) => h.replace('license: Apache-2.0', 'license: MIT')),
    ],
    ['a missing compatibility', mutateHeader((h) => h.replace(/^compatibility: .*\n/mu, ''))],
    [
      'an empty compatibility',
      mutateHeader((h) => h.replace(/^compatibility: .*$/mu, 'compatibility: ""')),
    ],
    [
      'a compatibility of 500 characters or more',
      mutateHeader((h) =>
        h.replace(/^compatibility: .*$/mu, `compatibility: Needs ${'a'.repeat(500)} package.`),
      ),
    ],
    [
      'a compatibility of more than one sentence',
      mutateHeader((h) =>
        h.replace(/^(compatibility: .*)$/mu, '$1 It also needs a network connection.'),
      ),
    ],
    [
      'a missing metadata map',
      mutateHeader((h) =>
        h.replace(/^metadata:\n {2}devai-status: .*\n {2}devai-recipe-schema: .*$/mu, '').trimEnd(),
      ),
    ],
    [
      'a devai-status that differs from the manifest',
      mutateHeader((h) => h.replace('devai-status: stable', 'devai-status: preview')),
    ],
    ['a missing devai-status', mutateHeader((h) => h.replace(/^ {2}devai-status: .*\n/mu, ''))],
    [
      'a devai-recipe-schema that differs from the manifest',
      mutateHeader((h) => h.replace("devai-recipe-schema: '1'", "devai-recipe-schema: '2'")),
    ],
    [
      'an unquoted devai-recipe-schema',
      mutateHeader((h) => h.replace("devai-recipe-schema: '1'", 'devai-recipe-schema: 1')),
    ],
    ['an extra metadata key', mutateHeader((h) => `${h}\n  devai-extra: value`)],
    ['an extra top-level key', mutateHeader((h) => `${h}\nallowed-tools: Bash`)],
    [
      'a name that differs from its directory and manifest',
      mutateHeader((h, name) => h.replace(`name: ${name}`, 'name: devai-other')),
    ],
    [
      'a slash-command glyph in the body',
      (header, body) => ({ header, body: `${body}\nThen run /devai-verify on the result.\n` }),
    ],
    [
      'a skill-mention glyph in the body',
      (header, body) => ({ header, body: `${body}\nThen ask $devai-verify to review it.\n` }),
    ],
    [
      'a glyph opening a body line',
      (header, body) => ({ header, body: `${body}\n/devai-plan first.\n` }),
    ],
  ])('refuses %s without touching the source bytes', (_case, mutate) => {
    const root = copyResources();
    const path = join(root, recipeName, 'SKILL.md');
    const { header, body } = split(readFileSync(path, 'utf8'));
    const next = mutate(header, body, recipeName);
    expect(`${next.header}${next.body}`).not.toBe(`${header}${body}`);
    writeFileSync(path, `---\n${next.header}\n---\n${next.body}`);
    const before = readFileSync(path);

    expect(() => loadRecipes(root)).toThrow(/^[A-Z][A-Z0-9_]+/u);
    expect(readFileSync(path)).toEqual(before);
  });

  it('accepts plain recipe names and the runtime-state path in a body', () => {
    const root = copyResources();
    const path = join(root, recipeName, 'SKILL.md');
    writeFileSync(
      path,
      `${readFileSync(path, 'utf8')}\nHand off to devai-verify; records live under .devai/state/round-runs/**.\n`,
    );
    expect(() => loadRecipes(root)).not.toThrow();
  });
});
