// Invariants: ADR-SCR-0011 IA-004, ADR-REL-0033 IA-001, IA-002, IA-003
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI_PACKAGE = join(ROOT, 'packages/cli');
const FIXTURES = join(ROOT, 'tests/fixtures/sensor-readings/packed-adopter');
const STORE = '.devai/state/sensor-readings';
const LEGACY_STORE = 'record/proofs/freshness/readings';
const FOUR_KINDS = [
  'decision_record_integrity',
  'decision_citation_resolution',
  'archive_immutability',
  'round_record_integrity',
] as const;

// The packed paths an adopter installs, each paired with the source bytes it must equal.
const PACKED_LAW = [
  ['dist/law/policy/sensor-registry.json', 'law/policy/sensor-registry.json'],
  ['dist/runtime/index/sensor-registry.json', 'law/policy/sensor-registry.json'],
  ['dist/law/policy/sense-presets.json', 'law/policy/sense-presets.json'],
  ['dist/runtime/index/sense-presets.json', 'law/policy/sense-presets.json'],
  [
    'dist/runtime/index/schemas/sensor-reading.schema.json',
    'law/schemas/sensor-reading.schema.json',
  ],
] as const;

const { npmPackOutput } = (await import(
  new URL('../../scripts/npm-pack-output.mjs', import.meta.url).href
)) as {
  npmPackOutput: (
    value: unknown,
    expected: { name: string; version: string },
  ) => { filename: string; files: { path: string }[] };
};

interface RegistryEntry {
  readonly kind: string;
  readonly effect: string;
}
interface Cell {
  readonly substrate: string;
  readonly property: string;
  readonly verdict: string;
  readonly sensor_readings?: readonly string[];
  readonly notes?: string;
}
interface Envelope<T> {
  readonly ok: boolean;
  readonly result?: { readonly value: T };
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly context?: { readonly payload?: T };
  };
}
interface SenseRunValue {
  readonly members: ReadonlyArray<{ readonly kind: string; readonly effect: string }>;
  readonly excluded: ReadonlyArray<{ readonly kind: string; readonly effect: string }>;
  readonly results: ReadonlyArray<{ readonly command: string; readonly stdout: string }>;
}
interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

let workspace = '';
let packageRoot = '';
let fixture = '';
let head = '';

