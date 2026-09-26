#!/usr/bin/env node

// Commit grammar and single-family rule (ADR-GOV-0018). Run as
// `check-commit-range.mjs <base> <head>`, it walks the first-parent commits in
// base..head after `historical_cutoff` and exits 1 naming every commit whose
// subject breaks the grammar, whose paths span more than one class family, or
// whose type does not allow the classes of its paths. Merge commits are exempt;
// a revert inherits the type of the commit it reverts.
//
// The module also exports the helpers the commit hooks share. Classification
// reads law/policy/change-taxonomy.json and the materialized binding directly,
// mirroring scripts/classify-paths.mjs, so no built package is needed. A
// repository without law/policy/commit-grammar.json has not adopted the grammar
// and every check here is skipped with a notice.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GRAMMAR_PATH = 'law/policy/commit-grammar.json';
const TAXONOMY_PATHS = ['law/policy/change-taxonomy.json', '.devai/config/change-taxonomy.json'];
const BINDING_PATHS = [
  '.devai/config/change-taxonomy-binding.json',
  'law/policy/adopter-defaults/change-taxonomy-binding.json',
];

export function gitIn(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export function repositoryRoot(cwd = process.cwd()) {
  return gitIn(cwd, ['rev-parse', '--show-toplevel']).trim();
}

function readJsonIfPresent(root, candidates) {
  const path = candidates.find((candidate) => existsSync(join(root, candidate)));
  return path === undefined ? null : JSON.parse(readFileSync(join(root, path), 'utf8'));
}

export function loadGrammar(root) {
  return readJsonIfPresent(root, [GRAMMAR_PATH]);
}

// Mirrors globExpression in packages/cli/src/services/check-runner/policy.ts.
function globExpression(pattern) {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern.charAt(index);
    if (character === '*' && pattern[index + 1] === '*') {
      const slash = pattern[index + 2] === '/';
      expression += slash ? '(?:.*/)?' : '.*';
      index += slash ? 2 : 1;
    } else if (character === '*') expression += '[^/]*';
    else if (character === '?') expression += '[^/]';
    else expression += character.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
  }
  return new RegExp(`${expression}$`, 'u');
}
const selectorMatches = ({ kind, pattern }, path) =>
  kind === 'exact'
    ? path === pattern
    : kind === 'prefix'
      ? path.startsWith(pattern)
      : globExpression(pattern).test(path);

/** Returns null when the repository carries no taxonomy or binding. */
export function loadTaxonomy(root) {
  const binding = readJsonIfPresent(root, BINDING_PATHS);
  if (binding === null) return null;
  const taxonomy = readJsonIfPresent(root, [binding.taxonomy, ...TAXONOMY_PATHS].filter(Boolean));
  if (taxonomy === null) return null;
  for (const entry of binding.bindings) {
    if (!Object.hasOwn(taxonomy.classes, entry.class)) {
      throw new Error(`DEVAI_CHANGE_TAXONOMY_CLASS_UNKNOWN:${entry.class}`);
    }
  }
  return { taxonomy, bindings: binding.bindings };
}

/**
 * Classifies paths and judges the family rule. Returns every class found with
 * its family and paths, the unclassified paths, and whether the set is mixed.
 * A set spanning families is permitted only when its classes fall inside one
 * pairing the taxonomy lists.
 */
export function classifyPaths({ taxonomy, bindings }, paths) {
  const byClass = new Map();
  const unclassified = [];
  for (const path of paths) {
    const hits = bindings.filter((entry) => selectorMatches(entry.selector, path));
    if (hits.length > 1) throw new Error(`DEVAI_CHANGE_TAXONOMY_OVERLAP:${path}`);
    if (hits.length === 0) {
      unclassified.push(path);
      continue;
    }
    const changeClass = hits[0].class;
    if (!byClass.has(changeClass)) byClass.set(changeClass, []);
    byClass.get(changeClass).push(path);
  }
  const classes = [...byClass.keys()].sort();
  const familyOf = (changeClass) => taxonomy.classes[changeClass].family;
  const families = [...new Set(classes.map(familyOf))].sort();
  const paired = (taxonomy.pairings ?? []).some((pairing) =>
    classes.every((changeClass) => pairing.classes.includes(changeClass)),
  );
  return {
    classes: classes.map((name) => ({ name, family: familyOf(name), paths: byClass.get(name) })),
    families,
    unclassified,
    mixed: families.length > 1 && !paired,
  };
}

/** First subject line of a commit message, ignoring git comment lines. */
export function subjectOf(message) {
  return (
    message
      .split('\n')
      .map((line) => line.trimEnd())
      .find((line) => line !== '' && !line.startsWith('#')) ?? ''
  );
}

/** Parses a subject against the grammar; null when it does not match. */
export function parseSubject(grammar, subject) {
  if (!new RegExp(grammar.subject_pattern, 'u').test(subject)) return null;
  const match = /^([a-z]+)(?:\(([^)]*)\))?(!)?: /u.exec(subject);
  if (match === null || !Object.hasOwn(grammar.types, match[1])) return null;
  return { type: match[1], scope: match[2] ?? null, breaking: match[3] === '!' };
}

export function allowedTypesLine(grammar) {
  return `allowed types: ${Object.keys(grammar.types).join(', ')}; form: type(scope)!: subject`;
}

