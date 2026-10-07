#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const rootArgument = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
const root = resolve(rootArgument ?? '.');
const check = process.argv.includes('--check');
const output = join(root, 'docs/reference/error-codes.md');
// #250: every package can emit a code the CLI surfaces, so every package source is scanned.
const sourceRoots = readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(root, 'packages', entry.name, 'src')))
  .map((entry) => `packages/${entry.name}/src`)
  .concat(['packages/cli/vendor/evidence-verification/src'])
  .sort();
// Quoted identifiers that share a code prefix but name a constant or credential, not a code.
// Quoted names that match a code prefix but are not codes; RELEASE_TAG is a workflow data
// variable the harness effect analysis admits (#325).
const notCodes = new Set(['ACTION_EFFECTS', 'GITHUB_TOKEN', 'POST_CUTOFF', 'RELEASE_TAG']);
const prefixes = new Set([
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
  'GITHUB',
  'GLOB',
  'HOOK',
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

function filesUnder(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? filesUnder(child) : /\.(?:ts|js|mjs)$/u.test(child) ? [child] : [];
  });
}

// #338: the `Exit class` cell is declared, never guessed from a code's name. Each entry names the
// class and exit the CLI emits and where that comes from;
// packages/cli/tests/unit/error-code-reference.test.ts checks the declarations against the emitting
// code (literal cliError constructors, the authority renderer and the action-output wrapper). A code without a declaration is raised as a
// message or payload whose class and exit are set by the envelope of the action that surfaces it,
// and the cell says exactly that.
const PER_ACTION = 'per action: set by the surfacing envelope';

// Literal envelope constructors (`cliError({ code, class, exit })`) and verified emitters.
const declaredCodes = new Map([
  // packages/cli/src/commands/actions constructor.
  ['ACTIONS_LIST_OUTPUT_INVALID', 'contract-violation / 7'],
  // packages/cli/src/action-output.ts errorCode()/errorClass(): the wrapper's normalized codes.
  ['ACTION_GATE_FAILED', 'gate-fail / 3'],
  ['ACTION_INVOCATION_REFUSED', 'routing-authority / 2 (invalid-input / 4, infrastructure / 6)'],
  ['ACTION_OUTPUT_CONTRACT_VIOLATION', 'contract-violation / 7'],
  ['ACTION_PRECONDITION_UNSATISFIED', 'precondition / 5'],
  // packages/cli/src/commands/check/facade.ts and command-router.ts constructors.
  ['CHECK_MEMBER_UNKNOWN', 'routing-authority / 2'],
  ['CHECK_RC_DB_TESTS_REQUIRED', 'precondition / 5'],
  ['CHECK_RUNNER_DESCRIPTOR', 'precondition / 5'],
  ['CHECK_SELECTION_INVALID', 'routing-authority / 2'],
  ['CHECK_TASK_DESCRIPTOR_MISSING', 'precondition / 5'],
  // ADR-CHK-0005: member result statuses, not refusal envelopes.
  ['CHECK_MEMBER_NOT_APPLICABLE', 'not-applicable result / 0'],
  ['CHECK_MEMBER_POPULATION_EMPTY', 'review result / 1'],
  // packages/cli/src/commands/init constructors.
  ['INIT_INTERACTIVE_EDIT_REFUSED', 'precondition / 5'],
  ['INIT_INTERACTIVE_FAILED', 'infrastructure / 6'],
  ['INIT_INTERACTIVE_INVOCATION_FAILED', 'precondition / 5'],
  ['INIT_INTERACTIVE_MODE_INVALID', 'invalid-input / 4'],
  ['INIT_TARGET_PRECONDITION_UNSATISFIED', 'precondition / 5'],
  ['INIT_UPGRADE_POSTCHECK_FAILED', 'gate-fail / 3'],
  // packages/cli/src/services/self-dogfood.ts refusal.
  ['POLICY_DENY', 'routing-authority / 2'],
  // packages/cli/src/command-router.ts and the sense facade constructors.
  ['SENSE_SELECTION_INVALID', 'routing-authority / 2'],
  ['SENSOR_KIND_SCHEMA_UNSUPPORTED', 'routing-authority / 2'],
  ['SENSOR_KIND_UNKNOWN', 'routing-authority / 2'],
  ['SENSOR_OPTIONAL_DEPENDENCY_MISSING', 'precondition / 5'],
  // The task, round and tracking writers' fallback for an unanticipated error (cli-error.ts
  // commandRefusal with the operation-failed code).
  ['ROUND_OPERATION_FAILED', 'infrastructure / 6'],
  ['TASK_OPERATION_FAILED', 'infrastructure / 6'],
  ['TRACKING_OPERATION_FAILED', 'infrastructure / 6'],
  // packages/loop/src/loop/dispatch-journal.ts DispatchUncertainError: super('TASK_DISPATCH_UNCERTAIN').
  ['TASK_DISPATCH_UNCERTAIN', 'routing-authority / 2'],
]);

