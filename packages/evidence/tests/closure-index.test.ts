// ADR-EVI-0001 (IA-001, IA-002, IA-004, IA-005): the closure reader and the rounds-index row
// computation the renderer reuses. The row shape, order, and rejections follow
// docs/reference/cli/evidence-render.md (Owner ruling of 2026-10-01, CMP-0004 guide decision 6).
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../skills/tests/unit/authority-host-test-scope.js';
import * as closureModule from '../src/closure/index.js';
import { computeLedger, readClosures, type PhaseClosureRecord } from '../src/closure/index.js';

/**
 * The interface TASK-0433 adds to `packages/evidence/src/closure/index.ts`: one row per
 * closure in rounds-index order, or a thrown Error naming the offending `PC-NNNN.json`.
 */
interface ClosureIndexRow {
  readonly closure: string;
  readonly round: string;
  readonly supersedes: string | null;
  readonly merged_as: string;
  readonly terminal: boolean;
}

type ClosureIndexRows = (records: readonly PhaseClosureRecord[]) => readonly ClosureIndexRow[];

function closureIndexRows(records: readonly PhaseClosureRecord[]): readonly ClosureIndexRow[] {
  const exported = (closureModule as unknown as { closureIndexRows?: ClosureIndexRows })
    .closureIndexRows;
  if (typeof exported !== 'function') {
    throw new TypeError('closureIndexRows is not exported from packages/evidence/src/closure');
  }
  return exported(records);
}

const CLOSURES = 'record/proofs/compliance/closures';
const DETRAN = fileURLToPath(new URL('../../../tests/fixtures/closures/detran', import.meta.url));

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-closure-index-'));
  roots.push(root);
  return root;
}

function closure(
  id: string,
  round: string,
  options: { readonly supersedes?: string; readonly merged?: string } = {},
): PhaseClosureRecord {
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
    closed_at: '2026-07-26T00:00:00.000Z',
    merged_as: options.merged ?? id.slice(3).repeat(10),
    release_disposition: 'none-needed',
    ...(options.supersedes !== undefined && { supersedes: options.supersedes }),
  };
}

function put(root: string, file: string, value: unknown): void {
  const dir = join(root, CLOSURES);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), `${JSON.stringify(value, null, 2)}\n`);
}

function read(root: string): Promise<PhaseClosureRecord[]> {
  return withAuthorityHostTestScope(() => readClosures(root));
}

/**
 * The superseding fixture: round order differs from closure-id order, and the R-0003 chain
 * PC-0004 -> PC-0003 -> PC-0005 differs from its closure-id order.
 */
function superseding(): PhaseClosureRecord[] {
  return [
    closure('PC-0001', 'R-0002'),
    closure('PC-0002', 'R-0001'),
    closure('PC-0003', 'R-0003', { supersedes: 'PC-0004' }),
    closure('PC-0004', 'R-0003'),
    closure('PC-0005', 'R-0003', { supersedes: 'PC-0003' }),
  ];
}

const SUPERSEDING_ROWS: readonly ClosureIndexRow[] = [
  {
    closure: 'PC-0002',
    round: 'R-0001',
    supersedes: null,
    merged_as: '0002'.repeat(10),
    terminal: true,
  },
  {
    closure: 'PC-0001',
    round: 'R-0002',
    supersedes: null,
    merged_as: '0001'.repeat(10),
    terminal: true,
  },
  {
    closure: 'PC-0004',
    round: 'R-0003',
    supersedes: null,
    merged_as: '0004'.repeat(10),
    terminal: false,
  },
  {
    closure: 'PC-0003',
    round: 'R-0003',
    supersedes: 'PC-0004',
    merged_as: '0003'.repeat(10),
    terminal: false,
  },
  {
    closure: 'PC-0005',
    round: 'R-0003',
    supersedes: 'PC-0003',
    merged_as: '0005'.repeat(10),
    terminal: true,
  },
];

