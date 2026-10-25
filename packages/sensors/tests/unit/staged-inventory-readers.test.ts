import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseInventoryApi } from '../../src/inventory-api.js';
import { senseInventoryRoutes } from '../../src/inventory-routes.js';
import { senseInventoryDataModel } from '../../src/inventory-data-model.js';
import { senseInventoryRbac } from '../../src/inventory-rbac.js';
import { senseInventoryDataHandling } from '../../src/inventory-data-handling.js';
import { senseInventoryDepGraph } from '../../src/inventory-dep-graph.js';
import { senseInventoryCoverage } from '../../src/inventory-coverage.js';
import { resolveBodyInput } from '../../src/inventory-body-inputs.js';
import { resolveRoutesPath } from '../../src/inventory-coverage-inputs.js';
import { walkFiles } from '../../src/inventory-walker.js';
import { readRegisteredActionIds, measureActionLinkage } from '../../src/declared-surfaces.js';
import { resolveDeclaredSensorInputs } from '../../../cli/src/commands/sense/shared.js';
import {
  resolveInventoryDataModelInputs,
  resolveInventoryRouteInputs,
} from '../../../cli/src/commands/sense/inventory-inputs.js';

// Independent structural witness for the frozen Architect interface. Runtime
// imports remain actual existing producers, so missing exports cannot mask RED.
interface Reader {
  readFile(path: string): string;
  listDirectory(path: string): readonly { name: string; kind: 'file' | 'directory' }[];
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
}
const NOW = '2026-10-24T20:00:00.000Z';
const KINDS = ['api', 'routes', 'model', 'rbac', 'handling', 'dependencies', 'coverage'] as const;
type Kind = (typeof KINDS)[number];
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-staged-readers-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function put(path: string, value: unknown) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
  return target;
}
function snapshot(): Map<string, string> {
  const files = new Map<string, string>();
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.set(path, readFileSync(path, 'utf8'));
    }
  };
  visit(root);
  return files;
}
function reader(input: ReadonlyMap<string, string>, fault?: 'read' | 'list') {
  const files = new Map(input);
  const calls: string[] = [];
  const directories = new Set([root]);
  for (const path of files.keys()) {
    let directory = dirname(path);
    while (directory !== dirname(root)) {
      directories.add(directory);
      if (directory === root) break;
      directory = dirname(directory);
    }
  }
  const sourceReader: Reader = Object.freeze({
    readFile(path: string) {
      calls.push(`read:${relative(root, path)}`);
      if (fault === 'read') throw new Error('STAGED_READER_READ_FAILED');
      const value = files.get(path);
      if (value === undefined) throw new Error(`STAGED_READER_MISSING:${path}`);
      return value;
    },
    listDirectory(path: string) {
      calls.push(`list:${relative(root, path)}`);
      if (fault === 'list') throw new Error('STAGED_READER_LIST_FAILED');
      if (!directories.has(path)) throw new Error(`STAGED_READER_MISSING_DIRECTORY:${path}`);
      const entries = [
        ...[...files.keys()]
          .filter((file) => dirname(file) === path)
          .map((file) => ({
            name: relative(path, file),
            kind: 'file' as const,
          })),
        ...[...directories]
          .filter((directory) => directory !== path && dirname(directory) === path)
          .map((directory) => ({
            name: relative(path, directory),
            kind: 'directory' as const,
          })),
      ];
      return Object.freeze(entries.sort((left, right) => left.name.localeCompare(right.name)));
    },
    exists: (path: string) => files.has(path) || directories.has(path),
    isDirectory: (path: string) => directories.has(path),
  });
  return { sourceReader, calls };
}
function produce(kind: Kind, sourceReader?: Reader) {
  const common = {
    repoRoot: root,
    now: NOW,
    persistBody: false,
    ...(sourceReader === undefined ? {} : { sourceReader }),
  };
  switch (kind) {
    case 'api':
      return senseInventoryApi({ ...common, scanDirs: ['src'] });
    case 'routes':
      return senseInventoryRoutes({ ...common, framework: 'react', scanDirs: ['web'] });
    case 'model':
      return senseInventoryDataModel({ ...common, migrationDirs: ['database'] });
    case 'rbac':
      return senseInventoryRbac({
        ...common,
        dataModelPath: join(root, 'overlay/model.json'),
        apiMapPath: join(root, 'overlay/api.json'),
      });
    case 'handling':
      return senseInventoryDataHandling({
        ...common,
        dataModelPath: join(root, 'overlay/model.json'),
      });
    case 'dependencies':
      return senseInventoryDepGraph({ ...common, scanDir: join(root, 'src') });
    case 'coverage':
      return senseInventoryCoverage({
        ...common,
        framework: 'react',
        apiMapPath: join(root, 'overlay/api.json'),
        routesPath: join(root, 'overlay/routes.json'),
        useCasesDir: join(root, 'product/use-cases'),
      });
  }
}
function populate(label: 'staged' | 'live') {
  const className = label === 'staged' ? 'Staged' : 'Live';
  put(
    'src/users.controller.ts',
    `import { Controller, Get, UseGuards } from '@nestjs/common';\n@Controller('${label}') export class ${className}Controller { @Get('list') @UseGuards(${className}Guard) list() {} }\n`,
  );
  put(
    'src/module.ts',
    `import { value } from './${label}-dependency'; export const result = value;\n`,
  );
  put(
    'web/routes.tsx',
    `const routes = <Route path="/${label}" element={<${className}Page />} />;\n`,
  );
  put(
    'database/schema.sql',
    `CREATE TABLE ${label}_users (id uuid PRIMARY KEY, email text); CREATE TABLE ${label}_roles (id uuid PRIMARY KEY, name text);\n`,
  );
  const model = produce('model');
  const api = produce('api');
  const routes = produce('routes');
  put('overlay/model.json', model.body);
  put('overlay/api.json', api.body);
  put('overlay/routes.json', routes.body);
  put('product/use-cases/use-case.json', {
    schemaVersion: '1.0.0',
    roles: ['operator'],
    cases: [
      {
        id: `UC-${label}`,
        title: `${label} scenario`,
        mainFlow: [
          {
            action: `${label} action`,
            refs: {
              endpointIds: [`GET /${label}/list`],
              routeIds: [],
              actionRefs: [{ id: `${label}.action` }],
            },
          },
        ],
      },
    ],
  });
  put('law/policy/action-registry.json', { entries: [{ action_id: `${label}.action` }] });
}
function assertBlocked(run: () => ReturnType<typeof produce>, reason: string) {
  let result: ReturnType<typeof produce>;
  try {
    result = run();
  } catch (error) {
    expect(String(error)).toContain(reason);
    return;
  }
  expect(result.reading.status).toBe('error');
  expect(JSON.stringify(result.reading.findings)).toContain(reason);
}

