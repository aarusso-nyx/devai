import { createHash } from 'node:crypto';
import { fstatSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import {
  PUBLISH_INDETERMINATE,
  closeReadOnlySync,
  mkdirSync,
  openReadOnlyNoFollowSync,
  publishFileNoReplaceSync,
  rmSync,
  unlinkSync,
} from '@devai-nyx/authority';
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

export interface ResolvedRecipeAdapterFile extends RecipeAdapterFile {
  readonly absolutePath: string;
  /** The resolved repository root the target is contained in. */
  readonly repoRoot: string;
  /** Preflight observation: the target's sha256 when it existed, or null when absent. */
  readonly observedSha256: string | null;
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

function containedTarget(root: string, relativePath: string): string {
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`RECIPE_INSTALL_ESCAPE: ${relativePath}`);
  }
  return target;
}

/** Ancestors of a contained target strictly below the repository root, outermost first. */
function installAncestors(root: string, target: string): readonly string[] {
  const ancestors: string[] = [];
  for (
    let cursor = dirname(target);
    cursor !== root && cursor !== dirname(cursor);
    cursor = dirname(cursor)
  ) {
    ancestors.unshift(cursor);
  }
  return ancestors;
}

/**
 * Refuses when an existing ancestor of the target, or the target itself, is a symbolic
 * link (dangling or not), or when an existing ancestor is not a directory. It uses lstat
 * only, so it never follows a link.
 */
function assertNoLinkedInstallPath(root: string, relativePath: string): string {
  const target = containedTarget(root, relativePath);
  for (const ancestor of installAncestors(root, target)) {
    const stat = lstatSync(ancestor, { throwIfNoEntry: false });
    if (stat === undefined) break;
    if (stat.isSymbolicLink()) throw new Error(`RECIPE_INSTALL_SYMLINK_REFUSED: ${relativePath}`);
    if (!stat.isDirectory()) throw new Error(`RECIPE_ADAPTER_CONFLICT: ${relativePath}`);
  }
  if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`RECIPE_INSTALL_SYMLINK_REFUSED: ${relativePath}`);
  }
  return target;
}

function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

type TargetObservation =
  | { readonly kind: 'absent' }
  | { readonly kind: 'file'; readonly sha256: string }
  | { readonly kind: 'link' }
  | { readonly kind: 'other' };

/**
 * Observes one target without following a link: lstat first, then a read through a
 * descriptor opened with O_NOFOLLOW whose fstat must still be a regular file. A target
 * that becomes a link between the two calls fails the open and is never read through.
 */
function observeTarget(path: string): TargetObservation {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return { kind: 'absent' };
  if (stat.isSymbolicLink()) return { kind: 'link' };
  if (!stat.isFile()) return { kind: 'other' };
  let descriptor: number;
  try {
    descriptor = openReadOnlyNoFollowSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'absent' };
    if (code === 'ELOOP' || code === 'EMLINK') return { kind: 'link' };
    throw error;
  }
  try {
    if (!fstatSync(descriptor).isFile()) return { kind: 'other' };
    return { kind: 'file', sha256: sha256(readFileSync(descriptor)) };
  } finally {
    closeReadOnlySync(descriptor);
  }
}

export function installRecipeAdapters(opts: {
  readonly repoRoot: string;
  readonly resourcesRoot?: string;
  readonly hosts?: readonly RecipeHost[];
}): { readonly written: readonly string[]; readonly unchanged: readonly string[] } {
  const plan = buildRecipeAdapterPlan(opts.resourcesRoot, opts.hosts);
  const resolved = preflightRecipeAdapterInstall(opts.repoRoot, plan);
  return executeRecipeAdapterPlan(resolved);
}

/**
 * Checks every target before the first write and records what it observed: a target is
 * either absent or a regular file that already holds the generated bytes. A symbolic link
 * anywhere on an installation path refuses the whole installation, and so does any target
 * with other bytes or of another kind.
 */
export function preflightRecipeAdapterInstall(
  repoRoot: string,
  plan: RecipeAdapterPlan,
): readonly ResolvedRecipeAdapterFile[] {
  const root = resolve(repoRoot);
  const checked = plan.files.map((file) => ({
    file,
    absolutePath: assertNoLinkedInstallPath(root, file.path),
  }));
  const conflicts: string[] = [];
  const resolved = checked.map(({ file, absolutePath }): ResolvedRecipeAdapterFile => {
    const observation = observeTarget(absolutePath);
    if (observation.kind === 'link') {
      throw new Error(`RECIPE_INSTALL_SYMLINK_REFUSED: ${file.path}`);
    }
    if (
      observation.kind === 'other' ||
      (observation.kind === 'file' && observation.sha256 !== sha256(file.content))
    ) {
      conflicts.push(file.path);
    }
    return {
      ...file,
      absolutePath,
      repoRoot: root,
      observedSha256: observation.kind === 'file' ? observation.sha256 : null,
    };
  });
  if (conflicts.length > 0) {
    throw new Error(`RECIPE_ADAPTER_CONFLICT: ${conflicts.join(', ')}`);
  }
  return resolved;
}

