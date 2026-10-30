#!/usr/bin/env node

// Commit grammar and single-family rule (ADR-GOV-0018). Run as
// `check-commit-range.mjs <base> <head>`, it walks the first-parent commits in
// base..head after `historical_cutoff` and exits 1 naming every commit whose
// subject breaks the grammar, whose paths span more than one class family, or
// whose type does not allow the classes of its paths. A revert inherits the type of the
// commit it reverts.
//
// It also judges provenance (ADR-CHK-0008): a commit with more than one parent is refused,
// the author must be an exact DEVAI role identity admitted by the author-path table for every
// path the commit changes, and the committer must be the author's role or the update-branch
// App. Each refusal names the commit. ADR-CHK-0009 replaces the test-class row: the Engineer is
// also admitted there for a test file the commit adds or modifies, never deletes, that imports a
// `packages/` file the same commit changes, once the constitution grants that verb (1.1.0).
//
// The module also exports the helpers the commit hooks share. Classification
// reads law/policy/change-taxonomy.json and the materialized binding directly,
// mirroring scripts/classify-paths.mjs, so no built package is needed. A
// repository without law/policy/commit-grammar.json has not adopted the grammar
// and every check here is skipped with a notice.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMPILED_AUTHORITY_POLICY,
  documentationCommitJudge,
} from './commit-documentation-authority.mjs';

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

/** Each path the commit changes with its status letter (A, M, D, T); renames are a D and an A. */
function commitChanges(root, sha) {
  const fields = gitIn(root, [
    'diff-tree',
    '--root',
    '--no-commit-id',
    '-r',
    '--no-renames',
    '--name-status',
    '-z',
    sha,
  ])
    .split('\0')
    .filter(Boolean);
  const changes = new Map();
  for (let index = 0; index + 1 < fields.length; index += 2) {
    changes.set(fields[index + 1], fields[index].charAt(0));
  }
  return changes;
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

function commitPresent(root, sha) {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Commit provenance (ADR-CHK-0008): every commit of a pull-request range carries an exact
// DEVAI role author, that author is admitted by the author-path table for every path the
// commit changes, and its committer is the same role or the update-branch App.
const ROLES = ['Owner', 'Architect', 'Inspector', 'Engineer'];
const MACHINE = 'Machine';
/** The update-branch GitHub App the Owner names at OE-02: its rebase updates keep the author. */
export const DEVAI_UPDATE_BRANCH_COMMITTER = Object.freeze({
  name: 'devai-update-branch[bot]',
  emailSuffix: '+devai-update-branch[bot]@users.noreply.github.com',
});

/** The DEVAI role an identity names exactly, or undefined. */
export function identityRole(name, email) {
  for (const role of [...ROLES, MACHINE]) {
    if (name === `DEVAI ${role}` && email === `${role.toLowerCase()}@devai.local`) return role;
  }
  return undefined;
}

const UPDATE_BRANCH_EMAIL = /^\d+\+devai-update-branch\[bot\]@users\.noreply\.github\.com$/u;

function updateBranchApp(name, email) {
  return name === DEVAI_UPDATE_BRANCH_COMMITTER.name && UPDATE_BRANCH_EMAIL.test(email);
}

const ROOT_PROSE = new Set([
  'README.md',
  'CLAUDE.md',
  'AGENTS.md',
  'CHANGELOG.md',
  'LICENSE',
  'NOTICE',
]);
const ROOT_WORKSPACE = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'vitest.config.ts',
  'eslint.config.mjs',
  '.prettierrc.json',
  '.prettierignore',
  '.editorconfig',
  '.npmrc',
  '.node-version',
  '.gitignore',
  'test-tasks.json',
  'test-task-exclusivity.json',
]);
const POLICY_COPIES = new Set([
  'change-taxonomy.json',
  'domains.json',
  'forbidden-actions.json',
  'glob-guards.json',
  'release-verification.json',
  'scorecard-na.json',
  'subprocess-effects.json',
  'thresholds.json',
]);
/** Pinned outputs of init apply / init bind whose source is fixed by the pin itself. */
const PINNED_SOURCES = new Map([
  ['.devai/pin/constitution.md', ['law/constitution.md']],
  ['.devai/constitution.md', ['law/constitution.md']],
]);
/** Pinned outputs whose source is the adopter binding's own source policy. */
const BINDING_PINNED = new Set([
  '.devai/config/project.json',
  '.devai/config/adopter-policy-binding.json',
]);
const ADOPTER_BINDING = '.devai/config/adopter-policy-binding.json';

