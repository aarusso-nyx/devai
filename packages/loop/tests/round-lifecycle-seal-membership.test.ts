// ADR-EVI-0001 (IA-003, IA-005): `round seal` passes the phase-ledger precondition only on an
// exact terminal row of the rounds index for the round being sealed, and keeps the error code
// ROUND_ARCHIVE_PHASE_LEDGER_MISSING otherwise. The row shape follows
// docs/reference/cli/evidence-render.md (Owner ruling of 2026-10-01, CMP-0004 guide decision 6).
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { validators } from '@devai-nyx/schemas';
import { withAuthorityHostTestScope } from '../../skills/tests/unit/authority-host-test-scope.js';
import {
  closeGovernedRound,
  declareGovernedRound,
  scaffoldGovernedRound,
} from '../src/round-lifecycle/index.js';

const LEDGER = 'record/derived/indexes/rounds.md';
const CLOSURES = 'record/proofs/compliance/closures';
const MISSING = 'ROUND_ARCHIVE_PHASE_LEDGER_MISSING';
const DETRAN = fileURLToPath(new URL('../../../tests/fixtures/closures/detran', import.meta.url));
const HEADER = [
  '# Rounds index',
  '',
  '| closure | round | supersedes | merged_as | terminal |',
  '| --- | --- | --- | --- | --- |',
];
const SHA = 'b'.repeat(40);

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, path: string, value: unknown): string {
  const target = join(root, path);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  return target;
}

function index(rows: readonly string[]): string {
  return `${[...HEADER, ...rows].join('\n')}\n`;
}

function row(
  closure: string,
  round: string,
  supersedes: string | null,
  terminal: boolean,
  merged = SHA,
): string {
  return `| ${closure} | ${round} | ${supersedes ?? '-'} | ${merged} | ${terminal ? 'yes' : 'no'} |`;
}

interface SealTarget {
  readonly round: string;
  readonly closure: string;
  readonly merged: string;
  readonly declared: string;
  readonly closed: string;
  readonly gate: string;
}

function roundRecord(target: SealTarget): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    id: target.round,
    title: 'Seal membership fixture',
    type: 'round-record',
    status: 'closed',
    date: '2026-10-01',
    authority: 'Architect',
    kind: 'round',
    goal: 'Seal only on an exact terminal row',
    declared_by: target.declared,
    closed_by: target.closed,
    phase_closure: target.closure,
    merged_as: target.merged,
    isolation: { kind: 'worktree', branch: 'fixture', base_sha: 'a'.repeat(40) },
    waves: [
      {
        id: 'W1',
        title: 'Seal',
        roles: ['Inspector'],
        type: 'serial',
        lock_scopes: ['tests/**'],
        gates: [target.gate],
      },
    ],
    gates: [target.gate],
    orchestrator_prompt: 'prompts/00-orchestrator.md',
    plan_path: 'plan.md',
  };
}

async function declare(root: string, target: SealTarget): Promise<void> {
  const value = roundRecord(target);
  expect(validators.recordMeta(value), JSON.stringify(validators.recordMeta.errors)).toBe(true);
  const recordPath = write(root, `inputs/${target.round}.json`, value);
  await withAuthorityHostTestScope(() => {
    scaffoldGovernedRound({ repoRoot: root, round: target.round });
    declareGovernedRound({ repoRoot: root, round: target.round, recordPath });
  });
}

function closure(id: string, round: string, supersedes?: string): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    id,
    round_id: round,
    declaring_decision: 'DII-1',
    closing_decision: 'DII-2',
    batches: [{ id: 'B1', roles: ['Architect'], headline: 'fixture' }],
    gates: { unit: { status: 'pass' } },
    source_repo_deleted: false,
    validation_criteria: [{ criterion: 'fixture', verdict: 'pass', evidence: 'unit' }],
    closed_at: '2026-10-01T00:00:00.000Z',
    merged_as: SHA,
    release_disposition: 'none-needed',
    ...(supersedes !== undefined && { supersedes }),
  };
}

