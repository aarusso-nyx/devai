import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectRequest,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { senseInventoryCoverage } from '../../src/inventory-coverage.js';
import { senseInventoryRbac } from '../../src/inventory-rbac.js';
import type { SensorReading } from '../../src/sensor-reading.js';
import type { DataModelBody, DataModelTable } from '../../src/inventory-data-model.js';

const NOW = '2026-09-08T12:00:00.000Z';

const roots: string[] = [];
// Inject only a selected directory-read failure. Real mode bits cannot establish
// unreadability when the mutation container runs as root; all other I/O is real.
const deniedDirectoryReads = vi.hoisted(() => new Set<string>());
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: (...args: unknown[]) => {
      if (deniedDirectoryReads.has(String(args[0])))
        throw new Error('EACCES: fixture directory read denied');
      return Reflect.apply(actual.readdirSync, actual, args);
    },
  };
});

afterEach(() => {
  deniedDirectoryReads.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-coverage-rbac-'));
  roots.push(root);
  return root;
}

function write(root: string, rel: string, contents: string): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

function writeJson(root: string, rel: string, value: unknown): string {
  return write(root, rel, `${JSON.stringify(value, null, 2)}\n`);
}

/** Refuse reads of this exact directory until the case finishes. */
function denyRead(path: string): void {
  deniedDirectoryReads.add(path);
}

function codes(reading: SensorReading): readonly string[] {
  return (reading.findings ?? []).map((finding) => finding.code);
}

function findingFor(reading: SensorReading, code: string) {
  return (reading.findings ?? []).find((finding) => finding.code === code);
}

/**
 * Both sensors persist their body through the authority mutation seam, so the
 * write path is only observable inside a real host-effect scope. This grants
 * exactly `mkdirSync` + `writeFileSync` confined to the fixture root, records
 * every request, and optionally refuses one symbol to exercise the sensors'
 * write-failure branch.
 */
function withWriteScope<T>(
  root: string,
  callback: (requests: readonly AuthorityHostEffectRequest[]) => T,
  options: { readonly denySymbol?: string } = {},
): T {
  const requests: AuthorityHostEffectRequest[] = [];
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'sensors-coverage-rbac-test-authority',
    issuer_version: '1.0.0',
    invocation_id: 'sensors-coverage-rbac-1',
    canonicalSha256: (value: unknown) =>
      createHash('sha256')
        .update(JSON.stringify(value) ?? '')
        .digest('hex'),
    randomId: () => 'sensors-coverage-rbac-receipt',
    now: () => NOW,
    receipt_ttl_ms: 30_000,
  }) as { dispose: () => unknown };
  const scope: AuthorityHostEffectScope = {
    action_id: 'sense inventory persist',
    invocation_id: 'sensors-coverage-rbac-1',
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (request, apply) => {
      requests.push(request);
      const target = request.arguments[0];
      if (
        request.kind !== 'filesystem' ||
        !['mkdirSync', 'writeFileSync'].includes(request.symbol) ||
        typeof target !== 'string' ||
        (resolve(target) !== resolve(root) && !resolve(target).startsWith(resolve(root) + sep))
      ) {
        throw new Error('SENSORS_TEST_EFFECT_OUT_OF_SCOPE');
      }
      if (request.symbol === options.denySymbol) throw new Error('SENSORS_TEST_WRITE_DENIED');
      return apply();
    },
  };
  try {
    return runWithAuthorityHostEffects(scope, () => callback(requests));
  } finally {
    issuer.dispose();
  }
}

function table(
  name: string,
  columns: readonly string[],
  extra: Partial<DataModelTable> = {},
): DataModelTable {
  return {
    name,
    columns: columns.map((column) => ({ name: column, type: 'text' })),
    evidence: [{ path: `database/${name}.sql`, startLine: 1, endLine: 2 }],
    ...extra,
  };
}

function dataModel(tables: readonly DataModelTable[]): DataModelBody {
  return {
    schemaVersion: '1.0.0',
    generatedAt: NOW,
    dialect: 'postgres',
    tables,
  };
}

