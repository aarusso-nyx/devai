// ADR-EVI-0001 (IA-001, IA-002, IA-004, IA-005): `devai evidence render --kind rounds` renders
// record/derived/indexes/rounds.md from the phase closures, rejects an inconsistent closure set
// without writing, and `--check` compares bytes without writing. The contract under test is
// docs/reference/cli/evidence-render.md (Owner ruling of 2026-10-01, CMP-0004 guide decision 6).
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  cpSync,
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
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CAC } from '../../node_modules/cac/dist/index.d.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { renderRoundRecords } from '@devai-nyx/loop';
import { EXIT_USAGE } from '@devai-nyx/utils';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { evidenceRender } from '../../src/commands/evidence/facade.js';

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};

const CLOSURES = 'record/proofs/compliance/closures';
const INDEX = 'record/derived/indexes/rounds.md';
// `--out` is confined to the action's declared state and proof domains; the committed index
// is promoted from a rendered copy, never written in place by this action.
const OUT = '.devai/state/render/rounds.md';
const DETRAN = fileURLToPath(
  new URL('../../../../tests/fixtures/closures/detran', import.meta.url),
);
const PREFIX = 'devai evidence render: ';

interface InvocationResult {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}

const roots: string[] = [];

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), 'devai-evidence-render-rounds-'));
  roots.push(path);
  return path;
}