/** A repository whose round R-0005 is closed through `sealed`, with an index written by `ledger`. */
async function fixture(options: {
  readonly sealed?: string;
  readonly closures?: readonly Record<string, unknown>[];
  readonly ledger: string | null;
}): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'devai-seal-membership-'));
  roots.push(root);
  const sealed = options.sealed ?? 'PC-0001';
  for (const value of options.closures ?? [closure('PC-0001', 'R-0005')]) {
    expect(validators.phaseClosure(value), JSON.stringify(validators.phaseClosure.errors)).toBe(
      true,
    );
    write(root, `${CLOSURES}/${String(value['id'])}.json`, value);
  }
  write(
    root,
    'law/register/DECISIONS.md',
    '### DII-1 — Declare fixture\n\n### DII-2 — Close fixture\n',
  );
  await declare(root, {
    round: 'R-0005',
    closure: sealed,
    merged: SHA,
    declared: 'DII-1',
    closed: 'DII-2',
    gate: 'unit',
  });
  if (options.ledger !== null) write(root, LEDGER, options.ledger);
  return root;
}

function seal(root: string, round: string | number = 'R-0005'): Promise<unknown> {
  return withAuthorityHostTestScope(() => closeGovernedRound({ repoRoot: root, round }));
}

function sealed(root: string, round = 'R-0005'): boolean {
  return existsSync(join(root, 'work/rounds', round, 'close-state.jsonl'));
}

describe('round seal exact membership: what seals', () => {
  it('seals on the exact terminal row of the round', async () => {
    const root = await fixture({ ledger: index([row('PC-0001', 'R-0005', null, true)]) });

    await expect(seal(root)).resolves.toMatchObject({ ok: true, id: 'R-0005' });
    expect(sealed(root)).toBe(true);
  });

  it('seals on the exact terminal row among the rows of other rounds', async () => {
    const root = await fixture({
      ledger: index([
        row('PC-0002', 'R-0004', null, true),
        row('PC-0001', 'R-0005', null, true),
        row('PC-0003', 'R-0006', null, true),
      ]),
    });

    await expect(seal(root)).resolves.toMatchObject({ ok: true });
    expect(sealed(root)).toBe(true);
  });

  it('seals through the superseding closure on its terminal row', async () => {
    const root = await fixture({
      sealed: 'PC-0002',
      closures: [closure('PC-0001', 'R-0005'), closure('PC-0002', 'R-0005', 'PC-0001')],
      ledger: index([
        row('PC-0001', 'R-0005', null, false),
        row('PC-0002', 'R-0005', 'PC-0001', true),
      ]),
    });

    await expect(seal(root)).resolves.toMatchObject({ ok: true });
    expect(sealed(root)).toBe(true);
  });
});

describe('round seal exact membership: what does not seal (IA-003)', () => {
  const cases: readonly { readonly name: string; readonly ledger: string | null }[] = [
    { name: 'no index file', ledger: null },
    { name: 'an empty index', ledger: '' },
    { name: 'the header without rows', ledger: index([]) },
    {
      name: 'the id only inside a longer id',
      ledger: index([row('PC-00010', 'R-0005', null, true)]),
    },
    {
      name: 'the id only as the prefix of a longer cell',
      ledger: index([row('PC-0001a', 'R-0005', null, true)]),
    },
    {
      name: 'the id only in a sentence',
      ledger: `${index([])}\nPC-0001 closed R-0005 and is terminal: yes.\n`,
    },
    {
      name: 'the id only in the heading',
      ledger: `# Rounds index PC-0001\n\n${index([]).split('\n').slice(2).join('\n')}`,
    },
    { name: 'the legacy substring-only ledger line', ledger: 'PC-0001\n' },
    {
      name: 'the id only as a superseded row',
      ledger: index([
        row('PC-0001', 'R-0005', null, false),
        row('PC-0002', 'R-0005', 'PC-0001', true),
      ]),
    },
    {
      name: 'the id only in the supersedes cell of another row',
      ledger: index([row('PC-0002', 'R-0005', 'PC-0001', true)]),
    },
    {
      name: 'the terminal row of a different round',
      ledger: index([row('PC-0001', 'R-0006', null, true)]),
    },
    {
      name: 'a row whose round cell only contains the round id',
      ledger: index([row('PC-0001', 'R-00050', null, true)]),
    },
    {
      name: 'a row with a terminal cell other than yes',
      ledger: index([
        row('PC-0001', 'R-0005', null, true).replace('| yes |', '| yes, superseded |'),
      ]),
    },
  ];

  it.each(cases)('refuses $name with ROUND_ARCHIVE_PHASE_LEDGER_MISSING', async ({ ledger }) => {
    const root = await fixture({ ledger });
    const before = ledger === null ? null : readFileSync(join(root, LEDGER), 'utf8');

    await expect(seal(root)).rejects.toThrow(MISSING);
    expect(sealed(root)).toBe(false);
    expect(existsSync(join(root, LEDGER)) ? readFileSync(join(root, LEDGER), 'utf8') : null).toBe(
      before,
    );
  });
});