// packages/cli/src/commands/backlog/index.ts failure(): a refusal envelope carrying the backlog code.
const backlogPrecondition = new Set([
  'BACKLOG_ITEM_ALREADY_RESOLVED',
  'BACKLOG_ITEM_NOT_FOUND',
  'BACKLOG_ORIGIN_COMMIT_UNAVAILABLE',
]);

// Codes that no envelope or command payload carries as its code, with where they surface instead.
const internalCodes = new Map([
  [
    'BACKLOG_SCORECARD_INVALID',
    'Raised by the post-merge auditor observation-backlog compiler, not by the backlog commands; it never reaches an envelope as its code.',
  ],
]);
// MODEL_BRIDGE_* codes are raised inside the model bridge, which only `sense run llm_judge` calls; the
// run records the thrown message as that member's `stderr` in its result, never as an envelope code.
const MODEL_BRIDGE_INTERNAL =
  'Raised by the model bridge inside `sense run llm_judge`; the run records it as the failing member `stderr`, never as an envelope code. Fix the named provider, model or host condition and rerun the sensor.';

function internalNote(code) {
  if (internalCodes.has(code)) return internalCodes.get(code);
  if (code.startsWith('MODEL_')) return MODEL_BRIDGE_INTERNAL;
  return undefined;
}

// packages/cli/src/authority/authority-results.ts renderAuthorityResult(): the CLI's own rule.
function authorityClass(code) {
  if (code.includes('CONTRACT') || code.includes('INVALID') || code.includes('DIVERGENCE'))
    return 'contract-violation / 7';
  if (code.includes('TIMEOUT') || code.includes('CRASH') || code.includes('SIGNAL'))
    return 'infrastructure / 6';
  return 'routing-authority / 2 (precondition / 5 for a dependency error)';
}

// #338: task, round and tracking failures are refusal envelopes whose exit is the one the error
// carries, so a code thrown as `new TaskServiceError('CODE', EXIT)`, the loop's `fail('CODE', EXIT)`
// or `new TrackingCommandError('CODE', EXIT)` is declared by its throw sites (default exit 2).
const THROWN_EXIT_SYMBOLS = new Map([
  ['EXIT_USAGE', 2],
  ['EXIT_FAIL', 2],
  ['EXIT_GATE', 3],
  ['EXIT_PRECONDITION', 5],
]);
const THROWN_CLASSES = new Map([
  [2, 'routing-authority'],
  [3, 'gate-fail'],
  [4, 'invalid-input'],
  [5, 'precondition'],
  [6, 'infrastructure'],
  [7, 'contract-violation'],
]);
const thrownExits = new Map();

