// ADR-SCR-0005: DEVAI's own .devai/config/sensor-inputs.json is a declaration under
// law/schemas/sensor-inputs.schema.json. This contract pins that the committed file and
// the empty adopter default validate, that every kind they (and the schema) name is a
// registered sensor kind in law/policy/sensor-registry.json, and that the schema itself
// refuses the shapes sense run must refuse: an undeclared key, a kind the registry does
// not hold, a kind that takes no input, and a path that leaves the repository root.
//
// Interface assumptions: none beyond the committed files. The registry is read from
// law/policy/sensor-registry.json, the Architect source the runtime registry is
// generated from.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const SCHEMA_PATH = resolve(ROOT, 'law/schemas/sensor-inputs.schema.json');
const DECLARATION_PATH = resolve(ROOT, '.devai/config/sensor-inputs.json');
const ADOPTER_DEFAULT_PATH = resolve(ROOT, 'law/policy/adopter-defaults/sensor-inputs.json');
const REGISTRY_PATH = resolve(ROOT, 'law/policy/sensor-registry.json');

interface Declaration {
  readonly schemaVersion: string;
  readonly inputs: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const schema = readJson<{
  readonly properties: {
    readonly inputs: { readonly properties: Readonly<Record<string, unknown>> };
  };
  readonly examples?: readonly unknown[];
}>(SCHEMA_PATH);
const declaration = readJson<Declaration>(DECLARATION_PATH);
const registry = readJson<{ readonly entries: readonly { readonly kind: string }[] }>(
  REGISTRY_PATH,
);
const registeredKinds = new Set(registry.entries.map((entry) => entry.kind));

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validate = ajv.compile(schema);

function valid(instance: unknown): boolean {
  return validate(instance);
}

describe('DEVAI sensor inputs declaration', () => {
  it('validates against law/schemas/sensor-inputs.schema.json', () => {
    const ok = validate(declaration);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('names only registered sensor kinds', () => {
    const kinds = Object.keys(declaration.inputs);
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      expect(registeredKinds.has(kind), `${kind} is not in sensor-registry.json`).toBe(true);
    }
  });

  it('declares the framework layout the ADR records', () => {
    expect(declaration.inputs['spec_depth']).toEqual({
      adrDir: 'law/adr',
      invariantsDir: 'law/invariants',
    });
    for (const kind of [
      'test_security_coverage',
      'test_performance_coverage',
      'test_robustness_coverage',
      'test_idiomaticity',
    ]) {
      expect(declaration.inputs[kind]).toEqual({ testGlobs: ['packages/*/tests', 'tests'] });
    }
    expect(declaration.inputs['action_effect_inference']).toEqual({
      tsconfigPath: 'tests/config/tsconfig.effects.json',
    });
    expect(declaration.inputs['type_check']).toEqual({ argv: ['pnpm', 'run', 'typecheck'] });
  });

  it('declares directories and projects that exist inside the repository', () => {
    const spec = declaration.inputs['spec_depth'] ?? {};
    for (const dir of [spec['adrDir'], spec['invariantsDir']]) {
      expect(typeof dir).toBe('string');
      expect(statSync(resolve(ROOT, dir as string)).isDirectory()).toBe(true);
    }
    const tsconfig = declaration.inputs['action_effect_inference']?.['tsconfigPath'];
    expect(existsSync(resolve(ROOT, tsconfig as string))).toBe(true);

    // Every declared test root expands to at least one directory; a wildcard segment
    // expands against the directory before it.
    const globs = declaration.inputs['test_security_coverage']?.['testGlobs'] as string[];
    for (const glob of globs) {
      const [before, after] = glob.split('/*/');
      const expanded =
        after === undefined
          ? [resolve(ROOT, glob)]
          : readdirSync(resolve(ROOT, before as string)).map((entry) =>
              resolve(ROOT, before as string, entry, after),
            );
      expect(
        expanded.some((dir) => existsSync(dir) && statSync(dir).isDirectory()),
        `${glob} expands to no directory`,
      ).toBe(true);
    }
  });

  it('declares a type check argv that names an existing root script', () => {
    const argv = declaration.inputs['type_check']?.['argv'] as string[];
    const scripts = readJson<{ readonly scripts: Readonly<Record<string, string>> }>(
      resolve(ROOT, 'package.json'),
    ).scripts;
    expect(argv.slice(0, 2)).toEqual(['pnpm', 'run']);
    expect(Object.keys(scripts)).toContain(argv[2]);
  });
});

describe('sensor inputs schema', () => {
  it('keys only registered sensor kinds', () => {
    for (const kind of Object.keys(schema.properties.inputs.properties)) {
      expect(registeredKinds.has(kind), `${kind} is not in sensor-registry.json`).toBe(true);
    }
  });

  it('accepts the empty adopter default and its own examples', () => {
    expect(valid(readJson(ADOPTER_DEFAULT_PATH))).toBe(true);
    expect(readJson<Declaration>(ADOPTER_DEFAULT_PATH).inputs).toEqual({});
    for (const example of schema.examples ?? []) expect(valid(example)).toBe(true);
  });

  const refused: readonly (readonly [string, unknown])[] = [
    ['an undeclared key', { schemaVersion: '1.0.0', inputs: { spec_depth: { adrRoot: 'x' } } }],
    [
      'a kind that is not registered',
      { schemaVersion: '1.0.0', inputs: { not_a_sensor: { testGlobs: ['tests'] } } },
    ],
    [
      'a registered kind that takes no input',
      { schemaVersion: '1.0.0', inputs: { lint: { argv: ['eslint', '.'] } } },
    ],
    ['a kind with no key', { schemaVersion: '1.0.0', inputs: { spec_depth: {} } }],
    ['a parent segment', { schemaVersion: '1.0.0', inputs: { spec_depth: { adrDir: '../adr' } } }],
    [
      'an embedded parent segment',
      { schemaVersion: '1.0.0', inputs: { spec_depth: { adrDir: 'law/../../adr' } } },
    ],
    [
      'an absolute path',
      { schemaVersion: '1.0.0', inputs: { test_coverage_depth: { coveragePath: '/etc/passwd' } } },
    ],
    [
      'a test root leaving the repository',
      { schemaVersion: '1.0.0', inputs: { test_idiomaticity: { testGlobs: ['../*/tests'] } } },
    ],
    [
      'a wildcard in a plain path',
      { schemaVersion: '1.0.0', inputs: { action_effect_inference: { tsconfigPath: '*.json' } } },
    ],
    ['an empty argv', { schemaVersion: '1.0.0', inputs: { type_check: { argv: [] } } }],
    [
      'a shell-joined script name',
      { schemaVersion: '1.0.0', inputs: { perf_test: { scriptName: 'bench && rm -rf .' } } },
    ],
    ['an unknown schema version', { schemaVersion: '2.0.0', inputs: {} }],
    ['an extra top-level key', { schemaVersion: '1.0.0', inputs: {}, overrides: {} }],
  ];

  for (const [label, instance] of refused) {
    it(`refuses ${label}`, () => {
      expect(valid(instance)).toBe(false);
    });
  }
});