/**
 * The checked-in adopter binding at a commit: its source policy and the outputs it
 * materializes. An absent or unreadable binding names no source.
 */
export function readAdopterBinding(root, commit) {
  try {
    const binding = JSON.parse(gitIn(root, ['show', `${commit}:${ADOPTER_BINDING}`]));
    return {
      source: typeof binding.source_path === 'string' ? binding.source_path : undefined,
      outputs: new Set(Object.keys(binding.materialized ?? {})),
    };
  } catch {
    return { source: undefined, outputs: new Set() };
  }
}

/**
 * The law sources whose change in the same commit admits the Architect for a materialized or
 * pinned output (the law-with-generated pairing of ADR-CHK-0008), or undefined when the path
 * is not such an output.
 */
export function canonicalSources(path, binding = { source: undefined, outputs: new Set() }) {
  const sources = new Set(PINNED_SOURCES.get(path) ?? []);
  const name = path.startsWith('.devai/config/') ? path.slice('.devai/config/'.length) : '';
  // The byte copies scripts/check-policy-materialization.mjs pins to their law/policy source.
  if (POLICY_COPIES.has(name)) sources.add(`law/policy/${name}`);
  if (binding.source !== undefined && (binding.outputs.has(path) || BINDING_PINNED.has(path))) {
    sources.add(binding.source);
  }
  const output =
    POLICY_COPIES.has(name) ||
    PINNED_SOURCES.has(path) ||
    BINDING_PINNED.has(path) ||
    path.startsWith('.devai/pin/');
  return output ? sources : undefined;
}
const ARCHITECT_BINDINGS = new Set([
  '.devai/config/change-taxonomy-binding.json',
  '.devai/config/credential-requirements-binding.json',
  '.devai/config/sensor-inputs.json',
]);
const ENGINEER_BINDINGS = new Set([
  '.devai/config/toolchain.json',
  '.devai/config/preflight-probes.json',
]);
const PLACEHOLDERS = new Set(['.devai/state/.gitkeep', '.devai/worktrees/.gitkeep']);
const NEVER_COMMITTED = ['scratch/', '.devai/state/', '.devai/worktrees/', '.devai/local/'];

const TEST_CLASS = /^(?:tests\/|packages\/[^/]+\/tests\/)/u;
/** A test file of the test class; configuration, helpers and fixtures there are not tests. */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
/** The first constitution whose Articles 6 and 7 grant the Engineer focused-regression verb. */
export const FOCUSED_REGRESSION_MIN_CONSTITUTION = '1.1.0';
const CONSTITUTION_SOURCES = ['law/constitution.md', '.devai/pin/constitution.md'];
// Mirrors parseConstitutionVersion in packages/utils/src/constitution-version.ts.
const CONSTITUTION_VERSION =
  /^\*\*(?:Candidate version|Version):\*\*\s*([0-9]+\.[0-9]+\.[0-9]+)\s*$/mu;
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const ENTRY_CONDITIONS = ['development', 'import', 'default', 'types', 'require'];

/** Whether a dotted version is at least the minimum; an unparsable version is not. */
export function versionAtLeast(version, minimum) {
  const parse = (value) =>
    /^(\d+)\.(\d+)\.(\d+)$/u
      .exec(value ?? '')
      ?.slice(1)
      .map(Number);
  const actual = parse(version);
  const floor = parse(minimum);
  if (actual === undefined || floor === undefined) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== floor[index]) return actual[index] > floor[index];
  }
  return true;
}

let typescript;
/** The installed TypeScript compiler, loaded only when an Engineer commit reaches a test path. */
function loadTypescript() {
  if (typescript === undefined) {
    try {
      typescript = createRequire(import.meta.url)('typescript');
    } catch {
      typescript = null;
    }
  }
  return typescript;
}

