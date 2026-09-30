// Invariants: ADR-SCR-0011 IA-001, IA-002, IA-003
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSchema } from '@devai-nyx/schemas';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSensorReading } from '../../src/sensor-reading.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const REAL_BIN = join(REPOSITORY_ROOT, 'packages/cli/dist/runtime/index/bin.js');

const FOUR_KINDS = [
  'decision_record_integrity',
  'decision_citation_resolution',
  'archive_immutability',
  'round_record_integrity',
] as const;
const LEGACY_SCHEMA_ONLY = [
  'api_test',
  'contract_validation',
  'db_test',
  'journey_test',
  'mutation_test',
] as const;

interface RegistryEntry {
  readonly kind: string;
  readonly effect: string;
  readonly diagnostic?: boolean;
  readonly cells?: readonly unknown[];
  readonly schema_admission?: 'admitted' | 'unsupported';
}
interface Presets {
  readonly presets: ReadonlyArray<{ readonly name: string; readonly members: readonly string[] }>;
}
interface ReadingSchema {
  readonly required: readonly string[];
  readonly properties: {
    readonly sensor: { readonly properties: { readonly kind: { readonly enum: string[] } } };
  };
}

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(join(REPOSITORY_ROOT, relative), 'utf8')) as T;
}

// The packaged boundary an adopter validates against is the schema FILE, never the in-memory
// roster, so the invariant reads the bytes of law/schemas/sensor-reading.schema.json.
const SCHEMA_BYTES = readFileSync(join(REPOSITORY_ROOT, 'law/schemas/sensor-reading.schema.json'));
const FILE_SCHEMA = JSON.parse(SCHEMA_BYTES.toString('utf8')) as ReadingSchema;
const FILE_ENUM: readonly string[] = FILE_SCHEMA.properties.sensor.properties.kind.enum;
const REGISTRY = readJson<{ entries: RegistryEntry[] }>('law/policy/sensor-registry.json').entries;
const PRESETS = readJson<Presets>('law/policy/sense-presets.json').presets;

function presetMembers(name: string): readonly string[] {
  const preset = PRESETS.find((candidate) => candidate.name === name);
  if (preset === undefined) throw new Error(`preset ${name} missing`);
  return preset.members;
}

/** Registry-minus-schema over the read kinds a preset selects (ADR-SCR-0011). */
function admissionGap(
  registry: readonly RegistryEntry[],
  members: readonly string[],
  admitted: readonly string[],
): string[] {
  const readKinds = new Set(
    registry.filter((entry) => entry.effect === 'read').map((entry) => entry.kind),
  );
  const enumSet = new Set(admitted);
  return members.filter((kind) => readKinds.has(kind) && !enumSet.has(kind));
}

function fileSchemaValidator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv.compile(JSON.parse(SCHEMA_BYTES.toString('utf8')) as object);
}

describe('ADR-SCR-0011 IA-001: every sweep read kind is admitted by the packaged schema', () => {
  it('selects exactly the registry read kinds into sweep, in registry order', () => {
    expect(presetMembers('sweep')).toEqual(
      REGISTRY.filter((entry) => entry.effect === 'read').map((entry) => entry.kind),
    );
  });

  it('computes an empty registry-minus-schema set over every sweep read kind', () => {
    expect(admissionGap(REGISTRY, presetMembers('sweep'), FILE_ENUM)).toEqual([]);
  });

  it('computes an empty registry-minus-schema set for every preset', () => {
    for (const preset of PRESETS) {
      expect(admissionGap(REGISTRY, preset.members, FILE_ENUM), preset.name).toEqual([]);
    }
  });

  it('admits every registry kind that is not declared unsupported, and declares none today', () => {
    const enumSet = new Set(FILE_ENUM);
    expect(REGISTRY.filter((entry) => entry.schema_admission === 'unsupported')).toEqual([]);
    expect(
      REGISTRY.filter((entry) => entry.schema_admission !== 'unsupported')
        .map((entry) => entry.kind)
        .filter((kind) => !enumSet.has(kind)),
    ).toEqual([]);
  });

  it('keeps exactly the five schema-only legacy values beyond the registry', () => {
    const registryKinds = new Set(REGISTRY.map((entry) => entry.kind));
    expect(FILE_ENUM.filter((kind) => !registryKinds.has(kind)).sort()).toEqual([
      ...LEGACY_SCHEMA_ONLY,
    ]);
    expect(new Set(FILE_ENUM).size).toBe(FILE_ENUM.length);
    expect(FILE_ENUM).toHaveLength(REGISTRY.length + LEGACY_SCHEMA_ONLY.length);
  });

  it.each(FOUR_KINDS)('turns red when %s is removed from the schema enum', (kind) => {
    expect(FILE_ENUM).toContain(kind);
    expect(presetMembers('sweep')).toContain(kind);
    const withoutKind = FILE_ENUM.filter((value) => value !== kind);
    expect(admissionGap(REGISTRY, presetMembers('sweep'), withoutKind)).toEqual([kind]);
  });

  it('maps none of the four admitted diagnostic kinds to a scorecard cell', () => {
    for (const kind of FOUR_KINDS) {
      const entry = REGISTRY.find((candidate) => candidate.kind === kind);
      expect(entry, kind).toBeDefined();
      expect(entry?.effect).toBe('read');
      expect(entry?.diagnostic).toBe(true);
      expect(entry?.cells ?? []).toEqual([]);
    }
  });

  it('admits in source exactly the kind set the packaged schema file admits', () => {
    // The schemas loader must not narrow the file enum at load: source and package agree.
    const loaded = loadSchema('sensor-reading.schema.json') as unknown as ReadingSchema;
    expect([...loaded.properties.sensor.properties.kind.enum].sort()).toEqual(
      [...FILE_ENUM].sort(),
    );
  });
});

