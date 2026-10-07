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

function exitValues() {
  const source = readFileSync(join(root, 'packages/utils/src/exit.ts'), 'utf8');
  const value = (name) =>
    Number(new RegExp(`export const ${name} = (\\d+);`, 'u').exec(source)?.[1]);
  return {
    pass: value('EXIT_PASS'),
    review: value('EXIT_REVIEW'),
    fail: value('EXIT_FAIL'),
    usage: value('EXIT_USAGE'),
    precondition: value('EXIT_PRECONDITION'),
  };
}

// BACKLOG_* codes are never an envelope code. The backlog commands write their own failure payload
// `{code, operation, exit}` (packages/cli/src/commands/backlog/index.ts `failure()`) and exit with
// its `exit`: 1 for the codes below, EXIT_USAGE for every other one. Under `--format json` the action
// wrapper carries that payload in `error.context.payload` of ACTION_INVOCATION_REFUSED (payload exit
// 2) or ACTION_OUTPUT_CONTRACT_VIOLATION (payload exit 1).
const backlogPayloadExitOne = new Set([
  'BACKLOG_ITEM_ALREADY_RESOLVED',
  'BACKLOG_ITEM_NOT_FOUND',
  'BACKLOG_OPERATION_FAILED',
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

function classify(code, exits) {
  if (internalNote(code) !== undefined) return ['internal', 'none'];
  if (code.startsWith('BACKLOG_'))
    return ['backlog-payload', backlogPayloadExitOne.has(code) ? 1 : exits.usage];
  // ADR-CHK-0005: not-applicable is its own result class, never a failure.
  if (code === 'CHECK_MEMBER_NOT_APPLICABLE') return ['not-applicable', exits.pass];
  if (code === 'CHECK_MEMBER_POPULATION_EMPTY') return ['review', exits.review];
  if (code.startsWith('AUTHORITY_') || code === 'POLICY_DENY')
    return ['routing-authority', exits.usage];
  if (
    code === 'CHECK_SELECTION_INVALID' ||
    code === 'CHECK_MEMBER_UNKNOWN' ||
    code.startsWith('ROUTE_') ||
    code.endsWith('_USAGE') ||
    code.endsWith('_ARGUMENT')
  )
    return ['usage', exits.usage];
  if (
    code === 'CHECK_RUNNER_DESCRIPTOR' ||
    code === 'CHECK_TASK_DESCRIPTOR_MISSING' ||
    code === 'CHECK_RC_DB_TESTS_REQUIRED' ||
    code === 'TASK_ROUND_INACTIVE' ||
    code.includes('_PRECONDITION') ||
    code.endsWith('_UNAVAILABLE')
  )
    return ['precondition', exits.precondition];
  return ['failure', exits.fail];
}

function words(code) {
  return code.toLowerCase().replaceAll('_', ' ');
}

function remediation(code) {
  const internal = internalNote(code);
  if (internal !== undefined) return internal;
  if (code.startsWith('BACKLOG_'))
    return 'Reported in the backlog failure payload `{code, operation, exit}`; correct the named input or item, then retry.';
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

const exits = exitValues();
const rows = [...codes].sort().map((code) => {
  const [exitClass, exit] = classify(code, exits);
  return `| \`${code}\` | ${words(code)} | Stable diagnostic for ${words(code)}. | ${remediation(code)} | ${exitClass} / ${String(exit)} |`;
});
const content = `<!-- @generated by scripts/generate-error-code-reference.mjs; do not edit -->
# Error code reference

DEVAI refusal and failure envelopes carry stable codes. This page is generated from the
diagnostic codes in every package source and the vendored evidence verifier. A code can appear in
more than one action; the envelope's concrete message, remediation, references, and context remain
authoritative for that invocation.

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