/**
 * The module specifiers a source imports, re-exports, requires or loads dynamically. Comments and
 * strings are not imports. Null when the TypeScript scanner is unavailable.
 */
export function importSpecifiers(text) {
  const ts = loadTypescript();
  if (ts === null) return null;
  return ts.preProcessFile(text, true, true).importedFiles.map(({ fileName }) => fileName);
}

// Mirrors candidateFiles in packages/cli/src/services/write-scope/import-adjacency.ts.
function candidateFiles(target) {
  const candidates = [target];
  const emitted = /\.([mc]?)js(x?)$/u.exec(target);
  if (emitted !== null) {
    candidates.push(`${target.slice(0, -emitted[0].length)}.${emitted[1]}ts${emitted[2]}`);
  }
  if (target.endsWith('.d.ts')) candidates.push(`${target.slice(0, -'.d.ts'.length)}.ts`);
  for (const extension of SOURCE_EXTENSIONS) candidates.push(`${target}${extension}`);
  for (const extension of SOURCE_EXTENSIONS) candidates.push(`${target}/index${extension}`);
  return candidates;
}

/** The entry targets a workspace package exports for a subpath (`.` or `./name`). */
function exportTargets(manifest, subpath) {
  const exported = manifest.exports;
  if (exported === undefined || exported === null) {
    if (subpath === '.') return [manifest.main ?? 'index.js'];
    return [subpath];
  }
  const conditional =
    typeof exported === 'object' &&
    !Array.isArray(exported) &&
    !Object.keys(exported).some((key) => key.startsWith('.'));
  const entry =
    typeof exported === 'string' || conditional
      ? subpath === '.'
        ? exported
        : undefined
      : exported[subpath];
  if (typeof entry === 'string') return [entry];
  if (entry === null || typeof entry !== 'object') return [];
  return ENTRY_CONDITIONS.flatMap((condition) =>
    typeof entry[condition] === 'string' ? [entry[condition]] : [],
  );
}

/**
 * The repository files one import specifier of `from` resolves to: a relative specifier against
 * the importing file, a workspace specifier through the exports of the `packages/*` manifest that
 * names it, where an emitted `dist/` target stands for its `src/` source. Bare specifiers of any
 * other package resolve to nothing. Mirrors resolveImport in
 * packages/cli/src/services/write-scope/import-adjacency.ts.
 */
export function resolveImport(specifier, from, files, workspaces) {
  const present = (targets) =>
    targets.flatMap((target) =>
      candidateFiles(target)
        .filter((path) => files.has(path))
        .slice(0, 1),
    );
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const target = posix.normalize(posix.join(posix.dirname(from), specifier));
    return target.startsWith('../') ? [] : present([target]);
  }
  const workspace = [...workspaces]
    .filter(({ name }) => specifier === name || specifier.startsWith(`${name}/`))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (workspace === undefined) return [];
  const subpath = specifier === workspace.name ? '.' : `.${specifier.slice(workspace.name.length)}`;
  return present(
    exportTargets(workspace.manifest, subpath).flatMap((entry) => {
      const target = posix.normalize(posix.join(workspace.directory, entry));
      const emitted = `${workspace.directory}/dist/`;
      return target.startsWith(emitted)
        ? [target, `${workspace.directory}/src/${target.slice(emitted.length)}`]
        : [target];
    }),
  );
}

/**
 * The focused-regression judge of one commit (ADR-CHK-0009): whether the Engineer is admitted on
 * a test-class path because the commit adds or modifies that test file, never deletes it, and one
 * of its imports resolves to a file under `packages/`, outside the test class, that the same
 * commit adds or modifies, under a constitution that grants the verb. Repository facts are read
 * once, and only when a test-class path is judged.
 */