async function invoke(
  argv: readonly string[],
  options: { readonly writeConsent?: boolean } = {},
): Promise<InvocationResult> {
  const cli = cac('devai-evidence-render-rounds');
  evidenceRender.register(cli);
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let stdout = '';
  let stderr = '';
  try {
    process.argv = ['node', 'devai', ...argv];
    process.exitCode = undefined;
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    cli.parse(process.argv, { run: false });
    if (options.writeConsent === true) process.argv.push('--write');
    await withAuthorityHostTestScope(() => cli.runMatchedCommand());
    await new Promise<void>((done) => setImmediate(done));
    return {
      exit: typeof process.exitCode === 'number' ? process.exitCode : 0,
      stdout,
      stderr,
    };
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

function render(repo: string, extra: readonly string[] = []): Promise<InvocationResult> {
  return invoke(['evidence-render', '--kind', 'rounds', '--repo-root', repo, ...extra]);
}

function renderTo(repo: string, out = OUT): Promise<InvocationResult> {
  return invoke(['evidence-render', '--kind', 'rounds', '--repo-root', repo, '--out', out], {
    writeConsent: true,
  });
}

function check(repo: string): Promise<InvocationResult> {
  return render(repo, ['--check']);
}

function closure(
  id: string,
  round: string,
  options: { readonly supersedes?: string; readonly merged?: string } = {},
): Record<string, unknown> {
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
    merged_as: options.merged ?? id.slice(3).repeat(10),
    release_disposition: 'none-needed',
    ...(options.supersedes !== undefined && { supersedes: options.supersedes }),
  };
}

function put(repo: string, file: string, value: unknown): void {
  const target = join(repo, CLOSURES, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * The superseding fixture: round order differs from closure-id order, and the R-0003 chain
 * PC-0004 -> PC-0003 -> PC-0005 differs from its closure-id order.
 */
const SUPERSEDING: readonly Record<string, unknown>[] = [
  closure('PC-0001', 'R-0002'),
  closure('PC-0002', 'R-0001'),
  closure('PC-0003', 'R-0003', { supersedes: 'PC-0004' }),
  closure('PC-0004', 'R-0003'),
  closure('PC-0005', 'R-0003', { supersedes: 'PC-0003' }),
];

function superseding(order: 'forward' | 'reverse' = 'forward'): string {
  const repo = tempRoot();
  const records = order === 'forward' ? SUPERSEDING : [...SUPERSEDING].reverse();
  for (const record of records) put(repo, `${String(record['id'])}.json`, record);
  return repo;
}

const SUPERSEDING_INDEX = [
  '# Rounds index',
  '',
  '| closure | round | supersedes | merged_as | terminal |',
  '| --- | --- | --- | --- | --- |',
  `| PC-0002 | R-0001 | - | ${'0002'.repeat(10)} | yes |`,
  `| PC-0001 | R-0002 | - | ${'0001'.repeat(10)} | yes |`,
  `| PC-0004 | R-0003 | - | ${'0004'.repeat(10)} | no |`,
  `| PC-0003 | R-0003 | PC-0004 | ${'0003'.repeat(10)} | no |`,
  `| PC-0005 | R-0003 | PC-0003 | ${'0005'.repeat(10)} | yes |`,
  '',
].join('\n');

const DETRAN_INDEX = [
  '# Rounds index',
  '',
  '| closure | round | supersedes | merged_as | terminal |',
  '| --- | --- | --- | --- | --- |',
  '| PC-0001 | R-0003 | - | cf8f475eaf1951fa2ebb3c42d24f725c6581ea0e | yes |',
  '| PC-0002 | R-0004 | - | a7e5e93398dee6d3dd6a979d04dc5bd9e3b9d913 | yes |',
  '| PC-0003 | R-0005 | - | f432a0cd1ef3bc1005da24208b9e3fb58ac098d6 | yes |',
  '| PC-0004 | R-0006 | - | 515a5e3da63e040ae9287719d9a735213a31e249 | yes |',
  '| PC-0011 | R-0007 | - | b662f8af90fdd9d27be08ae49feec70ccd13aded | yes |',
  '| PC-0005 | R-0008 | - | 3f8a817f4e716749420f716a9e5a83cc6b956d8e | yes |',
  '| PC-0006 | R-0009 | - | 0940a201547ac92ac50d4d4a500544ceda1af559 | yes |',
  '| PC-0008 | R-0010 | - | 1c24657b784c519cd243a7e6925a33b460c760de | yes |',
  '| PC-0009 | R-0011 | - | 3bb94351a456f26c30aaa574998103cdd27e262c | yes |',
  '| PC-0010 | R-0012 | - | 828331d49ef5fb5d6ec368aba8c3f2360863e610 | yes |',
  '| PC-0013 | R-0013 | - | 646c6c2897f1dff275ebe513dfa15f62d5a2befb | yes |',
  '| PC-0007 | R-0014 | - | 48d103fc36fa3b15a32e5dd5da11b6d729b3c596 | yes |',
  '| PC-0014 | R-0015 | - | 50626da5967c703a035aff6ce469a3e59511648c | yes |',
  '| PC-0012 | R-0016 | - | 973e78c3cf0902479754e311412fea1082a5c9d0 | yes |',
  '| PC-0017 | R-0017 | - | d5afcf9211373238d6eb7b8ad09188a342101a39 | no |',
  '| PC-0018 | R-0017 | PC-0017 | d5afcf9211373238d6eb7b8ad09188a342101a39 | yes |',
  '| PC-0015 | R-0018 | - | 4bd1d553478e1eb831353d30dd6769183c2b3990 | no |',
  '| PC-0020 | R-0018 | PC-0015 | 4bd1d553478e1eb831353d30dd6769183c2b3990 | yes |',
  '| PC-0016 | R-0019 | - | 673934fc0bb634403b2ae7cfc8abf250183c4777 | yes |',
  '| PC-0019 | R-0021 | - | 1576708f8378817d5e3338953015f5acdb704e1e | yes |',
  '',
].join('\n');

/** Every file under `repo` with its sha256, so "writes nothing" is a whole-tree comparison. */
function tree(repo: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else
        entries[relative(repo, path)] = createHash('sha256')
          .update(readFileSync(path))
          .digest('hex');
    }
  };
  walk(repo);
  return entries;
}

describe('evidence render --kind rounds: canonical bytes (IA-004)', () => {
  it('renders the superseding fixture to the exact canonical bytes on stdout and writes nothing', async () => {
    const repo = superseding();
    const before = tree(repo);

    const result = await render(repo);

    expect(result).toEqual({ exit: 0, stdout: SUPERSEDING_INDEX, stderr: '' });
    expect(tree(repo)).toEqual(before);
  });

  it('renders byte-identically twice, and from two roots written in opposite orders', async () => {
    const first = superseding('forward');
    const second = superseding('reverse');

    const results = [await render(first), await render(first), await render(second)];

    for (const result of results) expect(result).toEqual(results[0]);
    expect(results[0]?.stdout).toBe(SUPERSEDING_INDEX);
  });

  it('keeps the byte contract: LF only, one trailing newline, no trailing whitespace', async () => {
    const { stdout } = await render(superseding());

    expect(stdout).not.toContain('\r');
    expect(stdout.endsWith('\n')).toBe(true);
    expect(stdout.endsWith('\n\n')).toBe(false);
    for (const line of stdout.split('\n')) expect(line).toBe(line.trimEnd());
    expect(stdout.split('\n').slice(0, 4)).toEqual([
      '# Rounds index',
      '',
      '| closure | round | supersedes | merged_as | terminal |',
      '| --- | --- | --- | --- | --- |',
    ]);
  });

  it('writes the same bytes with --out --write, and the written file then passes --check', async () => {
    const repo = superseding();

    const written = await renderTo(repo);

    expect(written.exit).toBe(0);
    expect(readFileSync(join(repo, OUT), 'utf8')).toBe(SUPERSEDING_INDEX);
    mkdirSync(join(repo, dirname(INDEX)), { recursive: true });
    cpSync(join(repo, OUT), join(repo, INDEX));
    const before = tree(repo);
    const checked = await check(repo);
    expect(checked).toMatchObject({ exit: 0, stderr: '' });
    expect(tree(repo)).toEqual(before);
  });

  it('reads no round record: a narrative under work/rounds does not change the index', async () => {
    const repo = superseding();
    mkdirSync(join(repo, 'work/rounds/R-0001'), { recursive: true });
    writeFileSync(
      join(repo, 'work/rounds/R-0001/record.md'),
      '---\nid: R-0001\n---\n\n# R-0001\n\nPC-0099 is mentioned only here.\n',
    );

    expect((await render(repo)).stdout).toBe(SUPERSEDING_INDEX);
  });
});

describe('evidence render --kind rounds: rejections write nothing (IA-001, IA-002)', () => {
  const cases: readonly {
    readonly name: string;
    readonly files: Readonly<Record<string, Record<string, unknown>>>;
    readonly file: RegExp;
  }[] = [
    {
      name: 'a closure file whose name differs from its id',
      files: {
        'PC-0001.json': closure('PC-0001', 'R-0001'),
        'PC-0002.json': closure('PC-0002', 'R-0002'),
        'PC-0003.json': closure('PC-0002', 'R-0003'),
      },
      file: /PC-0003\.json/u,
    },
    {
      name: 'the same closure under two file names',
      files: {
        'PC-0001.json': closure('PC-0001', 'R-0001'),
        'PC-0002.json': closure('PC-0001', 'R-0001'),
      },
      file: /PC-0002\.json/u,
    },
    {
      name: 'a supersedes link naming an absent id',
      files: {
        'PC-0001.json': closure('PC-0001', 'R-0001'),
        'PC-0002.json': closure('PC-0002', 'R-0001', { supersedes: 'PC-0099' }),
      },
      file: /PC-0002\.json/u,
    },
    {
      name: 'a supersedes link that crosses rounds',
      files: {
        'PC-0001.json': closure('PC-0001', 'R-0017'),
        'PC-0002.json': closure('PC-0002', 'R-0018', { supersedes: 'PC-0001' }),
      },
      file: /PC-0002\.json/u,
    },
    {
      name: 'two closures that supersede each other',
      files: {
        'PC-0004.json': closure('PC-0004', 'R-0001', { supersedes: 'PC-0005' }),
        'PC-0005.json': closure('PC-0005', 'R-0001', { supersedes: 'PC-0004' }),
      },
      file: /PC-000[45]\.json/u,
    },
    {
      name: 'a chain that never reaches a terminal closure',
      files: {
        'PC-0001.json': closure('PC-0001', 'R-0001'),
        'PC-0002.json': closure('PC-0002', 'R-0001', { supersedes: 'PC-0003' }),
        'PC-0003.json': closure('PC-0003', 'R-0001', { supersedes: 'PC-0002' }),
      },
      file: /PC-000[23]\.json/u,
    },
    {
      name: 'two terminal closures for one round',
      files: {
        'PC-0001.json': closure('PC-0001', 'R-0017'),
        'PC-0002.json': closure('PC-0002', 'R-0017'),
      },
      file: /PC-000[12]\.json/u,
    },
  ];

  function rejected(files: Readonly<Record<string, Record<string, unknown>>>): string {
    const repo = tempRoot();
    for (const [name, value] of Object.entries(files)) put(repo, name, value);
    return repo;
  }

  function expectRejected(result: InvocationResult, file: RegExp): void {
    expect(result.exit).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr.startsWith(PREFIX)).toBe(true);
    expect(result.stderr).toMatch(file);
  }

  it.each(cases)('rejects $name on stdout, naming the file', async ({ files, file }) => {
    const repo = rejected(files);
    const before = tree(repo);

    expectRejected(await render(repo), file);
    expect(tree(repo)).toEqual(before);
  });

  it.each(cases)(
    'rejects $name under --out --write and creates no index',
    async ({ files, file }) => {
      const repo = rejected(files);

      expectRejected(await renderTo(repo), file);
      expect(existsSync(join(repo, OUT))).toBe(false);
      expect(existsSync(join(repo, INDEX))).toBe(false);
    },
  );

  it.each(cases)(
    'rejects $name under --out --write and leaves a committed index untouched',
    async ({ files, file }) => {
      const repo = rejected(files);
      mkdirSync(join(repo, dirname(INDEX)), { recursive: true });
      writeFileSync(join(repo, INDEX), SUPERSEDING_INDEX);
      const before = tree(repo);

      expectRejected(await renderTo(repo), file);
      expect(tree(repo)).toEqual(before);
    },
  );

  it.each(cases)('rejects $name under --check and writes nothing', async ({ files, file }) => {
    const repo = rejected(files);
    mkdirSync(join(repo, dirname(INDEX)), { recursive: true });
    writeFileSync(join(repo, INDEX), SUPERSEDING_INDEX);
    const before = tree(repo);

    const result = await check(repo);

    expect(result.exit).not.toBe(0);
    expect(result.stderr).toMatch(file);
    expect(tree(repo)).toEqual(before);
  });
});

