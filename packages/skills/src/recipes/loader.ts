import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRecipeManifest } from './validate.js';
import { RECIPE_NAMES, type LoadedRecipe } from './types.js';

const DEFAULT_RESOURCES_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../resources/recipes',
);

/** The Agent Skills core front-matter keys every recipe carries (ADR-GOV-0020). */
const CORE_KEYS = ['name', 'description', 'license', 'compatibility', 'metadata'] as const;
const METADATA_KEYS = ['devai-status', 'devai-recipe-schema'] as const;
const RECIPE_LICENSE = 'Apache-2.0';
const COMPATIBILITY_LIMIT = 500;

/** A host invocation glyph: a slash command or a Codex skill mention naming a recipe. */
const INVOCATION_GLYPH = /(?:^|[^\w./-])[/$]devai-[a-z]+/mu;

interface SkillHeader {
  /** Top-level scalar values in file order; a map key holds the empty string. */
  readonly fields: ReadonlyMap<string, string>;
  /** Children of the one two-space-indented map, `metadata`, in file order. */
  readonly metadata: ReadonlyMap<string, string> | undefined;
  /** True when a line is neither a `key: value` line nor a two-space map child. */
  readonly malformed: boolean;
  readonly body: string;
}

/**
 * A line-oriented reader for the recipe front matter, deliberately narrower
 * than YAML: top-level `key: value` lines plus one map whose children are
 * indented by exactly two spaces. Anything else is left for the contract check
 * to refuse.
 */
function parseSkillHeader(markdown: string): SkillHeader {
  const normalized = markdown.replaceAll('\r\n', '\n');
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(normalized);
  if (match === null) throw new Error('SKILL_HEADER_MISSING');
  const fields = new Map<string, string>();
  const maps = new Map<string, Map<string, string>>();
  let openMap: Map<string, string> | undefined;
  let malformed = false;
  for (const line of (match[1] ?? '').split('\n')) {
    if (line.trim().length === 0) continue;
    const indented = line.startsWith('  ');
    const text = indented ? line.slice(2) : line;
    const separator = text.indexOf(':');
    if (separator < 1 || /^\s/u.test(text)) {
      malformed = true;
      continue;
    }
    const key = text.slice(0, separator).trim();
    const value = text.slice(separator + 1).trim();
    if (indented) {
      if (openMap === undefined || openMap.has(key)) malformed = true;
      else openMap.set(key, value);
      continue;
    }
    if (fields.has(key)) malformed = true;
    fields.set(key, value);
    openMap = undefined;
    if (value.length === 0) {
      openMap = new Map<string, string>();
      maps.set(key, openMap);
    }
  }
  const name = fields.get('name');
  const description = fields.get('description');
  if (name === undefined || description === undefined || description.length === 0) {
    throw new Error('SKILL_HEADER_INVALID');
  }
  return {
    fields,
    metadata: maps.get('metadata'),
    malformed,
    body: normalized.slice(match[0].length),
  };
}

/** The value of a plain or quoted YAML scalar, or undefined for an unterminated quote. */
function scalar(raw: string): string | undefined {
  const quote = raw[0];
  if (quote !== "'" && quote !== '"') return raw;
  if (raw.length < 2 || !raw.endsWith(quote)) return undefined;
  const inner = raw.slice(1, -1);
  return quote === "'" ? inner.replaceAll("''", "'") : inner.replaceAll('\\"', '"');
}

function isQuoted(raw: string): boolean {
  return /^(?:'[^']*'|"[^"]*")$/u.test(raw);
}

function sentenceCount(text: string): number {
  return text.split(/[.!?](?:\s+|$)/u).filter((part) => part.trim().length > 0).length;
}

/**
 * Refuses front matter outside the Agent Skills core set: exactly the five core
 * keys, the Apache-2.0 license, a one-sentence compatibility under 500
 * characters, and a metadata map bound to the manifest's status and schema.
 */
function assertCoreFrontMatter(
  directory: string,
  header: SkillHeader,
  manifest: { readonly status: string; readonly schemaVersion: string },
): void {
  const problems: string[] = header.malformed ? ['a line outside the core key layout'] : [];
  const keys = [...header.fields.keys()];
  const unexpected = keys.filter((key) => !(CORE_KEYS as readonly string[]).includes(key));
  const missing = CORE_KEYS.filter((key) => !header.fields.has(key));
  if (unexpected.length > 0) problems.push(`unexpected keys ${unexpected.join(', ')}`);
  if (missing.length > 0) problems.push(`missing keys ${missing.join(', ')}`);
  const license = scalar(header.fields.get('license') ?? '');
  if (header.fields.has('license') && license !== RECIPE_LICENSE) {
    problems.push(`license must be ${RECIPE_LICENSE}`);
  }
  const compatibility = scalar(header.fields.get('compatibility') ?? '');
  if (
    header.fields.has('compatibility') &&
    (compatibility === undefined ||
      compatibility.length === 0 ||
      compatibility.length >= COMPATIBILITY_LIMIT ||
      sentenceCount(compatibility) !== 1)
  ) {
    problems.push(
      `compatibility must be one non-empty sentence under ${String(COMPATIBILITY_LIMIT)} characters`,
    );
  }
  const metadata = header.metadata;
  if (header.fields.has('metadata')) {
    const metadataKeys = [...(metadata?.keys() ?? [])];
    if (
      metadataKeys.length !== METADATA_KEYS.length ||
      METADATA_KEYS.some((key) => !metadataKeys.includes(key))
    ) {
      problems.push(`metadata must hold exactly ${METADATA_KEYS.join(', ')}`);
    } else {
      if (scalar(metadata?.get('devai-status') ?? '') !== manifest.status) {
        problems.push('metadata devai-status must equal the manifest status');
      }
      const schema = metadata?.get('devai-recipe-schema') ?? '';
      if (!isQuoted(schema) || scalar(schema) !== manifest.schemaVersion) {
        problems.push('metadata devai-recipe-schema must be the quoted manifest schemaVersion');
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`RECIPE_SKILL_FRONT_MATTER_INVALID: ${directory}: ${problems.join('; ')}`);
  }
  if (INVOCATION_GLYPH.test(header.body)) {
    throw new Error(
      `RECIPE_SKILL_INVOCATION_GLYPH: ${directory}: a recipe body names recipes without a host invocation glyph`,
    );
  }
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
    // Identity first, so a renamed or re-described recipe reports the mismatch
    // rather than a front-matter shape problem.
    if (
      header.fields.get('name') !== name ||
      header.fields.get('name') !== manifestRaw.name ||
      header.fields.get('description') !== manifestRaw.description
    ) {
      throw new Error(`RECIPE_SKILL_HEADER_MISMATCH: ${name}`);
    }
    assertCoreFrontMatter(name, header, manifestRaw);
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
