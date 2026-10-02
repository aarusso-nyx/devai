// TASK-0641 / ADR-EVI-0004; Constitution Articles 29, 30, 41 (INV-CORE-007):
// Real integrity and seal consumers must agree on exact canonical terminal membership,
// preserve refusal precedence and never mutate proof/history bytes on reads or refusals.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validators } from '@devai-nyx/schemas';
import { stringify } from 'yaml';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { renderClosureIndex } from '../../../evidence/src/closure/index.js';
import { parseGovernanceRecord, roundRecordIntegrity } from '../../src/governance-ledger/index.js';
import { closeGovernedRound } from '../../src/round-lifecycle/index.js';

const SHA = 'b'.repeat(40);
const LEDGER = 'record/derived/indexes/rounds.md';
const PROOF = 'record/proofs/compliance/closures/PC-0007.json';
const ARCHIVE = 'work/rounds/R-0007';
const ACTIVE = ARCHIVE;
const HEADER =
  '# Rounds index\n\n| closure | round | supersedes | merged_as | terminal |\n| --- | --- | --- | --- | --- |\n';
let root: string;

function row(
  closure = 'PC-0007',
  round = 'R-0007',
  supersedes = '-',
  terminal = 'yes',
  merged = SHA,
) {
  return `| ${closure} | ${round} | ${supersedes} | ${merged} | ${terminal} |`;
}
function index(...rows: readonly string[]) {
  return `${HEADER}${rows.join('\n')}\n`;
}
const VALID = row();
const chain = [
  row('PC-0005', 'R-0007', '-', 'no'),
  row('PC-0006', 'R-0007', 'PC-0005', 'no'),
  row('PC-0007', 'R-0007', 'PC-0006'),
];
const invalidIndexes: readonly { readonly name: string; readonly ledger: string | null }[] = [
  { name: 'missing index', ledger: null },
  { name: 'empty index', ledger: '' },
  { name: 'presentation only', ledger: HEADER },
  { name: 'bare closure mention', ledger: 'PC-0007\n' },
  { name: 'heading mention', ledger: '# Closed PC-0007\n' },
  { name: 'prose mention', ledger: 'The closure PC-0007 is closed.\n' },
  { name: 'longer closure identity', ledger: index(row('PC-00070')) },
  { name: 'longer round identity', ledger: index(row('PC-0007', 'R-00070')) },
  { name: 'wrong round', ledger: index(row('PC-0007', 'R-0008')) },
  { name: 'case folded round', ledger: index(row('PC-0007', 'r-0007')) },
  {
    name: 'superseded queried closure',
    ledger: index(row('PC-0007', 'R-0007', '-', 'no'), row('PC-0008', 'R-0007', 'PC-0007')),
  },
  { name: 'closure only in supersedes cell', ledger: index(row('PC-0008', 'R-0007', 'PC-0007')) },
  { name: 'nonterminal sink', ledger: index(row('PC-0007', 'R-0007', '-', 'no')) },
  { name: 'four cells after valid row', ledger: index(VALID, '| PC-0008 | R-0008 | - | yes |') },
  {
    name: 'six cells before valid row',
    ledger: index('| PC-0008 | R-0008 | - | - | yes | extra |', VALID),
  },
  {
    name: 'missing leading delimiter after valid row',
    ledger: index(VALID, row('PC-0008', 'R-0008').slice(2)),
  },
  {
    name: 'missing trailing delimiter before valid row',
    ledger: index(row('PC-0008', 'R-0008').slice(0, -2), VALID),
  },
  { name: 'indented data beside valid row', ledger: index(VALID, ` ${row('PC-0008', 'R-0008')}`) },
  {
    name: 'tab indented data beside valid row',
    ledger: index(`\t${row('PC-0008', 'R-0008')}`, VALID),
  },
  {
    name: 'missing delimiter spacing beside valid row',
    ledger: index(VALID, row('PC-0008', 'R-0008').replace(' | R-', '| R-')),
  },
  { name: 'closure cell padding', ledger: index(VALID, row(' PC-0008', 'R-0008')) },
  { name: 'round cell padding', ledger: index(VALID, row('PC-0008', 'R-0008 ')) },
  { name: 'empty round cell', ledger: index(VALID, row('PC-0008', '')) },
  { name: 'CRLF data', ledger: index(VALID).replaceAll('\n', '\r\n') },
  { name: 'invalid ID beside valid row', ledger: index(VALID, row('PC-008', 'R-0008')) },
  {
    name: 'invalid SHA beside valid row',
    ledger: index(VALID, row('PC-0008', 'R-0008', '-', 'yes', 'z'.repeat(40))),
  },
  {
    name: 'uppercase SHA beside valid row',
    ledger: index(VALID, row('PC-0008', 'R-0008', '-', 'yes', 'B'.repeat(40))),
  },
  {
    name: 'short SHA beside valid row',
    ledger: index(VALID, row('PC-0008', 'R-0008', '-', 'yes', 'b'.repeat(39))),
  },
  {
    name: 'invalid terminal token beside valid row',
    ledger: index(VALID, row('PC-0008', 'R-0008', '-', 'true')),
  },
  { name: 'compound terminal token', ledger: index(row('PC-0007', 'R-0007', '-', 'yes no')) },
  { name: 'duplicate identical target', ledger: index(VALID, VALID) },
  {
    name: 'duplicate closure across rounds after match',
    ledger: index(VALID, row('PC-0007', 'R-0008')),
  },
  {
    name: 'duplicate closure across rounds before match',
    ledger: index(row('PC-0007', 'R-0008'), VALID),
  },
  { name: 'two independent terminal rows', ledger: index(VALID, row('PC-0008')) },
  {
    name: 'predecessor incorrectly marked terminal',
    ledger: index(row('PC-0006'), row('PC-0007', 'R-0007', 'PC-0006')),
  },
  {
    name: 'sink incorrectly marked nonterminal',
    ledger: index(row('PC-0006', 'R-0007', '-', 'no'), row('PC-0007', 'R-0007', 'PC-0006', 'no')),
  },
  { name: 'missing supersession target', ledger: index(row('PC-0007', 'R-0007', 'PC-0006')) },
  {
    name: 'cross-round supersession target',
    ledger: index(row('PC-0006', 'R-0006', '-', 'no'), row('PC-0007', 'R-0007', 'PC-0006')),
  },
  { name: 'self supersession', ledger: index(row('PC-0007', 'R-0007', 'PC-0007')) },
  {
    name: 'fork from one predecessor',
    ledger: index(
      row('PC-0006', 'R-0007', '-', 'no'),
      row('PC-0007', 'R-0007', 'PC-0006'),
      row('PC-0008', 'R-0007', 'PC-0006'),
    ),
  },
  {
    name: 'cycle beside plausible target',
    ledger: index(
      VALID,
      row('PC-0005', 'R-0007', 'PC-0006', 'no'),
      row('PC-0006', 'R-0007', 'PC-0005', 'no'),
    ),
  },
  {
    name: 'disconnected chain beside plausible target',
    ledger: index(VALID, row('PC-0005', 'R-0007', '-', 'no'), row('PC-0006', 'R-0007', 'PC-0005')),
  },
  {
    name: 'contradictory unrelated round after match',
    ledger: index(VALID, row('PC-0008', 'R-0008'), row('PC-0009', 'R-0008')),
  },
  {
    name: 'unrelated cycle after match',
    ledger: index(
      VALID,
      row('PC-0008', 'R-0008', 'PC-0009', 'no'),
      row('PC-0009', 'R-0008', 'PC-0008', 'no'),
    ),
  },
];
const validIndexes = [
  { name: 'one canonical target', ledger: index(VALID) },
  { name: 'terminal successor', ledger: index(...chain) },
  { name: 'physical row order independent chain', ledger: index(...[...chain].reverse()) },
  {
    name: 'historical merged placeholder',
    ledger: index(row('PC-0007', 'R-0007', '-', 'yes', '-')),
  },
  {
    name: 'lowercase 64 digit merged SHA',
    ledger: index(row('PC-0007', 'R-0007', '-', 'yes', 'a'.repeat(64))),
  },
  {
    name: 'narrative and absent presentation headers',
    ledger: `Narrative text\n${VALID}\n# Later notes\n`,
  },
  { name: 'coherent unrelated round', ledger: index(row('PC-0008', 'maintenance'), VALID) },
  {
    name: 'canonical renderer output',
    ledger: renderClosureIndex([
      { closure: 'PC-0007', round: 'R-0007', supersedes: null, merged_as: SHA, terminal: true },
    ]),
  },
];