export function focusedRegressionJudge(root, sha, changes) {
  let facts;
  const load = () => {
    const text = CONSTITUTION_SOURCES.map((path) => {
      try {
        return gitIn(root, ['show', `${sha}:${path}`]);
      } catch {
        return undefined;
      }
    }).find((candidate) => candidate !== undefined);
    const version = text === undefined ? undefined : CONSTITUTION_VERSION.exec(text)?.[1];
    if (!versionAtLeast(version, FOCUSED_REGRESSION_MIN_CONSTITUTION)) return { active: false };
    const files = new Set(
      gitIn(root, ['ls-tree', '-r', '-z', '--name-only', sha]).split('\0').filter(Boolean),
    );
    const workspaces = [...files]
      .filter((path) => /^packages\/[^/]+\/package\.json$/u.test(path))
      .flatMap((path) => {
        try {
          const manifest = JSON.parse(gitIn(root, ['show', `${sha}:${path}`]));
          return typeof manifest.name === 'string'
            ? [{ name: manifest.name, directory: posix.dirname(path), manifest }]
            : [];
        } catch {
          return [];
        }
      });
    const sources = new Set(
      [...changes]
        .filter(
          ([path, status]) =>
            status !== 'D' && path.startsWith('packages/') && !TEST_CLASS.test(path),
        )
        .map(([path]) => path),
    );
    return { active: true, files, workspaces, sources };
  };
  return (path) => {
    const status = changes.get(path);
    if (status === undefined || status === 'D' || !TEST_CLASS.test(path) || !TEST_FILE.test(path)) {
      return false;
    }
    facts ??= load();
    if (!facts.active || facts.sources.size === 0) return false;
    const specifiers = importSpecifiers(gitIn(root, ['show', `${sha}:${path}`]));
    if (specifiers === null) return false;
    return specifiers.some((specifier) =>
      resolveImport(specifier, path, facts.files, facts.workspaces).some((target) =>
        facts.sources.has(target),
      ),
    );
  };
}

const REGISTRY_SOURCE = 'law/policy/action-registry.json';
const REGISTRY_OUTPUTS = new Set([
  'packages/cli/src/generated/action-registry.ts',
  'packages/effects-check/src/generated/action-catalog.ts',
  'packages/sensors/src/generated/action-kinds.ts',
]);

// Both pins require a reviewed update when the canonical generator or formatter changes.
const REGISTRY_GENERATOR_SHA256 =
  '6c6ff06564fa19539adec3c750351b78e4f3383e102dca60799ec87af78a82ea';
const REGISTRY_FORMATTER_SHA256 =
  'ec9283d8a414942aeb3d9083a1164842447406877252e43b23ac9250cba89cbe';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Copy only regular files, hashing sorted relative names and per-file hashes. */
function copyVerifiedFormatter(source, target) {
  const hash = createHash('sha256');
  function copy(directory, relative = '') {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const nameRelative = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(path);
      if (stat.isDirectory()) copy(path, nameRelative);
      else if (stat.isFile()) {
        const bytes = readFileSync(path);
        const destination = join(target, nameRelative);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, bytes);
        hash.update(`${nameRelative}\0`);
        hash.update(createHash('sha256').update(readFileSync(destination)).digest());
      } else throw new Error('REGISTRY_FORMATTER_NONREGULAR');
    }
  }
  copy(source);
  return hash.digest('hex') === REGISTRY_FORMATTER_SHA256;
}

/** Verify the commit's own regular-file blobs against the pinned base generator, fail closed. */
export function registryGeneratedJudge(root, base, sha, changes) {
  let result;
  return (path) => {
    if (!REGISTRY_OUTPUTS.has(path) || !['A', 'M'].includes(changes.get(REGISTRY_SOURCE)))
      return false;
    if (result !== undefined) return result;
    result = false;
    let temporary;
    try {
      temporary = mkdtempSync(join(tmpdir(), 'devai-registry-provenance-'));
      const generator = execFileSync(
        'git',
        ['show', `${base}:scripts/generate-action-registry.mjs`],
        {
          cwd: root,
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      if (digest(generator) !== REGISTRY_GENERATOR_SHA256) return false;
      const formatter = realpathSync(
        dirname(createRequire(import.meta.url).resolve('prettier/package.json')),
      );
      if (!copyVerifiedFormatter(formatter, join(temporary, 'node_modules/prettier'))) return false;
      const script = join(temporary, 'generate-action-registry.mjs');
      writeFileSync(script, generator);
      if (digest(readFileSync(script)) !== REGISTRY_GENERATOR_SHA256) return false;
      for (const relative of [REGISTRY_SOURCE, ...REGISTRY_OUTPUTS]) {
        const entry = gitIn(root, ['ls-tree', sha, '--', relative]).trim();
        if (!/^100644 blob [0-9a-f]+\t/u.test(entry)) return false;
        const bytes = execFileSync('git', ['show', `${sha}:${relative}`], {
          cwd: root,
          maxBuffer: 64 * 1024 * 1024,
        });
        // The generator checks decoded strings; reject noncanonical UTF-8 so equality is byte-exact.
        if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) return false;
        const target = join(temporary, relative);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes);
      }
      execFileSync(process.execPath, [script, temporary, '--check'], {
        stdio: 'pipe',
        env: {},
      });
      result = true;
    } catch {
      result = false;
    } finally {
      if (temporary !== undefined) rmSync(temporary, { recursive: true, force: true });
    }
    return result;
  };
}

