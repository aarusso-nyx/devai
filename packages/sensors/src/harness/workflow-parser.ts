import ts from 'typescript';
import { foldWorkflowLines } from './folded-lines.js';
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { REVIEWED_WORKFLOW_STEPS } from './reviewed-workflow-steps.js';

/**
 * Shared workflow YAML parser for Phase 28 harness sensors. Walks
 * `.github/workflows/*.yml{,.yaml}` and extracts a minimal typed AST
 * sufficient for the 7 F5 sensors. Line-based (not a full YAML
 * parser) — deliberate choice to avoid adding a yaml dep; the
 * supported scoped structure is closed; unsupported authority remains UNKNOWN.
 */

export interface WorkflowAst {
  readonly file: string;
  readonly relativeFile: string;
  /** Path filters declared under any `on.<trigger>.paths:` block (union). */
  readonly onPaths: readonly string[];
  /** Path-ignore filters declared under any `on.<trigger>.paths-ignore:` block. */
  readonly onPathsIgnore: readonly string[];
  /** Whether the workflow has a top-level `permissions:` block. */
  readonly hasPermissionsBlock: boolean;
  /** Whether the workflow has a top-level `concurrency:` block. */
  readonly hasConcurrencyBlock: boolean;
  /** Action references discovered (one per `uses:` line). */
  readonly actionUses: readonly ActionUse[];
  /** Per-job: number of step entries. */
  readonly jobs: readonly WorkflowJob[];
  /** Number of distinct top-level `run:` script invocations. */
  readonly runStepCount: number;
  /** Concatenated `run:` script bodies (best-effort; used by 28.E alignment). */
  readonly runScripts: readonly string[];
  /** Cache-action references seen (any uses: containing 'cache', e.g. actions/cache). */
  readonly hasCache: boolean;
  /** Reusable-workflow uses: `uses: <owner>/<repo>/.github/workflows/*.yml@*` or `./.github/workflows/*.yml`. */
  readonly reusableWorkflowUses: readonly string[];
  /** Composite-action uses: `uses: ./.github/actions/<name>`. */
  readonly compositeActionUses: readonly string[];
}

export interface ActionUse {
  readonly owner: string;
  readonly repo: string;
  readonly ref: string;
  readonly line: number;
}

export interface WorkflowJob {
  readonly name: string;
  readonly stepCount: number;
  readonly matrixDimensions: number;
  /** Total matrix combinations: product of all listed dimensions. */
  readonly matrixCombinations: number;
  readonly effect?: 'read-only' | 'publication' | 'unknown';
  readonly concurrency?: { readonly group: string; readonly cancelInProgress: boolean | null };
  readonly condition?: string;
  readonly needs?: readonly string[];
  readonly environment?: string | Readonly<Record<string, string>>;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly runScripts?: readonly string[];
}

function abs(repoRoot: string, p: string): string {
  return isAbsolute(p) ? p : resolve(repoRoot, p);
}

function sourceBindingRefused(): never {
  throw new Error('WORKFLOW_SOURCE_BINDING_REFUSED');
}
function pathWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
type SourceBinding = {
  root: string;
  logicalRoot: string;
  logical: string;
  actual: string;
  stat: Stats;
};
/** Validate every candidate-owned path component before source bytes or caller paths escape. */
function sourceBinding(repoRoot: string, path: string): SourceBinding | undefined {
  const root = candidateRoot(repoRoot);
  if (!root) return sourceBindingRefused();
  const logicalRoot = resolve(repoRoot);
  const lexical = abs(logicalRoot, path);
  let rel: string;
  if (pathWithin(logicalRoot, lexical)) rel = relative(logicalRoot, lexical);
  else if (pathWithin(root, lexical)) rel = relative(root, lexical);
  else return sourceBindingRefused();
  const actual = resolve(root, rel);
  if (!pathWithin(root, actual)) return sourceBindingRefused();
  const pieces = rel ? rel.split(sep) : [];
  let cursor = root;
  let stat: Stats;
  try {
    stat = lstatSync(root);
  } catch {
    return sourceBindingRefused();
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return sourceBindingRefused();
  for (let i = 0; i < pieces.length; i++) {
    cursor = join(cursor, pieces[i] ?? '');
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      // A genuinely missing path is unavailable, not a dangling alias or unreadability.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      return sourceBindingRefused();
    }
    if (stat.isSymbolicLink() || (i < pieces.length - 1 && !stat.isDirectory()))
      return sourceBindingRefused();
  }
  try {
    if (realpathSync(actual) !== actual || candidateRoot(repoRoot) !== root)
      return sourceBindingRefused();
  } catch {
    return sourceBindingRefused();
  }
  return { root, logicalRoot, logical: resolve(logicalRoot, rel), actual, stat };
}
function sameSourceIdentity(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.nlink === b.nlink
  );
}
/** Ordinary I/O denial of an already bound, contained regular file: the entry is unreadable. */
const UNREADABLE_CODES = new Set(['EACCES', 'EPERM', 'EIO']);
class UnreadableSource extends Error {}
function unreadable(error: unknown): boolean {
  return UNREADABLE_CODES.has(String((error as NodeJS.ErrnoException | undefined)?.code ?? ''));
}
/**
 * Read from a validated descriptor; recheck containment/identity before exposing caller .file.
 * Escapes, aliases and identity changes refuse. An ordinary read denial of the bound regular
 * file returns undefined (unreadable entry). The bytes are also read through the logical path
 * exposed as .file, exactly as downstream consumers read them, and must equal the descriptor
 * bytes; any divergence refuses.
 */
function readBoundSource(
  repoRoot: string,
  path: string,
  read: boolean,
): { file: string; source: string } | undefined {
  const binding = sourceBinding(repoRoot, path);
  if (!binding || !binding.stat.isFile() || binding.stat.nlink !== 1) return sourceBindingRefused();
  let fd: number | undefined;
  try {
    try {
      fd = openSync(binding.actual, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (unreadable(error)) throw new UnreadableSource();
      throw error;
    }
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameSourceIdentity(binding.stat, opened))
      return sourceBindingRefused();
    const bytes = read ? readFileSync(fd) : Buffer.alloc(0);
    if (read) {
      let viaPath: Buffer;
      try {
        viaPath = readFileSync(binding.logical);
      } catch (error) {
        if (unreadable(error)) throw new UnreadableSource();
        throw error;
      }
      if (!viaPath.equals(bytes)) return sourceBindingRefused();
    }
    const source = bytes.toString('utf8');
    if (!Buffer.from(source, 'utf8').equals(bytes)) return sourceBindingRefused();
    const after = sourceBinding(repoRoot, path);
    if (
      !after ||
      after.root !== binding.root ||
      after.actual !== binding.actual ||
      !sameSourceIdentity(opened, fstatSync(fd)) ||
      !sameSourceIdentity(opened, after.stat)
    )
      return sourceBindingRefused();
    return { file: after.logical, source };
  } catch (error) {
    if (error instanceof UnreadableSource) return undefined;
    return sourceBindingRefused();
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        sourceBindingRefused();
      }
    }
  }
}
export function listWorkflowFiles(repoRoot: string, dir?: string): string[] {
  const binding = sourceBinding(repoRoot, dir ?? '.github/workflows');
  if (!binding) return [];
  // A positively identified ordinary non-directory has no workflow inventory.
  if (!binding.stat.isDirectory()) {
    if (binding.stat.isFile()) return [];
    return sourceBindingRefused();
  }
  let names: string[];
  try {
    names = readdirSync(binding.actual);
  } catch {
    return sourceBindingRefused();
  }
  const files: string[] = [];
  for (const name of names
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()) {
    const selected = sourceBinding(repoRoot, join(binding.logical, name));
    if (!selected) return sourceBindingRefused();
    // Suffix-bearing real directories are excluded structurally, never treated as source files.
    if (selected.stat.isDirectory()) continue;
    // A bound but unreadable file is still a selected workflow entry; loading skips it.
    files.push(readBoundSource(repoRoot, selected.logical, false)?.file ?? selected.logical);
  }
  const after = sourceBinding(repoRoot, binding.logical);
  if (!after || after.actual !== binding.actual || !sameSourceIdentity(binding.stat, after.stat))
    return sourceBindingRefused();
  return files;
}

function indentOf(line: string): number {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  return i;
}

function trimComment(line: string): string {
  // Drop everything after a `#` that is not inside a quoted scalar. Counting
  // quotes before the first `#` kept `"gen/#out/**" # note` whole, comment and
  // all; scanning the line (as harness-invariant-alignment.ts does for the same
  // construct) closes the quote and strips only the real comment.
  let single = false;
  let double = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (double && char === '\\') {
      // Consume escape pairs: an even run leaves the next quote unescaped.
      i += 1;
      continue;
    }
    if (char === "'" && !double) single = !single;
    else if (char === '"' && !single) double = !double;
    else if (char === '#' && !single && !double && (i === 0 || /\s/.test(line[i - 1] ?? '')))
      return line.slice(0, i).trimEnd();
  }
  return line;
}

const USES_RE = /^\s*-?\s*uses:\s*(['"]?)([^\s@'"]+)(?:@([^\s'"]+))?\1\s*$/;

function parseUses(line: string, lineNo: number): ActionUse | null {
  const m = line.match(USES_RE);
  if (m === null) return null;
  const target = m[2] ?? '';
  const ref = m[3] ?? '';
  if (target.startsWith('./')) {
    // Local action / reusable workflow — owner '' indicates local.
    return { owner: '', repo: target, ref, line: lineNo };
  }
  const parts = target.split('/');
  if (parts.length < 2) return null;
  const owner = parts[0] ?? '';
  const repo = parts.slice(1).join('/');
  return { owner, repo, ref, line: lineNo };
}