function recordThrowSites(file, source) {
  const patterns = [
    /new (?:TaskServiceError|TrackingCommandError)\(\s*(?:'([A-Z][A-Z0-9_]+)'|`([A-Z][A-Z0-9_]+):[^`]*`)\s*(?:,\s*([A-Z_]+|[0-9]))?\s*\)/gu,
  ];
  if (file.includes('/packages/loop/src/')) {
    patterns.push(/\bfail\(\s*'([A-Z][A-Z0-9_]+)'()\s*(?:,\s*([A-Z_]+|[0-9]))?\s*\)/gu);
  }
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const code = match[1] ?? match[2];
      const symbol = match[3];
      const exit =
        symbol === undefined
          ? 2
          : /^[0-9]$/u.test(symbol)
            ? Number(symbol)
            : THROWN_EXIT_SYMBOLS.get(symbol);
      if (code === undefined || exit === undefined || !THROWN_CLASSES.has(exit)) continue;
      const exits = thrownExits.get(code) ?? new Set();
      exits.add(exit);
      thrownExits.set(code, exits);
    }
  }
}

function thrownClass(code) {
  const exits = [...(thrownExits.get(code) ?? [])].sort((a, b) => a - b);
  if (exits.length === 0) return undefined;
  const pairs = exits.map((exit) => `${THROWN_CLASSES.get(exit)} / ${String(exit)}`);
  return pairs.length === 1 ? pairs[0] : `${pairs[0]} (${pairs.slice(1).join(', ')})`;
}

function classify(code) {
  if (internalNote(code) !== undefined) return 'internal / none';
  if (declaredCodes.has(code)) return declaredCodes.get(code);
  if (code === 'BACKLOG_OPERATION_FAILED') return 'infrastructure / 6';
  if (code.startsWith('BACKLOG_'))
    return backlogPrecondition.has(code) ? 'precondition / 5' : 'routing-authority / 2';
  if (code.startsWith('AUTHORITY_')) return authorityClass(code);
  // packages/cli/src/command-router.ts usageRefusal() and the route constructors.
  if (code.startsWith('ROUTE_')) return 'routing-authority / 2';
  return thrownClass(code) ?? PER_ACTION;
}

function words(code) {
  return code.toLowerCase().replaceAll('_', ' ');
}

function remediation(code) {
  const internal = internalNote(code);
  if (internal !== undefined) return internal;
  if (code.startsWith('BACKLOG_'))
    return 'Follow the backlog refusal envelope remediation; correct the named input or item, then retry.';
  if (code === 'AUTHORITY_POLICY_MISSING')
    return 'Run the ordered bind commands in `context.commands`.';
  if (code === 'CHECK_SELECTION_INVALID') return 'Use `--only <member>` or `--suite <name>`.';
  if (code === 'CHECK_MEMBER_UNKNOWN')
    return 'Use a suggested member, when present, or inspect `devai check --help`.';
  if (code === 'CHECK_RUNNER_DESCRIPTOR')
    return 'Correct `test-tasks.json`; for `--local`, declare `test:local-full`.';
  if (code === 'CHECK_RC_DB_TESTS_REQUIRED')
    return 'Set `DEVAI_DB_TESTS=1` and a reachable `DEVAI_DB_URL`.';
  if (code === 'CHECK_MEMBER_NOT_APPLICABLE')
    return 'None: the member does not apply to the detected repository kind, so read its own `status` rather than the aggregate `ok` when a CI list requires it to pass.';
  if (code === 'CHECK_MEMBER_POPULATION_EMPTY')
    return 'Reference the DEVAI actions the adopter uses in its workflows or scripts, or claim them in an invariant `measurable_via`, then rerun the member.';
  if (code === 'CHECK_REPOSITORY_KIND_INVALID')
    return 'Bind the adopter policy so `.devai/config/adopter-policy-binding.json` exists and carries a string `policy_id`, then retry.';
  if (code === 'CHECK_MEMBER_APPLICABILITY_UNDECLARED')
    return 'Declare `applicability` for the member or selector in `law/policy/check-suites.json`.';
  if (code === 'TASK_ROUND_INACTIVE')
    return 'Applies to `round run` and task dispatch only; `round status` reads a sealed round without it. Open or reactivate the task round before dispatching.';
  if (code.startsWith('AUTHORITY_') || code === 'POLICY_DENY')
    return 'Follow the structured envelope remediation without widening the declared authority.';
  if (code.startsWith('CHECK_'))
    return 'Correct the selected check inputs or satisfy its reported prerequisite, then retry.';
  if (code.startsWith('ROUTE_'))
    return 'Use the canonical command path and named options shown by `--help`.';
  return 'Follow the structured envelope remediation and retry only after its condition is satisfied.';
}

const codes = new Set();
for (const sourceRoot of sourceRoots) {
  for (const file of filesUnder(join(root, sourceRoot))) {
    const source = readFileSync(file, 'utf8');
    recordThrowSites(file, source);
    // A quoted code, or a code that opens a template message (`PROOF_EPOCH_TRUNCATED ${path}`).
    for (const match of source.matchAll(
      /(?:['"]([A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+)['"]|`([A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+)[\s:`])/gu,
    )) {
      const code = match[1] ?? match[2];
      if (code !== undefined && prefixes.has(code.split('_')[0]) && !notCodes.has(code))
        codes.add(code);
    }
    for (const match of source.matchAll(/['"](DEVAI_VERIFIER_[A-Z0-9_]+)(?=[:'"])/gu)) {
      const code = match[1];
      if (code !== undefined) codes.add(code);
    }
  }
}

const rows = [...codes].sort().map((code) => {
  return `| \`${code}\` | ${words(code)} | Stable diagnostic for ${words(code)}. | ${remediation(code)} | ${classify(code)} |`;
});
const content = `<!-- @generated by scripts/generate-error-code-reference.mjs; do not edit -->
# Error code reference

DEVAI refusal and failure envelopes carry stable codes. This page is generated from the
diagnostic codes in every package source and the vendored evidence verifier. A code can appear in
more than one action; the envelope's concrete message, remediation, references, and context remain
authoritative for that invocation.

The exit class is declared, never inferred from a code's name, and a contract test checks it against
the emitting code. \`per action\` marks a code raised as a message or payload: the envelope of the
action that surfaces it sets its class and exit. \`internal\` marks a code that never reaches an
envelope as its code.

| Code | Cause | Meaning | Remediation | Exit class |
| --- | --- | --- | --- | --- |
${rows.join('\n')}
`;

if (check) {
  if (!existsSync(output) || readFileSync(output, 'utf8') !== content) {
    throw new Error(`ERROR_CODE_REFERENCE_DRIFT:${relative(root, output)}`);
  }
  process.stdout.write(`error code reference: PASS (${String(rows.length)} codes)\n`);
} else {
  writeFileSync(output, content);
  process.stdout.write(`error code reference: generated ${String(rows.length)} codes\n`);
}