function cli(args: readonly string[]): CliResult {
  const result = spawnSync(
    process.execPath,
    [join(packageRoot, 'dist/runtime/index/bin.js'), ...args],
    { cwd: fixture, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function envelope<T>(result: CliResult): Envelope<T> {
  // The CLI writes its envelope to stdout, or to stderr when the action is refused or gated.
  return JSON.parse(result.stdout.trim() === '' ? result.stderr : result.stdout) as Envelope<T>;
}

function packedJson<T>(relative: string): T {
  return JSON.parse(readFileSync(join(packageRoot, relative), 'utf8')) as T;
}

function packedSchemaValidator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv.compile(packedJson<object>('dist/runtime/index/schemas/sensor-reading.schema.json'));
}

function resetStore(): void {
  rmSync(join(fixture, STORE), { recursive: true, force: true });
  mkdirSync(join(fixture, STORE), { recursive: true });
}

function placeInStore(kind: string, name: string, body: string): string {
  const path = join(fixture, STORE, kind, name);
  mkdirSync(join(fixture, STORE, kind), { recursive: true });
  writeFileSync(path, body);
  return path;
}

function senseRunReading(kind: string): Record<string, unknown> {
  // A non-pass reading arrives inside the gated error payload rather than the result.
  const result = cli(['sense', 'run', kind, '--repo-root', '.', '--format', 'json']);
  const parsed = envelope<SenseRunValue>(result);
  const value = parsed.result?.value ?? parsed.error?.context?.payload;
  const stdout = value?.results[0]?.stdout ?? '';
  expect(stdout, result.stderr).not.toBe('');
  return JSON.parse(stdout) as Record<string, unknown>;
}

function recordReading(reading: Record<string, unknown>): string {
  const input = join('scratch', `${String(reading['id'])}.json`);
  mkdirSync(join(fixture, 'scratch'), { recursive: true });
  writeFileSync(join(fixture, input), `${JSON.stringify(reading)}\n`);
  const result = cli([
    'sense',
    'record',
    '--input',
    input,
    '--repo-root',
    '.',
    '--as-role',
    'inspector',
    '--write',
    '--format',
    'json',
  ]);
  expect(result.status, result.stderr).toBe(0);
  return envelope<{ path: string }>(result).result?.value.path ?? '';
}

function scorecard(at: string = head): CliResult {
  return cli(['audit', 'scorecard', '--repo-root', '.', '--at', at, '--format', 'json']);
}

function presenceCell(result: CliResult): Cell {
  expect(result.status, result.stderr).toBe(0);
  const cells = envelope<{ cells: Cell[] }>(result).result?.value.cells ?? [];
  const found = cells.find((cell) => cell.substrate === 'F4' && cell.property === 'T1');
  if (found === undefined) throw new Error('F4:T1 cell missing');
  return found;
}

function presenceCellIfEmitted(result: CliResult): Cell | undefined {
  if (result.status !== 0) return undefined;
  return presenceCell(result);
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'devai-packed-adopter-'));
  const packDestination = join(workspace, 'pack');
  const extract = join(workspace, 'extract');
  fixture = join(workspace, 'adopter');
  for (const directory of [packDestination, extract, fixture]) mkdirSync(directory);

  expect(existsSync(join(CLI_PACKAGE, 'dist/runtime/index/bin.js')), 'run pnpm run build').toBe(
    true,
  );
  const manifest = JSON.parse(readFileSync(join(CLI_PACKAGE, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
  };
  const entry = npmPackOutput(
    JSON.parse(
      execFileSync(
        'npm',
        ['pack', '--json', '--ignore-scripts', '--pack-destination', packDestination],
        { cwd: CLI_PACKAGE, encoding: 'utf8' },
      ),
    ),
    { name: manifest.name, version: manifest.version },
  );
  const tarball = join(packDestination, basename(entry.filename));
  expect(existsSync(tarball)).toBe(true);
  execFileSync('tar', ['-xzf', tarball, '-C', extract]);
  packageRoot = join(extract, 'package');

  const git = (args: readonly string[]) =>
    execFileSync('git', [...args], { cwd: fixture, encoding: 'utf8' }).trim();
  git(['init', '-q']);
  git(['config', 'user.name', 'DEVAI packed adopter']);
  git(['config', 'user.email', 'packed-adopter@example.invalid']);
  writeFileSync(join(fixture, '.gitignore'), '.devai/state/\nscratch/\n');
  for (const selector of [
    ['--constitution', '--tier', 'tier1'],
    ['--operational-law'],
    ['--subprocess-effects'],
    [],
  ]) {
    const bound = cli([
      'init',
      'bind',
      ...selector,
      '--target',
      '.',
      '--as-role',
      'architect',
      '--write',
      '--format',
      'json',
    ]);
    expect(bound.status, bound.stderr).toBe(0);
  }
  mkdirSync(join(fixture, 'src'));
  writeFileSync(
    join(fixture, 'src/tickets.controller.ts'),
    [
      "import { Controller, Get } from '@nestjs/common';",
      '',
      "@Controller('tickets')",
      'export class TicketsController {',
      '  @Get()',
      '  list() { return []; }',
      '}',
      '',
    ].join('\n'),
  );
  git(['add', '-A']);
  git(['commit', '-qm', 'packed adopter fixture']);
  head = git(['rev-parse', 'HEAD']);
}, 180_000);

afterAll(() => {
  if (workspace !== '') rmSync(workspace, { recursive: true, force: true });
});

describe('ADR-SCR-0011 IA-004: the packed artifact admits every sweep read kind', () => {
  it.each(PACKED_LAW)('packs %s byte-identical to %s', (packed, source) => {
    expect(readFileSync(join(packageRoot, packed)).equals(readFileSync(join(ROOT, source)))).toBe(
      true,
    );
  });

  it('declares no effect other than read in the packed sweep preset', () => {
    const registry = packedJson<{ entries: RegistryEntry[] }>(
      'dist/law/policy/sensor-registry.json',
    ).entries;
    const sweep = packedJson<{ presets: { name: string; members: string[] }[] }>(
      'dist/law/policy/sense-presets.json',
    ).presets.find((preset) => preset.name === 'sweep');
    const effects = new Map(registry.map((entry) => [entry.kind, entry.effect]));
    expect(sweep?.members.length).toBeGreaterThan(0);
    expect(sweep?.members.filter((kind) => effects.get(kind) !== 'read')).toEqual([]);
    const enumKinds = new Set(
      packedJson<{ properties: { sensor: { properties: { kind: { enum: string[] } } } } }>(
        'dist/runtime/index/schemas/sensor-reading.schema.json',
      ).properties.sensor.properties.kind.enum,
    );
    expect(sweep?.members.filter((kind) => !enumKinds.has(kind))).toEqual([]);
  });

  it('validates every reading the packed sweep emits against the packed schema', () => {
    const result = cli([
      'sense',
      'run',
      '--preset',
      'sweep',
      '--round',
      'R-0001',
      '--repo-root',
      '.',
      '--format',
      'json',
    ]);
    const parsed = envelope<SenseRunValue>(result);
    const value = parsed.result?.value ?? parsed.error?.context?.payload;
    expect(value, result.stderr).toBeDefined();
    expect(value?.members.filter((member) => member.effect !== 'read')).toEqual([]);
    expect(value?.excluded.every((member) => member.effect !== 'read')).toBe(true);

    const validate = packedSchemaValidator();
    const emitted: string[] = [];
    for (const run of value?.results ?? []) {
      if (run.stdout === '') continue;
      const reading = JSON.parse(run.stdout) as { sensor: { kind: string } };
      expect(validate(reading), `${run.command}: ${JSON.stringify(validate.errors)}`).toBe(true);
      emitted.push(reading.sensor.kind);
    }
    for (const kind of FOUR_KINDS) expect(emitted).toContain(kind);
  }, 120_000);
});

describe('ADR-REL-0033: the scorecard route from the packed artifact', () => {
  it('consumes a recorded reading from the readings store identically on two runs', () => {
    resetStore();
    const reading = senseRunReading('inventory_api');
    expect(reading['status']).toBe('pass');
    expect(packedSchemaValidator()(reading)).toBe(true);
    const persisted = recordReading(reading);
    const relative = join(STORE, 'inventory_api', `${String(reading['id'])}.json`);
    expect(persisted.endsWith(relative)).toBe(true);
    expect(existsSync(join(fixture, relative))).toBe(true);

    const first = scorecard();
    const second = scorecard();
    expect(first.status, first.stderr).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    const cell = presenceCell(first);
    expect(cell.verdict).toBe('PASS');
    expect(cell.sensor_readings).toEqual([reading['id']]);
    expect(existsSync(join(fixture, LEGACY_STORE))).toBe(false);
  }, 60_000);

  it('selects the later of two recorded readings of one kind on both runs', () => {
    resetStore();
    // Reading ids are content-derived (status and findings), so the earlier observation is
    // taken with the controller moved out of the fixture: it reads review, the later one pass.
    const controller = join(fixture, 'src/tickets.controller.ts');
    const aside = join(workspace, 'tickets.controller.ts');
    renameSync(controller, aside);
    let earlier: Record<string, unknown>;
    try {
      earlier = senseRunReading('inventory_api');
    } finally {
      renameSync(aside, controller);
    }
    recordReading(earlier);
    const earlierBytes = readFileSync(
      join(fixture, STORE, 'inventory_api', `${String(earlier['id'])}.json`),
      'utf8',
    );
    const later = senseRunReading('inventory_api');
    expect(later['supersedes']).toBe(earlier['id']);
    expect(earlier['status']).toBe('review');
    expect(later['status']).toBe('pass');
    expect(later['id']).not.toBe(earlier['id']);
    expect(String(later['timestamp']) > String(earlier['timestamp'])).toBe(true);
    recordReading(later);
    recordReading(earlier);
    expect(
      readFileSync(join(fixture, STORE, 'inventory_api', `${String(earlier['id'])}.json`), 'utf8'),
    ).toBe(earlierBytes);

    const first = scorecard();
    const second = scorecard();
    expect(second.stdout).toBe(first.stdout);
    expect(presenceCell(first).sensor_readings).toEqual([later['id']]);
    expect(presenceCell(second).sensor_readings).toEqual([later['id']]);
  }, 60_000);

  it('reads UNKNOWN with an empty readings store', () => {
    resetStore();
    const cell = presenceCell(scorecard());
    expect(cell.verdict).toBe('UNKNOWN');
    expect(cell.sensor_readings ?? []).toEqual([]);
  }, 30_000);

  it('reads a failure older than the stale window as stale and not PASS', () => {
    resetStore();
    const stale = readFileSync(join(FIXTURES, 'inventory-api-fail-stale.json'), 'utf8');
    expect(packedSchemaValidator()(JSON.parse(stale))).toBe(true);
    recordReading(JSON.parse(stale) as Record<string, unknown>);

    const cell = presenceCell(scorecard());
    expect(cell.verdict).toBe('REVIEW');
    expect(cell.notes).toContain('REVIEW-stale');
  }, 30_000);

  it('refuses an --at that is not the exact 40-character HEAD', () => {
    resetStore();
    const otherSha = head.startsWith('b') ? 'c'.repeat(40) : 'b'.repeat(40);
    for (const at of [head.slice(0, 12), otherSha]) {
      const result = scorecard(at);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
      if (at.length === 40) {
        expect(envelope(result).error?.message).toBe('AUDIT_SCORECARD_EXACT_HEAD_REQUIRED');
      }
    }
  }, 30_000);

  it('rejects a file of invalid JSON in the store with SCORECARD_READING_UNPARSEABLE', () => {
    resetStore();
    placeInStore('inventory_api', 'SR-00000000000000c3.json', '{not json\n');

    const result = scorecard();
    expect(`${result.stdout}${result.stderr}`).toMatch(
      /SCORECARD_READING_UNPARSEABLE:\S*SR-00000000000000c3\.json/u,
    );
    expect(presenceCellIfEmitted(result)?.verdict).not.toBe('PASS');
  }, 30_000);

  it('rejects a schema-invalid SensorReading with SCORECARD_READING_INVALID, never PASS', () => {
    resetStore();
    const invalid = readFileSync(join(FIXTURES, 'inventory-api-schema-invalid.json'), 'utf8');
    expect(packedSchemaValidator()(JSON.parse(invalid))).toBe(false);
    placeInStore('inventory_api', 'SR-00000000000000b2.json', invalid);

    const result = scorecard();
    expect(`${result.stdout}${result.stderr}`).toMatch(
      /SCORECARD_READING_INVALID:\S*SR-00000000000000b2\.json/u,
    );
    expect(presenceCellIfEmitted(result)?.verdict).not.toBe('PASS');
  }, 30_000);

  it('leaves no copy or symlink under the legacy readings store', () => {
    expect(existsSync(join(fixture, LEGACY_STORE))).toBe(false);
    // ADR-SCR-0008: sense record appends its chain entry to record/proofs/chain.json,
    // which is the only path it may create under record/.
    const created: string[] = [];
    const walk = (relative: string): void => {
      const stat = lstatSync(join(fixture, relative));
      if (stat.isDirectory()) {
        for (const entry of readdirSync(join(fixture, relative)).sort()) {
          walk(`${relative}/${entry}`);
        }
        return;
      }
      created.push(
        `${relative}:${stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : 'other'}`,
      );
    };
    if (existsSync(join(fixture, 'record'))) walk('record');
    expect(created).toEqual(['record/proofs/chain.json:file']);
  });
});