function write(path: string, body: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}
function git(...args: string[]) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function commit() {
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'closed fixture',
  );
}
function closedRecord(round = 'R-0007', phase: unknown = 'PC-0007') {
  return {
    schemaVersion: '1.0.0',
    id: round,
    title: 'Exact closure consumer fixture',
    type: 'round-record',
    status: 'closed',
    date: '2026-10-01',
    authority: 'Architect',
    kind: 'round',
    goal: 'Preserve exact membership',
    declared_by: 'DII-1',
    closed_by: 'DII-2',
    phase_closure: phase,
    merged_as: SHA,
    isolation: { kind: 'worktree', branch: 'fixture', base_sha: 'a'.repeat(40) },
    waves: [
      {
        id: 'W1',
        title: 'Closure',
        roles: ['Inspector'],
        type: 'serial',
        lock_scopes: ['tests/**'],
        gates: ['unit'],
      },
    ],
    gates: ['unit'],
    orchestrator_prompt: 'prompts/00-orchestrator.md',
    plan_path: 'plan.md',
  };
}
function recordMarkdown(record: Record<string, unknown>) {
  return `---\n${stringify(record, { lineWidth: 0 }).trimEnd()}\n---\n# Fixture round\n`;
}
function proof() {
  return {
    schemaVersion: '1.0.0',
    id: 'PC-0007',
    round_id: 'R-0007',
    declaring_decision: 'DII-1',
    closing_decision: 'DII-2',
    batches: [{ id: 'B1', roles: ['Inspector'], headline: 'fixture' }],
    gates: { unit: { status: 'pass' } },
    source_repo_deleted: false,
    validation_criteria: [{ criterion: 'fixture', verdict: 'pass' }],
    closed_at: '2026-10-01T00:00:00.000Z',
    merged_as: SHA,
  };
}
function fixture(ledger: string | null, round = 'R-0007') {
  const record = closedRecord(round);
  const closure = proof();
  expect(validators.recordMeta(record)).toBe(true);
  expect(validators.phaseClosure(closure)).toBe(true);
  for (const dir of [`work/rounds/${round}`]) {
    write(`${dir}/record.md`, recordMarkdown(record));
    expect(
      validators.recordMeta(parseGovernanceRecord(join(root, dir, 'record.md')).frontmatter),
    ).toBe(true);
    write(`${dir}/plan.md`, '# Plan\n');
    write(`${dir}/prompts/00-orchestrator.md`, '# Prompt\n');
  }
  write(PROOF, JSON.stringify(closure));
  write('record/proofs/chain.json', '[{"fixture":"immutable bytes"}]\n');
  write(
    'record/proofs/compliance/closures/PC-0006.json',
    '{"historical":"preserve exact bytes"}\n',
  );
  write('law/register/DII-1.md', '# Declare\n');
  write('law/register/DII-2.md', '# Close\n');
  if (ledger !== null) write(LEDGER, ledger);
  commit();
}
function snapshot() {
  const files: Record<string, string> = {};
  function visit(path: string) {
    for (const name of readdirSync(join(root, path)).sort()) {
      if (name === '.git') continue;
      const rel = join(path, name);
      if (statSync(join(root, rel)).isDirectory()) visit(rel);
      else files[rel] = readFileSync(join(root, rel)).toString('base64');
    }
  }
  visit('');
  return files;
}
function unresolved(round = 'R-0007', citation = 'PC-0007') {
  return {
    code: 'ROUND_PHASE_CLOSURE_UNRESOLVED',
    message: `${round} cites missing phase closure ${citation}.`,
    path: `work/rounds/${round}/record.md`,
  };
}
async function sealError(code: string) {
  await expect(
    withAuthorityHostTestScope(() => closeGovernedRound({ repoRoot: root, round: 'R-0007' })),
  ).rejects.toThrowError(code);
  expect(existsSync(join(root, ACTIVE, 'close-state.jsonl'))).toBe(false);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-cmp0006-closure-'));
  git('init', '--quiet', '--initial-branch=main');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('TASK-0641 exact terminal closure membership through both real consumers', () => {
  it.each(invalidIndexes)(
    'integrity refuses $name with exact finding and unchanged bytes',
    async ({ ledger }) => {
      fixture(ledger);
      const before = snapshot();
      expect(roundRecordIntegrity({ repoRoot: root })).toEqual({
        ok: false,
        findings: [unresolved()],
      });
      expect(snapshot()).toEqual(before);
    },
  );
  it.each(invalidIndexes)(
    'seal refuses $name at the ledger check without writing',
    async ({ ledger }) => {
      fixture(ledger);
      const before = snapshot();
      await sealError('ROUND_ARCHIVE_PHASE_LEDGER_MISSING');
      expect(snapshot()).toEqual(before);
    },
  );
  it.each(validIndexes)('integrity accepts $name without writes', ({ ledger }) => {
    fixture(ledger);
    const before = snapshot();
    expect(roundRecordIntegrity({ repoRoot: root })).toEqual({ ok: true, findings: [] });
    expect(snapshot()).toEqual(before);
  });
  it.each(validIndexes)(
    'seal accepts $name while retaining independent proof/record identity',
    async ({ ledger }) => {
      fixture(ledger);
      const before = snapshot();
      expect(
        await withAuthorityHostTestScope(() =>
          closeGovernedRound({ repoRoot: root, round: 'R-0007' }),
        ),
      ).toEqual({
        ok: true,
        id: 'R-0007',
        path: ACTIVE,
        close_state: `${ACTIVE}/close-state.jsonl`,
      });
      const after = snapshot();
      const state = after[`${ACTIVE}/close-state.jsonl`];
      expect(state).toBeDefined();
      expect(after).toEqual({ ...before, [`${ACTIVE}/close-state.jsonl`]: state });
      expect(JSON.parse(readFileSync(join(root, ACTIVE, 'close-state.jsonl'), 'utf8'))).toEqual({
        schemaVersion: '1.0.0',
        round_id: 'R-0007',
        status: 'closed',
        closing_decision: 'DII-2',
        phase_closure: 'PC-0007',
        merged_as: SHA,
      });
    },
  );
  it('uses actual archive-directory round identity rather than a different frontmatter identity', () => {
    fixture(index(VALID));
    const dir = join(root, 'work/rounds/R-0008');
    mkdirSync(dir);
    write('work/rounds/R-0008/record.md', recordMarkdown(closedRecord()));
    rmSync(join(root, ARCHIVE), { recursive: true });
    commit();
    expect(roundRecordIntegrity({ repoRoot: root })).toEqual({
      ok: false,
      findings: [unresolved('R-0008')],
    });
  });
  it('permits a schema-supported nonnumeric round identity without normalizing it', () => {
    fixture(index(row('PC-0007', 'maintenance')), 'maintenance');
    expect(roundRecordIntegrity({ repoRoot: root })).toEqual({ ok: true, findings: [] });
  });
  it.each([{ phase: null }, { phase: 7 }, { phase: ['PC-0007'] }, { phase: { id: 'PC-0007' } }])(
    'does not coerce non-string closure citation %j into membership',
    ({ phase }) => {
      fixture(index(VALID));
      write(`${ARCHIVE}/record.md`, recordMarkdown(closedRecord('R-0007', phase)));
      const before = snapshot();
      const report = roundRecordIntegrity({ repoRoot: root });
      expect(report.ok).toBe(false);
      expect(report.findings).toContainEqual(unresolved('R-0007', '(none)'));
      expect(snapshot()).toEqual(before);
    },
  );
  it('retains closed-only applicability when a draft cites prose-only evidence', () => {
    fixture('PC-0007\n');
    write(`${ARCHIVE}/record.md`, recordMarkdown({ ...closedRecord(), status: 'draft' }));
    expect(roundRecordIntegrity({ repoRoot: root })).toEqual({ ok: true, findings: [] });
  });
  it.each([
    {
      name: 'missing decision',
      code: 'ROUND_ARCHIVE_DECISION_MISSING:DII-2',
      mutate: () => rmSync(join(root, 'law/register/DII-2.md')),
    },
    {
      name: 'absent closure proof',
      code: 'ROUND_ARCHIVE_PHASE_CLOSURE_MISSING:PC-0007',
      mutate: () => rmSync(join(root, PROOF)),
    },
    {
      name: 'invalid proof JSON',
      code: 'ROUND_ARCHIVE_PHASE_CLOSURE_INVALID',
      mutate: () => write(PROOF, '{'),
    },
    {
      name: 'mismatched merged identity',
      code: 'ROUND_ARCHIVE_PHASE_CLOSURE_MISMATCH',
      mutate: () => write(PROOF, JSON.stringify({ ...proof(), merged_as: 'a'.repeat(40) })),
    },
  ])('keeps $name refusal before malformed membership', async ({ code, mutate }) => {
    fixture('PC-0007\n');
    mutate();
    const before = snapshot();
    await sealError(code);
    expect(snapshot()).toEqual(before);
  });
  it.each([
    {
      name: 'failed gate',
      code: 'ROUND_ARCHIVE_GATE_NOT_GREEN:unit',
      mutate: () =>
        write(PROOF, JSON.stringify({ ...proof(), gates: { unit: { status: 'fail' } } })),
    },
    {
      name: 'failed validation criterion',
      code: 'ROUND_ARCHIVE_VALIDATION_NOT_GREEN',
      mutate: () =>
        write(
          PROOF,
          JSON.stringify({
            ...proof(),
            validation_criteria: [{ criterion: 'fixture', verdict: 'fail' }],
          }),
        ),
    },
    {
      name: 'missing required plan',
      code: 'ROUND_ARCHIVE_REQUIRED_ARTIFACT_MISSING:plan.md',
      mutate: () => rmSync(join(root, ACTIVE, 'plan.md')),
    },
  ])('does not let a terminal row bypass $name', async ({ code, mutate }) => {
    fixture(index(VALID));
    mutate();
    const before = snapshot();
    await sealError(code);
    expect(snapshot()).toEqual(before);
  });
});