/** The canonical index of the DETRAN fixture, as the reference page renders it. */
const DETRAN_INDEX = index([
  row('PC-0001', 'R-0003', null, true, 'cf8f475eaf1951fa2ebb3c42d24f725c6581ea0e'),
  row('PC-0002', 'R-0004', null, true, 'a7e5e93398dee6d3dd6a979d04dc5bd9e3b9d913'),
  row('PC-0003', 'R-0005', null, true, 'f432a0cd1ef3bc1005da24208b9e3fb58ac098d6'),
  row('PC-0004', 'R-0006', null, true, '515a5e3da63e040ae9287719d9a735213a31e249'),
  row('PC-0011', 'R-0007', null, true, 'b662f8af90fdd9d27be08ae49feec70ccd13aded'),
  row('PC-0005', 'R-0008', null, true, '3f8a817f4e716749420f716a9e5a83cc6b956d8e'),
  row('PC-0006', 'R-0009', null, true, '0940a201547ac92ac50d4d4a500544ceda1af559'),
  row('PC-0008', 'R-0010', null, true, '1c24657b784c519cd243a7e6925a33b460c760de'),
  row('PC-0009', 'R-0011', null, true, '3bb94351a456f26c30aaa574998103cdd27e262c'),
  row('PC-0010', 'R-0012', null, true, '828331d49ef5fb5d6ec368aba8c3f2360863e610'),
  row('PC-0013', 'R-0013', null, true, '646c6c2897f1dff275ebe513dfa15f62d5a2befb'),
  row('PC-0007', 'R-0014', null, true, '48d103fc36fa3b15a32e5dd5da11b6d729b3c596'),
  row('PC-0014', 'R-0015', null, true, '50626da5967c703a035aff6ce469a3e59511648c'),
  row('PC-0012', 'R-0016', null, true, '973e78c3cf0902479754e311412fea1082a5c9d0'),
  row('PC-0017', 'R-0017', null, false, 'd5afcf9211373238d6eb7b8ad09188a342101a39'),
  row('PC-0018', 'R-0017', 'PC-0017', true, 'd5afcf9211373238d6eb7b8ad09188a342101a39'),
  row('PC-0015', 'R-0018', null, false, '4bd1d553478e1eb831353d30dd6769183c2b3990'),
  row('PC-0020', 'R-0018', 'PC-0015', true, '4bd1d553478e1eb831353d30dd6769183c2b3990'),
  row('PC-0016', 'R-0019', null, true, '673934fc0bb634403b2ae7cfc8abf250183c4777'),
  row('PC-0019', 'R-0021', null, true, '1576708f8378817d5e3338953015f5acdb704e1e'),
]);

interface DetranClosure {
  readonly id: string;
  readonly round_id: string;
  readonly declaring_decision: string;
  readonly closing_decision: string;
  readonly merged_as: string;
  readonly supersedes?: string;
  readonly gates: Record<string, { readonly status: string }>;
  readonly validation_criteria: readonly { readonly verdict: string }[];
}