/**
 * The authors the ADR-CHK-0008 table, with the test-class row of ADR-CHK-0009, admits for one
 * path, judged with the other paths of the same commit (the law-with-generated pairing); an
 * empty set refuses the path. The most specific row decides, and a path no row names is refused.
 * `focused` is the commit's focused-regression judge; without one the test class admits only the
 * Inspector.
 */
export function admittedAuthors(
  path,
  commitPaths,
  binding,
  focused = undefined,
  registryGenerated = undefined,
  documentation = undefined,
) {
  const only = (...roles) => new Set(roles);
  if (path === 'scratch/README.md') return only('Architect');
  if (PLACEHOLDERS.has(path)) return only('Engineer');
  if (NEVER_COMMITTED.some((prefix) => path.startsWith(prefix))) return only();
  if (path === COMPILED_AUTHORITY_POLICY)
    return documentation?.policyAuthors(commitPaths) ?? only();
  const sources = canonicalSources(path, binding);
  if (sources !== undefined) {
    // Machine always; the Architect only in the commit that changes this output's own source.
    return [...sources].some((source) => commitPaths.includes(source))
      ? only(MACHINE, 'Architect')
      : only(MACHINE);
  }
  if (ARCHITECT_BINDINGS.has(path)) return only('Architect');
  if (ENGINEER_BINDINGS.has(path)) return only('Engineer');
  if (path.startsWith('law/glossary/')) return only('Architect', 'Owner');
  if (path.startsWith('law/')) return only('Architect');
  if (path.startsWith('product/')) return only('Owner');
  if (path.startsWith('docs/')) return documentation?.authorsFor(path) ?? only('Architect');
  if (ROOT_PROSE.has(path)) return only('Architect');
  if (TEST_CLASS.test(path)) {
    return focused?.(path) === true ? only('Inspector', 'Engineer') : only('Inspector');
  }
  if (path.startsWith('packages/')) {
    return registryGenerated?.(path) === true ? only('Engineer', 'Architect') : only('Engineer');
  }
  if (ROOT_WORKSPACE.has(path) || /^tsconfig[^/]*\.json$/u.test(path)) return only('Engineer');
  if (path.startsWith('scripts/') || path.startsWith('.githooks/') || path.startsWith('.github/')) {
    return only('Engineer');
  }
  if (path.startsWith('.claude/')) return only('Architect');
  if (path.startsWith('record/derived/')) return only(MACHINE);
  if (path.startsWith('record/proofs/')) return only(MACHINE, ...ROLES);
  if (path.startsWith('record/')) return only(MACHINE, ...ROLES);
  return only();
}