/** The DETRAN rows in canonical order (rounds by id, then supersession chain). */
const DETRAN_ROWS: readonly (readonly [string, string, string | null, string, boolean])[] = [
  ['PC-0001', 'R-0003', null, 'cf8f475eaf1951fa2ebb3c42d24f725c6581ea0e', true],
  ['PC-0002', 'R-0004', null, 'a7e5e93398dee6d3dd6a979d04dc5bd9e3b9d913', true],
  ['PC-0003', 'R-0005', null, 'f432a0cd1ef3bc1005da24208b9e3fb58ac098d6', true],
  ['PC-0004', 'R-0006', null, '515a5e3da63e040ae9287719d9a735213a31e249', true],
  ['PC-0011', 'R-0007', null, 'b662f8af90fdd9d27be08ae49feec70ccd13aded', true],
  ['PC-0005', 'R-0008', null, '3f8a817f4e716749420f716a9e5a83cc6b956d8e', true],
  ['PC-0006', 'R-0009', null, '0940a201547ac92ac50d4d4a500544ceda1af559', true],
  ['PC-0008', 'R-0010', null, '1c24657b784c519cd243a7e6925a33b460c760de', true],
  ['PC-0009', 'R-0011', null, '3bb94351a456f26c30aaa574998103cdd27e262c', true],
  ['PC-0010', 'R-0012', null, '828331d49ef5fb5d6ec368aba8c3f2360863e610', true],
  ['PC-0013', 'R-0013', null, '646c6c2897f1dff275ebe513dfa15f62d5a2befb', true],
  ['PC-0007', 'R-0014', null, '48d103fc36fa3b15a32e5dd5da11b6d729b3c596', true],
  ['PC-0014', 'R-0015', null, '50626da5967c703a035aff6ce469a3e59511648c', true],
  ['PC-0012', 'R-0016', null, '973e78c3cf0902479754e311412fea1082a5c9d0', true],
  ['PC-0017', 'R-0017', null, 'd5afcf9211373238d6eb7b8ad09188a342101a39', false],
  ['PC-0018', 'R-0017', 'PC-0017', 'd5afcf9211373238d6eb7b8ad09188a342101a39', true],
  ['PC-0015', 'R-0018', null, '4bd1d553478e1eb831353d30dd6769183c2b3990', false],
  ['PC-0020', 'R-0018', 'PC-0015', '4bd1d553478e1eb831353d30dd6769183c2b3990', true],
  ['PC-0016', 'R-0019', null, '673934fc0bb634403b2ae7cfc8abf250183c4777', true],
  ['PC-0019', 'R-0021', null, '1576708f8378817d5e3338953015f5acdb704e1e', true],
];

describe('readClosures refusals the rounds index inherits (IA-001)', () => {
  it('refuses a closure file whose name differs from its id and names the file', async () => {
    const root = tempRoot();
    put(root, 'PC-0001.json', closure('PC-0001', 'R-0001'));
    put(root, 'PC-0002.json', closure('PC-0002', 'R-0002'));
    put(root, 'PC-0003.json', closure('PC-0002', 'R-0003'));

    await expect(read(root)).rejects.toThrow(/PC-0003\.json/u);
  });

  it('refuses the same closure id under two file names and names the second file', async () => {
    const root = tempRoot();
    put(root, 'PC-0001.json', closure('PC-0001', 'R-0001'));
    put(root, 'PC-0002.json', closure('PC-0001', 'R-0001'));

    await expect(read(root)).rejects.toThrow(/PC-0002\.json/u);
  });

  it('reads the DETRAN fixture byte-exact and sorted by closure id', async () => {
    const records = await read(DETRAN);

    expect(records.map((record) => record.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `PC-${String(index + 1).padStart(4, '0')}`),
    );
    const ledger = computeLedger(records);
    expect(
      ledger.rounds.filter((round) => round.superseded_by !== undefined).map((round) => round.id),
    ).toEqual(['PC-0015', 'PC-0017']);
  });
});

describe('closureIndexRows order (IA-004)', () => {
  it('orders rounds by id and each round by its supersession chain, not by closure id', () => {
    expect(closureIndexRows(superseding())).toEqual(SUPERSEDING_ROWS);
  });

  it('is a function of the closures alone: every input order yields the same rows', () => {
    const records = superseding();
    const permutations = [
      records,
      [...records].reverse(),
      [records[2], records[4], records[0], records[3], records[1]],
      [records[4], records[3], records[2], records[1], records[0]],
    ].map((list) => list.filter((record): record is PhaseClosureRecord => record !== undefined));

    for (const permutation of permutations) {
      expect(closureIndexRows(permutation)).toEqual(SUPERSEDING_ROWS);
    }
  });

  it('marks exactly one terminal row per round', () => {
    const rows = closureIndexRows(superseding());
    const terminals = new Map<string, number>();
    for (const row of rows) {
      if (row.terminal) terminals.set(row.round, (terminals.get(row.round) ?? 0) + 1);
    }
    expect([...terminals.entries()].sort()).toEqual([
      ['R-0001', 1],
      ['R-0002', 1],
      ['R-0003', 1],
    ]);
  });

  it('returns no rows for no closures', () => {
    expect(closureIndexRows([])).toEqual([]);
  });
});