/** Test seam (fault injection): runs before each publication, after its write-time recheck. */
export interface RecipeAdapterExecuteHooks {
  readonly beforePublish?: (file: ResolvedRecipeAdapterFile, index: number) => void;
}

/**
 * Write-time recheck of one target against its preflight observation, without following
 * a link: every ancestor and the target are lstat-checked, and the target must still be
 * absent, or still a regular file with the observed digest.
 */
function recheckTarget(file: ResolvedRecipeAdapterFile): void {
  assertNoLinkedInstallPath(file.repoRoot, file.path);
  const observation = observeTarget(file.absolutePath);
  if (observation.kind === 'link') {
    throw new Error(`RECIPE_INSTALL_SYMLINK_REFUSED: ${file.path}`);
  }
  const drifted =
    file.observedSha256 === null
      ? observation.kind !== 'absent'
      : observation.kind !== 'file' || observation.sha256 !== file.observedSha256;
  if (drifted) throw new Error(`RECIPE_ADAPTER_DRIFT: ${file.path}`);
}

interface InstallJournal {
  readonly directories: string[];
  readonly files: { readonly path: string; readonly ino: number; readonly dev: number }[];
}

/** Creates each missing ancestor one level at a time, checking each level without following links. */
function createAncestors(file: ResolvedRecipeAdapterFile, journal: InstallJournal): void {
  for (const ancestor of installAncestors(file.repoRoot, file.absolutePath)) {
    const stat = lstatSync(ancestor, { throwIfNoEntry: false });
    if (stat === undefined) {
      // Non-recursive: EEXIST refuses an entry that appeared after the lstat.
      mkdirSync(ancestor);
      journal.directories.push(ancestor);
      continue;
    }
    if (stat.isSymbolicLink()) throw new Error(`RECIPE_INSTALL_SYMLINK_REFUSED: ${file.path}`);
    if (!stat.isDirectory()) throw new Error(`RECIPE_ADAPTER_DRIFT: ${file.path}`);
  }
}

function journalPublished(journal: InstallJournal, path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat?.isFile() === true) journal.files.push({ path, ino: stat.ino, dev: stat.dev });
}

/**
 * Removes what this installation created, newest first: a published file only while it is
 * still the inode this call linked, and a created directory only while it is empty. The
 * prior set (absent targets and files that already held the generated bytes) is untouched.
 */
function rollBack(journal: InstallJournal): void {
  for (const file of journal.files.toReversed()) {
    const stat = lstatSync(file.path, { throwIfNoEntry: false });
    if (stat?.isFile() === true && stat.ino === file.ino && stat.dev === file.dev) {
      unlinkSync(file.path);
    }
  }
  for (const directory of journal.directories.toReversed()) {
    const stat = lstatSync(directory, { throwIfNoEntry: false });
    if (stat?.isDirectory() === true && readdirSync(directory).length === 0) {
      rmSync(directory, { recursive: true });
    }
  }
}

/**
 * Installs a preflighted plan as one unit (#313).
 *
 * 1. Every target is rechecked against its preflight observation without following a link,
 *    so drift or a link inserted after preflight refuses before the first write.
 * 2. Each absent target is published with the ADR-AUT-0005 no-replace publication (staged,
 *    fsynced, linked into place, never replacing an entry that appeared meanwhile), right
 *    after its ancestors are created one level at a time and the target is rechecked again.
 *    A target that already held the generated bytes is rechecked and left unchanged.
 * 3. Any failure removes every file and directory this call created, newest first, so the
 *    call leaves either the prior set or the complete new set, never a mix.
 */
export function executeRecipeAdapterPlan(
  resolved: readonly ResolvedRecipeAdapterFile[],
  hooks: RecipeAdapterExecuteHooks = {},
): {
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
} {
  for (const file of resolved) recheckTarget(file);
  const written: string[] = [];
  const unchanged: string[] = [];
  const journal: InstallJournal = { directories: [], files: [] };
  try {
    for (const [index, file] of resolved.entries()) {
      if (file.observedSha256 !== null) {
        recheckTarget(file);
        unchanged.push(file.path);
        continue;
      }
      createAncestors(file, journal);
      recheckTarget(file);
      hooks.beforePublish?.(file, index);
      try {
        publishFileNoReplaceSync(file.absolutePath, file.content);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code === 'EEXIST') {
          throw new Error(`RECIPE_ADAPTER_DRIFT: ${file.path}`, { cause: error });
        }
        // An indeterminate publication linked the bytes into place: the journal owns them.
        if (code === PUBLISH_INDETERMINATE) journalPublished(journal, file.absolutePath);
        throw error;
      }
      journalPublished(journal, file.absolutePath);
      written.push(file.path);
    }
  } catch (error) {
    rollBack(journal);
    throw error;
  }
  return { written, unchanged };
}
