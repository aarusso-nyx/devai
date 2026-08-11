import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { extractComponents } from '../../src/inventory/component-extractor.js';
import { validateContracts } from '../../src/inventory/contract-validator.js';
import { normalizeCoverage } from '../../src/inventory/coverage-normalizer.js';
import { extractDependencies } from '../../src/inventory/dependency-graph.js';
import { glossaryCoverage } from '../../src/inventory/glossary-coverage.js';
import { deriveInventoryId, sha256Hex } from '../../src/inventory/id.js';
import { extractModules } from '../../src/inventory/module-extractor.js';
import { regenerateInventory } from '../../src/inventory/regen.js';
import { checkRegen, loadRegenConfig } from '../../src/inventory/regen-checker.js';
import { extractRoutes } from '../../src/inventory/route-extractor.js';
import { discoverSchemas } from '../../src/inventory/schemas-discoverer.js';
import { discoverTests } from '../../src/inventory/test-discoverer.js';
import {
  className,
  decoratorName,
  decoratorStringArg,
  iterateClassDecorators,
  iterateMethodDecorators,
  methodName,
  parseSourceFile,
} from '../../src/inventory/ts-ast.js';
import { relativizeAll, walkFiles, WALKER_DEFAULT_IGNORE } from '../../src/inventory/walker.js';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-inventory-'));
  roots.push(root);
  return root;
}