describe('all seven pure native producers obey an explicit immutable source reader', () => {
  it.each(KINDS)(
    '%s ordinary no-reader output is stable and observation writes nothing',
    (kind) => {
      populate('staged');
      const before = snapshot();
      const first = produce(kind);
      expect(first.reading.status).not.toBe('error');
      expect(produce(kind).body).toEqual(first.body);
      expect(snapshot()).toEqual(before);
    },
  );

  it.each(KINDS)(
    '%s reads staged A instead of live B and preserves ordinary no-reader behavior',
    (kind) => {
      populate('staged');
      const expected = produce(kind).body;
      const files = snapshot();
      populate('live');
      const ordinary = produce(kind).body;
      expect(ordinary).not.toEqual(expected); // Actual discriminator, never a vacuous fixture.
      const staged = reader(files);
      expect(produce(kind, staged.sourceReader).body).toEqual(expected);
      expect(staged.calls.length).toBeGreaterThan(0);
      expect(produce(kind).body).toEqual(ordinary);
    },
  );

  it.each(KINDS)('%s discovers staged-only files and excludes live-only files', (kind) => {
    populate('staged');
    const expected = produce(kind).body;
    const files = snapshot();
    rmSync(root, { recursive: true });
    mkdirSync(root);
    put('live-only/controller.ts', '@Controller("foreign") class Foreign {}');
    put('live-only/model.json', { forbidden: 'live-only' });
    expect(produce(kind, reader(files).sourceReader).body).toEqual(expected);
    expect(snapshot().size).toBe(2);
  });

  it.each(KINDS)(
    '%s blocks source read failure instead of catching/skipping/falling back',
    (kind) => {
      populate('staged');
      const files = snapshot();
      populate('live');
      assertBlocked(
        () => produce(kind, reader(files, 'read').sourceReader),
        'STAGED_READER_READ_FAILED',
      );
    },
  );

  it.each(['api', 'routes', 'model', 'dependencies'] as const)(
    '%s blocks snapshot enumeration failure',
    (kind) => {
      populate('staged');
      assertBlocked(
        () => produce(kind, reader(snapshot(), 'list').sourceReader),
        'STAGED_READER_LIST_FAILED',
      );
    },
  );

  it.each(['rbac', 'handling', 'coverage'] as const)(
    '%s rejects malformed same-run bodies despite valid live poison',
    (kind) => {
      populate('staged');
      const files = snapshot();
      files.set(
        join(root, kind === 'coverage' ? 'overlay/api.json' : 'overlay/model.json'),
        '{invalid',
      );
      populate('live');
      let failed = false;
      try {
        failed = produce(kind, reader(files).sourceReader).reading.status === 'error';
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    },
  );

  it.each(['rbac', 'handling', 'coverage'] as const)(
    '%s blocks a missing required snapshot body instead of reading the live body',
    (kind) => {
      populate('staged');
      const files = snapshot();
      files.delete(join(root, kind === 'coverage' ? 'overlay/api.json' : 'overlay/model.json'));
      populate('live');
      expect(produce(kind).reading.status).not.toBe('error');
      let failed = false;
      try {
        failed = produce(kind, reader(files).sourceReader).reading.status === 'error';
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    },
  );
});

describe('declared configuration, registry/use-cases and body overlay use the same reader', () => {
  it.each(['declaration', 'routes', 'model'] as const)(
    'resolves %s options from staged declaration only',
    (kind) => {
      populate('staged');
      put('.devai/config/sensor-inputs.json', {
        schemaVersion: '1.0.0',
        inputs: {
          inventory_routes: { framework: 'react', scanDirs: ['web'] },
          inventory_data_model: { migrationDirs: ['database'] },
        },
        surfaces: { http: true, database: true, rbac: true, actions: true },
      });
      const expected = resolveDeclaredSensorInputs({
        repoRoot: root,
        sensorKind: 'inventory_routes',
      });
      const files = snapshot();
      put('other/placeholder.ts', 'export {};');
      put('.devai/config/sensor-inputs.json', {
        schemaVersion: '1.0.0',
        inputs: {
          inventory_routes: { framework: 'angular', scanDirs: ['other'] },
          inventory_data_model: { migrationDirs: ['other'] },
        },
        surfaces: { http: false, database: false, rbac: false, actions: false },
      });
      const sourceReader = reader(files).sourceReader;
      const options = { repoRoot: root, sensorKind: 'inventory_routes', sourceReader };
      const route = resolveInventoryRouteInputs as unknown as (
        root: string,
        explicit: undefined,
        reader: Reader,
      ) => unknown;
      const model = resolveInventoryDataModelInputs as unknown as (
        root: string,
        explicit: undefined,
        reader: Reader,
      ) => unknown;
      if (kind === 'declaration') expect(resolveDeclaredSensorInputs(options)).toEqual(expected);
      if (kind === 'routes')
        expect(route(root, undefined, sourceReader)).toEqual({
          framework: 'react',
          scanDirs: ['web'],
        });
      if (kind === 'model')
        expect(model(root, undefined, sourceReader)).toEqual({ migrationDirs: ['database'] });
    },
  );

  it('reads staged registry and use-case linkage without live data', () => {
    populate('staged');
    const expected = measureActionLinkage(root);
    const files = snapshot();
    populate('live');
    const sourceReader = reader(files).sourceReader;
    const ids = readRegisteredActionIds as unknown as (
      root: string,
      admit: () => boolean,
      reader: Reader,
    ) => unknown;
    const linkage = measureActionLinkage as unknown as (
      root: string,
      directory: string,
      admit: () => boolean,
      reader: Reader,
    ) => unknown;
    expect(ids(root, () => true, sourceReader)).toEqual(['staged.action']);
    expect(linkage(root, join(root, 'product/use-cases'), () => true, sourceReader)).toEqual(
      expected,
    );
  });

  it('resolves body membership from snapshot rather than poisoned regenerated live state', () => {
    populate('staged');
    const kindFile = 'inventory_data_model/data-model.json';
    const direct = put(`record/proofs/sensors/${kindFile}`, produce('model').body);
    const files = snapshot();
    put(`.devai/state/sensors/${kindFile}`, '{poisoned');
    const resolve = resolveBodyInput as unknown as (
      root: string,
      explicit: undefined,
      name: string,
      reader: Reader,
    ) => unknown;
    expect(resolve(root, undefined, kindFile, reader(files).sourceReader)).toBe(direct);
    expect(resolveBodyInput(root, undefined, kindFile)).toBe(
      join(root, `.devai/state/sensors/${kindFile}`),
    );
  });
});

describe('independent reader edge review', () => {
  it.each([{}, { action_id: 17 }, { action_id: '' }])(
    'rejects malformed required registry entries: %j',
    (entry) => {
      populate('staged');
      const files = snapshot();
      files.set(
        join(root, 'law/policy/action-registry.json'),
        JSON.stringify({ entries: [entry] }),
      );
      // The valid live registry cannot stand in for the malformed staged entry.
      expect(() => readRegisteredActionIds(root, () => true, reader(files).sourceReader)).toThrow();
      expect(readRegisteredActionIds(root)).toEqual(['staged.action']);
    },
  );

  it.each(['{invalid', '{}', '{"schemaVersion":"1.0.0","roles":[],"cases":"invalid"}'])(
    'blocks malformed required use-case bytes/shape %s',
    (value) => {
      populate('staged');
      const files = snapshot();
      files.set(join(root, 'product/use-cases/use-case.json'), value);
      const sourceReader = reader(files).sourceReader;
      expect(() =>
        measureActionLinkage(root, join(root, 'product/use-cases'), () => true, sourceReader),
      ).toThrow();
      let blocked = false;
      try {
        blocked = produce('coverage', sourceReader).reading.status === 'error';
      } catch {
        blocked = true;
      }
      expect(blocked).toBe(true);
    },
  );

  it('does not suppress use-case directory discovery errors', () => {
    populate('staged');
    const base = reader(snapshot()).sourceReader;
    const sourceReader = Object.freeze({
      ...base,
      listDirectory(path: string) {
        if (path === join(root, 'product/use-cases'))
          throw new Error('STAGED_USECASE_DISCOVERY_FAILED');
        return base.listDirectory(path);
      },
    });
    expect(() =>
      measureActionLinkage(root, join(root, 'product/use-cases'), () => true, sourceReader),
    ).toThrow('STAGED_USECASE_DISCOVERY_FAILED');
    assertBlocked(() => produce('coverage', sourceReader), 'STAGED_USECASE_DISCOVERY_FAILED');
  });

  it('does not fall through unreadable staged routes to poisoned live state', () => {
    populate('staged');
    const path = 'record/proofs/sensors/inventory_routes';
    put(`${path}/routes-react.json`, produce('routes').body);
    const files = snapshot();
    put('.devai/state/sensors/inventory_routes/routes-react.json', '{poisoned');
    expect(() =>
      resolveRoutesPath(
        root,
        undefined,
        undefined,
        () => true,
        [path],
        reader(files, 'list').sourceReader,
      ),
    ).toThrow('STAGED_READER_LIST_FAILED');
  });

  it.each(['../outside.ts', '/outside.ts', 'nested/file.ts', 'nested\\file.ts', '.', '..'])(
    'rejects non-name staged directory entries %s',
    (name) => {
      populate('staged');
      const base = reader(snapshot()).sourceReader;
      const sourceReader = Object.freeze({
        ...base,
        listDirectory: () => [{ name, kind: 'file' as const }],
      });
      expect(() => walkFiles(root, { sourceReader })).toThrow('INVENTORY_SOURCE_DIRECTORY_INVALID');
    },
  );
});

// Optional absence is observable data, while present malformed/denied input still refuses.
it('does not attempt to read an absent optional staged action registry', () => {
  const staged = reader(new Map());
  expect(readRegisteredActionIds(root, () => true, staged.sourceReader)).toBeNull();
  expect(
    measureActionLinkage(root, join(root, 'product/use-cases'), () => true, staged.sourceReader),
  ).toBeNull();
  expect(staged.calls).toEqual([]);
});
