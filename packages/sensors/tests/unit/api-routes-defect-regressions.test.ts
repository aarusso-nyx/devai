import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { senseInventoryApi } from '../../src/inventory-api.js';
import { senseInventoryRoutes } from '../../src/inventory-routes.js';

const NOW = '2026-09-08T12:00:00.000Z';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-round22-red-'));
  roots.push(root);
  return root;
}

function write(root: string, rel: string, contents: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

describe('API and route inventory completeness regressions', () => {
  it('D22-A1: distinct controller methods on the same verb+path are both inventoried', () => {
    const root = fixtureRoot();
    write(
      root,
      'dup.controller.ts',
      [
        `@Controller('svc')`,
        `class Svc {`,
        `  @Get()`,
        `  @UseGuards(Authenticated)`,
        `  list() {}`,
        `  @Get('/')`,
        `  legacyList() {}`,
        `}`,
        ``,
      ].join('\n'),
    );

    const result = senseInventoryApi({ repoRoot: root, persistBody: false, now: NOW });

    // Previously, the dedupe key was (method, path, controller.file), so the second
    // handler is dropped without any finding: a real endpoint disappears
    // from the inventory that inv-suggest and sense-rbac consume.
    expect(result.body.endpoints.map((endpoint) => endpoint.controller.methodName)).toEqual([
      'list',
      'legacyList',
    ]);
    expect(result.body.endpoints[0]?.auth).toEqual({ guards: ['Authenticated'], required: true });
    expect(result.body.endpoints[1]?.auth).toBeUndefined();
  });

  it('D22-A2: repeated method-level guards do not invalidate the whole api map', () => {
    const root = fixtureRoot();
    write(
      root,
      'guards.controller.ts',
      [
        `@Controller('svc')`,
        `class Svc {`,
        `  @Get()`,
        `  @UseGuards(SameGuard, SameGuard)`,
        `  list() {}`,
        `}`,
        ``,
      ].join('\n'),
    );

    const result = senseInventoryApi({ repoRoot: root, persistBody: false, now: NOW });

    // Previously, class-level guards were appended with a `includes` dedupe, but the
    // method-level list is spread verbatim. api-map.schema.json declares
    // auth.guards uniqueItems, so one duplicated decorator argument fails
    // the entire body and the sensor reports error with no inventory at all.
    expect(result.body.endpoints[0]?.auth?.guards).toEqual(['SameGuard']);
    expect(result.reading.status).toBe('pass');
  });

  it('D22-R1: JSX routes declared in .js sources are discovered', () => {
    const root = fixtureRoot();
    write(
      root,
      'web/app.js',
      `export const App = () => <Route path="/from-js" element={<P />} />;\n`,
    );

    const result = senseInventoryRoutes({
      repoRoot: root,
      scanDirs: ['web'],
      persistBody: false,
      now: NOW,
    });

    // walkTsxJsx deliberately includes `.js`, but parseSource previously selected
    // ScriptKind.TSX for `.tsx`/`.jsx`, so JSX in a plain `.js` React source
    // is parsed as TypeScript and the route is silently missed.
    expect(result.body.routes.map((route) => route.path)).toEqual(['/from-js']);
  });

  it('D22-A3: a controller base path with a trailing slash does not double the separator', () => {
    const root = fixtureRoot();
    write(
      root,
      'trailing.controller.ts',
      [`@Controller('api/')`, `class Api {`, `  @Get('v1')`, `  v1() {}`, `}`, ``].join('\n'),
    );

    const result = senseInventoryApi({ repoRoot: root, persistBody: false, now: NOW });

    // joinPath previously only normalised a leading slash, so '/api/' + '/v1' emits
    // '/api//v1' — a path that never matches the served route when
    // sense-coverage or sense-rbac compares it to a frontend route.
    expect(result.body.endpoints[0]?.path).toBe('/api/v1');
  });
});
