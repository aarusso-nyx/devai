/**
 * The write-scope judgement of a governed task diff: Constitution Article 6 binds every changed
 * path to its role through the static path table, and under constitution 1.1.0 the Engineer also
 * holds the focused-regression verb on the test class (Article 7, ADR-GOV-0026). That verb is
 * enforced here, at diff time, by adjacency: a test file the task adds, or changes without
 * touching an existing assertion, is admitted when it imports a source the same task changed.
 * Deleting a test, editing an assertion of a test the task did not add, and any non-test file of
 * the test class (thresholds, helpers, fixtures) stay Inspector verbs. The action registry is not
 * involved (Owner ruling (a) on #412).
 */
import {
  ENGINEER_ROOT_WORKSPACE_FILES,
  ENGINEER_TEST_CLASS_VERB,
  INSPECTOR_TEST_DIRECTORY_SEGMENT,
  STATIC_AUTHORITY_PREFIXES,
  TEST_FILE_PATTERN,
  existsSync,
  lstatSync,
  readFileSync,
} from '@devai-nyx/authority';
import type { TaskRecord } from '@devai-nyx/loop';
import { changedAssertions, changedTestRegistrations } from '@devai-nyx/sensors';
import { parseConstitutionVersion } from '@devai-nyx/skills';
import { join, sep } from 'node:path';
import { gte, valid } from 'semver';
import { importedRepositoryFiles, workspacePackages } from './import-adjacency.js';

/** The Article 6 role that owns a repository-relative path, or undefined when none may. */
export function article6Role(path: string): string | undefined {
  const normalized = path.split(sep).join('/');
  const segments = normalized.split('/');
  if (segments.length === 1) {
    return (ENGINEER_ROOT_WORKSPACE_FILES as readonly string[]).includes(normalized)
      ? 'engineer'
      : undefined;
  }
  if (segments[0] === 'packages' && segments[2] === INSPECTOR_TEST_DIRECTORY_SEGMENT) {
    return 'inspector';
  }
  const match = [...STATIC_AUTHORITY_PREFIXES]
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find((entry) => normalized.startsWith(entry.prefix));
  const authority = match?.authority as readonly string[] | undefined;
  return authority?.length === 1 ? authority[0] : undefined;
}

/**
 * Whether the task holds the focused-regression verb: it is an Engineer task, it is not
 * designated independent-assurance (ADR-GOV-0026 decision 3), and the repository's pinned
 * constitution grants the verb. A missing or unreadable pin withholds it.
 */
export function focusedRegressionAvailable(repoRoot: string, task: TaskRecord): boolean {
  if (task.discipline !== ENGINEER_TEST_CLASS_VERB.role) return false;
  if (task.independent_assurance === true) return false;
  const pin = join(repoRoot, '.devai/pin/constitution.md');
  if (!existsSync(pin)) return false;
  const version = parseConstitutionVersion(readFileSync(pin, 'utf8'));
  return (
    version !== null &&
    valid(version) !== null &&
    gte(version, ENGINEER_TEST_CLASS_VERB.min_constitution)
  );
}

/**
 * Whether a changed path lies inside the task's declared boundary (`intent_diff.planned_files`,
 * the campaign `boundary.paths`; ADR-MDL-0009): an exact path, or a path under an entry that
 * ends with `/`. A task that declares no boundary is bounded by its Article 6 role alone.
 */
export function withinDeclaredBoundary(path: string, boundary: readonly string[]): boolean {
  const normalized = path.split(sep).join('/');
  return boundary.some((entry) =>
    entry.endsWith('/') ? normalized.startsWith(entry) : normalized === entry,
  );
}

/** The task's declared boundary; empty when it declares none. */
export function declaredBoundary(task: TaskRecord): readonly string[] {
  const planned = (task as { readonly intent_diff?: { readonly planned_files?: unknown } })
    .intent_diff?.planned_files;
  return Array.isArray(planned) ? (planned as string[]) : [];
}

export type WriteChangeKind = 'added' | 'modified' | 'deleted';

export interface WriteChange {
  readonly path: string;
  readonly kind: WriteChangeKind;
}

export interface WriteScopeInput {
  readonly discipline: string;
  readonly changes: readonly WriteChange[];
  /** Whether the task holds the focused-regression verb (`focusedRegressionAvailable`). */
  readonly focusedRegression: boolean;
  /** The task's head tree on disk, where changed files and workspace manifests are read. */
  readonly headRoot: string;
  /** The task-base content of a path, or undefined when it cannot be read. */
  readonly readBase: (path: string) => string | undefined;
}

export interface WriteScopeVerdict {
  /** Changed paths the task's role may not write, sorted. */
  readonly outOfScope: readonly string[];
  /** The same paths for evidence, each refused test-class write naming why. */
  readonly violations: readonly string[];
}

/** Every changed path outside the task's write scope, and why. */
export function judgeWriteScope(input: WriteScopeInput): WriteScopeVerdict {
  const changes = input.changes.map((change) => ({
    ...change,
    path: change.path.split(sep).join('/'),
  }));
  const sources = new Set(
    changes
      .filter((change) => change.kind !== 'deleted' && article6Role(change.path) === 'engineer')
      .map((change) => change.path),
  );
  let workspaces: ReturnType<typeof workspacePackages> | undefined;
  const focusedRefusal = (change: WriteChange): string | undefined => {
    if (change.kind === 'deleted') return 'deletes a test';
    if (!TEST_FILE_PATTERN.test(change.path)) return 'is not a test file';
    // A link is not a test the task authored, and reading through it could leave the tree.
    if (!lstatSync(join(input.headRoot, change.path)).isFile()) return 'is not a regular file';
    const head = readFileSync(join(input.headRoot, change.path), 'utf8');
    workspaces ??= workspacePackages(input.headRoot);
    const imports = importedRepositoryFiles(input.headRoot, change.path, head, workspaces);
    if (![...imports].some((target) => sources.has(target))) {
      return 'imports no source this task changed';
    }
    if (change.kind === 'modified') {
      const base = input.readBase(change.path);
      if (base === undefined) return 'its task-base content is unreadable';
      if (changedAssertions(base, head).length > 0) {
        return 'changes an assertion of a test this task did not add';
      }
      if (changedTestRegistrations(base, head).length > 0) {
        return 'removes, renames or re-marks a test this task did not add';
      }
    }
    return undefined;
  };
  const refused: { readonly path: string; readonly violation: string }[] = [];
  for (const change of changes) {
    const role = article6Role(change.path);
    if (role === input.discipline) continue;
    const verb =
      input.focusedRegression &&
      input.discipline === ENGINEER_TEST_CLASS_VERB.role &&
      role === 'inspector';
    if (!verb) {
      refused.push({ path: change.path, violation: change.path });
      continue;
    }
    const reason = focusedRefusal(change);
    if (reason !== undefined) {
      refused.push({
        path: change.path,
        violation: `${change.path} (${ENGINEER_TEST_CLASS_VERB.verb}: ${reason})`,
      });
    }
  }
  refused.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    outOfScope: refused.map(({ path }) => path),
    violations: refused.map(({ violation }) => violation),
  };
}
