import { ROSTER } from '@devai-nyx/schemas';
import { EXIT_FAIL, EXIT_PASS } from '@devai-nyx/utils';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { CAC } from 'cac';
import { afterEach, aroundEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  checkAdopterSchemas,
  checkSchemaCanon,
  checkSchemasCmd,
  checkSchemasForRepository,
  registerCheckSchemas,
} from '../../src/commands/check/schemas.js';

const roots: string[] = [];
const originalStdout = process.stdout.write;
const originalExitCode = process.exitCode;
aroundEach((run) => withAuthorityHostTestScope(run));
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
  process.stdout.write = originalStdout;
  process.exitCode = originalExitCode;
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devai-schema-adopter-'));
  roots.push(root);
  put(root, '.devai/config/project.json', { schemaVersion: '1.0.0', project_type: 'runtime-host' });
  return root;
}
function put(root: string, relative: string, value: unknown) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

describe('adopter schema report boundaries', () => {
  it('checks present valid bindings without requiring optional configuration', () => {
    const root = fixture();
    put(root, '.devai/config/glob-guards.json', { schemaVersion: '1.0.0', guards: [] });
    expect(checkAdopterSchemas(root)).toEqual({
      ok: true,
      mode: 'adopter-binding',
      checked: ['.devai/config/project.json', '.devai/config/glob-guards.json'],
      findings: [],
    });
  });
  it('reports the missing mandatory project even when optional bindings validate', () => {
    const root = fixture();
    rmSync(join(root, '.devai/config/project.json'));
    put(root, '.devai/config/glob-guards.json', { schemaVersion: '1.0.0', guards: [] });
    expect(checkAdopterSchemas(root)).toEqual({
      ok: false,
      mode: 'adopter-binding',
      checked: ['.devai/config/glob-guards.json'],
      findings: [
        {
          rule: 'adopter-binding-schema',
          path: '.devai/config/project.json',
          message: 'Bound adopter project configuration is absent.',
        },
      ],
    });
  });
  it('aggregates malformed JSON and schema violations without modifying either file', () => {
    const root = fixture();
    const project = '.devai/config/project.json';
    const guards = '.devai/config/glob-guards.json';
    writeFileSync(join(root, project), '{broken');
    put(root, guards, { schemaVersion: '1.0.0', guards: [{ pattern: 42 }] });
    const before = [project, guards].map((p) => readFileSync(join(root, p)));
    const report = checkAdopterSchemas(root);
    expect(report.ok).toBe(false);
    expect(report.checked).toEqual([project, guards]);
    expect(report.findings.map(({ rule, path }) => ({ rule, path }))).toEqual([
      { rule: 'adopter-binding-schema', path: project },
      { rule: 'adopter-binding-schema', path: guards },
    ]);
    expect(report.findings[0]?.message.length).toBeGreaterThan(0);
    expect(report.findings[1]?.message).toContain('/guards/0');
    expect([project, guards].map((p) => readFileSync(join(root, p)))).toEqual(before);
  });
  it.each(['name', 'private', 'canon', 'roster'] as const)(
    'uses adopter validation when source identity lacks %s',
    (missing) => {
      const root = fixture();
      put(root, 'package.json', {
        name: missing === 'name' ? 'adopter' : 'devai',
        private: missing !== 'private',
      });
      if (missing !== 'canon') mkdirSync(join(root, 'law/schemas'), { recursive: true });
      if (missing !== 'roster') put(root, 'packages/schemas/src/roster.ts', 'fixture marker');
      expect(checkSchemasForRepository(root)).toEqual({
        ok: true,
        mode: 'adopter-binding',
        checked: ['.devai/config/project.json'],
        findings: [],
      });
    },
  );
});

function canonFixture() {
  const root = fixture();
  const source = resolve(import.meta.dirname, '../../../..');
  for (const name of readdirSync(join(source, 'law/schemas')).filter((name) =>
    name.endsWith('.schema.json'),
  )) {
    const bytes = readFileSync(join(source, 'law/schemas', name));
    for (const base of ['law/schemas', 'packages/schemas/dist/schemas']) {
      mkdirSync(join(root, base), { recursive: true });
      writeFileSync(join(root, base, name), bytes);
    }
  }
  for (const path of [
    'packages/cli/src/generated/action-registry.ts',
    'packages/effects-check/src/generated/action-catalog.ts',
    'packages/sensors/src/generated/action-kinds.ts',
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), '// @generated from law/policy/action-registry.json\n');
  }
  return root;
}

interface CommandOptions {
  readonly repoRoot?: string;
  readonly human?: boolean;
}

interface RegisteredCommand {
  readonly command: readonly [string, string];
  readonly options: readonly (readonly [string, string])[];
  readonly invoke: (options: CommandOptions) => void;
}

function registeredCommand(useWrapper = false): RegisteredCommand {
  let action: ((options: CommandOptions) => void) | undefined;
  let commandCall: readonly [string, string] | undefined;
  const optionCalls: Array<readonly [string, string]> = [];
  const chain = {
    option(flag: string, description: string) {
      optionCalls.push([flag, description]);
      return chain;
    },
    action(callback: (options: CommandOptions) => void) {
      action = callback;
      return chain;
    },
  };
  const cli = {
    command: (name: string, description: string) => {
      commandCall = [name, description];
      return chain;
    },
  } as unknown as CAC;
  if (useWrapper) registerCheckSchemas(cli);
  else checkSchemasCmd.register(cli);
  if (commandCall === undefined || action === undefined) {
    throw new Error('check-schemas command was not completely registered');
  }
  return { command: commandCall, options: optionCalls, invoke: action };
}

