import { ROSTER } from '@devai-nyx/schemas';
import { checkSchemaCanon } from '../../src/commands/check/schemas.js';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, aroundEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  checkAdopterSchemas,
  checkSchemasForRepository,
} from '../../src/commands/check/schemas.js';

const roots: string[] = [];
aroundEach((run) => withAuthorityHostTestScope(run));
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
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

describe('complete schema canon filesystem checks', () => {
  it('accepts the complete source catalogue without expanding the runtime roster', () => {
    const report = checkSchemaCanon(canonFixture());
    expect(ROSTER).toHaveLength(89);
    expect(report).toMatchObject({ ok: true, canonical_total: 96, findings: [] });
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
      expect(report.canonical_total).toBe(kind === 'unexpected' ? 97 : 95);
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