type ExecutionYaml = (
  | { kind: 'scalar'; value: string; syntax: 'plain' | 'quoted' | 'block' }
  | { kind: 'opaque' }
  | { kind: 'map'; entries: Map<string, ExecutionYaml> }
  | { kind: 'list'; items: ExecutionYaml[] }
) & { line?: number; display?: string };
/** Bounded YAML structure. Unsupported syntax never supplies executable authority. */
function executionYaml(source: string): ExecutionYaml | undefined {
  const rows = source.split('\n');
  let cursor = 0;
  const skip = () => {
    while (cursor < rows.length && !trimComment(rows[cursor] ?? '').trim()) cursor++;
  };
  const rowText = () => {
    const row = rows[cursor] ?? '';
    if (/^ *\t/u.test(row)) throw new Error('unproved YAML indentation');
    return trimComment(row);
  };
  // YAML permits whitespace between a mapping key and its ':' indicator (`run : x`); the key
  // identity is unchanged, so it is read exactly as GitHub's parser reads it.
  const keyValue = (text: string): { key: string; value: string } => {
    const match =
      /^(?:([A-Za-z0-9_.-]+)|'([A-Za-z0-9_.-]+)'|"([A-Za-z0-9_.-]+)")[ \t]*:(?:[ \t]+(.*)|$)/u.exec(
        text,
      );
    if (!match) throw new Error('unproved YAML mapping');
    return { key: match[1] ?? match[2] ?? match[3] ?? '', value: match[4] ?? '' };
  };
  function decodedValue(text: string, parent: number, displayIndent: number): ExecutionYaml {
    if (/^[|>][-+]?$/u.test(text)) {
      const body: string[] = [];
      while (cursor < rows.length) {
        const row = rows[cursor] ?? '';
        if (row.trim() && indentOf(row) <= parent) break;
        body.push(row);
        cursor++;
      }
      const nonempty = body.filter((row) => row.trim());
      const width = nonempty.length ? indentOf(nonempty[0] ?? '') : parent + 1;
      if (nonempty.some((row) => /^ *\t/u.test(row) || indentOf(row) < width))
        throw new Error('unproved scalar indentation');
      const stripped = body.map((row) => row.slice(width));
      const view = body.map((row) => trimComment(row).slice(displayIndent + 2));
      const result = text.startsWith('>') ? foldWorkflowLines(stripped) : stripped.join('\n');
      const display = (text.startsWith('>') ? foldWorkflowLines(view) : view.join('\n')).replace(
        /\n+$/u,
        '',
      );
      return { kind: 'scalar', value: result, syntax: 'block', display };
    }
    if (!text) {
      skip();
      if (cursor < rows.length && indentOf(rowText()) > parent) {
        const next = rowText().trim();
        if (
          !/^-(?:\s|$)/u.test(next) &&
          !/^(?:[A-Za-z0-9_.-]+|'[A-Za-z0-9_.-]+'|"[A-Za-z0-9_.-]+")[ \t]*:/u.test(next)
        ) {
          const body: string[] = [];
          while (
            cursor < rows.length &&
            (!(rows[cursor] ?? '').trim() || indentOf(rows[cursor] ?? '') > parent)
          )
            body.push(rows[cursor++] ?? '');
          const display = foldWorkflowLines(
            body.map((row) => trimComment(row).slice(displayIndent + 2)),
          );
          return { kind: 'scalar', syntax: 'block', value: display, display };
        }
        return block(indentOf(rowText()));
      }
      return { kind: 'scalar', value: '', syntax: 'plain' };
    }
    if (text === '{}') return { kind: 'map', entries: new Map() };
    if (text === '[]') return { kind: 'list', items: [] };
    // A closed literal job-id sequence supports needs without admitting general flow YAML.
    if (text.startsWith('[') && text.endsWith(']')) {
      const names = text
        .slice(1, -1)
        .split(',')
        .map((item) => item.trim());
      if (names[names.length - 1] === '') names.pop();
      if (
        names.every((item) =>
          /^(?:[A-Za-z0-9_.-]+|'[A-Za-z0-9_.-]+'|"[A-Za-z0-9_.-]+")$/u.test(item),
        )
      )
        return { kind: 'list', items: names.map((item) => value(item, parent)) };
    }
    if (/^[&*!{[]/u.test(text)) return { kind: 'opaque' };
    if (text.startsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(text);
        return typeof parsed === 'string'
          ? { kind: 'scalar', value: parsed, syntax: 'quoted' }
          : { kind: 'opaque' };
      } catch {
        return { kind: 'opaque' };
      }
    }
    if (text.startsWith("'")) {
      if (!/^'(?:[^']|'')*'$/u.test(text)) return { kind: 'opaque' };
      return { kind: 'scalar', value: text.slice(1, -1).replace(/''/gu, "'"), syntax: 'quoted' };
    }
    if (/:\s/u.test(text)) return { kind: 'opaque' };
    return { kind: 'scalar', value: text, syntax: 'plain' };
  }
  function value(text: string, parent: number, displayIndent = parent): ExecutionYaml {
    const line = cursor;
    const decoded = decodedValue(text, parent, displayIndent);
    return { ...decoded, line, ...(decoded.display === undefined ? { display: text } : {}) };
  }
  function mapping(width: number, first?: string, firstDisplay = width - 2): ExecutionYaml {
    const entries = new Map<string, ExecutionYaml>();
    const append = (text: string, displayIndent = width) => {
      const pair = keyValue(text);
      if (entries.has(pair.key)) throw new Error('duplicate YAML key');
      entries.set(pair.key, value(pair.value, width, displayIndent));
    };
    if (first !== undefined) append(first, firstDisplay);
    while (true) {
      skip();
      if (cursor >= rows.length) break;
      const row = rowText();
      if (indentOf(row) < width) break;
      if (indentOf(row) !== width || /^-(?:\s|$)/u.test(row.trim()))
        throw new Error('unproved mapping scope');
      cursor++;
      append(row.slice(width));
    }
    return { kind: 'map', entries };
  }
  function block(width: number): ExecutionYaml {
    skip();
    if (!/^-(?:\s|$)/u.test(rowText().slice(width))) return mapping(width);
    const items: ExecutionYaml[] = [];
    while (true) {
      skip();
      if (cursor >= rows.length || indentOf(rowText()) < width) break;
      const row = rowText();
      // Any run of spaces may follow the '-' indicator; an inline mapping then starts at the
      // first key column, so its sibling keys are scoped to that exact column.
      const item = /^-(?:( +)(.*))?$/u.exec(row.slice(width));
      if (indentOf(row) !== width || !item) throw new Error('unproved YAML sequence');
      cursor++;
      const text = item[2] ?? '';
      const column = width + 1 + (item[1]?.length ?? 1);
      if (!text) {
        skip();
        if (cursor >= rows.length || indentOf(rowText()) <= width)
          throw new Error('unbound YAML item');
        items.push(block(indentOf(rowText())));
      } else if (/^(?:[A-Za-z0-9_.-]+|'[A-Za-z0-9_.-]+'|"[A-Za-z0-9_.-]+")[ \t]*:/u.test(text))
        items.push(mapping(column, text, width));
      else items.push(value(text, width));
    }
    return { kind: 'list', items };
  }
  try {
    skip();
    if (cursor >= rows.length || indentOf(rowText()) !== 0) return undefined;
    const result = block(0);
    skip();
    return cursor === rows.length ? result : undefined;
  } catch {
    return undefined;
  }
}
const yamlMap = (value: ExecutionYaml | undefined): Map<string, ExecutionYaml> | undefined =>
  value?.kind === 'map' ? value.entries : undefined;
const yamlText = (value: ExecutionYaml | undefined): string | undefined =>
  value?.kind === 'scalar' ? value.value : undefined;
const yamlString = (value: ExecutionYaml | undefined): string | undefined => {
  // Admission controls need a proven scalar identity; run block semantics are separate.
  if (value?.kind !== 'scalar' || value.syntax === 'block') return undefined;
  // Refuse unproved plain-scalar whitespace identity rather than normalize provider controls.
  if (value.syntax === 'plain' && value.value.trim() !== value.value) return undefined;
  if (
    value.syntax === 'plain' &&
    /^(?:true|false|null|~|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|[-+]?0[box][0-9a-f]+|[-+]?\.(?:inf|nan))$/iu.test(
      value.value,
    )
  )
    return undefined;
  return value.value;
};

const yamlBoolean = (value: ExecutionYaml | undefined): boolean | undefined => {
  if (
    value?.kind !== 'scalar' ||
    value.syntax !== 'plain' ||
    !/^(?:true|false)$/iu.test(value.value)
  )
    return undefined;
  return value.value.toLowerCase() === 'true';
};

/**
 * Contexts a concurrency group may read (#325). Each names the run's own scope: its ref, its
 * workflow, its commit, its event, the pull request or merge-queue entry it serves, or a
 * dispatch input. None selects code, a credential or a runtime.
 */
const CONCURRENCY_CONTEXTS = new Set([
  'github.ref',
  'github.ref_name',
  'github.workflow',
  'github.sha',
  'github.event_name',
  'github.event.pull_request.number',
  'github.event.merge_group.head_sha',
]);

/**
 * The contexts one `${{ … }}` concurrency expression reads, or undefined when it uses
 * anything outside a closed grammar: allowlisted contexts and `inputs.<name>`, quoted
 * literals, `==`, `!=`, `&&`, `||`, `!`, parentheses, and `format(literal, …)`.
 */
export function concurrencyExpressionContexts(expression: string): readonly string[] | undefined {
  const token = /\s*(?:('(?:[^']|'')*')|([A-Za-z_][A-Za-z0-9_.-]*)|(==|!=|&&|\|\||[!(),]))/uy;
  const tokens: string[] = [];
  let offset = 0;
  while (offset < expression.length) {
    token.lastIndex = offset;
    const match = token.exec(expression);
    if (!match) {
      if (expression.slice(offset).trim() !== '') return undefined;
      break;
    }
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
    if (tokens.length > 256) return undefined;
    offset = token.lastIndex;
  }
  const contexts: string[] = [];
  let cursor = 0;
  function primary(): boolean {
    const value = tokens[cursor++];
    if (value === undefined) return false;
    if (value === '!') return primary();
    if (value === '(') return expression_() && tokens[cursor++] === ')';
    if (value.startsWith("'")) return true;
    if (value === 'format') {
      if (tokens[cursor++] !== '(' || !tokens[cursor]?.startsWith("'")) return false;
      cursor++;
      while (tokens[cursor] === ',') {
        cursor++;
        if (!expression_()) return false;
      }
      return tokens[cursor++] === ')';
    }
    if (CONCURRENCY_CONTEXTS.has(value) || /^inputs\.[A-Za-z_][A-Za-z0-9_-]*$/u.test(value)) {
      contexts.push(value);
      return true;
    }
    return false;
  }
  function comparison(): boolean {
    if (!primary()) return false;
    if (tokens[cursor] === '==' || tokens[cursor] === '!=') {
      cursor++;
      return primary();
    }
    return true;
  }
  function expression_(): boolean {
    if (!comparison()) return false;
    while (tokens[cursor] === '&&' || tokens[cursor] === '||') {
      cursor++;
      if (!comparison()) return false;
    }
    return true;
  }
  return expression_() && cursor === tokens.length ? contexts : undefined;
}