/** Provenance findings for one commit of a pull-request range; empty when it is admitted. */
export function provenanceFindings({
  parents,
  author,
  committer,
  paths,
  binding,
  focused,
  registryGenerated,
  documentation,
}) {
  const findings = [];
  try {
    documentation?.verifyCurrent();
  } catch (error) {
    findings.push(
      `path ${COMPILED_AUTHORITY_POLICY} documentation authority refused: ${error instanceof Error ? error.message : 'verification failed'}`,
    );
  }
  if (parents > 1) {
    findings.push(
      `merge commit with ${String(parents)} parents: a pull-request range admits no merge commit (ADR-CHK-0008)`,
    );
  }
  const role = identityRole(author.name, author.email);
  if (role === undefined) {
    findings.push(
      `author "${author.name} <${author.email}>" is not an exact DEVAI role identity (DEVAI <Role> <role@devai.local>)`,
    );
  } else {
    const committerRole = identityRole(committer.name, committer.email);
    if (committerRole !== role && !updateBranchApp(committer.name, committer.email)) {
      findings.push(
        `committer "${committer.name} <${committer.email}>" is neither the author's role (${role}) nor the update-branch App`,
      );
    }
    for (const path of paths) {
      let admitted;
      try {
        admitted = admittedAuthors(path, paths, binding, focused, registryGenerated, documentation);
      } catch (error) {
        findings.push(
          `path ${path} documentation authority refused: ${error instanceof Error ? error.message : 'verification failed'}`,
        );
        continue;
      }
      if (admitted.size === 0) {
        findings.push(`path ${path} is not admitted for any author by the ADR-CHK-0008 table`);
      } else if (!admitted.has(role)) {
        const verb =
          role === 'Engineer' && TEST_CLASS.test(path)
            ? `; the Engineer focused-regression verb (ADR-CHK-0009) admits only a test file this commit adds or modifies that imports a packages/ file this commit changes, under constitution ${FOCUSED_REGRESSION_MIN_CONSTITUTION} or later`
            : '';
        findings.push(
          `path ${path} admits ${[...admitted].join(' or ')}, not the author role ${role}${verb}`,
        );
      }
    }
  }
  return findings;
}

function checkRange(root, base, head) {
  const grammar = loadGrammar(root);
  if (grammar === null) {
    process.stdout.write(`commit range: SKIP (no ${GRAMMAR_PATH})\n`);
    return 0;
  }
  const taxonomy = loadTaxonomy(root);
  const binding = readAdopterBinding(root, head);
  const exclusions = [`^${base}`];
  if (grammar.historical_cutoff !== null) {
    if (commitPresent(root, grammar.historical_cutoff)) {
      exclusions.push(`^${grammar.historical_cutoff}`);
    } else {
      // A repository without the cutoff commit (a fixture, a shallow clone) has no
      // history before it to exempt: the whole range is checked.
      process.stderr.write(
        `commit range: historical_cutoff ${grammar.historical_cutoff} is not in this repository; checking the whole range\n`,
      );
    }
  }
  const shas = gitIn(root, ['rev-list', '--first-parent', '--reverse', head, ...exclusions])
    .split('\n')
    .filter(Boolean);
  const revertPrefix = grammar.exemptions?.reverts?.subject_prefix ?? 'Revert ';
  const offenders = [];
  for (const sha of shas) {
    const parentCount =
      gitIn(root, ['rev-list', '--parents', '-n', '1', sha]).trim().split(' ').length - 1;
    const [authorName = '', authorEmail = '', committerName = '', committerEmail = ''] = gitIn(
      root,
      ['log', '-1', '--format=%an%x00%ae%x00%cn%x00%ce', sha],
    )
      .replace(/\n$/u, '')
      .split('\0');
    const changes = parentCount > 1 ? new Map() : commitChanges(root, sha);
    const documentation = documentationCommitJudge(root, sha);
    let provenance;
    try {
      provenance = provenanceFindings({
        binding,
        parents: parentCount,
        author: { name: authorName, email: authorEmail },
        committer: { name: committerName, email: committerEmail },
        paths: [...changes.keys()],
        focused: focusedRegressionJudge(root, sha, changes),
        registryGenerated: registryGeneratedJudge(root, base, sha, changes),
        documentation,
      });
    } finally {
      try {
        documentation.dispose();
      } catch (error) {
        provenance ??= [];
        provenance.push(
          `documentation snapshot custody refused: ${error instanceof Error ? error.message : 'verification failed'}`,
        );
      }
    }
    if (parentCount > 1) {
      offenders.push({
        sha,
        subject: subjectOf(gitIn(root, ['log', '-1', '--format=%B', sha])),
        findings: provenance,
      });
      continue;
    }
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
    findings.push(...provenance);
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