describe('senseInventoryCoverage matrix assembly, persistence, and hashing', () => {
  /**
   * Surface + use-case fixture where every route and endpoint is linked.
   * One endpoint carries an explicit id and one relies on the
   * `"METHOD path"` fallback, so both id shapes flow through the matrix.
   */
  function linkedFixture(): string {
    const root = fixtureRoot();
    writeJson(root, 'record/proofs/sensors/inventory_api/api-map.json', {
      endpoints: [
        { method: 'GET', path: '/users' },
        { id: 'ep-user-detail', method: 'GET', path: '/users/:id' },
      ],
    });
    writeJson(root, 'record/proofs/sensors/inventory_routes/routes-react.json', {
      framework: 'react',
      routes: [
        { id: 'route-users', path: '/users' },
        { id: 'route-user-detail', path: '/users/42' },
      ],
    });
    writeJson(root, 'product/use-cases/browse.json', {
      schemaVersion: '1.0.0',
      roles: ['operator'],
      cases: [
        {
          id: 'UC-1',
          title: 'Browse users',
          mainFlow: [
            {
              action: 'list users',
              refs: { routeIds: ['route-users'], endpointIds: ['GET /users'] },
            },
            {
              action: 'open a user',
              refs: { routeIds: ['route-user-detail'], endpointIds: ['ep-user-detail'] },
            },
          ],
        },
      ],
    });
    return root;
  }

  it('persists a fully linked matrix and mirrors it in metrics and coverage_hash', () => {
    const root = linkedFixture();

    const { result, requests } = withWriteScope(root, (recorded) => ({
      result: senseInventoryCoverage({ repoRoot: root, now: NOW }),
      requests: recorded,
    }));

    const bodyPath = join(root, 'record/proofs/sensors/inventory_coverage/coverage-matrix.json');
    expect(result.reading.status).toBe('pass');
    expect(result.reading.findings).toBeUndefined();
    expect(result.bodyPath).toBe(bodyPath);
    expect(result.reading.evidence_path).toBe(bodyPath);
    expect(readFileSync(bodyPath, 'utf8')).toBe(`${JSON.stringify(result.body, null, 2)}\n`);
    expect(requests.map((request) => request.symbol)).toEqual(['mkdirSync', 'writeFileSync']);
    expect(requests[0]?.arguments).toEqual([dirname(bodyPath), { recursive: true }]);

    // The hash sorts copies; the body must keep the inventory's own order.
    expect(result.body).toEqual({
      schemaVersion: '1.0.0',
      generatedAt: NOW,
      routes: ['route-users', 'route-user-detail'],
      endpoints: ['GET /users', 'ep-user-detail'],
      useCases: [{ id: 'UC-1', title: 'Browse users' }],
      links: [
        {
          routeId: 'route-users',
          endpointId: 'GET /users',
          useCaseId: 'UC-1',
          linkKind: 'paired',
        },
        {
          routeId: 'route-user-detail',
          endpointId: 'ep-user-detail',
          useCaseId: 'UC-1',
          linkKind: 'paired',
        },
      ],
      unmapped: { routes: [], endpoints: [] },
      stats: { routeCount: 2, endpointCount: 2, useCaseCount: 1, linkCount: 2 },
    });

    // Independent recomputation of the documented hash pre-image: every axis
    // sorted, links keyed `linkKind|routeId|endpointId|useCaseId`.
    const expectedHash = createHash('sha256')
      .update(
        JSON.stringify({
          routes: ['route-user-detail', 'route-users'],
          endpoints: ['GET /users', 'ep-user-detail'],
          useCases: ['UC-1'],
          links: [
            {
              linkKind: 'paired',
              routeId: 'route-user-detail',
              endpointId: 'ep-user-detail',
              useCaseId: 'UC-1',
            },
            {
              linkKind: 'paired',
              routeId: 'route-users',
              endpointId: 'GET /users',
              useCaseId: 'UC-1',
            },
          ],
          unmappedRoutes: [],
          unmappedEndpoints: [],
        }),
      )
      .digest('hex');
    expect(result.reading.metrics).toEqual({
      route_count: 2,
      endpoint_count: 2,
      use_case_count: 1,
      link_count: 2,
      unmapped_route_count: 0,
      unmapped_endpoint_count: 0,
      inferred_path_match_count: 2,
      coverage_hash: expectedHash,
    });
    expect(result.reading.command).toBe(`devai sense coverage --repo-root ${root}`);
    expect(result.reading.sensor).toEqual({
      name: 'inventory:coverage',
      kind: 'inventory_coverage',
      version: '1.0.0',
    });
    expect(result.reading).toMatchObject({ deterministic: true, tier: 'L0', timestamp: NOW });
  });

  it('witnesses authored use-cases in coverage_hash while the surface stays identical', () => {
    const root = linkedFixture();
    const linked = senseInventoryCoverage({ repoRoot: root, persistBody: false, now: NOW });
    const repeat = senseInventoryCoverage({ repoRoot: root, persistBody: false, now: NOW });
    rmSync(join(root, 'product/use-cases'), { recursive: true, force: true });
    const surfaceOnly = senseInventoryCoverage({ repoRoot: root, persistBody: false, now: NOW });

    const hash = (reading: SensorReading): unknown => reading.metrics?.coverage_hash;
    expect(hash(repeat.reading)).toBe(hash(linked.reading));
    expect(hash(surfaceOnly.reading)).not.toBe(hash(linked.reading));
    expect(surfaceOnly.reading.metrics).toMatchObject({
      route_count: 2,
      endpoint_count: 2,
      use_case_count: 0,
      link_count: 0,
      unmapped_route_count: 2,
      unmapped_endpoint_count: 2,
    });
  });

  it('reviews an unmapped surface with counted partial linking and no-use-case findings', () => {
    const root = linkedFixture();
    writeJson(root, 'record/proofs/sensors/inventory_routes/routes-react.json', {
      framework: 'react',
      routes: [
        { id: 'route-users', path: '/users' },
        { id: 'route-user-detail', path: '/users/42' },
        { id: 'route-settings', path: '/settings' },
      ],
    });

    const partial = senseInventoryCoverage({ repoRoot: root, persistBody: false, now: NOW });
    expect(partial.reading.status).toBe('review');
    expect(codes(partial.reading)).toEqual(['COVERAGE_PARTIAL_USE_CASE_LINKING']);
    expect(findingFor(partial.reading, 'COVERAGE_PARTIAL_USE_CASE_LINKING')).toEqual({
      severity: 'info',
      code: 'COVERAGE_PARTIAL_USE_CASE_LINKING',
      message:
        '1 use-case(s) populate 2 link(s); 1 route(s) and 0 endpoint(s) remain unmapped. ' +
        'Extend use-case refs.routeIds + refs.endpointIds to close.',
    });
    expect((partial.body as { unmapped: { routes: string[] } }).unmapped.routes).toEqual([
      'route-settings',
    ]);

    rmSync(join(root, 'product/use-cases'), { recursive: true, force: true });
    const unauthored = withWriteScope(root, () =>
      senseInventoryCoverage({ repoRoot: root, now: NOW }),
    );
    expect(unauthored.reading.status).toBe('review');
    // A review still materializes the matrix: only pass and review persist.
    const reviewBodyPath = join(
      root,
      'record/proofs/sensors/inventory_coverage/coverage-matrix.json',
    );
    expect(unauthored.bodyPath).toBe(reviewBodyPath);
    expect(readFileSync(reviewBodyPath, 'utf8')).toBe(
      `${JSON.stringify(unauthored.body, null, 2)}\n`,
    );
    expect(findingFor(unauthored.reading, 'COVERAGE_NO_USE_CASES')).toEqual({
      severity: 'warning',
      code: 'COVERAGE_NO_USE_CASES',
      message:
        `Coverage matrix assembled with 3 routes and 2 endpoints, but no use-cases authored under ` +
        `${join(root, 'product/use-cases')}. Author use-cases manually or through a bounded ` +
        `documentation recipe to populate triads.`,
    });
  });

  it('passes an inventoried-but-empty surface without demanding use-cases', () => {
    const root = fixtureRoot();
    writeJson(root, 'record/proofs/sensors/inventory_api/api-map.json', { endpoints: [] });
    writeJson(root, 'record/proofs/sensors/inventory_routes/routes-react.json', {
      framework: 'react',
      routes: [],
    });

    const result = senseInventoryCoverage({ repoRoot: root, persistBody: false, now: NOW });
    expect(result.reading.status).toBe('pass');
    expect(result.reading.findings).toBeUndefined();
    expect(result.bodyPath).toBeNull();
    expect(result.reading.evidence_path).toBeUndefined();
    expect(result.reading.metrics).toMatchObject({
      route_count: 0,
      endpoint_count: 0,
      inferred_path_match_count: 0,
    });
  });

  it('synthesizes deduplicated links across files, flows, and cardinalities', () => {
    const root = fixtureRoot();
    writeJson(root, 'record/proofs/sensors/inventory_api/api-map.json', {
      endpoints: [
        { method: 'GET', path: '/users' },
        { method: 'POST', path: '/users' },
      ],
    });
    writeJson(root, 'record/proofs/sensors/inventory_routes/routes-react.json', {
      framework: 'react',
      routes: [
        { id: 'route-users', path: '/users' },
        { id: 'route-new-user', path: '/users/new' },
      ],
    });
    // `a-*.json` sorts before `b-*.json`; the walker's sorted order fixes which
    // occurrence of a repeated 4-tuple wins and where each link lands.
    writeJson(root, 'product/use-cases/a-main.json', {
      schemaVersion: '1.0.0',
      roles: ['operator'],
      cases: [
        {
          id: 'UC-cross',
          title: 'Cross product and single axes',
          mainFlow: [
            {
              action: 'cross product',
              refs: {
                routeIds: ['route-users', 'route-new-user'],
                endpointIds: ['GET /users', 'POST /users'],
              },
            },
            {
              action: 'repeat of the same pairing',
              refs: { routeIds: ['route-users'], endpointIds: ['GET /users'] },
            },
            { action: 'no refs at all' },
            { action: 'only unknown refs', refs: { routeIds: ['ghost-route'] } },
          ],
          alternateFlows: [
            {
              when: 'the operator only navigates',
              steps: [
                {
                  action: 'route only, unknown endpoint dropped',
                  refs: { routeIds: ['route-users'], endpointIds: ['DELETE /ghost'] },
                },
              ],
            },
          ],
        },
      ],
    });
    writeJson(root, 'product/use-cases/b-jobs.json', {
      schemaVersion: '1.0.0',
      roles: ['system'],
      cases: [
        {
          id: 'UC-job',
          title: 'Background reconciliation',
          mainFlow: [
            { action: 'endpoint only', refs: { endpointIds: ['POST /users'] } },
            { action: 'endpoint only again', refs: { endpointIds: ['POST /users'] } },
          ],
        },
      ],
    });

    const result = senseInventoryCoverage({ repoRoot: root, persistBody: false, now: NOW });
    const body = result.body as {
      useCases: ReadonlyArray<{ id: string; title?: string }>;
      links: ReadonlyArray<{ routeId: string | null; endpointId: string | null; linkKind: string }>;
      unmapped: { routes: string[]; endpoints: string[] };
      stats: { linkCount: number; useCaseCount: number };
    };

    expect(body.links).toEqual([
      {
        routeId: 'route-users',
        endpointId: 'GET /users',
        useCaseId: 'UC-cross',
        linkKind: 'paired',
      },
      {
        routeId: 'route-users',
        endpointId: 'POST /users',
        useCaseId: 'UC-cross',
        linkKind: 'paired',
      },
      {
        routeId: 'route-new-user',
        endpointId: 'GET /users',
        useCaseId: 'UC-cross',
        linkKind: 'paired',
      },
      {
        routeId: 'route-new-user',
        endpointId: 'POST /users',
        useCaseId: 'UC-cross',
        linkKind: 'paired',
      },
      { routeId: 'route-users', endpointId: null, useCaseId: 'UC-cross', linkKind: 'route-only' },
      { routeId: null, endpointId: 'POST /users', useCaseId: 'UC-job', linkKind: 'endpoint-only' },
    ]);
    expect(body.useCases).toEqual([
      { id: 'UC-cross', title: 'Cross product and single axes' },
      { id: 'UC-job', title: 'Background reconciliation' },
    ]);
    expect(body.stats).toEqual({
      routeCount: 2,
      endpointCount: 2,
      useCaseCount: 2,
      linkCount: 6,
    });
    expect(body.unmapped).toEqual({ routes: [], endpoints: [] });
    expect(result.reading.status).toBe('pass');
  });

  it('reports unparsable, schema-invalid, and unreadable use-case sources without failing', () => {
    const root = fixtureRoot();
    writeJson(root, 'record/proofs/sensors/inventory_api/api-map.json', { endpoints: [] });
    writeJson(root, 'record/proofs/sensors/inventory_routes/routes-react.json', {
      framework: 'react',
      routes: [{ id: 'route-users', path: '/users' }],
    });
    write(root, 'product/use-cases/broken.json', '{bad');
    writeJson(root, 'product/use-cases/schema-invalid.json', {
      schemaVersion: '1.0.0',
      roles: ['operator'],
      cases: [{ id: 'UC-no-title', mainFlow: [{ action: 'step' }] }],
    });
    write(root, 'product/use-cases/notes.md', 'not a use-case bundle');

    const skipped = senseInventoryCoverage({ repoRoot: root, persistBody: false, now: NOW });
    expect(skipped.reading.status).toBe('review');
    expect(codes(skipped.reading)).toEqual([
      'COVERAGE_USE_CASES_PARSE_FAILED',
      'COVERAGE_USE_CASES_SCHEMA_INVALID',
      'COVERAGE_NO_USE_CASES',
    ]);
    expect(findingFor(skipped.reading, 'COVERAGE_USE_CASES_PARSE_FAILED')?.message).toContain(
      'failed to parse broken.json',
    );
    expect(findingFor(skipped.reading, 'COVERAGE_USE_CASES_SCHEMA_INVALID')?.message).toContain(
      'schema-invalid.json fails use-cases.schema.json',
    );
    expect(skipped.reading.metrics?.use_case_count).toBe(0);

    // A use-cases path that is a file, not a directory, is silently ignored.
    const asFile = senseInventoryCoverage({
      repoRoot: root,
      useCasesDir: join(root, 'product/use-cases/broken.json'),
      persistBody: false,
      now: NOW,
    });
    expect(codes(asFile.reading)).toEqual(['COVERAGE_NO_USE_CASES']);

    const useCasesDir = join(root, 'product/use-cases');
    denyRead(useCasesDir);
    expect(() => readdirSync(useCasesDir)).toThrow();
    const unreadable = senseInventoryCoverage({ repoRoot: root, persistBody: false, now: NOW });
    expect(unreadable.reading.status).toBe('review');
    expect(codes(unreadable.reading)).toEqual([
      'COVERAGE_USE_CASES_DIR_UNREADABLE',
      'COVERAGE_NO_USE_CASES',
    ]);
    expect(findingFor(unreadable.reading, 'COVERAGE_USE_CASES_DIR_UNREADABLE')).toMatchObject({
      severity: 'error',
      message: expect.stringContaining(`could not read use-cases dir ${useCasesDir}`),
    });
  });

  it('counts each route at most once against literal, colon, and brace endpoint shapes', () => {
    const root = fixtureRoot();
    writeJson(root, 'record/proofs/sensors/inventory_api/api-map.json', {
      endpoints: [
        { method: 'GET', path: '/orders/:id' },
        { method: 'GET', path: '/orders/{id}' },
        { method: 'GET', path: '/reports/v1.0' },
      ],
    });
    writeJson(root, 'record/proofs/sensors/inventory_routes/routes-react.json', {
      framework: 'react',
      routes: [
        { id: 'route-order', path: '/orders/7' },
        { id: 'route-report', path: '/reports/v1.0' },
        // `.` is escaped before the placeholder rewrite, so this must not match.
        { id: 'route-report-any', path: '/reports/v1x0' },
        { id: 'route-nested', path: '/orders/7/items' },
      ],
    });

    const result = senseInventoryCoverage({ repoRoot: root, persistBody: false, now: NOW });
    expect(result.reading.metrics?.inferred_path_match_count).toBe(2);
  });

  it('resolves the routes body without guessing and reports each resolution honestly', () => {
    const root = fixtureRoot();
    writeJson(root, 'record/proofs/sensors/inventory_api/api-map.json', { endpoints: [] });

    const noDirectory = senseInventoryCoverage({ repoRoot: root, persistBody: false, now: NOW });
    expect(noDirectory.reading.status).toBe('review');
    expect(findingFor(noDirectory.reading, 'COVERAGE_REQUIRES_ROUTES')?.message).toBe(
      `No routes-inventory body found under ${join(root, 'record/proofs/sensors/inventory_routes')}. ` +
        `Run 'devai sense run inventory_routes' first.`,
    );

    const missingFramework = senseInventoryCoverage({
      repoRoot: root,
      framework: 'react',
      persistBody: false,
      now: NOW,
    });
    expect(findingFor(missingFramework.reading, 'COVERAGE_REQUIRES_ROUTES')?.message).toContain(
      join(root, 'record/proofs/sensors/inventory_routes/routes-react.json'),
    );

    writeJson(root, 'record/proofs/sensors/inventory_routes/routes-react.json', {
      framework: 'react',
      routes: [{ id: 'route-react', path: '/react' }],
    });
    writeJson(root, 'record/proofs/sensors/inventory_routes/routes-angular.json', {
      framework: 'angular',
      routes: [{ id: 'route-angular', path: '/angular' }],
    });
    // A non-matching filename in the same directory must not create ambiguity.
    writeJson(root, 'record/proofs/sensors/inventory_routes/latest.json', { framework: 'react' });

    const ambiguous = senseInventoryCoverage({ repoRoot: root, persistBody: false, now: NOW });
    expect(ambiguous.reading.status).toBe('review');
    expect(findingFor(ambiguous.reading, 'COVERAGE_ROUTES_AMBIGUOUS')?.message).toBe(
      `Multiple routes-inventory bodies found under ${join(root, 'record/proofs/sensors/inventory_routes')}: ` +
        `routes-angular.json, routes-react.json. Select one with routesPath or framework after ` +
        `running 'devai sense run inventory_routes'.`,
    );
    expect((ambiguous.body as { routes: string[] }).routes).toEqual([]);

    const explicit = senseInventoryCoverage({
      repoRoot: root,
      routesPath: join(root, 'record/proofs/sensors/inventory_routes/routes-angular.json'),
      persistBody: false,
      now: NOW,
    });
    expect(codes(explicit.reading)).not.toContain('COVERAGE_ROUTES_AMBIGUOUS');
    expect((explicit.body as { routes: string[] }).routes).toEqual(['route-angular']);

    const routesDir = join(root, 'record/proofs/sensors/inventory_routes');
    denyRead(routesDir);
    const unreadable = senseInventoryCoverage({ repoRoot: root, persistBody: false, now: NOW });
    expect(codes(unreadable.reading)).toContain('COVERAGE_REQUIRES_ROUTES');
    expect((unreadable.body as { routes: string[] }).routes).toEqual([]);
  });

  it('fails schema-invalid and unparsable inputs without materializing a body', () => {
    const root = fixtureRoot();
    writeJson(root, 'record/proofs/sensors/inventory_api/api-map.json', { endpoints: [] });
    writeJson(root, 'record/proofs/sensors/inventory_routes/routes-react.json', {
      framework: 'react',
      routes: [
        { id: 'route-duplicate', path: '/a' },
        { id: 'route-duplicate', path: '/b' },
      ],
    });

    const { invalid, requests } = withWriteScope(root, (recorded) => ({
      invalid: senseInventoryCoverage({ repoRoot: root, now: NOW }),
      requests: recorded,
    }));
    expect(invalid.reading.status).toBe('error');
    expect(codes(invalid.reading)).toEqual(['COVERAGE_SCHEMA_INVALID']);
    expect(findingFor(invalid.reading, 'COVERAGE_SCHEMA_INVALID')?.message).toContain(
      'body fails coverage-matrix.schema.json',
    );
    expect(invalid.bodyPath).toBeNull();
    expect(requests).toEqual([]);

    const malformed = senseInventoryCoverage({
      repoRoot: root,
      apiMapPath: join(root, 'missing-api-map.json'),
      routesPath: write(root, 'routes-broken.json', '{bad'),
      persistBody: false,
      now: NOW,
    });
    // The missing api-map alone is a review; the unparsable routes body wins.
    expect(malformed.reading.status).toBe('error');
    expect(codes(malformed.reading)).toEqual([
      'COVERAGE_REQUIRES_API_MAP',
      'COVERAGE_ROUTES_INVALID',
    ]);
    expect(findingFor(malformed.reading, 'COVERAGE_REQUIRES_API_MAP')?.message).toContain(
      "Run 'devai sense run inventory_api' first.",
    );

    const badApiMap = senseInventoryCoverage({
      repoRoot: root,
      apiMapPath: write(root, 'api-broken.json', '{bad'),
      routesPath: join(root, 'record/proofs/sensors/inventory_routes/routes-react.json'),
      persistBody: false,
      now: NOW,
    });
    expect(badApiMap.reading.status).toBe('error');
    expect(codes(badApiMap.reading)).toEqual(['COVERAGE_API_MAP_INVALID']);
    expect(badApiMap.reading.metrics).toMatchObject({
      route_count: 2,
      endpoint_count: 0,
      inferred_path_match_count: 0,
    });
  });

  it('surfaces a refused body write as an error with no evidence path', () => {
    const root = fixtureRoot();
    writeJson(root, 'record/proofs/sensors/inventory_api/api-map.json', { endpoints: [] });
    writeJson(root, 'record/proofs/sensors/inventory_routes/routes-react.json', {
      framework: 'react',
      routes: [{ id: 'route-users', path: '/users' }],
    });
    const bodyPath = join(root, 'observed/coverage.json');

    const refused = withWriteScope(
      root,
      () => senseInventoryCoverage({ repoRoot: root, bodyPath, now: NOW }),
      { denySymbol: 'writeFileSync' },
    );
    expect(refused.reading.status).toBe('error');
    expect(refused.bodyPath).toBeNull();
    expect(refused.reading.evidence_path).toBeUndefined();
    expect(findingFor(refused.reading, 'COVERAGE_WRITE_FAILED')).toEqual({
      severity: 'critical',
      code: 'COVERAGE_WRITE_FAILED',
      message: 'SENSORS_TEST_WRITE_DENIED',
    });

    // Outside any authority scope the mutation seam itself refuses the write.
    const unscoped = senseInventoryCoverage({ repoRoot: root, bodyPath, now: NOW });
    expect(unscoped.reading.status).toBe('error');
    expect(findingFor(unscoped.reading, 'COVERAGE_WRITE_FAILED')?.message).toBe(
      'AUTHORITY_FINAL_BOUNDARY_REQUIRED',
    );
  });
});