/** The contexts a whole concurrency group reads, or undefined when any part is refused. */
export function concurrencyGroupContexts(group: string): readonly string[] | undefined {
  const contexts: string[] = [];
  let rest = group;
  for (;;) {
    const open = rest.indexOf('${{');
    if (open < 0) return rest.includes('}}') ? undefined : contexts;
    if (rest.slice(0, open).includes('}}')) return undefined;
    const close = rest.indexOf('}}', open + 3);
    if (close < 0) return undefined;
    const read = concurrencyExpressionContexts(rest.slice(open + 3, close));
    if (read === undefined) return undefined;
    contexts.push(...read);
    rest = rest.slice(close + 2);
  }
}

/** undefined is absent; null refuses; values have typed actual scoped authority. */
function controlConcurrency(value: ExecutionYaml | undefined): WorkflowJob['concurrency'] | null {
  if (value === undefined) return undefined;
  const fields = yamlMap(value);
  if (!fields || [...fields.keys()].some((key) => !['group', 'cancel-in-progress'].includes(key)))
    return null;
  const group = yamlString(fields.get('group'));
  if (group === undefined || /[\r\n]/u.test(group)) return null;
  if (concurrencyGroupContexts(group) === undefined) return null;
  const cancellation = fields.get('cancel-in-progress');
  const cancel = cancellation === undefined ? null : yamlBoolean(cancellation);
  return cancel === undefined ? null : { group, cancelInProgress: cancel };
}
function rootConcurrencyExposed(content: string, fields: Map<string, ExecutionYaml>): boolean {
  const actual = controlConcurrency(fields.get('concurrency'));
  if (actual === null) return false;
  // Frozen caller projection is a compatibility check, never independent authority.
  const block = content.match(/^concurrency\s*:\s*\n((?:[ \t]+.*(?:\n|$))*)/mu);
  if (actual === undefined) return block === null;
  if (!block) return false;
  const body = block[1] ?? '';
  const group = body.match(/^\s+group\s*:\s*(.+?)\s*$/mu)?.[1] ?? '';
  const cancel = body.match(/^\s+cancel-in-progress\s*:\s*(true|false)\s*$/mu)?.[1];
  return (
    group === actual.group &&
    (cancel === undefined ? null : cancel === 'true') === actual.cancelInProgress
  );
}

/** Prove actual scheduler presence against the unchanged readiness caller projection. */
function scheduleProjectionExposed(content: string, fields: Map<string, ExecutionYaml>): boolean {
  const trigger = fields.get('on');
  let scheduled = false;
  if (trigger !== undefined) {
    const triggers = yamlMap(trigger);
    if (triggers) {
      const schedule = triggers.get('schedule');
      scheduled = schedule !== undefined;
      if (schedule !== undefined) {
        if (schedule.kind !== 'list' || !schedule.items.length) return false;
        for (const entry of schedule.items) {
          const declaration = yamlMap(entry);
          const cron = yamlString(declaration?.get('cron'));
          if (
            !declaration ||
            declaration.size !== 1 ||
            cron === undefined ||
            !/^[0-9*,/-]+(?:[ \t]+[0-9*,/-]+){4}$/u.test(cron)
          )
            return false;
        }
      }
    } else {
      const names = trigger.kind === 'list' ? trigger.items : [trigger];
      if (
        !names.length ||
        names.some((name) => {
          const event = yamlString(name);
          return !event || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(event) || event === 'schedule';
        })
      )
        return false;
    }
  }
  return scheduled === /^\s{2}schedule\s*:/mu.test(content);
}

interface CollectedJob {
  name: string;
  stepCount: number;
  matrixSizes: number[];
}

/** Generic filesystem binding; absence is unavailable evidence, never an observation proof. */
function candidateRoot(repoRoot: string): string | undefined {
  try {
    if (!repoRoot.trim() || !statSync(repoRoot).isDirectory()) return undefined;
    const root = realpathSync(repoRoot);
    if (!statSync(root).isDirectory()) return undefined;
    readdirSync(root); // Prove a readable resolved directory before optional evidence projection.
    return root;
  } catch {
    return undefined;
  }
}

export function parseWorkflow(file: string, content: string, repoRoot: string): WorkflowAst {
  const fields = yamlMap(executionYaml(content));
  const scopedJobs = yamlMap(fields?.get('jobs'));
  const inventoryKnown = scopedJobs !== undefined && scopedJobs.size > 0;
  const root = candidateRoot(repoRoot);
  const bound = root !== undefined;
  const jobs: CollectedJob[] = [];
  const onPaths: string[] = [];
  const onPathsIgnore: string[] = [];
  const actionUses: ActionUse[] = [];
  const runScripts: string[] = [];
  const reusable: string[] = [];
  const composites: string[] = [];
  let hasCache = false;
  const commentFree = content.split('\n').map(trimComment);

  function captureUse(value: ExecutionYaml | undefined): void {
    const literal = yamlString(value);
    if (literal === undefined) return;
    const use = parseUses(`uses: ${JSON.stringify(literal)}`, value?.line ?? 0);
    if (!use) return;
    actionUses.push(use);
    if (use.repo.startsWith('./.github/actions/')) composites.push(use.repo);
    else if (use.repo.endsWith('.yml') || use.repo.endsWith('.yaml')) reusable.push(use.repo);
    const path = `${use.owner}/${use.repo}`.toLowerCase();
    if (path.includes('cache')) hasCache = true;
    // Diagnostic cache signal (unchanged structural contract): a setup-* action counts as
    // cache-eligible when a `cache:` key appears within the 10 lines after its uses: line,
    // stopping at the next list item. It never contributes executable authority.
    if (path.includes('actions/setup-') && value?.line !== undefined) {
      const at = value.line - 1;
      for (let j = at + 1; j <= Math.min(at + 10, commentFree.length - 1); j++) {
        if (/^\s*cache\s*:\s*\S+/u.test(commentFree[j] ?? '')) {
          hasCache = true;
          break;
        }
        if (/^\s*-\s/u.test(commentFree[j] ?? '')) break;
      }
    }
  }
  function captureSteps(value: ExecutionYaml | undefined): number {
    if (value?.kind !== 'list') return 0;
    for (const entry of value.items) {
      const step = yamlMap(entry);
      if (!step) continue;
      captureUse(step.get('uses'));
      const run = step.get('run');
      if (yamlText(run) !== undefined) {
        // Preserve the legacy diagnostic presentation; executable proof uses decoded value.
        const display = run?.display ?? yamlText(run) ?? '';
        if (display) runScripts.push(display);
      }
    }
    return value.items.length;
  }
  if (scopedJobs) {
    for (const [name, value] of scopedJobs) {
      const job = yamlMap(value);
      const matrix = yamlMap(yamlMap(job?.get('strategy'))?.get('matrix'));
      const matrixSizes = matrix
        ? [...matrix.values()]
            .filter((dimension) => dimension.kind === 'list' && dimension.items.length > 0)
            .map((dimension) => (dimension.kind === 'list' ? dimension.items.length : 0))
        : [];
      captureUse(job?.get('uses'));
      jobs.push({ name, stepCount: captureSteps(job?.get('steps')), matrixSizes });
    }
  }
  // Never expose an admitting zero-job view for a malformed, unproved or declared-but-unproved
  // inventory. A fully proved document that declares no jobs key at all has a known empty
  // inventory (zero jobs), which callers report as such rather than as one unresolved job.
  // A key that only case-folds to 'jobs' (e.g. 'Jobs') is not an absent inventory: GitHub
  // rejects it, and its content stays unresolved rather than reading as zero jobs.
  const provedWithoutJobs =
    fields !== undefined && ![...fields.keys()].some((key) => key.toLowerCase() === 'jobs');
  if (!inventoryKnown && !provedWithoutJobs)
    jobs.push({ name: '<unresolved-workflow>', stepCount: 0, matrixSizes: [] });
  // Best-effort diagnostic metadata comes from actual runs.steps, never descriptive text.
  // Missing using identity cannot certify execution: actionEffect still requires composite.
  const runs = yamlMap(fields?.get('runs'));
  if (runs && (!runs.has('using') || yamlString(runs.get('using')) === 'composite'))
    captureSteps(runs.get('steps'));
  const triggers = yamlMap(fields?.get('on'));
  if (triggers) {
    for (const trigger of triggers.values()) {
      const options = yamlMap(trigger);
      for (const [key, target] of [
        ['paths', onPaths],
        ['paths-ignore', onPathsIgnore],
      ] as const) {
        const values = options?.get(key);
        if (values?.kind !== 'list') continue;
        for (const value of values.items) {
          const path = yamlString(value);
          if (path) target.push(path);
        }
      }
    }
  }
  function unboundAware(name: string): ReturnType<typeof jobEffectFacts> | Record<string, never> {
    const facts = jobEffectFacts(content, repoRoot, name);
    if (bound || !inventoryKnown) return facts;
    return facts.concurrency !== undefined ||
      facts.environment !== undefined ||
      facts.needs !== undefined ||
      facts.condition !== undefined ||
      Object.keys(facts.permissions ?? {}).length > 0
      ? facts
      : {};
  }
  const logicalRoot = resolve(repoRoot);
  const rel =
    isAbsolute(file) && pathWithin(logicalRoot, file)
      ? relative(logicalRoot, file).split(sep).join('/')
      : isAbsolute(file) && root && pathWithin(root, file)
        ? relative(root, file).split(sep).join('/')
        : file;
  return {
    file,
    relativeFile: rel,
    onPaths: [...new Set(onPaths)],
    onPathsIgnore: [...new Set(onPathsIgnore)],
    hasPermissionsBlock: fields?.has('permissions') ?? false,
    hasConcurrencyBlock: fields?.has('concurrency') ?? false,
    actionUses,
    jobs: jobs.map((job) => {
      const dims = job.matrixSizes.length;
      const combos = job.matrixSizes.reduce((acc, n) => acc * n, 1);
      return {
        name: job.name,
        stepCount: job.stepCount,
        matrixDimensions: dims,
        matrixCombinations: dims === 0 ? 0 : combos,
        // Bound source and all unresolved inventories always carry their facts. Unbound
        // structural parsing keeps every declared job control with its UNKNOWN effect and
        // omits facts only for a job that declares no control at all.
        ...unboundAware(job.name),
      };
    }),
    runStepCount: runScripts.length,
    runScripts,
    hasCache,
    reusableWorkflowUses: reusable,
    compositeActionUses: composites,
  };
}