describe('closureIndexRows rejections (IA-001, IA-002)', () => {
  const cases: readonly {
    readonly name: string;
    readonly records: readonly PhaseClosureRecord[];
    readonly file: RegExp;
  }[] = [
    {
      name: 'two records carrying the same id',
      records: [closure('PC-0001', 'R-0001'), closure('PC-0001', 'R-0002')],
      file: /PC-0001\.json/u,
    },
    {
      name: 'a supersedes link that names an absent id',
      records: [
        closure('PC-0001', 'R-0001'),
        closure('PC-0002', 'R-0001', { supersedes: 'PC-0099' }),
      ],
      file: /PC-0002\.json/u,
    },
    {
      name: 'a supersedes link that crosses rounds',
      records: [
        closure('PC-0001', 'R-0017'),
        closure('PC-0002', 'R-0018', { supersedes: 'PC-0001' }),
      ],
      file: /PC-0002\.json/u,
    },
    {
      name: 'two closures that supersede each other',
      records: [
        closure('PC-0004', 'R-0001', { supersedes: 'PC-0005' }),
        closure('PC-0005', 'R-0001', { supersedes: 'PC-0004' }),
      ],
      file: /PC-000[45]\.json/u,
    },
    {
      name: 'a closure that supersedes itself',
      records: [closure('PC-0001', 'R-0001', { supersedes: 'PC-0001' })],
      file: /PC-0001\.json/u,
    },
    {
      name: 'a three-closure cycle',
      records: [
        closure('PC-0001', 'R-0001', { supersedes: 'PC-0003' }),
        closure('PC-0002', 'R-0001', { supersedes: 'PC-0001' }),
        closure('PC-0003', 'R-0001', { supersedes: 'PC-0002' }),
      ],
      file: /PC-000[123]\.json/u,
    },
    {
      name: 'a cycle beside a terminal closure of the same round, so the chain never reaches it',
      records: [
        closure('PC-0001', 'R-0001'),
        closure('PC-0002', 'R-0001', { supersedes: 'PC-0003' }),
        closure('PC-0003', 'R-0001', { supersedes: 'PC-0002' }),
      ],
      file: /PC-000[23]\.json/u,
    },
    {
      name: 'two terminal closures for one round',
      records: [closure('PC-0001', 'R-0017'), closure('PC-0002', 'R-0017')],
      file: /PC-000[12]\.json/u,
    },
    {
      name: 'two closures superseding the same closure (a fork with two terminals)',
      records: [
        closure('PC-0001', 'R-0017'),
        closure('PC-0002', 'R-0017', { supersedes: 'PC-0001' }),
        closure('PC-0003', 'R-0017', { supersedes: 'PC-0001' }),
      ],
      file: /PC-000[23]\.json/u,
    },
  ];

  it.each(cases)('rejects $name and names the offending file', ({ records, file }) => {
    expect(() => closureIndexRows(records)).toThrow(file);
  });
});

describe('the DETRAN closures fixture (IA-005)', () => {
  it('yields the canonical rows: rounds by id, PC-0018 after PC-0017, PC-0020 after PC-0015', async () => {
    const rows = closureIndexRows(await read(DETRAN));

    expect(
      rows.map((row) => [row.closure, row.round, row.supersedes, row.merged_as, row.terminal]),
    ).toEqual(DETRAN_ROWS);
  });

  it("carries exactly the adopter index's closure, round, supersedes, and merged_as cells", async () => {
    const adopter = readFileSync(join(DETRAN, 'record/derived/indexes/rounds.md'), 'utf8')
      .split('\n')
      .filter((line) => /^\| PC-[0-9]{4} \|/u.test(line))
      .map((line) => {
        const [id = '', round = '', supersedes = '', merged = ''] = line.slice(2, -2).split(' | ');
        return [id, round, supersedes === '—' ? null : supersedes, merged] as const;
      });
    const rows = closureIndexRows(await read(DETRAN)).map(
      (row) => [row.closure, row.round, row.supersedes, row.merged_as] as const,
    );

    expect(adopter).toHaveLength(20);
    const key = (row: readonly unknown[]): string => JSON.stringify(row);
    expect(rows.map(key).sort()).toEqual(adopter.map(key).sort());
  });

  it('marks terminal exactly the closures no other closure supersedes', async () => {
    const records = await read(DETRAN);
    const superseded = new Set(
      computeLedger(records).rounds.flatMap((round) =>
        round.superseded_by === undefined ? [] : [round.id],
      ),
    );
    for (const row of closureIndexRows(records)) {
      expect(row.terminal, row.closure).toBe(!superseded.has(row.closure));
    }
  });

  it('renders the same rows from a copy of the fixture as from the fixture itself', async () => {
    const copy = tempRoot();
    cpSync(join(DETRAN, 'record'), join(copy, 'record'), { recursive: true });

    expect(closureIndexRows(await read(copy))).toEqual(closureIndexRows(await read(DETRAN)));
  });
});