describe('senseInventoryRbac binding inference, evidence, and persistence', () => {
  it('reports an absent data model as unknown and measures nothing', () => {
    const root = fixtureRoot();

    const { result, requests } = withWriteScope(root, (recorded) => ({
      result: senseInventoryRbac({ repoRoot: root, now: NOW }),
      requests: recorded,
    }));

    expect(result.reading.status).toBe('unknown');
    expect(findingFor(result.reading, 'RBAC_REQUIRES_DATA_MODEL')).toEqual({
      severity: 'info',
      code: 'RBAC_REQUIRES_DATA_MODEL',
      message:
        `Data-model body not found at ` +
        `${join(root, 'record/proofs/sensors/inventory_data_model/data-model.json')}. ` +
        `Run 'devai sense run inventory_data_model' first; nothing measured.`,
    });
    // 'unknown' is neither pass nor review: nothing is materialized.
    expect(result.bodyPath).toBeNull();
    expect(result.reading.evidence_path).toBeUndefined();
    expect(requests).toEqual([]);
    expect(result.body).toMatchObject({
      rbacIlfTables: [],
      roles: [{ id: '__placeholder', name: '__placeholder', evidence: [] }],
      permissions: [{ id: '__placeholder', name: '__placeholder' }],
      sourceRepo: root,
    });
    expect(result.reading.metrics).toEqual({
      role_table_count: 0,
      permission_table_count: 0,
      join_table_count: 0,
      endpoint_binding_count: 0,
      endpoints_without_role_count: 0,
      synthetic_guard_permission_count: 0,
      synthetic_role_permission_count: 0,
      rbac_hash: createHash('sha256').update('[]').digest('hex'),
    });
  });

  it('classifies named, heuristic, pattern, and foreign-key RBAC tables in order', () => {
    const root = fixtureRoot();
    writeJson(
      root,
      'record/proofs/sensors/inventory_data_model/data-model.json',
      dataModel([
        table('users', ['id', 'email']),
        table('roles', ['id', 'name']),
        // `user_roles` is a role-like *name*, so it is a role table, not a join.
        table('user_roles', ['user_id', 'role_id']),
        table('permissions', ['id', 'name']),
        // Heuristic: name + slug and 'role' in the table name.
        table('tenant_roles_catalog', ['Name', 'Slug']),
        // Heuristic: name column and 'permission' in the table name.
        table('legacy_permission_map', ['name', 'value']),
        // Pattern-matched join tables.
        table('role_has_permissions', ['role_id', 'permission_id']),
        table('assignments', ['role_id', 'permission_id']),
        // FK topology join: references a role-like and a permission-like table.
        table('grants', ['role_id', 'permission_id'], {
          foreign_keys: [
            {
              columns: ['role_id'],
              references_table: 'Roles',
              references_columns: ['id'],
            },
            {
              columns: ['permission_id'],
              references_table: 'permissions',
              references_columns: ['id'],
            },
          ],
        }),
        // Only one RBAC axis in its foreign keys: not a binding table.
        table('audit_log', ['id', 'role_id'], {
          foreign_keys: [
            { columns: ['role_id'], references_table: 'roles', references_columns: ['id'] },
          ],
        }),
        // A `name`+`key` table without 'role' in its name stays out.
        table('feature_flags', ['name', 'key']),
      ]),
    );

    const result = senseInventoryRbac({ repoRoot: root, persistBody: false, now: NOW });
    const body = result.body as {
      rbacIlfTables: string[];
      roles: ReadonlyArray<{ id: string; evidence?: readonly unknown[] }>;
      unmapped: { rolesWithoutPermissions: string[]; permissionsWithoutBindings: string[] };
    };

    expect(body.rbacIlfTables).toEqual([
      'roles',
      'user_roles',
      'tenant_roles_catalog',
      'permissions',
      'legacy_permission_map',
      'role_has_permissions',
      'assignments',
      'grants',
    ]);
    expect(result.reading.metrics).toMatchObject({
      role_table_count: 3,
      permission_table_count: 2,
      join_table_count: 3,
      endpoint_binding_count: 0,
      synthetic_guard_permission_count: 0,
      synthetic_role_permission_count: 0,
      rbac_hash: createHash('sha256').update(JSON.stringify(body.rbacIlfTables)).digest('hex'),
    });
    expect(body.unmapped.rolesWithoutPermissions).toEqual([
      'roles',
      'user_roles',
      'tenant_roles_catalog',
    ]);
    expect(body.unmapped.permissionsWithoutBindings).toEqual([
      'permissions',
      'legacy_permission_map',
    ]);
    expect(body.roles[0]).toEqual({
      id: 'roles',
      name: 'roles',
      evidence: [{ path: 'database/roles.sql', startLine: 1, endLine: 2 }],
    });
    expect(result.reading.status).toBe('pass');
    expect(result.reading.findings).toBeUndefined();
  });

  it('binds endpoints from guards and roles and separates claimed-public from unclaimed', () => {
    const root = fixtureRoot();
    writeJson(
      root,
      'record/proofs/sensors/inventory_data_model/data-model.json',
      dataModel([table('users', ['id'])]),
    );
    writeJson(root, 'record/proofs/sensors/inventory_api/api-map.json', {
      endpoints: [
        {
          method: 'POST',
          path: '/users',
          auth: { required: true, guards: ['SessionGuard'], roles: ['admin', 'auditor'] },
        },
        {
          id: 'ep-list-users',
          method: 'GET',
          path: '/users',
          auth: { required: true, guards: ['SessionGuard'] },
        },
        { method: 'GET', path: '/health', auth: { required: false, guards: ['SessionGuard'] } },
        { method: 'GET', path: '/version', auth: { required: true } },
        { method: 'DELETE', path: '/users/:id' },
      ],
    });

    const result = senseInventoryRbac({ repoRoot: root, persistBody: false, now: NOW });
    const body = result.body as {
      roles: ReadonlyArray<{ id: string }>;
      permissions: ReadonlyArray<{ id: string }>;
      bindings: { endpointBindings: ReadonlyArray<Record<string, unknown>> };
      unmapped: { endpointsWithoutRole: string[] };
      stats: Record<string, number>;
    };

    expect(body.bindings.endpointBindings).toEqual([
      { permissionId: 'guard:SessionGuard', endpointId: 'POST /users', methods: ['POST'] },
      { permissionId: 'role:admin', endpointId: 'POST /users', methods: ['POST'] },
      { permissionId: 'role:auditor', endpointId: 'POST /users', methods: ['POST'] },
      { permissionId: 'guard:SessionGuard', endpointId: 'ep-list-users', methods: ['GET'] },
    ]);
    // `auth.required === false` is a claim; `required: true` without guards or
    // roles, and a missing `auth` block, are not.
    expect(body.unmapped.endpointsWithoutRole).toEqual(['GET /version', 'DELETE /users/:id']);
    expect(body.roles.map((role) => role.id)).toEqual(['role:admin', 'role:auditor']);
    expect(body.permissions.map((permission) => permission.id)).toEqual([
      'guard:SessionGuard',
      'role:admin',
      'role:auditor',
    ]);
    expect(body.stats).toEqual({
      roleCount: 0,
      permissionCount: 0,
      endpointBindingCount: 4,
      routeBindingCount: 0,
      entityBindingCount: 0,
    });
    expect(result.reading.metrics).toMatchObject({
      endpoint_binding_count: 4,
      endpoints_without_role_count: 2,
      synthetic_guard_permission_count: 1,
      synthetic_role_permission_count: 2,
    });
    // Controller signals alone keep the inventory out of the empty branch.
    expect(result.reading.status).toBe('pass');
    expect(result.reading.findings).toBeUndefined();
  });

  it('reviews a data model with no RBAC shape and no controller signals', () => {
    const root = fixtureRoot();
    writeJson(
      root,
      'record/proofs/sensors/inventory_data_model/data-model.json',
      dataModel([table('users', ['id', 'email']), table('orders', ['id', 'total'])]),
    );
    writeJson(root, 'record/proofs/sensors/inventory_api/api-map.json', {
      endpoints: [{ method: 'GET', path: '/orders', auth: { required: false } }],
    });

    const result = withWriteScope(root, () => senseInventoryRbac({ repoRoot: root, now: NOW }));
    expect(result.reading.status).toBe('review');
    // A review persists: the empty inventory is still canonical observation.
    expect(result.bodyPath).toBe(join(root, 'record/proofs/sensors/inventory_rbac/rbac.json'));
    expect(readFileSync(result.bodyPath as string, 'utf8')).toBe(
      `${JSON.stringify(result.body, null, 2)}\n`,
    );
    expect(findingFor(result.reading, 'RBAC_INVENTORY_EMPTY')).toEqual({
      severity: 'warning',
      code: 'RBAC_INVENTORY_EMPTY',
      message:
        'No RBAC-shaped tables detected (roles=0, permissions=0) and no @UseGuards/@Roles in ' +
        'api-map. Adopter may use non-RBAC auth or a non-standard naming convention.',
    });
    expect((result.body as { roles: ReadonlyArray<{ id: string }> }).roles).toEqual([
      { id: '__placeholder', name: '__placeholder', evidence: [] },
    ]);
  });

  it('persists the inventory body and mirrors it at the evidence path', () => {
    const root = fixtureRoot();
    writeJson(
      root,
      'record/proofs/sensors/inventory_data_model/data-model.json',
      dataModel([table('roles', ['id', 'name']), table('permissions', ['id', 'name'])]),
    );
    const bodyPath = join(root, 'observed/rbac/rbac.json');

    const { result, requests } = withWriteScope(root, (recorded) => ({
      result: senseInventoryRbac({ repoRoot: root, bodyPath, now: NOW }),
      requests: recorded,
    }));

    expect(result.reading.status).toBe('pass');
    expect(result.bodyPath).toBe(bodyPath);
    expect(result.reading.evidence_path).toBe(bodyPath);
    expect(readFileSync(bodyPath, 'utf8')).toBe(`${JSON.stringify(result.body, null, 2)}\n`);
    expect(requests.map((request) => request.symbol)).toEqual(['mkdirSync', 'writeFileSync']);
    expect(requests[0]?.arguments).toEqual([dirname(bodyPath), { recursive: true }]);

    const refused = withWriteScope(
      root,
      () => senseInventoryRbac({ repoRoot: root, bodyPath, now: NOW }),
      { denySymbol: 'writeFileSync' },
    );
    expect(refused.reading.status).toBe('error');
    expect(refused.bodyPath).toBeNull();
    expect(refused.reading.evidence_path).toBeUndefined();
    expect(findingFor(refused.reading, 'RBAC_WRITE_FAILED')).toEqual({
      severity: 'critical',
      code: 'RBAC_WRITE_FAILED',
      message: 'SENSORS_TEST_WRITE_DENIED',
    });
  });

  it('separates an unparsable api-map from an unparsable data model', () => {
    const root = fixtureRoot();
    writeJson(
      root,
      'record/proofs/sensors/inventory_data_model/data-model.json',
      dataModel([table('users', ['id'])]),
    );
    const broken = write(root, 'record/proofs/sensors/inventory_api/api-map.json', '{bad');

    const softFailure = senseInventoryRbac({ repoRoot: root, persistBody: false, now: NOW });
    expect(softFailure.reading.status).toBe('review');
    expect(codes(softFailure.reading)).toEqual(['RBAC_API_MAP_INVALID', 'RBAC_INVENTORY_EMPTY']);
    expect(findingFor(softFailure.reading, 'RBAC_API_MAP_INVALID')?.message).toContain(
      `api-map at ${broken} failed to parse:`,
    );
    expect(
      (softFailure.body as { bindings: { endpointBindings: unknown[] } }).bindings.endpointBindings,
    ).toEqual([]);

    const hardFailure = senseInventoryRbac({
      repoRoot: root,
      dataModelPath: write(root, 'data-model-broken.json', '{bad'),
      persistBody: false,
      now: NOW,
    });
    expect(hardFailure.reading.status).toBe('error');
    // The api-map is still the broken one: both inputs report independently.
    expect(codes(hardFailure.reading)).toEqual(['RBAC_DATA_MODEL_INVALID', 'RBAC_API_MAP_INVALID']);
    expect(findingFor(hardFailure.reading, 'RBAC_DATA_MODEL_INVALID')?.severity).toBe('critical');
    expect(hardFailure.bodyPath).toBeNull();
  });

  it('fails a body that violates rbac-inventory.schema.json before persisting', () => {
    const root = fixtureRoot();
    writeJson(
      root,
      'record/proofs/sensors/inventory_data_model/data-model.json',
      dataModel([table('users', ['id'])]),
    );
    // TRACE is outside the schema's EndpointBinding method enum.
    writeJson(root, 'record/proofs/sensors/inventory_api/api-map.json', {
      endpoints: [
        { method: 'TRACE', path: '/debug', auth: { required: true, guards: ['DebugGuard'] } },
      ],
    });

    const { result, requests } = withWriteScope(root, (recorded) => ({
      result: senseInventoryRbac({ repoRoot: root, now: NOW }),
      requests: recorded,
    }));

    expect(result.reading.status).toBe('error');
    expect(codes(result.reading)).toEqual(['RBAC_SCHEMA_INVALID']);
    expect(findingFor(result.reading, 'RBAC_SCHEMA_INVALID')?.message).toContain(
      'body fails rbac-inventory.schema.json',
    );
    expect(result.bodyPath).toBeNull();
    expect(requests).toEqual([]);
  });
});