function detranClosures(): DetranClosure[] {
  const dir = join(DETRAN, CLOSURES);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as DetranClosure);
}

function detranTarget(value: DetranClosure, round = value.round_id): SealTarget {
  const gate = Object.entries(value.gates).find(([, result]) => result.status === 'pass')?.[0];
  if (gate === undefined) throw new Error(`${value.id} has no passing gate`);
  return {
    round,
    closure: value.id,
    merged: value.merged_as,
    declared: value.declaring_decision,
    closed: value.closing_decision,
    gate,
  };
}

/** A temp copy of the DETRAN closures with the given index and decisions; the fixture is never written. */
function detranRepository(ledger: string): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-seal-membership-detran-'));
  roots.push(root);
  cpSync(join(DETRAN, CLOSURES), join(root, CLOSURES), { recursive: true });
  const decisions = new Set(
    detranClosures().flatMap((value) => [value.declaring_decision, value.closing_decision]),
  );
  write(
    root,
    'law/register/DECISIONS.md',
    [...decisions]
      .sort()
      .map((decision) => `### ${decision} — DETRAN fixture decision\n`)
      .join('\n'),
  );
  write(root, LEDGER, ledger);
  return root;
}

describe('round seal against the DETRAN closures fixture (IA-005)', () => {
  const closures = detranClosures();
  const superseded = new Set(closures.flatMap((value) => value.supersedes ?? []));
  const terminal = closures.filter((value) => !superseded.has(value.id));
  const green = (value: DetranClosure): boolean =>
    Object.values(value.gates).every((result) => result.status === 'pass') &&
    value.validation_criteria.every((criterion) => criterion.verdict !== 'fail');

  it('has eighteen rounds with one terminal closure each', () => {
    expect(terminal).toHaveLength(18);
    expect(new Set(terminal.map((value) => value.round_id)).size).toBe(18);
  });

  it('seals R-0017 through PC-0018, the terminal row the adopter sealed', async () => {
    const pc0018 = closures.find((value) => value.id === 'PC-0018');
    if (pc0018 === undefined) throw new Error('PC-0018 missing from the DETRAN fixture');
    const root = detranRepository(DETRAN_INDEX);
    await declare(root, detranTarget(pc0018));

    await expect(seal(root, 'R-0017')).resolves.toMatchObject({ ok: true, id: 'R-0017' });
    expect(sealed(root, 'R-0017')).toBe(true);
  });

  it('passes the ledger precondition for every terminal closure, and seals every green one', async () => {
    const root = detranRepository(DETRAN_INDEX);
    for (const value of terminal) await declare(root, detranTarget(value));

    for (const value of terminal) {
      const outcome = await seal(root, value.round_id).then(
        () => 'sealed',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect(outcome, `${value.round_id} via ${value.id}`).not.toBe(MISSING);
      if (green(value)) expect(outcome, `${value.round_id} via ${value.id}`).toBe('sealed');
    }
  });

  it.each([
    ['R-0017', 'PC-0017'],
    ['R-0018', 'PC-0015'],
  ])('refuses %s through its superseded closure %s', async (round, id) => {
    const value = closures.find((candidate) => candidate.id === id);
    if (value === undefined) throw new Error(`${id} missing from the DETRAN fixture`);
    const root = detranRepository(DETRAN_INDEX);
    await declare(root, detranTarget(value, round));

    await expect(seal(root, round)).rejects.toThrow(MISSING);
    expect(sealed(root, round)).toBe(false);
  });

  it("refuses R-0017 against the adopter's hand-generated index, which has no terminal cell", async () => {
    const pc0018 = closures.find((value) => value.id === 'PC-0018');
    if (pc0018 === undefined) throw new Error('PC-0018 missing from the DETRAN fixture');
    const adopter = readFileSync(join(DETRAN, LEDGER), 'utf8');
    const root = detranRepository(adopter);
    await declare(root, detranTarget(pc0018));

    await expect(seal(root, 'R-0017')).rejects.toThrow(MISSING);
    expect(sealed(root, 'R-0017')).toBe(false);
  });
});
