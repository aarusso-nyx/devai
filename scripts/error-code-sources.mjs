// Shared by scripts/generate-error-code-reference.mjs and its check test (#338): the code prefixes
// the reference scans and the parser of task, round and tracking throw sites. The CLI keeps the
// same prefix set in packages/cli/src/error-code-prefixes.ts; a test keeps the two equal.

/**
 * Quoted names that match a code prefix but are not codes; RELEASE_TAG is a workflow data variable
 * the harness effect analysis admits (#325).
 */
export const NOT_CODES = new Set(['ACTION_EFFECTS', 'GITHUB_TOKEN', 'POST_CUTOFF', 'RELEASE_TAG']);

/** The first segment of every DEVAI diagnostic code the reference lists. */
export const ERROR_CODE_PREFIXES = new Set([
  'ACTION',
  'ACTIONS',
  'ADOPTER',
  'AGENT',
  'ARTIFACT',
  'AUDIT',
  'AUTHORITY',
  'BACKLOG',
  'BLUEPRINT',
  'BUILD',
  'CAMPAIGN',
  'CATALOG',
  'CHECK',
  'CI',
  'CLI',
  'CONSTITUTION',
  'COVERAGE',
  'DATABASE',
  'DISPOSITION',
  'DOCS',
  'DURABLE',
  'EVIDENCE',
  'EXPERIMENTAL',
  'FORBIDDEN',
  'GIT',
  'GITHUB',
  'GLOB',
  'HOOK',
  'HOST',
  'INIT',
  'INTENT',
  'INVENTORY',
  'JOURNEY',
  'LEDGER',
  'LOOP',
  'MODEL',
  'MUTATION',
  'POLICY',
  'POST',
  'PROCESS',
  'PROMPT',
  'PROOF',
  'RATIFICATION',
  'RECEIPT',
  'RECIPE',
  'RELEASE',
  'ROUND',
  'ROUTE',
  'SCHEMA',
  'SCORECARD',
  'SENSE',
  'SENSOR',
  'TASK',
  'TRACE',
  'TRACKING',
  'TRANSLATION',
  'TRIAGE',
  'TRUSTED',
  'WORKTREE',
]);

/** The exit named by an EXIT_* constant at a throw site. */
export const THROWN_EXIT_SYMBOLS = new Map([
  ['EXIT_USAGE', 2],
  ['EXIT_FAIL', 2],
  ['EXIT_GATE', 3],
  ['EXIT_PRECONDITION', 5],
]);

/** The class error.schema.json pairs with each envelope exit. */
export const EXIT_CLASSES = new Map([
  [2, 'routing-authority'],
  [3, 'gate-fail'],
  [4, 'invalid-input'],
  [5, 'precondition'],
  [6, 'infrastructure'],
  [7, 'contract-violation'],
]);

/** The argument text of the call whose `(` is at `open`, or undefined when unbalanced. */
function callArguments(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "'" || char === '"' || char === '`') {
      for (index += 1; index < source.length && source[index] !== char; index += 1) {
        if (source[index] === '\\') index += 1;
      }
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return undefined;
}

/** Top-level comma-separated arguments, trimmed; a trailing comma adds no argument. */
function splitArguments(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'" || char === '"' || char === '`') {
      for (index += 1; index < text.length && text[index] !== char; index += 1) {
        if (text[index] === '\\') index += 1;
      }
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last.length > 0) parts.push(last);
  return parts;
}

/**
 * Task, round and tracking throw sites in one source file: `new TaskServiceError(code, exit?)`,
 * `new TrackingCommandError(code, exit?)` and, in packages/loop, `fail(code, exit?)`. The code is a
 * quoted literal or a template that opens with `CODE:`; arguments may span lines and end with a
 * trailing comma. An exit that is not a literal 2-7 or a known EXIT_* constant is skipped.
 */
export function parseThrowSites(file, source) {
  const sites = [];
  const callee = file.includes('/packages/loop/src/')
    ? /\b(?:new (?:TaskServiceError|TrackingCommandError)|fail)\s*\(/gu
    : /\bnew (?:TaskServiceError|TrackingCommandError)\s*\(/gu;
  for (const match of source.matchAll(callee)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const text = callArguments(source, open);
    if (text === undefined) continue;
    const [first, second] = splitArguments(text);
    const code =
      /^'([A-Z][A-Z0-9_]+)'$/u.exec(first ?? '')?.[1] ??
      /^`([A-Z][A-Z0-9_]+):[^`]*`$/u.exec(first ?? '')?.[1];
    if (code === undefined) continue;
    const exit =
      second === undefined
        ? 2
        : /^[0-9]$/u.test(second)
          ? Number(second)
          : THROWN_EXIT_SYMBOLS.get(second);
    if (exit === undefined || !EXIT_CLASSES.has(exit)) continue;
    sites.push({ code, exit });
  }
  return sites;
}
