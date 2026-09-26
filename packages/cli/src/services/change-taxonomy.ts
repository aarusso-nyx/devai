import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectorMatches } from './check-runner/policy.js';

/**
 * Change-class taxonomy (ADR-GOV-0017). The law policy declares the closed
 * class vocabulary; the adopter binding assigns repository paths to those
 * classes. Every path resolves to at most one class: two bindings that reach
 * one path are a load error, never a precedence rule.
 */

export const CHANGE_CLASSES = [
  'law',
  'spec',
  'plan',
  'code',
  'tests',
  'docs',
  'ci',
  'toolchain',
  'generated',
] as const;

export type ChangeClass = (typeof CHANGE_CLASSES)[number];

export interface ChangeTaxonomyBinding {
  readonly selector: Readonly<{ kind: 'exact' | 'prefix' | 'glob'; pattern: string }>;
  readonly class: ChangeClass;
}

export interface ChangeTaxonomy {
  readonly classes: readonly ChangeClass[];
  readonly bindings: readonly ChangeTaxonomyBinding[];
  /** The single class bound to path, or undefined when no binding covers it. */
  classify(path: string): ChangeClass | undefined;
}

/** Law policy path; the materialized adopter copy is the fallback. */
export const CHANGE_TAXONOMY_POLICY_PATHS = [
  'law/policy/change-taxonomy.json',
  '.devai/config/change-taxonomy.json',
] as const;

/** Adopter binding path; the law-provided default is the fallback. */
export const CHANGE_TAXONOMY_BINDING_PATHS = [
  '.devai/config/change-taxonomy-binding.json',
  'law/policy/adopter-defaults/change-taxonomy-binding.json',
] as const;

const SELECTOR_KINDS = new Set(['exact', 'prefix', 'glob']);

function record(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function readJson(repoRoot: string, candidates: readonly string[], code: string): unknown {
  const path = candidates.find((candidate) => existsSync(join(repoRoot, candidate)));
  if (path === undefined) throw new Error(`${code}: none of ${candidates.join(', ')}`);
  try {
    return JSON.parse(readFileSync(join(repoRoot, path), 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`${code}: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isChangeClass(value: unknown): value is ChangeClass {
  return typeof value === 'string' && (CHANGE_CLASSES as readonly string[]).includes(value);
}

function loadClasses(repoRoot: string): readonly ChangeClass[] {
  const policy = record(
    readJson(repoRoot, CHANGE_TAXONOMY_POLICY_PATHS, 'CHANGE_TAXONOMY_POLICY_INVALID'),
    'CHANGE_TAXONOMY_POLICY_INVALID',
  );
  if (policy['schemaVersion'] !== '1.0.0' || policy['id'] !== 'change-taxonomy') {
    throw new Error('CHANGE_TAXONOMY_POLICY_INVALID: unsupported taxonomy document');
  }
  const declared = Object.keys(record(policy['classes'], 'CHANGE_TAXONOMY_POLICY_INVALID'));
  const unknown = declared.filter((name) => !isChangeClass(name));
  const missing = CHANGE_CLASSES.filter((name) => !declared.includes(name));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `CHANGE_TAXONOMY_POLICY_INVALID: class set must equal ${CHANGE_CLASSES.join(',')}`,
    );
  }
  return CHANGE_CLASSES;
}

function label(entry: Readonly<{ selector: Readonly<{ kind: string; pattern: string }> }>): string {
  return `${entry.selector.kind}:${entry.selector.pattern}`;
}

/**
 * Load and validate the binding against the law class vocabulary. Throws
 * CHANGE_TAXONOMY_CLASS_UNKNOWN for a class outside the vocabulary and
 * CHANGE_TAXONOMY_BINDING_OVERLAP for two exact or prefix entries that reach
 * one path. Overlap through a glob is detected when a path is classified.
 */
export function loadBindings(repoRoot: string): readonly ChangeTaxonomyBinding[] {
  const classes = loadClasses(repoRoot);
  const document = record(
    readJson(repoRoot, CHANGE_TAXONOMY_BINDING_PATHS, 'CHANGE_TAXONOMY_BINDING_INVALID'),
    'CHANGE_TAXONOMY_BINDING_INVALID',
  );
  if (
    document['schemaVersion'] !== '1.0.0' ||
    document['id'] !== 'change-taxonomy-binding' ||
    !Array.isArray(document['bindings']) ||
    document['bindings'].length === 0
  ) {
    throw new Error('CHANGE_TAXONOMY_BINDING_INVALID: unsupported binding document');
  }
  const entries = document['bindings'].map((raw, index): ChangeTaxonomyBinding => {
    const entry = record(raw, `CHANGE_TAXONOMY_BINDING_INVALID: entry ${String(index)}`);
    const selector = record(
      entry['selector'],
      `CHANGE_TAXONOMY_BINDING_INVALID: entry ${String(index)}`,
    );
    const kind = selector['kind'];
    const pattern = selector['pattern'];
    if (typeof kind !== 'string' || !SELECTOR_KINDS.has(kind) || typeof pattern !== 'string') {
      throw new Error(`CHANGE_TAXONOMY_BINDING_INVALID: entry ${String(index)} selector`);
    }
    const className = entry['class'];
    if (!isChangeClass(className) || !classes.includes(className)) {
      throw new Error(`CHANGE_TAXONOMY_CLASS_UNKNOWN: ${String(className)} (${kind}:${pattern})`);
    }
    return {
      selector: { kind: kind as ChangeTaxonomyBinding['selector']['kind'], pattern },
      class: className,
    };
  });
  for (const [index, left] of entries.entries()) {
    for (const right of entries.slice(index + 1)) {
      const [l, r] = [left.selector, right.selector];
      if (l.kind === 'glob' || r.kind === 'glob') continue;
      const overlap =
        l.pattern === r.pattern ||
        (l.kind === 'prefix' && r.pattern.startsWith(l.pattern)) ||
        (r.kind === 'prefix' && l.pattern.startsWith(r.pattern));
      if (overlap) {
        throw new Error(`CHANGE_TAXONOMY_BINDING_OVERLAP: ${label(left)} ${label(right)}`);
      }
    }
  }
  return entries;
}

/** Load the taxonomy and binding under repoRoot and return a memoizing classifier. */
export function loadChangeTaxonomy(repoRoot: string): ChangeTaxonomy {
  const bindings = loadBindings(repoRoot);
  const cache = new Map<string, ChangeClass | undefined>();
  return {
    classes: CHANGE_CLASSES,
    bindings,
    classify(path: string): ChangeClass | undefined {
      if (cache.has(path)) return cache.get(path);
      const hits = bindings.filter((entry) => selectorMatches(entry.selector, path));
      if (hits.length > 1) {
        throw new Error(
          `CHANGE_TAXONOMY_BINDING_OVERLAP: ${[path, ...hits.map((entry) => label(entry))].join(' ')}`,
        );
      }
      const result = hits[0]?.class;
      cache.set(path, result);
      return result;
    },
  };
}

/** Classify one path under repoRoot. Prefer loadChangeTaxonomy for many paths. */
export function classify(repoRoot: string, path: string): ChangeClass | undefined {
  return loadChangeTaxonomy(repoRoot).classify(path);
}