/** Findings for one commit: grammar, family rule, and type-versus-class rule. */
export function judgeCommit({ grammar, classification, subject, typeSubject = subject }) {
  const findings = [];
  const parsed = parseSubject(grammar, typeSubject);
  if (parsed === null) {
    findings.push(`subject does not match the commit grammar: "${typeSubject}"`);
  }
  if (classification?.mixed) {
    findings.push(`paths span ${String(classification.families.length)} families`);
  }
  if (parsed !== null && classification !== null) {
    const allowed = grammar.types[parsed.type].allowed_classes;
    const refused = classification.classes.filter(({ name }) => !allowed.includes(name));
    if (refused.length > 0) {
      findings.push(
        `type ${parsed.type} does not allow class ${refused.map(({ name }) => name).join(', ')}` +
          ` (${parsed.type} allows ${allowed.join(', ')})`,
      );
    }
  }
  return findings.length === 0 ? findings : [...findings, ...describeClasses(classification)];
}

export function describeClasses(classification) {
  if (classification === null) return [];
  const lines = classification.classes.map(
    ({ name, family, paths }) => `  class ${name} (${family}): ${paths.join(' ')}`,
  );
  if (classification.unclassified.length > 0) {
    lines.push(`  unclassified: ${classification.unclassified.join(' ')}`);
  }
  return lines;
}

/** A suggested `git add -p` split, one commit per family. */
export function suggestSplit(classification) {
  const lines = ['suggested split: commit one family at a time', '  git restore --staged -- .'];
  for (const family of classification.families) {
    const paths = classification.classes
      .filter((entry) => entry.family === family)
      .flatMap((entry) => entry.paths);
    lines.push(`  git add -p -- ${paths.join(' ')}   # ${family}, then git commit`);
  }
  return lines;
}

function commitPaths(root, sha) {
  return gitIn(root, ['diff-tree', '--root', '--no-commit-id', '-r', '--name-only', '-z', sha])
    .split('\0')
    .filter(Boolean);
}

/** Maximum bump floor over the commits in base..head, merges excluded. */
export function bumpFloorOverRange(root, grammar, base, head) {
  const rank = { none: 0, patch: 1, minor: 2, major: 3 };
  let floor = 'none';
  const shas = gitIn(root, ['rev-list', '--no-merges', `${base}..${head}`])
    .split('\n')
    .filter(Boolean);
  for (const sha of shas) {
    const parsed = parseSubject(grammar, subjectOf(gitIn(root, ['log', '-1', '--format=%B', sha])));
    if (parsed === null) continue;
    const level = parsed.breaking
      ? grammar.breaking_marker.bump
      : grammar.types[parsed.type].bump_floor;
    if (rank[level] > rank[floor]) floor = level;
  }
  return floor;
}

function checkRange(root, base, head) {
  const grammar = loadGrammar(root);
  if (grammar === null) {
    process.stdout.write(`commit range: SKIP (no ${GRAMMAR_PATH})\n`);
    return 0;
  }
  const taxonomy = loadTaxonomy(root);
  const exclusions = [`^${base}`];
  if (grammar.historical_cutoff !== null) exclusions.push(`^${grammar.historical_cutoff}`);
  const shas = gitIn(root, ['rev-list', '--first-parent', '--reverse', head, ...exclusions])
    .split('\n')
    .filter(Boolean);
  const revertPrefix = grammar.exemptions?.reverts?.subject_prefix ?? 'Revert ';
  const offenders = [];
  for (const sha of shas) {
    const parents = gitIn(root, ['rev-list', '--parents', '-n', '1', sha]).trim().split(' ');
    if (parents.length > 2) continue;
    const message = gitIn(root, ['log', '-1', '--format=%B', sha]);
    const subject = subjectOf(message);
    let typeSubject = subject;
    if (subject.startsWith(revertPrefix)) {
      const reverted = /This reverts commit ([0-9a-f]{7,40})/u.exec(message)?.[1];
      if (reverted !== undefined) {
        // Inherit: the reverted commit's type judges the revert's paths. A
        // reverted commit outside the grammar is a historical exception.
        const original = subjectOf(gitIn(root, ['log', '-1', '--format=%B', reverted]));
        typeSubject = parseSubject(grammar, original) === null ? null : original;
      }
    }
    const classification =
      taxonomy === null ? null : classifyPaths(taxonomy, commitPaths(root, sha));
    const findings =
      typeSubject === null
        ? classification?.mixed
          ? [
              `paths span ${String(classification.families.length)} families`,
              ...describeClasses(classification),
            ]
          : []
        : judgeCommit({ grammar, classification, subject, typeSubject });
    if (findings.length > 0) offenders.push({ sha, subject, findings });
  }
  for (const { sha, subject, findings } of offenders) {
    process.stderr.write(`commit ${sha} ${subject}\n${findings.map((f) => `  ${f}`).join('\n')}\n`);
  }
  const verdict = offenders.length === 0 ? 'PASS' : 'FAIL';
  process.stdout.write(
    `commit range: ${verdict} (${String(shas.length)} first-parent commits, ${String(offenders.length)} offending)\n`,
  );
  if (offenders.length > 0) {
    process.stdout.write(`offending commits: ${offenders.map(({ sha }) => sha).join(' ')}\n`);
    process.stdout.write(`${allowedTypesLine(grammar)}\n`);
  }
  return offenders.length === 0 ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const [base, head] = process.argv.slice(2).filter((argument) => argument !== '--');
  if (base === undefined || head === undefined) {
    process.stderr.write('usage: check-commit-range.mjs <base> <head>\n');
    process.exit(64);
  }
  process.exitCode = checkRange(repositoryRoot(), base, head);
}