function put(root: string, relativePath: string, contents: string): string {
  const path = join(root, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('inventory extraction expansion', () => {
  it('extracts framework modules, components, routes, guards, and AST names', () => {
    const root = fixture();
    const sourcePath = put(
      root,
      'src/application.ts',
      [
        '@Module() export class AppModule {}',
        '@NgModule({}) class WebModule {}',
        '@Component({}) class PageComponent {}',
        '@Directive class DemoDirective {}',
        '@Pipe() class DemoPipe {}',
        '@Injectable() class DemoService {}',
        '@Controller(`/users`) class UsersController {',
        "  @Get(':id') @UseGuards(AuthGuard) getOne() {}",
        '  @Post() create() {}',
        '  @Delete(dynamicPath) remove() {}',
        '  @Custom() ignored() {}',
        '}',
        '@Unknown() class Ignored {}',
        '@Controller() class RootController { @Head() ["status"]() {} @All() "quoted"() {} }',
        '@Controller("loose") class LooseController { @Options("/check") check() {} }',
        '@Component({}) class {}',
      ].join('\n'),
    );
    put(root, 'src/types.d.ts', '@Module() declare class Phantom {}');

    const modules = extractModules({ repoRoot: root });
    expect(modules.map(({ kind, name }) => [kind, name])).toEqual([
      ['nestjs_module', 'AppModule'],
      ['ngmodule', 'WebModule'],
    ]);

    const components = extractComponents({ repoRoot: root });
    expect(components.map(({ kind, name }) => [kind, name])).toEqual([
      ['angular_component', '<anonymous>'],
      ['angular_directive', 'DemoDirective'],
      ['angular_pipe', 'DemoPipe'],
      ['service', 'DemoService'],
      ['nestjs_controller', 'LooseController'],
      ['angular_component', 'PageComponent'],
      ['nestjs_controller', 'RootController'],
      ['nestjs_controller', 'UsersController'],
    ]);

    const routes = extractRoutes({ repoRoot: root });
    expect(routes.map(({ method, path, protected: guarded }) => [method, path, guarded])).toEqual([
      ['ALL', '/', undefined],
      ['DELETE', '/users', undefined],
      ['GET', '/users/:id', true],
      ['HEAD', '/', undefined],
      ['OPTIONS', '/loose/check', undefined],
      ['POST', '/users', undefined],
    ]);

    const parsed = parseSourceFile(sourcePath);
    const classDecorators = [...iterateClassDecorators(parsed)];
    const methodDecorators = [...iterateMethodDecorators(parsed)];
    const anonymousClass = classDecorators.at(-1);
    const head = methodDecorators.find(({ name }) => name === 'Head');
    const all = methodDecorators.find(({ name }) => name === 'All');
    const custom = methodDecorators.find(({ name }) => name === 'Custom');
    const deleted = methodDecorators.find(({ name }) => name === 'Delete');
    const firstClass = classDecorators[0];
    if (
      anonymousClass === undefined ||
      head === undefined ||
      all === undefined ||
      custom === undefined ||
      deleted === undefined ||
      firstClass === undefined
    ) {
      throw new Error('fixture decorators were not discovered');
    }
    expect(className(anonymousClass.class)).toBe('<anonymous>');
    expect(methodName(head.method)).toBe('<anonymous>');
    expect(methodName(all.method)).toBe('quoted');
    expect(decoratorName(custom.decorator)).toBe('Custom');
    expect(decoratorStringArg(deleted.decorator, 0)).toBeNull();
    expect(decoratorStringArg(firstClass.decorator, 99)).toBeNull();
  });

  it('builds deterministic local, absolute, external, and re-export dependency edges', () => {
    const root = fixture();
    put(
      root,
      'src/a.ts',
      [
        "import './b.js';",
        "import fs from 'node:fs';",
        "export * from '../shared.js';",
        "export * from '@scope/pkg';",
        'const untouched = true;',
      ].join('\n'),
    );
    put(root, 'src/b.ts', 'export const b = true;');
    put(root, 'shared.ts', 'export const shared = true;');
    put(root, 'ignored.d.ts', "import 'phantom';");

    const first = extractDependencies({ repoRoot: root });
    const second = extractDependencies({ repoRoot: root });
    expect(first.nodes).toEqual(['shared.ts', 'src/a.ts', 'src/b.ts']);
    expect(first.edges).toEqual([
      { from: 'src/a.ts', to: '@scope/pkg', external: true },
      { from: 'src/a.ts', to: 'node:fs', external: true },
      { from: 'src/a.ts', to: 'shared.ts', external: false },
      { from: 'src/a.ts', to: 'src/b.ts', external: false },
    ]);
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.hash).toBe(first.hash);
  });

  it('walks deterministically, filters extensions and ignored dirs, and skips symlinks', () => {
    const root = fixture();
    put(root, 'src/z.ts', 'z');
    put(root, 'src/a.md', 'a');
    put(root, 'dist/hidden.ts', 'hidden');
    put(root, 'custom/hidden.ts', 'hidden');
    symlinkSync(join(root, 'src/z.ts'), join(root, 'src/link.ts'));

    expect(WALKER_DEFAULT_IGNORE.has('node_modules')).toBe(true);
    expect(relativizeAll(walkFiles(root, { extensions: ['.ts'] }), root)).toEqual([
      'custom/hidden.ts',
      'src/z.ts',
    ]);
    expect(
      relativizeAll(
        walkFiles(root, { extensions: ['.ts'], ignoreDirs: new Set(['custom', 'src']) }),
        root,
      ),
    ).toEqual(['dist/hidden.ts']);
    expect(walkFiles(join(root, 'absent'))).toEqual([]);
  });

  it('discovers every test-suite suffix and deduplicates invariant markers', () => {
    const root = fixture();
    const cases = [
      ['a.test.ts', 'unit'],
      ['b.integration.test.ts', 'int'],
      ['c.api.spec.ts', 'api'],
      ['d.e2e.test.ts', 'e2e'],
      ['e.sec.spec.ts', 'sec'],
      ['f.perf.test.ts', 'perf'],
      ['g.journey.test.ts', 'journey'],
      ['h.db.spec.ts', 'db'],
      ['i.regression.test.ts', 'unit'],
    ] as const;
    for (const [name] of cases) {
      put(root, `tests/${name}`, '// INV-DEVAI-001 INV-DEVAI-001 INV-LAW2-999');
    }
    put(root, 'tests/not-a-test.ts', '// INV-DEVAI-002');

    const found = discoverTests({ repoRoot: root });
    expect(found.map(({ path, suite }) => [path.split('/').at(-1), suite])).toEqual(cases);
    expect(
      found.every(({ invariants }) => invariants.join(',') === 'INV-DEVAI-001,INV-LAW2-999'),
    ).toBe(true);
  });

  it('discovers file schemas without a database and sorts stable records', async () => {
    const root = fixture();
    put(root, 'schemas/zeta.schema.json', '{}');
    put(root, 'schemas/alpha.schema.json', '{}');
    put(root, 'api/openapi.yaml', 'openapi: 3.1.0');
    put(root, 'api/openapi.json', '{}');
    put(root, 'api/other.json', '{}');

    await expect(
      discoverSchemas({ repoRoot: root, databaseUrl: 'postgres://unused', noDb: true }),
    ).resolves.toEqual([
      { kind: 'json_schema', name: 'alpha', path: 'schemas/alpha.schema.json' },
      { kind: 'json_schema', name: 'zeta', path: 'schemas/zeta.schema.json' },
      { kind: 'openapi', name: 'openapi', path: 'api/openapi.json' },
      { kind: 'openapi', name: 'openapi', path: 'api/openapi.yaml' },
    ]);
  });

  it('validates good schemas and reports parse and compilation failures', () => {
    const root = fixture();
    put(root, 'schemas/01-good.schema.json', JSON.stringify({ type: 'object' }));
    put(root, 'schemas/02-bad-json.schema.json', '{');
    put(root, 'schemas/03-bad-schema.schema.json', JSON.stringify({ type: 42 }));

    const result = validateContracts({ repoRoot: root });
    expect(result.ok).toBe(false);
    expect(result.checks.map(({ ok }) => ok)).toEqual([true, false, false]);
    expect(result.checks[1]?.errors[0]).toContain('JSON parse:');
    expect(result.checks[2]?.errors[0]).toContain('schema compile:');
  });

  it('normalizes missing, directory, full, and statement-only coverage inputs', () => {
    const root = fixture();
    expect(normalizeCoverage({ coveragePath: join(root, 'missing.json') }).missing).toBe(true);
    expect(normalizeCoverage({ coveragePath: root }).missing).toBe(true);

    const fullPath = put(
      root,
      'coverage/full.json',
      JSON.stringify({
        'a.ts': {
          s: { 0: 1, 1: 0 },
          b: { 0: [1, 0], 1: [2] },
          f: { 0: 1, 1: 0 },
          l: { 1: 1, 2: 0 },
        },
        'empty.ts': {},
      }),
    );
    expect(normalizeCoverage({ coveragePath: fullPath }).summary).toEqual({
      statements_total: 2,
      statements_covered: 1,
      branches_total: 3,
      branches_covered: 2,
      functions_total: 2,
      functions_covered: 1,
      lines_total: 2,
      lines_covered: 1,
      files_count: 2,
    });

    const statementsPath = put(
      root,
      'coverage/statements.json',
      JSON.stringify({ 'a.ts': { s: { 0: 1, 1: 0 } } }),
    );
    expect(normalizeCoverage({ coveragePath: statementsPath }).summary?.lines_total).toBe(2);
  });

  it('reports glossary aliases across unioned source directories and skips malformed entries', () => {
    const root = fixture();
    put(
      root,
      'law/glossary/GE-002.json',
      JSON.stringify({ id: 'GE-002', term: 'Evidence', aliases: ['proof'] }),
    );
    put(root, 'law/glossary/GE-001.json', JSON.stringify({ id: 'GE-001', term: 'Authority' }));
    put(root, 'law/glossary/GE-003.json', '{');
    put(root, 'src/a.ts', 'const proof = true;');
    put(root, 'docs/a.md', 'AUTHORITY and evidence');

    const result = glossaryCoverage({
      repoRoot: root,
      searchDirs: [join(root, 'src'), join(root, 'docs')],
    });
    expect(result.entries_count).toBe(2);
    expect(result.terms).toEqual([
      { id: 'GE-001', term: 'Authority', used_count: 1, used_in: ['docs/a.md'] },
      {
        id: 'GE-002',
        term: 'Evidence',
        used_count: 2,
        used_in: ['docs/a.md', 'src/a.ts'],
      },
    ]);
  });

  it('derives stable inventory and byte hashes', () => {
    expect(deriveInventoryId('MOD', 'same')).toMatch(/^MOD-[a-f0-9]{16}$/);
    expect(deriveInventoryId('MOD', 'same')).toBe(deriveInventoryId('MOD', 'same'));
    expect(sha256Hex('same')).toHaveLength(64);
    expect(sha256Hex(new Uint8Array([1, 2, 3]))).not.toBe(sha256Hex('same'));
  });

  it('regenerates a complete deterministic inventory and sorted checksums', async () => {
    const root = fixture();
    put(
      root,
      'src/app.ts',
      [
        '@Module() class AppModule {}',
        '@Controller("items") class ItemsController { @Get(":id") get() {} }',
        '@Injectable() class ItemService {}',
        "import 'node:fs';",
      ].join('\n'),
    );
    put(root, 'schemas/item.schema.json', JSON.stringify({ type: 'object' }));
    put(root, 'tests/item.test.ts', '// INV-DEVAI-001');
    put(root, 'b.txt', 'b');
    put(root, 'a.txt', 'a');

    const inventory = await regenerateInventory({
      repoRoot: root,
      timestamp: '2026-07-24T12:00:00.000Z',
      integrationHead: 'a'.repeat(40),
      checksumPaths: [join(root, 'b.txt'), join(root, 'missing.txt'), join(root, 'a.txt')],
    });
    expect(inventory.schemaVersion).toBe('1.0.0');
    expect(inventory.modules).toHaveLength(1);
    expect(inventory.routes[0]).toMatchObject({ method: 'GET', path: '/items/:id' });
    expect(inventory.components.map(({ name }) => name)).toEqual([
      'ItemService',
      'ItemsController',
    ]);
    expect(inventory.schemas).toEqual([
      { kind: 'json_schema', name: 'item', path: 'schemas/item.schema.json' },
    ]);
    expect(inventory.test_inventory[0]?.invariants).toEqual(['INV-DEVAI-001']);
    expect(inventory.dependency_graph[0]?.id).toMatch(/^DEP-[a-f0-9]{8}$/);
    expect(Object.keys(inventory.checksums)).toEqual(['a.txt', 'b.txt']);
  });

  it('loads regen configuration and reports empty commands and missing outputs', async () => {
    const root = fixture();
    const configPath = put(
      root,
      'regen.json',
      JSON.stringify({
        schemaVersion: '1.0.0',
        regen: [
          { name: 'empty', command: [], outputs: ['present.txt'] },
          { name: 'missing', command: [], outputs: ['missing.txt'] },
        ],
      }),
    );
    put(root, 'present.txt', 'stable');

    await withAuthorityHostTestScope(() => {
      const config = loadRegenConfig(configPath);
      const results = checkRegen({ repoRoot: root, config });
      expect(results[0]).toMatchObject({
        name: 'empty',
        ok: false,
        drifted_files: [],
        missing_files: [],
        command_error: 'empty command array',
      });
      expect(results[1]?.missing_files).toEqual(['missing.txt']);
    });
  });
});