describe('evidence render --kind rounds --check (IA-004)', () => {
  function committed(contents: string): string {
    const repo = superseding();
    mkdirSync(join(repo, dirname(INDEX)), { recursive: true });
    writeFileSync(join(repo, INDEX), contents);
    return repo;
  }

  it('exits zero on identical bytes and writes nothing', async () => {
    const repo = committed(SUPERSEDING_INDEX);
    const before = tree(repo);

    const result = await check(repo);

    expect(result.exit).toBe(0);
    expect(result.stderr).toBe('');
    expect(tree(repo)).toEqual(before);
  });

  const oneByte: readonly (readonly [string, string])[] = [
    [
      'one changed character',
      SUPERSEDING_INDEX.replace('| PC-0005 | R-0003 |', '| PC-0005 | R-0004 |'),
    ],
    ['one changed terminal cell', SUPERSEDING_INDEX.replace('| yes |', '| yez |')],
    ['a missing trailing newline', SUPERSEDING_INDEX.slice(0, -1)],
    ['an extra trailing newline', `${SUPERSEDING_INDEX}\n`],
    ['a CRLF line ending', SUPERSEDING_INDEX.replace('\n', '\r\n')],
    ['a trailing space', SUPERSEDING_INDEX.replace('# Rounds index\n', '# Rounds index \n')],
  ];

  it.each(oneByte)(
    'exits non-zero on %s and leaves the committed file untouched',
    async (_, contents) => {
      expect(contents).not.toBe(SUPERSEDING_INDEX);
      const repo = committed(contents);
      const before = tree(repo);

      const result = await check(repo);

      expect(result.exit).not.toBe(0);
      expect(result.stderr.startsWith(PREFIX)).toBe(true);
      expect(tree(repo)).toEqual(before);
      expect(readFileSync(join(repo, INDEX), 'utf8')).toBe(contents);
    },
  );

  it('exits non-zero on a missing committed index and does not create it', async () => {
    const repo = superseding();
    const before = tree(repo);

    const result = await check(repo);

    expect(result.exit).not.toBe(0);
    expect(result.stderr.startsWith(PREFIX)).toBe(true);
    expect(existsSync(join(repo, INDEX))).toBe(false);
    expect(tree(repo)).toEqual(before);
  });

  it('exits non-zero when a closure is added after the index was rendered (freshness)', async () => {
    const repo = committed(SUPERSEDING_INDEX);
    put(repo, 'PC-0006.json', closure('PC-0006', 'R-0004'));
    const before = tree(repo);

    expect((await check(repo)).exit).not.toBe(0);
    expect(tree(repo)).toEqual(before);
  });

  it('refuses --check together with --out as a usage error and writes nothing', async () => {
    const repo = committed(SUPERSEDING_INDEX);
    const before = tree(repo);

    const result = await invoke(
      ['evidence-render', '--kind', 'rounds', '--repo-root', repo, '--check', '--out', INDEX],
      { writeConsent: true },
    );

    expect(result.exit).toBe(EXIT_USAGE);
    expect(result.stdout).toBe('');
    expect(result.stderr.startsWith(PREFIX)).toBe(true);
    expect(tree(repo)).toEqual(before);
  });
});