function loadCompositeActionFlags(
  repoRoot: string,
  ref: string,
): { hasCache: boolean; actionUses: readonly ActionUse[]; runScripts: readonly string[] } | null {
  const normalized = ref.replace(/^\.\//, '');
  const primary = sourceBinding(repoRoot, join(normalized, 'action.yml'));
  const alternate = primary ? undefined : sourceBinding(repoRoot, join(normalized, 'action.yaml'));
  const selected = primary ?? alternate;
  if (!selected) return null;
  const bound = readBoundSource(repoRoot, selected.logical, true);
  if (!bound) return null;
  const { file: actionPath, source: content } = bound;
  const parsed = parseWorkflow(actionPath, content, repoRoot);
  return {
    hasCache: parsed.hasCache,
    actionUses: parsed.actionUses,
    runScripts: parsed.runScripts,
  };
}

export function loadWorkflows(repoRoot: string, dir?: string): WorkflowAst[] {
  const files = listWorkflowFiles(repoRoot, dir);
  const out: WorkflowAst[] = [];
  for (const f of files) {
    const bound = readBoundSource(repoRoot, f, true);
    if (!bound) continue; // Unreadable workflow entries are skipped, never fabricated.
    const { file, source: content } = bound;
    const wf = parseWorkflow(file, content, repoRoot);
    if (wf.compositeActionUses.length === 0) {
      out.push(wf);
      continue;
    }
    let mergedHasCache = wf.hasCache;
    const mergedActionUses = [...wf.actionUses];
    const mergedRunScripts = [...wf.runScripts];
    for (const ref of wf.compositeActionUses) {
      const composite = loadCompositeActionFlags(repoRoot, ref);
      if (composite === null) continue;
      if (composite.hasCache) mergedHasCache = true;
      mergedActionUses.push(...composite.actionUses);
      mergedRunScripts.push(...composite.runScripts);
    }
    out.push({
      ...wf,
      hasCache: mergedHasCache,
      actionUses: mergedActionUses,
      runScripts: mergedRunScripts,
    });
  }
  return out;
}

/**
 * Input classes of a registered action (WHOLE19-REV-002 R1/R2):
 * - inert: data that cannot change which bytes run or which authority is used;
 * - reducing: admitted only as its capability-reducing literal (persist-credentials: false);
 * - credential: admitted only absent or as the ambient job token expression;
 * - selector: selects source, runtime, server, host trust, paths or credentials;
 * - executable: carries code the action executes.
 * Undeclared names are inert only on a full-SHA pinned reference (R3); every other class and
 * every unlisted action is UNKNOWN by construction.
 */
type ActionInputClass = 'inert' | 'reducing' | 'credential' | 'selector' | 'executable';
interface RegisteredAction {
  readonly effect: 'read-only' | 'publication';
  /** Restores or downloads bytes into the workspace (WHOLE19-REV-012). */
  readonly bytesSelector: boolean;
  readonly inputs: Readonly<Record<string, ActionInputClass>>;
}
const REGISTERED_ACTIONS: ReadonlyMap<string, RegisteredAction> = new Map<string, RegisteredAction>(
  [
    [
      'actions/checkout',
      {
        effect: 'read-only',
        bytesSelector: false,
        inputs: {
          'fetch-depth': 'inert',
          'fetch-tags': 'inert',
          'show-progress': 'inert',
          clean: 'inert',
          'set-safe-directory': 'inert',
          'persist-credentials': 'reducing',
          token: 'credential',
          repository: 'selector',
          ref: 'selector',
          path: 'selector',
          'sparse-checkout': 'selector',
          'sparse-checkout-cone-mode': 'selector',
          submodules: 'selector',
          filter: 'selector',
          lfs: 'selector',
          'github-server-url': 'selector',
          'ssh-strict': 'selector',
          'ssh-known-hosts': 'selector',
          'ssh-key': 'selector',
          'ssh-user': 'selector',
        },
      },
    ],
    [
      'actions/setup-node',
      {
        effect: 'read-only',
        bytesSelector: false,
        inputs: {
          'node-version': 'inert',
          'node-version-file': 'inert',
          cache: 'inert',
          'cache-dependency-path': 'inert',
          'check-latest': 'inert',
          architecture: 'inert',
          token: 'credential',
          mirror: 'selector',
          'mirror-token': 'selector',
          'registry-url': 'selector',
          scope: 'selector',
          'always-auth': 'selector',
        },
      },
    ],
    [
      'actions/cache',
      {
        // Any restore input selects arbitrary workspace paths (R2).
        effect: 'read-only',
        bytesSelector: true,
        inputs: {
          path: 'selector',
          key: 'selector',
          'restore-keys': 'selector',
          enableCrossOsArchive: 'selector',
          'fail-on-cache-miss': 'selector',
          'lookup-only': 'selector',
          'save-always': 'selector',
          'upload-chunk-size': 'selector',
        },
      },
    ],
    [
      'actions/upload-artifact',
      {
        effect: 'read-only',
        bytesSelector: false,
        inputs: {
          name: 'inert',
          path: 'inert',
          'if-no-files-found': 'inert',
          'retention-days': 'inert',
          'compression-level': 'inert',
          'include-hidden-files': 'selector',
          overwrite: 'selector',
        },
      },
    ],
    [
      'actions/download-artifact',
      {
        effect: 'read-only',
        bytesSelector: true,
        inputs: {
          name: 'selector',
          pattern: 'selector',
          path: 'selector',
          'merge-multiple': 'selector',
          repository: 'selector',
          'run-id': 'selector',
          'github-token': 'selector',
        },
      },
    ],
    [
      'actions/upload-pages-artifact',
      {
        effect: 'read-only',
        bytesSelector: false,
        inputs: { name: 'inert', path: 'inert', 'retention-days': 'inert' },
      },
    ],
    [
      'pnpm/action-setup',
      {
        effect: 'read-only',
        bytesSelector: false,
        inputs: {
          version: 'inert',
          run_install: 'selector',
          dest: 'selector',
          standalone: 'selector',
          package_json_file: 'selector',
        },
      },
    ],
    [
      'actions/deploy-pages',
      {
        effect: 'publication',
        bytesSelector: false,
        inputs: {
          timeout: 'inert',
          error_count: 'inert',
          reporting_interval: 'inert',
          artifact_name: 'inert',
          preview: 'inert',
          token: 'credential',
        },
      },
    ],
    [
      'actions/github-script',
      {
        effect: 'publication',
        bytesSelector: false,
        inputs: {
          script: 'executable',
          'github-token': 'credential',
          debug: 'inert',
          'user-agent': 'inert',
          previews: 'inert',
          'result-encoding': 'inert',
          retries: 'inert',
          'retry-exempt-status-codes': 'inert',
        },
      },
    ],
    [
      'softprops/action-gh-release',
      {
        effect: 'publication',
        bytesSelector: false,
        inputs: {
          body: 'inert',
          body_path: 'inert',
          name: 'inert',
          tag_name: 'inert',
          draft: 'inert',
          prerelease: 'inert',
          files: 'inert',
          fail_on_unmatched_files: 'inert',
          target_commitish: 'inert',
          discussion_category_name: 'inert',
          generate_release_notes: 'inert',
          append_body: 'inert',
          make_latest: 'inert',
          repository: 'selector',
          token: 'credential',
        },
      },
    ],
  ],
);
/**
 * The canonical form of one step's YAML: maps with sorted keys, lists in order, scalars by
 * value. Undefined when any node is opaque, since its bytes would escape the digest.
 */
function canonicalStep(value: ExecutionYaml): unknown {
  switch (value.kind) {
    case 'scalar':
      return value.value;
    case 'list': {
      const items = value.items.map(canonicalStep);
      return items.includes(undefined) ? undefined : items;
    }
    case 'map': {
      const entries = [...value.entries.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonicalStep(item)] as const);
      return entries.some(([, item]) => item === undefined)
        ? undefined
        : Object.fromEntries(entries);
    }
    default:
      return undefined;
  }
}

/** sha256 of a step's canonical YAML, or undefined for a step with an opaque node. */
export function workflowStepDigest(step: ExecutionYaml): string | undefined {
  const canonical = canonicalStep(step);
  if (canonical === undefined || typeof canonical !== 'object' || Array.isArray(canonical))
    return undefined;
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

const REVIEWED_STEP_EFFECTS: ReadonlyMap<string, 'read-only' | 'publication'> = new Map(
  REVIEWED_WORKFLOW_STEPS.map((entry) => [entry.sha256, entry.effect] as const),
);

function reviewedStepEffect(step: ExecutionYaml): 'read-only' | 'publication' | undefined {
  const digest = workflowStepDigest(step);
  return digest === undefined ? undefined : REVIEWED_STEP_EFFECTS.get(digest);
}

/** Every step of every job in a workflow source with its canonical digest (#325 review aid). */
export function workflowStepInventory(
  content: string,
): readonly { job: string; index: number; name: string; sha256: string | undefined }[] {
  const jobs = yamlMap(yamlMap(executionYaml(content))?.get('jobs'));
  if (!jobs) return [];
  const out: { job: string; index: number; name: string; sha256: string | undefined }[] = [];
  for (const [job, definition] of jobs) {
    const steps = yamlMap(definition)?.get('steps');
    if (steps?.kind !== 'list') continue;
    steps.items.forEach((step, index) => {
      out.push({
        job,
        index,
        name:
          yamlString(yamlMap(step)?.get('name')) ?? yamlString(yamlMap(step)?.get('uses')) ?? '',
        sha256: workflowStepDigest(step),
      });
    });
  }
  return out;
}

/** A remote owner/repo[@ref] step reference; nested paths and docker:// never match. */
function remoteActionReference(use: string): { target: string; ref?: string } | undefined {
  const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:@([A-Za-z0-9_./-]+))?$/u.exec(use);
  if (!match) return undefined;
  return { target: match[1] ?? '', ...(match[2] === undefined ? {} : { ref: match[2] }) };
}
const AMBIENT_TOKEN = /^\$\{\{\s*(?:github\.token|secrets\.GITHUB_TOKEN)\s*\}\}$/u;
/** R2-R4 admission of one registered action's inputs; any doubt is UNKNOWN. */
function actionInputsAdmitted(
  action: RegisteredAction,
  ref: string | undefined,
  inputs: Map<string, ExecutionYaml>,
): boolean {
  // R3: undeclared names are inert only against a full-SHA pinned revision; an absent or
  // branch/tag reference with any input has no declared-input proof.
  if (ref === undefined || !/^[0-9a-f]{40}$/u.test(ref)) return false;
  // GitHub delivers every input as INPUT_<NAME upper-cased>, so input names are matched
  // case-insensitively: both the table and the step keys are folded before lookup, and two
  // step keys that fold to one name have no proved delivered value (WHOLE19-R2-001).
  const fold = (name: string): string => name.toLowerCase();
  const declared = new Map(
    Object.entries(action.inputs).map(([name, kind]) => [fold(name), kind] as const),
  );
  const seen = new Set<string>();
  for (const [key, value] of inputs) {
    const name = fold(key);
    if (seen.has(name)) return false;
    seen.add(name);
    if (value.kind !== 'scalar' || value.syntax === 'block') return false; // R4 shape.
    const text = value.value;
    const expression = text.includes('${{');
    const kind = declared.get(name) ?? 'inert';
    if (kind === 'inert') continue; // R4: expressions only in inert inputs.
    if (kind === 'reducing') {
      if (expression || value.syntax !== 'plain' || text !== 'false') return false;
      continue;
    }
    if (kind === 'credential') {
      if (!AMBIENT_TOKEN.test(text.trim()) || text.trim() !== text) return false;
      continue;
    }
    return false; // selector or executable.
  }
  return true;
}