function invokeCommand(options: CommandOptions): {
  readonly stdout: string;
  readonly exitCode: number | undefined;
} {
  let stdout = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.exitCode = undefined;
  registeredCommand().invoke(options);
  return { stdout, exitCode: process.exitCode };
}

describe('complete schema canon filesystem checks', () => {
  it('accepts the complete source catalogue without expanding the runtime roster', () => {
    const report = checkSchemaCanon(canonFixture());
    expect(ROSTER).toHaveLength(89);
    expect(report).toMatchObject({ ok: true, canonical_total: 99, findings: [] });
  });
  it.each(['missing-source-only', 'missing-runtime', 'unexpected'] as const)(
    'reports %s source inventory changes without throwing',
    (kind) => {
      const root = canonFixture();
      if (kind === 'unexpected') put(root, 'law/schemas/unexpected.schema.json', {});
      else
        rmSync(
          join(
            root,
            'law/schemas',
            kind === 'missing-source-only'
              ? 'claim-runtime-inputs.schema.json'
              : 'release-intent.schema.json',
          ),
        );
      const report = checkSchemaCanon(root);
      expect(report.ok).toBe(false);
      expect(report.canonical_total).toBe(kind === 'unexpected' ? 100 : 98);
      expect(report.findings).toContainEqual({
        rule: 'recursive-closed-complete-objects',
        path: 'law/schemas',
        message: 'Canonical directory and explicit source schema catalogue differ.',
      });
      if (kind === 'missing-runtime')
        expect(report.findings).toContainEqual({
          rule: 'dereferenced-publish-byte-identity',
          path: 'release-intent.schema.json',
          message: 'Bundled publish bytes differ from canonical law bytes.',
        });
    },
  );

  it('aggregates absent and unmarked generated views while retaining valid views', () => {
    const root = canonFixture();
    const initial = checkSchemaCanon(root);
    expect(
      initial.findings.filter(
        ({ rule }) =>
          rule === 'generated-marker-integrity' || rule === 'dereferenced-publish-byte-identity',
      ),
    ).toEqual([]);
    const missing = 'packages/cli/src/generated/action-registry.ts';
    const unmarked = 'packages/effects-check/src/generated/action-catalog.ts';
    rmSync(join(root, missing));
    writeFileSync(join(root, unmarked), '// unrelated generated file\n');
    const report = checkSchemaCanon(root);
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([
      ...initial.findings,
      ...[missing, unmarked].map((path) => ({
        rule: 'generated-marker-integrity',
        path,
        message: 'Generated action view is absent or lacks its canonical marker.',
      })),
    ]);
    expect(readFileSync(join(root, unmarked), 'utf8')).toBe('// unrelated generated file\n');
  });
  it('reports missing and changed packaged schemas with exact canonical names', () => {
    const root = canonFixture();
    const initial = checkSchemaCanon(root);
    expect(
      initial.findings.filter(
        ({ rule }) =>
          rule === 'generated-marker-integrity' || rule === 'dereferenced-publish-byte-identity',
      ),
    ).toEqual([]);
    const missing = ROSTER[0];
    const changed = ROSTER[1];
    if (missing === undefined || changed === undefined)
      throw new Error('two canonical schema fixtures required');
    rmSync(join(root, 'packages/schemas/dist/schemas', missing));
    const changedPath = join(root, 'packages/schemas/dist/schemas', changed);
    writeFileSync(changedPath, '{}\n');
    const report = checkSchemaCanon(root);
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([
      ...initial.findings,
      ...[missing, changed].map((path) => ({
        rule: 'dereferenced-publish-byte-identity',
        path,
        message: 'Bundled publish bytes differ from canonical law bytes.',
      })),
    ]);
    expect(readFileSync(changedPath, 'utf8')).toBe('{}\n');
  });
});

describe('check schemas command boundary', () => {
  it('registers its stable name and options through the exported wrapper', () => {
    const command = registeredCommand(true);
    expect(command.command).toEqual([
      'check-schemas',
      'Validate the complete recursive schema canon and every governed schema rule.',
    ]);
    expect(command.options).toEqual([
      ['--repo-root <path>', 'Repository root (default: .)'],
      ['--format <format>', 'Output format: json or human'],
      ['--human', 'Human-readable output'],
    ]);
  });

  it('emits the complete passing JSON report and pass exit', () => {
    const result = invokeCommand({ repoRoot: canonFixture() });
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      canonical_total: 99,
      rules: [
        'recursive-closed-complete-objects',
        'predicate-fragments-valid',
        'shared-vocabulary',
        'generated-marker-integrity',
        'dereferenced-publish-byte-identity',
      ],
      findings: [],
    });
    expect(result.stdout.endsWith('\n')).toBe(true);
    expect(result.exitCode).toBe(EXIT_PASS);
  });

  it('renders the exact passing human summary', () => {
    const result = invokeCommand({ repoRoot: canonFixture(), human: true });
    expect(result.stdout).toBe('policy check schemas: OK (99 canonical schemas, 0 findings)\n');
    expect(result.exitCode).toBe(EXIT_PASS);
  });

  it('renders every failure and sets the fail exit', () => {
    const root = canonFixture();
    const missing = ROSTER[0];
    if (missing === undefined) throw new Error('canonical schema fixture required');
    rmSync(join(root, 'packages/schemas/dist/schemas', missing));
    const result = invokeCommand({ repoRoot: root, human: true });
    expect(result.stdout).toBe(
      [
        'policy check schemas: FAIL (99 canonical schemas, 1 findings)',
        `  [dereferenced-publish-byte-identity] ${missing}: Bundled publish bytes differ from canonical law bytes.`,
        '',
      ].join('\n'),
    );
    expect(result.exitCode).toBe(EXIT_FAIL);
  });
});