describe('evidence render --kind round-narratives', () => {
  it('keeps the bytes the former rounds kind produced from round records', async () => {
    const repo = tempRoot();
    mkdirSync(join(repo, 'work/rounds/R-0001'), { recursive: true });
    writeFileSync(
      join(repo, 'work/rounds/R-0001/record.md'),
      '---\nid: R-0001\n---\n\n# R-0001\n\nNarrative body.\n',
    );
    const expected = renderRoundRecords({ repoRoot: repo });

    const result = await invoke([
      'evidence-render',
      '--kind',
      'round-narratives',
      '--repo-root',
      repo,
    ]);

    expect(result).toEqual({
      exit: 0,
      stdout: expected.endsWith('\n') ? expected : `${expected}\n`,
      stderr: '',
    });
  });

  it('renders the empty narrative heading for a repository without rounds', async () => {
    const result = await invoke([
      'evidence-render',
      '--kind',
      'round-narratives',
      '--repo-root',
      tempRoot(),
    ]);

    expect(result).toEqual({ exit: 0, stdout: '# Governed Rounds\n', stderr: '' });
  });
});

describe('evidence render --kind rounds against the DETRAN closures fixture (IA-005)', () => {
  function detran(): string {
    const repo = tempRoot();
    cpSync(join(DETRAN, CLOSURES), join(repo, CLOSURES), { recursive: true });
    return repo;
  }

  it('renders the canonical index: rounds by id, PC-0018 after PC-0017, PC-0020 after PC-0015', async () => {
    expect(await render(detran())).toEqual({ exit: 0, stdout: DETRAN_INDEX, stderr: '' });
  });

  it("carries exactly the adopter index's closure, round, supersedes, and merged_as cells", async () => {
    const cells = (text: string, placeholder: string): string[] =>
      text
        .split('\n')
        .filter((line) => /^\| PC-[0-9]{4} \|/u.test(line))
        .map((line) => {
          const [id = '', round = '', supersedes = '', merged = ''] = line
            .slice(2, -2)
            .split(' | ');
          return [id, round, supersedes === placeholder ? '' : supersedes, merged].join(' ');
        })
        .sort();
    const adopter = readFileSync(join(DETRAN, INDEX), 'utf8');

    const { stdout } = await render(detran());

    expect(cells(adopter, '—')).toHaveLength(20);
    expect(cells(stdout, '-')).toEqual(cells(adopter, '—'));
  });

  it("flags the adopter's hand-generated index as stale under --check without rewriting it", async () => {
    const repo = detran();
    mkdirSync(join(repo, dirname(INDEX)), { recursive: true });
    cpSync(join(DETRAN, INDEX), join(repo, INDEX));
    const before = tree(repo);

    expect((await check(repo)).exit).not.toBe(0);
    expect(tree(repo)).toEqual(before);

    expect((await renderTo(repo)).exit).toBe(0);
    expect(readFileSync(join(repo, OUT), 'utf8')).toBe(DETRAN_INDEX);
    cpSync(join(repo, OUT), join(repo, INDEX));
    expect((await check(repo)).exit).toBe(0);
  });
});

describe('evidence render --out write scope', () => {
  it.each([
    ['the committed rounds index', INDEX],
    ['an arbitrary workspace file', 'docs/rendered.md'],
    ['a parent of the repository', '../escaped.md'],
    ['an absolute path outside the repository', join(tmpdir(), 'devai-render-escape.md')],
  ])('refuses %s and writes nothing', async (_name, out) => {
    const repo = superseding();
    const before = tree(repo);
    const result = await renderTo(repo, out);
    expect(result.exit).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('EVIDENCE_RENDER_OUT_OUTSIDE_SCOPE');
    expect(tree(repo)).toEqual(before);
    expect(existsSync(join(repo, '..', 'escaped.md'))).toBe(false);
    expect(existsSync(join(tmpdir(), 'devai-render-escape.md'))).toBe(false);
  });

  it.each([
    ['runtime state', '.devai/state/render/rounds.md'],
    ['the proof store', 'record/proofs/rounds-view.md'],
  ])('writes inside %s through the guarded filesystem', async (_name, out) => {
    const repo = superseding();
    const result = await renderTo(repo, out);
    expect(result.exit).toBe(0);
    expect(readFileSync(join(repo, out), 'utf8')).toBe(SUPERSEDING_INDEX);
  });
});