/** Conservative per-job coverage. Unknown reachable code cannot certify cancellation safety. */
export function jobEffectFacts(
  content: string,
  repoRoot: string,
  name: string,
  visited = new Set<string>(),
): Pick<
  WorkflowJob,
  'effect' | 'concurrency' | 'condition' | 'needs' | 'environment' | 'permissions' | 'runScripts'
> {
  let effect: 'read-only' | 'publication' | 'unknown' = 'read-only';
  const mark = (next: typeof effect) => {
    if (next === 'unknown' || effect === 'unknown') effect = 'unknown';
    else if (next === 'publication') effect = 'publication';
  };
  type Effect = 'read-only' | 'publication' | 'unknown';
  const combine = (a: Effect, b: Effect): Effect =>
    a === 'unknown' || b === 'unknown'
      ? 'unknown'
      : a === 'publication' || b === 'publication'
        ? 'publication'
        : 'read-only';
  // Registered application data only; unproved loader/runtime/output/config selectors refuse.
  // #325: the job- and workflow-level data names the four DEVAI workflows declare. Each
  // carries a commit, a tag, a ref, a package name or a count; none selects code, a loader,
  // a runtime, an output path or configuration. Step-level env is reviewed with its step.
  const inertEnvironment = new Set([
    'OBSERVATION_ONLY',
    'DESTINATION',
    'CI',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'DEVAI_PREFLIGHT_BASE',
    'CANDIDATE_SHA',
    'CANDIDATE_REF',
    'PACKAGE_NAME',
    'EXPECTED_ACTION_COUNT',
    'RELEASE_TAG',
  ]);
  function loaderVariable(key: string): boolean {
    return !inertEnvironment.has(key);
  }
  function executionMetadata(fields: Map<string, ExecutionYaml>): boolean {
    const environment = fields.get('env');
    if (environment !== undefined) {
      const entries = yamlMap(environment);
      // A plain decimal integer is data too (#325: EXPECTED_ACTION_COUNT: 69).
      const dataValue = (value: ExecutionYaml): boolean =>
        yamlString(value) !== undefined ||
        (value.kind === 'scalar' &&
          value.syntax === 'plain' &&
          /^(?:0|[1-9]\d{0,8})$/u.test(value.value));
      if (!entries || [...entries].some(([key, value]) => loaderVariable(key) || !dataValue(value)))
        return false;
    }
    if (fields.has('container') || fields.has('services')) return false;
    const shell = fields.get('shell');
    if (
      shell !== undefined &&
      !new Set(['bash', 'sh', 'bash --noprofile --norc -e -o pipefail {0}', 'sh -e {0}']).has(
        yamlString(shell) ?? '',
      )
    )
      return false;
    const cwd = fields.get('working-directory');
    if (cwd !== undefined && !['.', './'].includes(yamlString(cwd) ?? '')) return false;
    const runner = fields.get('runs-on');
    if (runner !== undefined && !/^ubuntu-(?:latest|\d{2}\.\d{2})$/u.test(yamlString(runner) ?? ''))
      return false;
    const defaults = fields.get('defaults');
    if (defaults !== undefined) {
      const entries = yamlMap(defaults);
      if (!entries || [...entries.keys()].some((key) => key !== 'run')) return false;
      const run = entries.get('run');
      if (run !== undefined) {
        const options = yamlMap(run);
        if (
          !options ||
          [...options.keys()].some((key) => !['shell', 'working-directory'].includes(key)) ||
          !executionMetadata(options)
        )
          return false;
      }
    }
    return true;
  }
  type ActionStep = { reference: string; inputs?: Map<string, ExecutionYaml> };
  // bytesReplaced: a registered byte selector (cache restore, artifact download) precedes a
  // later workspace execution (run step or local action), so the analysed bytes may not run.
  type Executions = {
    scripts: string[];
    uses: ActionStep[];
    bytesSelected: boolean;
    bytesReplaced: boolean;
    /** Declared effects of steps found in the reviewed-step registry (#325). */
    reviewed: Effect[];
  };
  function executionSteps(value: ExecutionYaml | undefined): Executions | undefined {
    if (value?.kind !== 'list') return undefined;
    const result: Executions = {
      scripts: [],
      uses: [],
      bytesSelected: false,
      bytesReplaced: false,
      reviewed: [],
    };
    const allowed = new Set([
      'name',
      'id',
      'if',
      'run',
      'uses',
      'shell',
      'working-directory',
      'env',
      'with',
      'continue-on-error',
      'timeout-minutes',
    ]);
    for (const step of value.items) {
      // A reviewed step contributes its declared effect; its inputs, env and the bytes it
      // runs were judged in review against its exact canonical YAML (#325). A byte selector
      // among reviewed steps still replaces the bytes any later unreviewed step would run.
      const reviewed = reviewedStepEffect(step);
      if (reviewed !== undefined) {
        const reference = yamlString(yamlMap(step)?.get('uses'));
        const remote = reference === undefined ? undefined : remoteActionReference(reference);
        if (remote && REGISTERED_ACTIONS.get(remote.target)?.bytesSelector)
          result.bytesSelected = true;
        result.reviewed.push(reviewed);
        continue;
      }
      const fields = yamlMap(step);
      if (
        !fields ||
        [...fields.keys()].some((key) => !allowed.has(key)) ||
        !executionMetadata(fields)
      )
        return undefined;
      const run = fields.get('run'),
        use = fields.get('uses');
      if ((run === undefined) === (use === undefined)) return undefined;
      if (run !== undefined) {
        const script = yamlText(run);
        if (script === undefined || fields.has('with')) return undefined;
        if (result.bytesSelected) result.bytesReplaced = true;
        result.scripts.push(script);
      } else {
        const reference = yamlString(use);
        if (reference === undefined || fields.has('shell') || fields.has('working-directory'))
          return undefined;
        if (reference.startsWith('./') && result.bytesSelected) result.bytesReplaced = true;
        const remote = remoteActionReference(reference);
        if (remote && REGISTERED_ACTIONS.get(remote.target)?.bytesSelector)
          result.bytesSelected = true;
        // Inputs are kept with their action; actionEffect admits them only as inert data
        // of a registered remote capability and refuses every other input selection.
        const inputs = fields.get('with');
        if (inputs === undefined) result.uses.push({ reference });
        else {
          const entries = yamlMap(inputs);
          if (!entries) return undefined;
          result.uses.push({ reference, inputs: entries });
        }
      }
    }
    return result;
  }
  function conditionValue(value: ExecutionYaml): string | undefined {
    const boolean = yamlBoolean(value);
    if (boolean !== undefined) return String(boolean);
    let text = yamlString(value)?.trim();
    if (text === undefined || !text || text.length > 4096) return undefined;
    if (text.startsWith('${{') && text.endsWith('}}')) text = text.slice(3, -2).trim();
    if (text.includes('${{')) return undefined;
    const tokens: string[] = [];
    const token = /\s*(?:('(?:[^']|'')*')|([A-Za-z_][A-Za-z0-9_.]*)|(==|!=|&&|\|\||[!()]))/uy;
    let offset = 0;
    while (offset < text.length) {
      token.lastIndex = offset;
      const match = token.exec(text);
      if (!match) return undefined;
      tokens.push(match[1] ?? match[2]?.toLowerCase() ?? match[3] ?? '');
      if (tokens.length > 256) return undefined;
      offset = token.lastIndex;
    }
    let cursor = 0;
    const contexts = new Set([
      'github.ref',
      'github.event_name',
      'github.repository',
      'github.workflow',
      'github.sha',
      'github.actor',
    ]);
    const statuses = new Set(['success', 'always', 'failure', 'cancelled']);
    function primary(): boolean {
      if (tokens[cursor] === '!') {
        cursor++;
        return primary();
      }
      if (tokens[cursor] === '(') {
        cursor++;
        if (!expression() || tokens[cursor++] !== ')') return false;
        return true;
      }
      const value = tokens[cursor++];
      if (!value) return false;
      if (statuses.has(value)) return tokens[cursor++] === '(' && tokens[cursor++] === ')';
      // #325: a workflow_dispatch input is run data the dispatcher chose, never a status or
      // code selector, so a job condition may read it.
      return (
        value.startsWith("'") ||
        contexts.has(value) ||
        /^inputs\.[a-z_][a-z0-9_-]*$/u.test(value) ||
        ['true', 'false'].includes(value)
      );
    }
    function comparison(): boolean {
      if (!primary()) return false;
      if (['==', '!='].includes(tokens[cursor] ?? '')) {
        cursor++;
        return primary();
      }
      return true;
    }
    function conjunction(): boolean {
      if (!comparison()) return false;
      while (tokens[cursor] === '&&') {
        cursor++;
        if (!comparison()) return false;
      }
      return true;
    }
    function expression(): boolean {
      if (!conjunction()) return false;
      while (tokens[cursor] === '||') {
        cursor++;
        if (!conjunction()) return false;
      }
      return true;
    }
    return expression() && cursor === tokens.length ? tokens.join(' ') : undefined;
  }
  const unsafeControls = (): Pick<
    WorkflowJob,
    'effect' | 'concurrency' | 'condition' | 'needs' | 'environment' | 'permissions' | 'runScripts'
  > => ({ effect: 'unknown', permissions: {}, runScripts: [] });
  const workflowFields = yamlMap(executionYaml(content));
  const jobs = yamlMap(workflowFields?.get('jobs'));
  const jobFields = yamlMap(jobs?.get(name));
  if (!workflowFields || !jobs || !jobFields) return unsafeControls();
  const permissionNames = new Set([
    'actions',
    'attestations',
    'checks',
    'contents',
    'deployments',
    'discussions',
    'id-token',
    'issues',
    'models',
    'packages',
    'pages',
    'pull-requests',
    'security-events',
    'statuses',
  ]);
  function permissionValue(value: ExecutionYaml | undefined): Record<string, string> | undefined {
    if (value === undefined) return {};
    const all = yamlString(value);
    if (all === 'read-all' || all === 'write-all')
      return { '*': all === 'write-all' ? 'write' : 'read' }; // Declared wildcard, not invented individual scope grants.
    const fields = yamlMap(value);
    if (!fields) return undefined;
    const result: Record<string, string> = {};
    for (const [key, value] of fields) {
      const permission = yamlString(value);
      if (!permissionNames.has(key) || !['read', 'write', 'none'].includes(permission ?? ''))
        return undefined;
      result[key] = permission ?? '';
    }
    return result;
  }
  const permissions = permissionValue(jobFields.get('permissions'));
  const workflowPermissions = permissionValue(workflowFields.get('permissions'));
  if (!permissions || !workflowPermissions) return unsafeControls();
  const concurrency = controlConcurrency(jobFields.get('concurrency'));
  if (
    concurrency === null ||
    !rootConcurrencyExposed(content, workflowFields) ||
    !scheduleProjectionExposed(content, workflowFields)
  )
    return unsafeControls();
  let condition: string | undefined;
  if (jobFields.has('if')) {
    condition = conditionValue(jobFields.get('if') as ExecutionYaml);
    if (condition === undefined) return unsafeControls();
  }
  let needs: string[] | undefined;
  const prerequisites = jobFields.get('needs');
  if (prerequisites !== undefined) {
    const values = prerequisites.kind === 'list' ? prerequisites.items : [prerequisites];
    needs = [];
    for (const value of values) {
      const prerequisite = yamlString(value);
      if (
        !prerequisite ||
        !/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(prerequisite) ||
        !yamlMap(jobs.get(prerequisite))
      )
        return unsafeControls();
      needs.push(prerequisite);
    }
    if (new Set(needs).size !== needs.length) return unsafeControls();
  }
  let environment: WorkflowJob['environment'];
  const deployment = jobFields.get('environment');
  if (deployment !== undefined) {
    const text = yamlString(deployment);
    if (text !== undefined) environment = text;
    else {
      const fields = yamlMap(deployment);
      if (!fields || [...fields.keys()].some((key) => !['name', 'url'].includes(key)))
        return unsafeControls();
      const deploymentName = yamlString(fields.get('name'));
      const url = fields.has('url') ? yamlString(fields.get('url')) : undefined;
      if (deploymentName === undefined || (fields.has('url') && url === undefined))
        return unsafeControls();
      // Preserve declared environment.name semantics while validating its optional inert URL.
      environment = deploymentName;
    }
    if (
      typeof environment !== 'string' ||
      !environment.trim() ||
      /\$\{\{|[\r\n]/u.test(environment)
    )
      return unsafeControls();
  }
  let executions: Executions | undefined;
  if (executionMetadata(workflowFields) && executionMetadata(jobFields)) {
    if (jobFields.has('uses')) {
      const reference = yamlString(jobFields.get('uses'));
      // R5 / WHOLE19-REV-003: a reusable call forwarding with: or secrets: (including
      // inherit) hands inputs or credentials to its callee; that flow has no proof.
      if (
        reference !== undefined &&
        !jobFields.has('steps') &&
        !jobFields.has('with') &&
        !jobFields.has('secrets')
      )
        executions = {
          scripts: [],
          uses: [{ reference }],
          bytesSelected: false,
          bytesReplaced: false,
          reviewed: [],
        };
    } else executions = executionSteps(jobFields.get('steps'));
  }
  if (!executions || executions.bytesReplaced) mark('unknown');
  const scripts = executions?.scripts ?? [];
  const effectivePermissions = jobFields.has('permissions') ? permissions : workflowPermissions;
  if (environment !== undefined || Object.values(effectivePermissions).includes('write'))
    mark('publication');
  const root = candidateRoot(repoRoot);
  const sourceEffects = new Map<string, Effect>();
  const active = new Set(visited);
  function contained(path: string): { path: string; source: string } | undefined {
    if (!root) return undefined;
    try {
      const lexical = resolve(root, path);
      const rel = relative(root, lexical);
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
      const actual = realpathSync(lexical);
      const realRel = relative(root, actual);
      if (
        !realRel ||
        realRel === '..' ||
        realRel.startsWith(`..${sep}`) ||
        isAbsolute(realRel) ||
        !statSync(actual).isFile()
      )
        return undefined;
      return {
        path: actual,
        source: new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(actual)),
      };
    } catch {
      return undefined;
    }
  }
  function reachable(path: string): Effect {
    const file = contained(path);
    if (!file || active.has(file.path) || !/\.[cm]?[jt]s$/u.test(file.path)) return 'unknown';
    const cached = sourceEffects.get(file.path);
    if (cached !== undefined) return cached;
    active.add(file.path);
    // Nested declarations do not inherit control-flow narrowing; bind the proved origin once.
    const origin = file.path;
    type Value = {
      kind: 'data' | 'namespace' | 'call' | 'function' | 'promise' | 'opaque' | 'unknown';
      module?: string;
      operation?: string;
      literal?: string;
      primitive?: true;
      declaration?: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
      captured?: Scope;
      settled?: Value;
    };
    type Scope = Map<string, Value>;
    const data: Value = { kind: 'data' };
    const unknown: Value = { kind: 'unknown' };
    let result: Effect = 'read-only';
    const refuse = (): Value => {
      result = 'unknown';
      return unknown;
    };
    const fsReads = new Set([
      'readFile',
      'readFileSync',
      'stat',
      'statSync',
      'lstat',
      'lstatSync',
      'readdir',
      'readdirSync',
      'realpath',
      'realpathSync',
      'existsSync',
      'access',
      'accessSync',
      'readlink',
      'readlinkSync',
    ]);
    const fsWrites = new Set([
      'writeFile',
      'writeFileSync',
      'appendFile',
      'appendFileSync',
      'mkdir',
      'mkdirSync',
      'rm',
      'rmSync',
      'rmdir',
      'rmdirSync',
      'unlink',
      'unlinkSync',
      'rename',
      'renameSync',
      'copyFile',
      'copyFileSync',
      'cp',
      'cpSync',
      'chmod',
      'chmodSync',
      'chown',
      'chownSync',
      'link',
      'linkSync',
      'symlink',
      'symlinkSync',
      'truncate',
      'truncateSync',
    ]);
    const pathReads = new Set([
      'join',
      'resolve',
      'relative',
      'dirname',
      'basename',
      'extname',
      'normalize',
      'isAbsolute',
      'parse',
      'format',
      'toNamespacedPath',
    ]);
    const assertions = new Set([
      'ok',
      'equal',
      'notEqual',
      'strictEqual',
      'notStrictEqual',
      'deepEqual',
      'notDeepEqual',
      'deepStrictEqual',
      'notDeepStrictEqual',
      'fail',
    ]);
    const unsafeDataKeys = new Set([
      '__proto__',
      'prototype',
      'constructor',
      'caller',
      'callee',
      'arguments',
      'toString',
      'valueOf',
      'toJSON',
      'then',
    ]);
    const namespace = (module: string): Value => ({ kind: 'namespace', module });
    const callable = (module: string, operation: string): Value => ({
      kind: 'call',
      module,
      operation,
    });
    const activeFunctions = new Set<ts.Node>();
    function localFunction(
      declaration: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
      scope: Scope,
    ): Value {
      if (!ts.isArrowFunction(declaration) && declaration.asteriskToken) return refuse();
      return { kind: 'function', declaration, captured: scope };
    }
    function invokeLocal(fn: Value, args: readonly Value[]): Value {
      const declaration = fn.declaration;
      if (!declaration?.body || !fn.captured || activeFunctions.has(declaration)) return refuse();
      const scope = new Map(fn.captured);
      if (args.length > declaration.parameters.length) return refuse();
      for (const [index, parameter] of declaration.parameters.entries()) {
        if (!ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken)
          return refuse();
        scope.set(parameter.name.text, args[index] ?? data);
      }
      activeFunctions.add(declaration);
      try {
        const returned: Value[] = [];
        if (ts.isBlock(declaration.body)) statements(declaration.body.statements, scope, returned);
        else returned.push(expression(declaration.body, scope));
        if (returned.some((value) => !['data', 'opaque', 'promise'].includes(value.kind)))
          return refuse();
        const value: Value = returned.some((item) => item.kind !== 'data')
          ? { kind: 'opaque' }
          : data;
        return declaration.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
        )
          ? { kind: 'promise', settled: value }
          : value;
      } finally {
        activeFunctions.delete(declaration);
      }
    }
    function builtin(specifier: string): Value {
      const module = specifier.replace(/^node:/u, '');
      return [
        'fs',
        'fs/promises',
        'path',
        'path/posix',
        'path/win32',
        'assert',
        'assert/strict',
      ].includes(module)
        ? namespace(module)
        : refuse();
    }
    function member(base: Value, key: string): Value {
      if (base.kind === 'data') return unsafeDataKeys.has(key) ? refuse() : data;
      if (base.kind !== 'namespace') return refuse();
      const module = base.module ?? '';
      if (module === 'process' && key === 'env') return namespace('process/env');
      if (module === 'process/env')
        return unsafeDataKeys.has(key) ? refuse() : { kind: 'data', primitive: true };
      if (module === 'fs' && key === 'promises') return namespace('fs/promises');
      if (
        module.startsWith('fs') &&
        (fsReads.has(key) || fsWrites.has(key)) &&
        !(module === 'fs/promises' && key.endsWith('Sync'))
      )
        return callable(module, key);
      if (module.startsWith('path')) {
        if (['sep', 'delimiter'].includes(key)) return data;
        if (['posix', 'win32'].includes(key)) return namespace(`path/${key}`);
        if (pathReads.has(key)) return callable(module, key);
      }
      if (module.startsWith('assert')) {
        if (key === 'strict') return namespace('assert/strict');
        if (assertions.has(key)) return callable(module, key);
      }
      if (module === 'JSON' && ['parse', 'stringify'].includes(key)) return callable(module, key);
      if (module === 'console' && ['log', 'info', 'warn', 'error', 'debug'].includes(key))
        return callable(module, key);
      return refuse();
    }
    function keyOf(node: ts.PropertyName | ts.Expression): string | undefined {
      if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node))
        return node.text;
      return undefined;
    }
    function expression(node: ts.Expression, scope: Scope): Value {
      if (
        ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isTypeAssertionExpression(node)
      )
        return expression(node.expression, scope);
      if (ts.isStringLiteralLike(node))
        return { kind: 'data', literal: node.text, primitive: true };
      if (
        ts.isNumericLiteral(node) ||
        ts.isBigIntLiteral(node) ||
        [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(
          node.kind,
        )
      )
        return data;
      if (ts.isIdentifier(node)) {
        const bound = scope.get(node.text);
        if (bound) return bound.kind === 'unknown' ? refuse() : bound;
        if (['undefined', '__dirname', '__filename', 'NaN', 'Infinity'].includes(node.text))
          return data;
        if (['JSON', 'console'].includes(node.text)) return namespace(node.text);
        if (node.text === 'process') return namespace('process');
        if (node.text === 'fetch') return callable('global', 'fetch');
        return refuse();
      }
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
        return localFunction(node, scope);
      if (ts.isPropertyAccessExpression(node)) {
        if (node.questionDotToken) return refuse();
        return member(expression(node.expression, scope), node.name.text);
      }
      if (ts.isElementAccessExpression(node)) {
        const key = node.argumentExpression
          ? expression(node.argumentExpression, scope).literal
          : undefined;
        return key === undefined || node.questionDotToken
          ? refuse()
          : member(expression(node.expression, scope), key);
      }
      if (ts.isArrayLiteralExpression(node)) {
        for (const element of node.elements)
          if (ts.isSpreadElement(element) || expression(element, scope).kind !== 'data')
            return refuse();
        return data;
      }
      if (ts.isObjectLiteralExpression(node)) {
        for (const property of node.properties) {
          if (ts.isPropertyAssignment(property)) {
            const key = keyOf(property.name);
            if (
              key === undefined ||
              unsafeDataKeys.has(key) ||
              expression(property.initializer, scope).kind !== 'data'
            )
              return refuse();
          } else if (ts.isShorthandPropertyAssignment(property)) {
            if (
              unsafeDataKeys.has(property.name.text) ||
              property.objectAssignmentInitializer ||
              expression(property.name, scope).kind !== 'data'
            )
              return refuse();
          } else return refuse(); // Getters, methods, spreads and computed hooks are executable.
        }
        return data;
      }
      if (ts.isTemplateExpression(node)) {
        for (const span of node.templateSpans)
          if (expression(span.expression, scope).kind !== 'data') return refuse();
        return data;
      }
      if (ts.isBinaryExpression(node)) {
        if (
          node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        )
          return refuse();
        return expression(node.left, scope).kind === 'data' &&
          expression(node.right, scope).kind === 'data'
          ? data
          : refuse();
      }
      if (ts.isConditionalExpression(node)) {
        const condition = expression(node.condition, scope);
        const yes = expression(node.whenTrue, scope),
          no = expression(node.whenFalse, scope);
        return condition.kind === 'data' && yes.kind === 'data' && no.kind === 'data'
          ? data
          : refuse();
      }
      if (ts.isPrefixUnaryExpression(node)) {
        if ([ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator))
          return refuse();
        return expression(node.operand, scope).kind === 'data' ? data : refuse();
      }
      if (ts.isTypeOfExpression(node) || ts.isVoidExpression(node))
        return expression(node.expression, scope).kind === 'data' ? data : refuse();
      if (ts.isAwaitExpression(node)) {
        const value = expression(node.expression, scope);
        return value.kind === 'promise' ? (value.settled ?? { kind: 'opaque' }) : refuse();
      }
      if (ts.isCallExpression(node)) {
        if (node.questionDotToken || node.expression.kind === ts.SyntaxKind.ImportKeyword)
          return refuse();
        if (
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'require' &&
          !scope.has('require')
        ) {
          const argument = node.arguments[0];
          if (node.arguments.length !== 1 || !argument || !ts.isStringLiteralLike(argument))
            return refuse();
          if (argument.text.startsWith('.')) {
            result = combine(result, reachable(resolve(dirname(origin), argument.text)));
            return unknown; // Imported export provenance has not been proved.
          }
          return builtin(argument.text);
        }
        const fn = expression(node.expression, scope);
        const args = node.arguments.map((arg) =>
          ts.isSpreadElement(arg) ? refuse() : expression(arg, scope),
        );
        if (args.some((arg) => arg.kind !== 'data')) return refuse();
        if (fn.kind === 'function') return invokeLocal(fn, args);
        const module = fn.module ?? '',
          operation = fn.operation ?? '';
        if (fn.kind === 'namespace' && module.startsWith('assert')) return data;
        if (fn.kind !== 'call') return refuse();
        if (module === 'global' && operation === 'fetch') {
          if (!args.length || args.length > 2) return refuse();
          result = combine(result, 'publication');
          return { kind: 'promise', settled: { kind: 'opaque' } }; // Native Promise; Response methods remain unproved.
        }
        if (module === 'JSON') {
          if (!args.length || args.length > 1) return refuse(); // Reviver/replacer callbacks are unproved.
          return data; // Inert JSON data; no getters, proxies, callbacks or custom prototypes.
        }
        if (module.startsWith('fs')) {
          if (fsWrites.has(operation)) result = combine(result, 'publication');
          if (module === 'fs/promises') {
            const encoding = node.arguments[1];
            const settled =
              operation === 'readFile' &&
              encoding &&
              ts.isStringLiteralLike(encoding) &&
              ['utf8', 'utf-8'].includes(encoding.text)
                ? data
                : { kind: 'opaque' as const };
            return { kind: 'promise', settled };
          }
          if (operation === 'readFileSync') {
            const encoding = node.arguments[1];
            return encoding &&
              ts.isStringLiteralLike(encoding) &&
              ['utf8', 'utf-8'].includes(encoding.text)
              ? data
              : { kind: 'opaque' };
          }
          // Native handles, buffers, Stats methods and promises are not inert data proofs.
          return { kind: 'opaque' };
        }
        if (module.startsWith('path') || module.startsWith('assert') || module === 'console')
          return data;
        return refuse();
      }
      // Constructors, arbitrary thenables, tags, loops/iteration and unmodeled execution refuse.
      return refuse();
    }
    function bind(name: ts.BindingName, value: Value, scope: Scope): void {
      if (ts.isIdentifier(name)) {
        if (scope.has(name.text)) refuse();
        scope.set(name.text, value);
        return;
      }
      if (!ts.isObjectBindingPattern(name)) {
        refuse();
        return;
      }
      for (const element of name.elements) {
        const property =
          element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : undefined);
        const key = property && keyOf(property);
        if (key === undefined || element.dotDotDotToken || element.initializer) {
          refuse();
          continue;
        }
        bind(element.name, member(value, key), scope);
      }
    }
    function statements(nodes: readonly ts.Statement[], scope: Scope, returned?: Value[]): void {
      for (const node of nodes) {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          if (
            (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) ||
            (ts.isExportDeclaration(node) && node.isTypeOnly)
          )
            continue;
          const specifier = node.moduleSpecifier;
          if (!specifier && ts.isExportDeclaration(node)) continue;
          if (!specifier || !ts.isStringLiteralLike(specifier)) {
            refuse();
            continue;
          }
          let value: Value;
          if (specifier.text.startsWith('.')) {
            result = combine(result, reachable(resolve(dirname(origin), specifier.text)));
            value = unknown;
          } else value = builtin(specifier.text);
          if (ts.isImportDeclaration(node) && node.importClause) {
            const clause = node.importClause;
            if (clause.name) bind(clause.name, value, scope);
            if (clause.namedBindings) {
              if (ts.isNamespaceImport(clause.namedBindings))
                bind(clause.namedBindings.name, value, scope);
              else
                for (const element of clause.namedBindings.elements)
                  if (!element.isTypeOnly)
                    bind(
                      element.name,
                      member(value, (element.propertyName ?? element.name).text),
                      scope,
                    );
            }
          }
        } else if (ts.isVariableStatement(node)) {
          if (!(node.declarationList.flags & ts.NodeFlags.Const)) {
            refuse();
            continue;
          }
          for (const declaration of node.declarationList.declarations) {
            const value = declaration.initializer
              ? expression(declaration.initializer, scope)
              : refuse();
            bind(declaration.name, value, scope);
          }
        } else if (ts.isFunctionDeclaration(node)) {
          if (!node.name) refuse();
          else bind(node.name, localFunction(node, scope), scope);
        } else if (ts.isExpressionStatement(node)) expression(node.expression, scope);
        else if (ts.isBlock(node)) statements(node.statements, new Map(scope), returned);
        else if (ts.isIfStatement(node)) {
          if (expression(node.expression, scope).kind !== 'data') refuse();
          statements([node.thenStatement], new Map(scope), returned);
          if (node.elseStatement) statements([node.elseStatement], new Map(scope), returned);
        } else if (ts.isReturnStatement(node)) {
          if (!returned) refuse();
          else returned.push(node.expression ? expression(node.expression, scope) : data);
        } else if (ts.isThrowStatement(node)) {
          if (expression(node.expression, scope).kind !== 'data') refuse();
        } else if (ts.isExportAssignment(node)) {
          if (expression(node.expression, scope).kind !== 'data') refuse();
        } else if (
          !ts.isEmptyStatement(node) &&
          !ts.isInterfaceDeclaration(node) &&
          !ts.isTypeAliasDeclaration(node)
        )
          refuse();
      }
    }
    try {
      const ast = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true);
      if (
        (ast as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics
          .length
      )
        result = 'unknown';
      else statements(ast.statements, new Map());
    } finally {
      active.delete(file.path);
    }
    sourceEffects.set(file.path, result);
    return result;
  }

  /** A bounded POSIX word/list grammar; everything outside it requires a separate proof. */
  function commands(script: string): readonly (readonly string[])[] | undefined {
    if (script.includes('${{')) return undefined;
    const parts: string[][] = [];
    let words: string[] = [],
      word = '',
      started = false,
      quote = '';
    const finishWord = () => {
      if (started) words.push(word);
      word = '';
      started = false;
    };
    const finishCommand = () => {
      finishWord();
      if (words.length) parts.push(words);
      words = [];
    };
    for (let i = 0; i < script.length; i++) {
      const char = script[i] ?? '';
      if (quote === "'") {
        if (char === quote) quote = '';
        else word += char;
        continue;
      }
      if (quote === '"') {
        if (char === quote) quote = '';
        else {
          if (/[$`\\\r]/u.test(char)) return undefined;
          word += char;
        }
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char;
        started = true;
      } else if (char === '#' && !started) {
        while (i + 1 < script.length && script[i + 1] !== '\n') i++;
      } else if (char === ' ' || char === '\t') finishWord();
      else if (char === '\n' || char === ';') finishCommand();
      else {
        // Redirection, pipelines, background jobs, expansion, groups and escapes are unproved.
        if (/[|&<>$`\\(){}[\]*?~\r]/u.test(char)) return undefined;
        word += char;
        started = true;
      }
    }
    if (quote) return undefined;
    finishCommand();
    return parts;
  }
  function packageConfigurationUnknown(): boolean {
    if (!root) return true;
    // Package lifecycle prepends candidate node_modules/.bin to the executor search path.
    // Without a resolved bin capability, any bin scope (even empty or aliased) refuses.
    try {
      const modules = lstatSync(resolve(root, 'node_modules'));
      if (!modules.isDirectory() || modules.isSymbolicLink()) return true;
      try {
        lstatSync(resolve(root, 'node_modules', '.bin'));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
    }
    for (const name of [
      '.npmrc',
      '.pnpmfile.cjs',
      'pnpmfile.cjs',
      '.pnpmfile.js',
      'pnpm-workspace.yaml',
      'pnpm-workspace.yml',
    ]) {
      try {
        // Includes unreadable files, directories and dangling/escaping links; no config is skipped.
        lstatSync(resolve(root, name));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
      }
    }
    return false;
  }
  function packageEffect(
    manager: string,
    key: string,
    stack: Set<string>,
    publication = false,
  ): Effect {
    if (packageConfigurationUnknown()) return 'unknown';
    const manifest = contained('package.json');
    const identity = `${manager}:${publication ? '@publish' : key}`;
    if (!manifest || stack.has(identity)) return 'unknown';
    try {
      const parsed = JSON.parse(manifest.source) as {
        scripts?: unknown;
        workspaces?: unknown;
        pnpm?: unknown;
        config?: unknown;
        packageManager?: unknown;
      };
      if (
        parsed.workspaces !== undefined ||
        parsed.pnpm !== undefined ||
        parsed.config !== undefined ||
        parsed.packageManager !== undefined ||
        (parsed.scripts !== undefined &&
          (!parsed.scripts || typeof parsed.scripts !== 'object' || Array.isArray(parsed.scripts)))
      )
        return 'unknown';
      const scripts = (parsed.scripts ?? {}) as Record<string, unknown>;
      const next = new Set([...stack, identity]);
      let result: Effect = publication ? 'publication' : 'read-only';
      const selected = publication
        ? [
            'prepublish',
            'prepublishOnly',
            'prepack',
            'prepare',
            'postpack',
            'publish',
            'postpublish',
          ]
        : manager === 'npm'
          ? [`pre${key}`, key, `post${key}`]
          : [key];
      // pnpm lifecycle selection is configuration-dependent; do not invent a configured invocation.
      if (
        !publication &&
        manager === 'pnpm' &&
        (scripts[`pre${key}`] !== undefined || scripts[`post${key}`] !== undefined)
      )
        return 'unknown';
      if (!publication && typeof scripts[key] !== 'string') return 'unknown';
      for (const script of selected) {
        const body = scripts[script];
        if (body === undefined) continue;
        if (typeof body !== 'string') return 'unknown';
        result = combine(result, scriptEffect(body, next));
      }
      return result;
    } catch {
      return 'unknown';
    }
  }
  function scriptEffect(script: string, packageStack = new Set<string>()): Effect {
    const parts = commands(script);
    if (!root || !parts) return 'unknown';
    let result: Effect = 'read-only';
    for (const words of parts) {
      const tokens = [...words];
      while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[0] ?? '')) {
        if (loaderVariable((tokens[0] ?? '').split('=')[0] ?? '')) return 'unknown';
        tokens.shift();
      }
      const command = tokens.shift();
      if (!command) continue;
      if (command === 'export') {
        if (
          !tokens.length ||
          tokens.some((token) => {
            const name = /^([A-Za-z_][A-Za-z0-9_]*)(?:=|$)/u.exec(token)?.[1];
            return !name || loaderVariable(name);
          })
        )
          return 'unknown';
        continue;
      }
      if (command === 'echo' || command === ':') continue;
      if (command === 'test') {
        // Bash variable/arithmetic tests can evaluate operands; certify only inert comparisons.
        if (!(
          tokens.length === 1 ||
          (tokens.length === 2 &&
            ['-n', '-z', '-e', '-f', '-d', '-r', '-w', '-x', '-s'].includes(tokens[0] ?? '')) ||
          (tokens.length === 3 && ['=', '!='].includes(tokens[1] ?? ''))
        ))
          return 'unknown';
        continue;
      }
      if (command === 'true' || command === 'false') {
        if (tokens.length) return 'unknown';
        continue;
      }
      if (command === 'printf') {
        const format = tokens[0];
        if (
          format === undefined ||
          format.startsWith('-') ||
          (format.includes('%') && !['%s', '%s\n', '%s\\n'].includes(format))
        )
          return 'unknown';
        continue;
      }
      if (command === 'npm' || command === 'pnpm') {
        const manager = command;
        if (tokens[0] === 'exec') {
          // Package-bin selection is an indirect executor without a resolved capability identity.
          return 'unknown';
        } else {
          if (tokens[0] === 'publish') {
            if (tokens.length !== 1) return 'unknown';
            result = combine(result, packageEffect(manager, '', packageStack, true));
            continue;
          }
          let key: string | undefined;
          if (tokens[0] === 'run') {
            if (tokens.length !== 2) return 'unknown';
            key = tokens[1];
          } else if (tokens.length === 1 && ['test', 'start'].includes(tokens[0] ?? ''))
            key = tokens[0];
          if (!key || !/^[A-Za-z0-9_.:-]+$/u.test(key) || key.startsWith('-')) return 'unknown';
          result = combine(result, packageEffect(manager, key, packageStack));
          continue;
        }
      }
      if (command === 'gh' && ['api', 'release'].includes(tokens[0] ?? '')) {
        // gh is a registered publication mechanism; unproved selectors/options cannot certify it.
        if (tokens.some((token) => /^--(?:repo|hostname|config|template|jq)(?:=|$)/u.test(token)))
          return 'unknown';
        result = combine(result, 'publication');
        continue;
      }
      if (command === 'curl') return 'unknown'; // Output/config/protocol flags have no closed proof here.
      if (command === 'node') {
        while (
          ['--no-warnings', '--enable-source-maps', '--experimental-strip-types'].includes(
            tokens[0] ?? '',
          )
        )
          tokens.shift();
        if (tokens.length !== 1) return 'unknown';
        const path = tokens[0];
        if (!path || path.startsWith('-') || !/\.[cm]?[jt]s$/u.test(path)) return 'unknown';
        result = combine(result, reachable(path));
      } else return 'unknown'; // Includes indirect executors, cwd changes and unsupported languages.
    }
    return result;
  }

  function actionEffect(use: string, inputs?: Map<string, ExecutionYaml>): Effect {
    // Structural YAML has decoded this scalar exactly once.
    if (use.includes('${{') || /\s/u.test(use)) return 'unknown';
    // Local action and reusable workflow inputs reach their steps; that flow has no proof.
    if (inputs !== undefined && use.startsWith('./')) return 'unknown';
    if (!use.startsWith('./')) {
      // GitHub rejects a remote step `uses` without @ref at workflow validation, so such a
      // step never executes; its registered owner/repo identity alone classifies it, and R3
      // refuses any inputs on it. Unlisted identities, nested paths and docker:// are UNKNOWN.
      const reference = remoteActionReference(use);
      const action = reference && REGISTERED_ACTIONS.get(reference.target);
      if (!reference || !action) return 'unknown';
      if (inputs !== undefined && !actionInputsAdmitted(action, reference.ref, inputs))
        return 'unknown';
      return action.effect;
    }
    if (use.startsWith('./.github/workflows/')) {
      const workflow = contained(use);
      if (!workflow || active.has(workflow.path)) return 'unknown';
      active.add(workflow.path);
      try {
        const workflowFields = yamlMap(executionYaml(workflow.source));
        const jobs = yamlMap(workflowFields?.get('jobs'));
        if (!workflowFields || !jobs || !executionMetadata(workflowFields)) return 'unknown';
        const names = [...jobs.keys()];
        if (!names.length) return 'unknown';
        return names.reduce<Effect>(
          (result, job) =>
            combine(
              result,
              jobEffectFacts(workflow.source, root ?? '', job, new Set(active)).effect ?? 'unknown',
            ),
          'read-only',
        );
      } finally {
        active.delete(workflow.path);
      }
    }
    const action = contained(join(use, 'action.yml')) ?? contained(join(use, 'action.yaml'));
    if (!action || active.has(action.path) || !action.source) return 'unknown';
    active.add(action.path);
    try {
      const fields = yamlMap(executionYaml(action.source));
      const runs = yamlMap(fields?.get('runs'));
      if (
        !fields ||
        !runs ||
        !executionMetadata(fields) ||
        [...runs.keys()].some((key) => !['using', 'steps'].includes(key)) ||
        yamlString(runs.get('using')) !== 'composite'
      )
        return 'unknown';
      const nested = executionSteps(runs.get('steps'));
      // A byte selector inside a composite also changes the caller's later workspace bytes,
      // which this boundary does not track; refuse it rather than lose the ordering.
      if (!nested || nested.bytesSelected) return 'unknown';
      let result: Effect = 'read-only';
      for (const script of nested.scripts) result = combine(result, scriptEffect(script));
      for (const declared of nested.reviewed) result = combine(result, declared);
      for (const step of nested.uses)
        result = combine(result, actionEffect(step.reference, step.inputs));
      return result;
    } finally {
      active.delete(action.path);
    }
  }
  if (!root) mark('unknown');
  for (const script of executions?.scripts ?? []) mark(scriptEffect(script));
  for (const declared of executions?.reviewed ?? []) mark(declared);
  for (const step of executions?.uses ?? []) mark(actionEffect(step.reference, step.inputs));
  return {
    effect,
    ...(environment === undefined ? {} : { environment }),
    permissions,
    runScripts: scripts,
    ...(condition === undefined ? {} : { condition }),
    ...(needs === undefined ? {} : { needs }),
    ...(concurrency === undefined ? {} : { concurrency }),
  };
}