interface SenseRunValue {
  readonly members: ReadonlyArray<{ readonly kind: string; readonly effect: string }>;
  readonly execution_status: string;
  readonly readiness_status: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly results: ReadonlyArray<{ readonly stdout: string; readonly status: number | null }>;
}
interface SenseRunEnvelope {
  readonly ok: boolean;
  readonly action_id: string;
  readonly error?: {
    readonly code: string;
    readonly context?: { readonly payload?: SenseRunValue };
  };
  readonly result?: { readonly value: SenseRunValue };
}

describe('ADR-SCR-0011 IA-002 and IA-003: the four kinds through sense run', () => {
  let fixture = '';
  const validate = fileSchemaValidator();

  function cli(args: readonly string[]) {
    return spawnSync(process.execPath, [REAL_BIN, ...args], {
      cwd: fixture,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
  }

  // A passing run writes its envelope to stdout; a refused or failing run writes it to stderr.
  function senseRun(kind: string): {
    readonly exit: number | null;
    readonly envelope: SenseRunEnvelope;
  } {
    const result = cli(['sense', 'run', kind, '--repo-root', fixture, '--format', 'json']);
    const rendered = result.status === 0 ? result.stdout : result.stderr;
    return { exit: result.status, envelope: JSON.parse(rendered) as SenseRunEnvelope };
  }

  function readingOf(value: SenseRunValue | undefined): Record<string, unknown> {
    const stdout = value?.results[0]?.stdout;
    expect(stdout, JSON.stringify(value)).toBeTypeOf('string');
    return JSON.parse(stdout ?? '') as Record<string, unknown>;
  }

  beforeAll(() => {
    fixture = mkdtempSync(join(tmpdir(), 'devai-schema-admission-'));
    const git = spawnSync('git', ['init', '-q'], { cwd: fixture, encoding: 'utf8' });
    expect(git.status, git.stderr).toBe(0);
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
        fixture,
        '--as-role',
        'architect',
        '--write',
        '--format',
        'json',
      ]);
      expect(bound.status, bound.stderr).toBe(0);
    }
  }, 60_000);

  afterAll(() => {
    if (fixture !== '') rmSync(fixture, { recursive: true, force: true });
  });

  it.each(FOUR_KINDS)(
    'emits %s as a read reading that validates at the schema file boundary',
    (kind) => {
      const { exit, envelope } = senseRun(kind);
      expect(exit, JSON.stringify(envelope.error)).toBe(0);
      expect(envelope.ok).toBe(true);
      expect(envelope.action_id).toBe('sense run');
      expect(envelope.result?.value.members).toEqual([
        expect.objectContaining({ kind, effect: 'read' }),
      ]);
      const reading = readingOf(envelope.result?.value);
      expect(validate(reading), JSON.stringify(validate.errors)).toBe(true);
      for (const field of FILE_SCHEMA.required) expect(reading, field).toHaveProperty(field);
      expect(reading['command_hash']).toMatch(/^[a-f0-9]{64}$/u);
      expect(reading['status']).toBe('pass');
      expect(reading['sensor']).toMatchObject({ kind });
      expect(envelope.result?.value.readiness_status).toBe('pass');

      const unknown = { ...reading, sensor: { name: kind, kind: 'not_a_registered_kind' } };
      expect(validate(unknown)).toBe(false);
    },
    30_000,
  );

  it('refuses an unknown kind before any reading is emitted', () => {
    const { exit, envelope } = senseRun('not_a_registered_kind');
    expect(exit).not.toBe(0);
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('SENSOR_KIND_UNKNOWN');
    expect(envelope.result).toBeUndefined();
  }, 30_000);

  it('records a failing round_record_integrity as FAIL and never promotes it to PASS', () => {
    const round = join(fixture, 'work/rounds/R-0001');
    mkdirSync(round, { recursive: true });
    try {
      const { exit, envelope } = senseRun('round_record_integrity');
      expect(exit).not.toBe(0);
      expect(envelope.ok).toBe(false);
      expect(envelope.result).toBeUndefined();
      const value = envelope.error?.context?.payload;
      const reading = readingOf(value);
      expect(validate(reading), JSON.stringify(validate.errors)).toBe(true);
      expect(reading['status']).toBe('fail');
      expect(JSON.stringify(reading['findings'])).toContain('ROUND_RECORD_MISSING');
      expect(value?.readiness_status).toBe('fail');
      expect(value?.counts['pass']).toBe(0);
    } finally {
      rmSync(join(fixture, 'work'), { recursive: true, force: true });
    }
  }, 30_000);

  it.each(FOUR_KINDS)('keeps a fail or skipped %s reading fail or skipped', (kind) => {
    for (const status of ['fail', 'skipped'] as const) {
      const reading = buildSensorReading({
        sensorName: kind,
        sensorKind: kind,
        command: ['devai', 'sense', 'run', kind],
        status,
        deterministic: true,
      });
      expect(reading.status).toBe(status);
      expect(validate(reading), JSON.stringify(validate.errors)).toBe(true);
    }
  });
});
