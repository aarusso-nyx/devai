import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectRequest,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { afterEach, describe, expect, it } from 'vitest';
import { senseInventoryApi } from '../../src/inventory-api.js';
import { senseInventoryRoutes, type RoutesFramework } from '../../src/inventory-routes.js';
import type { SensorReading } from '../../src/sensor-reading.js';

const NOW = '2026-09-08T12:00:00.000Z';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-api-routes-'));
  roots.push(root);
  return root;
}

function write(root: string, rel: string, contents: string): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

/** 1-based line number of the first line containing `needle`. */
function lineOf(source: string, needle: string): number {
  const index = source.split('\n').findIndex((line) => line.includes(needle));
  expect(index, `fixture line not found: ${needle}`).toBeGreaterThanOrEqual(0);
  return index + 1;
}

function codes(reading: SensorReading): readonly string[] {
  return (reading.findings ?? []).map((finding) => finding.code);
}

function findingFor(reading: SensorReading, code: string) {
  return (reading.findings ?? []).find((finding) => finding.code === code);
}

/**
 * Both sensors persist through the authority mutation seam, so the write path
 * is only observable inside a real host-effect scope. This grants exactly
 * `mkdirSync` + `writeFileSync` confined to the fixture root, records every
 * request, and optionally refuses one symbol to drive the failure branch.
 */
function withWriteScope<T>(
  root: string,
  callback: (requests: readonly AuthorityHostEffectRequest[]) => T,
  options: { readonly denySymbol?: string } = {},
): T {
  const requests: AuthorityHostEffectRequest[] = [];
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'sensors-api-routes-test-authority',
    issuer_version: '1.0.0',
    invocation_id: 'sensors-api-routes-1',
    canonicalSha256: (value: unknown) =>
      createHash('sha256')
        .update(JSON.stringify(value) ?? '')
        .digest('hex'),
    randomId: () => 'sensors-api-routes-receipt',
    now: () => NOW,
    receipt_ttl_ms: 30_000,
  }) as { dispose: () => unknown };
  const scope: AuthorityHostEffectScope = {
    action_id: 'sense inventory persist',
    invocation_id: 'sensors-api-routes-1',
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (request, apply) => {
      requests.push(request);
      const target = request.arguments[0];
      if (
        request.kind !== 'filesystem' ||
        !['mkdirSync', 'writeFileSync'].includes(request.symbol) ||
        typeof target !== 'string' ||
        !resolve(target).startsWith(`${resolve(root)}${sep}`)
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

/** Mirror of the sensor's endpoints_hash so metrics are checked, not echoed. */
function expectedEndpointsHash(
  rows: ReadonlyArray<readonly [string, string, string, string]>,
): string {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

/** Mirror of the sensor's routes_hash. */
function expectedRoutesHash(rows: ReadonlyArray<readonly [string, string, string]>): string {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

/** Mirror of the sensor's route id derivation. */
function routeId(framework: RoutesFramework, fileRel: string, path: string, line: number): string {
  const digest = createHash('sha256')
    .update(`${fileRel}::${path}::${String(line)}`)
    .digest('hex')
    .slice(0, 12);
  return `${framework}:${digest}`;
}

// =====================================================================
// inventory:api — NestJS controller inventory
// =====================================================================

const USERS_CONTROLLER = [
  `import { Body, Controller, Delete, Get, Head, Headers, Options, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';`,
  ``,
  `@Controller('users')`,
  `@UseGuards(SessionGuard)`,
  `export class UsersController {`,
  `  @Get('prop')`,
  `  readonly notAMethod = 1;`,
  ``,
  `  @Post()`,
  `  create(@Body() dto: CreateUserDto) {}`,
  ``,
  `  @Get(':id')`,
  `  findOne(`,
  `    @Param('id') id: string,`,
  `    @Query('expand') expand: string,`,
  `    @Headers('x-trace') trace: string,`,
  `    @Header('x-alt') alt: string,`,
  `    @Res() res: unknown,`,
  `  ) {}`,
  ``,
  `  @Patch('/:id')`,
  `  @UseGuards(MethodGuard, SessionGuard)`,
  `  @Roles('admin', ReaderRole)`,
  `  update(@Param() whole: unknown, @Query() { cursor }: Paging) {}`,
  ``,
  `  @Delete('archive')`,
  `  @Public()`,
  `  archive() {}`,
  ``,
  `  @Head`,
  `  ping() {}`,
  ``,
  `  @Options('probe')`,
  `  @Get('shadowed')`,
  `  probe() {}`,
  ``,
  `  undecorated() {}`,
  `}`,
  ``,
  `class NotAController {`,
  `  @Get('ghost')`,
  `  ghost() {}`,
  `}`,
  ``,
].join('\n');

describe('senseInventoryApi NestJS extraction', () => {
  function usersFixture(): { root: string; rel: string } {
    const root = fixtureRoot();
    const rel = join('apps', 'api', 'src', 'users.controller.ts');
    write(root, rel, USERS_CONTROLLER);
    return { root, rel };
  }

  it('extracts every decorator shape into exact endpoints, params, auth and evidence', () => {
    const { root, rel } = usersFixture();

    const result = senseInventoryApi({
      repoRoot: root,
      scanDirs: ['apps/api'],
      publicMarkerDecorators: ['Public'],
      persistBody: false,
      stack: { backend: 'nestjs', frontend: 'react', db: 'postgres' },
      now: NOW,
    });

    expect(result.reading.status).toBe('pass');
    expect(result.reading.findings).toBeUndefined();
    expect(result.body.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`)).toEqual([
      'HEAD /users',
      'POST /users',
      'GET /users/:id',
      'PATCH /users/:id',
      'DELETE /users/archive',
      'OPTIONS /users/probe',
    ]);

    // A property carrying @Get is not a method declaration; an undecorated
    // method and a class without @Controller contribute nothing.
    expect(result.body.endpoints.some((endpoint) => endpoint.path.endsWith('prop'))).toBe(false);
    expect(result.body.endpoints.some((endpoint) => endpoint.path.endsWith('ghost'))).toBe(false);
    // The first HTTP decorator in source order wins: @Options beats @Get.
    expect(result.body.endpoints.some((endpoint) => endpoint.path.endsWith('shadowed'))).toBe(
      false,
    );

    const create = result.body.endpoints.find((endpoint) => endpoint.method === 'POST');
    expect(create).toEqual({
      method: 'POST',
      path: '/users',
      controller: {
        file: rel,
        class: 'UsersController',
        methodName: 'create',
        startLine: lineOf(USERS_CONTROLLER, '@Post()'),
        endLine: lineOf(USERS_CONTROLLER, 'create(@Body()'),
      },
      // @Body() is deliberately dropped: the api-map param vocabulary is
      // path|query|header|cookie and bodies belong in request.payload.
      auth: { guards: ['SessionGuard'], required: true },
      evidence: [
        {
          path: rel,
          startLine: lineOf(USERS_CONTROLLER, '@Post()'),
          endLine: lineOf(USERS_CONTROLLER, 'create(@Body()'),
        },
      ],
    });

    const findOne = result.body.endpoints.find((endpoint) => endpoint.method === 'GET');
    expect(findOne?.params).toEqual([
      { name: 'id', in: 'path' },
      { name: 'expand', in: 'query' },
      { name: 'x-trace', in: 'header' },
      { name: 'x-alt', in: 'header' },
    ]);
    expect(findOne?.controller.startLine).toBe(lineOf(USERS_CONTROLLER, `@Get(':id')`));
    expect(findOne?.controller.endLine).toBe(lineOf(USERS_CONTROLLER, '  ) {}'));

    // Argument-less @Param()/@Query() fall back to the parameter identifier;
    // a destructured binding has no identifier, so 'param' is used.
    const update = result.body.endpoints.find((endpoint) => endpoint.method === 'PATCH');
    expect(update?.params).toEqual([
      { name: 'whole', in: 'path' },
      { name: 'param', in: 'query' },
    ]);
    // Method guards come first; class guards are appended without duplicates.
    expect(update?.auth).toEqual({
      guards: ['MethodGuard', 'SessionGuard'],
      roles: ['admin', 'ReaderRole'],
      required: true,
    });

    // A public marker on the method wins over the inherited class guard.
    expect(result.body.endpoints.find((endpoint) => endpoint.method === 'DELETE')?.auth).toEqual({
      guards: ['SessionGuard'],
      required: false,
    });

    // A bare (non-call) verb decorator maps with an empty sub-path.
    const ping = result.body.endpoints.find((endpoint) => endpoint.method === 'HEAD');
    expect(ping?.path).toBe('/users');
    expect(ping?.params).toBeUndefined();
  });

  it('reports endpoint metrics, hash and reading envelope from the extracted endpoints', () => {
    const { root, rel } = usersFixture();
    write(
      root,
      join('apps', 'api', 'src', 'health.controller.ts'),
      `@Controller('health')\nclass H {\n  @Get()\n  live() {}\n}\n`,
    );

    const result = senseInventoryApi({
      repoRoot: root,
      scanDirs: ['apps/api'],
      publicMarkerDecorators: ['Public'],
      persistBody: false,
      now: NOW,
    });

    expect(result.reading).toMatchObject({
      sensor: { name: 'inventory:api', kind: 'inventory_api', version: '1.0.0' },
      command: `devai sense api --repo-root ${root}`,
      status: 'pass',
      deterministic: true,
      tier: 'L0',
      timestamp: NOW,
    });
    expect(result.reading.evidence_path).toBeUndefined();
    expect(result.body.schemaVersion).toBe('1.0.0');
    expect(result.body.generatedAt).toBe(NOW);
    expect(result.body.sourceRepo).toBe(root);
    expect(result.body.stack).toBeUndefined();
    expect(result.reading.metrics).toEqual({
      endpoint_count: 7,
      controller_file_count: 2,
      endpoints_hash: expectedEndpointsHash(
        result.body.endpoints.map(
          (endpoint) =>
            [
              endpoint.method,
              endpoint.path,
              endpoint.controller.file,
              endpoint.controller.methodName ?? '',
            ] as const,
        ),
      ),
    });
    expect(result.reading.metrics?.['endpoints_hash']).toBe(
      expectedEndpointsHash([
        ['GET', '/health', join('apps', 'api', 'src', 'health.controller.ts'), 'live'],
        ['HEAD', '/users', rel, 'ping'],
        ['POST', '/users', rel, 'create'],
        ['GET', '/users/:id', rel, 'findOne'],
        ['PATCH', '/users/:id', rel, 'update'],
        ['DELETE', '/users/archive', rel, 'archive'],
        ['OPTIONS', '/users/probe', rel, 'probe'],
      ]),
    );
  });

  it('joins controller and method paths while retaining distinct handlers', () => {
    const root = fixtureRoot();
    const source = [
      `@Controller()`,
      `class Bare {`,
      `  @Get()`,
      `  root() {}`,
      `  @Get('/')`,
      `  slash() {}`,
      `}`,
      `@Controller('/')`,
      `class Slashed {`,
      `  @Post('list')`,
      `  list() {}`,
      `}`,
      `@Controller('api/')`,
      `class Trailing {`,
      `  @Put('v1')`,
      `  v1() {}`,
      `}`,
      `@Controller('/nested')`,
      `class Nested {`,
      `  @Patch('deep/leaf')`,
      `  leaf() {}`,
      `}`,
      ``,
    ].join('\n');
    write(root, 'paths.controller.ts', source);

    const result = senseInventoryApi({ repoRoot: root, persistBody: false, now: NOW });

    expect(result.body.endpoints.map((endpoint) => endpoint.path)).toEqual([
      '/',
      '/',
      '/api/v1',
      '/list',
      '/nested/deep/leaf',
    ]);
    // Equivalent route paths must not erase distinct handler evidence.
    expect(
      result.body.endpoints
        .filter((endpoint) => endpoint.path === '/')
        .map((endpoint) => endpoint.controller.methodName),
    ).toEqual(['root', 'slash']);
  });

  it('omits class and methodName when the declaration has no identifier', () => {
    const root = fixtureRoot();
    write(
      root,
      'anon.controller.ts',
      [
        `@Controller('anon')`,
        `export default class {`,
        `  @Get('literal')`,
        `  'string-named'() {}`,
        `}`,
        ``,
      ].join('\n'),
    );

    const result = senseInventoryApi({ repoRoot: root, persistBody: false, now: NOW });

    expect(result.body.endpoints).toHaveLength(1);
    expect(result.body.endpoints[0]?.controller).toEqual({
      file: 'anon.controller.ts',
      startLine: 3,
      endLine: 4,
    });
    expect(result.reading.metrics?.['endpoints_hash']).toBe(
      expectedEndpointsHash([['GET', '/anon/literal', 'anon.controller.ts', '']]),
    );
  });

  it('sorts by path, then method, then controller file and dedupes overlapping scans', () => {
    const root = fixtureRoot();
    const shared = [
      `@Controller('shared')`,
      `class Shared {`,
      `  @Post()`,
      `  create() {}`,
      `  @Get()`,
      `  list() {}`,
      `}`,
      ``,
    ].join('\n');
    write(root, join('apps', 'one', 'a.controller.ts'), shared);
    write(root, join('apps', 'two', 'b.controller.ts'), shared);

    const result = senseInventoryApi({
      repoRoot: root,
      // The same directory twice, plus the parent that contains both: every
      // controller is reachable more than once.
      scanDirs: ['apps/one', 'apps/one', 'apps'],
      persistBody: false,
      now: NOW,
    });

    expect(
      result.body.endpoints.map(
        (endpoint) => `${endpoint.method} ${endpoint.path} ${endpoint.controller.file}`,
      ),
    ).toEqual([
      `GET /shared ${join('apps', 'one', 'a.controller.ts')}`,
      `GET /shared ${join('apps', 'two', 'b.controller.ts')}`,
      `POST /shared ${join('apps', 'one', 'a.controller.ts')}`,
      `POST /shared ${join('apps', 'two', 'b.controller.ts')}`,
    ]);
    expect(result.reading.metrics).toMatchObject({
      endpoint_count: 4,
      controller_file_count: 2,
    });
  });

  it('walks only .controller.ts files and honours default and custom ignore dirs', () => {
    const root = fixtureRoot();
    const controller = `@Controller('x')\nclass X {\n  @Get()\n  x() {}\n}\n`;
    write(root, 'src/kept.controller.ts', controller);
    write(root, 'src/skipped.ts', controller.replace(`'x'`, `'plain-ts'`));
    write(root, 'src/skipped.controller.tsx', controller.replace(`'x'`, `'tsx'`));
    write(root, 'src/skipped.controller.d.ts', controller.replace(`'x'`, `'declaration'`));
    write(root, 'node_modules/dep/vendor.controller.ts', controller.replace(`'x'`, `'vendor'`));
    write(root, 'dist/out.controller.ts', controller.replace(`'x'`, `'dist'`));

    const defaults = senseInventoryApi({ repoRoot: root, persistBody: false, now: NOW });
    expect(defaults.body.endpoints.map((endpoint) => endpoint.path)).toEqual(['/x']);

    // A caller-supplied ignore set replaces the defaults wholesale, so
    // `dist/` becomes visible while the newly named directory is skipped.
    const custom = senseInventoryApi({
      repoRoot: root,
      ignoreDirs: new Set(['node_modules']),
      persistBody: false,
      now: NOW,
    });
    expect(custom.body.endpoints.map((endpoint) => endpoint.path)).toEqual(['/dist', '/x']);
  });

  it('resolves scan dirs by absolute, relative, duplicate, missing and non-directory entry', () => {
    const root = fixtureRoot();
    write(root, 'root.controller.ts', `@Controller('root')\nclass R {\n  @Get()\n  r() {}\n}\n`);
    write(
      root,
      'apps/api/app.controller.ts',
      `@Controller('app')\nclass A {\n  @Get()\n  a() {}\n}\n`,
    );
    const filePath = write(root, 'notadir.txt', 'not a directory\n');

    const mixed = senseInventoryApi({
      repoRoot: root,
      scanDirs: [join(root, 'apps', 'api'), 'apps/api', 'apps/missing', filePath],
      persistBody: false,
      now: NOW,
    });
    expect(mixed.body.endpoints.map((endpoint) => endpoint.path)).toEqual(['/app']);

    // Every declared directory is unusable → fall back to the repo root.
    const fallback = senseInventoryApi({
      repoRoot: root,
      scanDirs: ['nowhere', filePath],
      persistBody: false,
      now: NOW,
    });
    expect(fallback.body.endpoints.map((endpoint) => endpoint.path)).toEqual(['/app', '/root']);

    // An absent list also scans the repo root.
    const implicit = senseInventoryApi({ repoRoot: root, persistBody: false, now: NOW });
    expect(implicit.body.endpoints.map((endpoint) => endpoint.path)).toEqual(['/app', '/root']);
  });

  it('reports a clean empty scan as review, keeps the body and still persists it', () => {
    const root = fixtureRoot();
    write(root, 'src/plain.ts', 'export const plain = true;\n');

    const { result, requests } = withWriteScope(root, (recorded) => ({
      result: senseInventoryApi({ repoRoot: root, now: NOW }),
      requests: recorded,
    }));

    expect(result.reading.status).toBe('review');
    expect(result.reading.findings).toEqual([
      {
        severity: 'warning',
        code: 'API_INVENTORY_EMPTY',
        message: 'No @Controller-decorated classes found under scan path.',
      },
    ]);
    expect(result.body.endpoints).toEqual([]);
    expect(result.reading.metrics).toEqual({
      endpoint_count: 0,
      controller_file_count: 0,
      endpoints_hash: expectedEndpointsHash([]),
    });

    const expectedPath = join(root, 'record/proofs/sensors/inventory_api/api-map.json');
    expect(result.bodyPath).toBe(expectedPath);
    expect(result.reading.evidence_path).toBe(expectedPath);
    expect(readFileSync(expectedPath, 'utf8')).toBe(`${JSON.stringify(result.body, null, 2)}\n`);
    expect(
      requests.map(
        (request) => `${request.kind}:${request.symbol}:${String(request.arguments[0])}`,
      ),
    ).toEqual([
      `filesystem:mkdirSync:${dirname(expectedPath)}`,
      `filesystem:writeFileSync:${expectedPath}`,
    ]);
  });

  it('writes to a caller-supplied body path and skips the seam when persistBody is false', () => {
    const root = fixtureRoot();
    write(root, 'a.controller.ts', `@Controller('a')\nclass A {\n  @Get()\n  a() {}\n}\n`);
    const bodyPath = join(root, 'out', 'nested', 'api.json');

    const { result, requests } = withWriteScope(root, (recorded) => ({
      result: senseInventoryApi({ repoRoot: root, bodyPath, now: NOW }),
      requests: recorded,
    }));
    expect(result.reading.status).toBe('pass');
    expect(result.bodyPath).toBe(bodyPath);
    expect(JSON.parse(readFileSync(bodyPath, 'utf8'))).toEqual(result.body);
    expect(requests).toHaveLength(2);

    // persistBody:false performs no host effect at all — proven by running
    // it outside any authority scope, where a write would throw.
    const observed = senseInventoryApi({ repoRoot: root, bodyPath, persistBody: false, now: NOW });
    expect(observed.reading.status).toBe('pass');
    expect(observed.bodyPath).toBeNull();
    expect(observed.reading.evidence_path).toBeUndefined();
    expect(observed.body).toEqual(result.body);
  });

  it('turns a refused write into API_INVENTORY_WRITE_FAILED with a null body path', () => {
    const root = fixtureRoot();
    write(root, 'a.controller.ts', `@Controller('a')\nclass A {\n  @Get()\n  a() {}\n}\n`);
    const bodyPath = join(root, 'denied', 'api-map.json');

    const denied = withWriteScope(
      root,
      () => senseInventoryApi({ repoRoot: root, bodyPath, now: NOW }),
      { denySymbol: 'writeFileSync' },
    );

    expect(denied.reading.status).toBe('error');
    expect(denied.bodyPath).toBeNull();
    expect(denied.reading.evidence_path).toBeUndefined();
    expect(findingFor(denied.reading, 'API_INVENTORY_WRITE_FAILED')).toEqual({
      severity: 'critical',
      code: 'API_INVENTORY_WRITE_FAILED',
      message: 'SENSORS_TEST_WRITE_DENIED',
    });
    expect(existsSync(bodyPath)).toBe(false);
    // The body is still returned to the caller even though nothing landed.
    expect(denied.body.endpoints).toHaveLength(1);
  });

  it('fails the write when the body path is blocked by an existing file', () => {
    const root = fixtureRoot();
    write(root, 'a.controller.ts', `@Controller('a')\nclass A {\n  @Get()\n  a() {}\n}\n`);
    // `blocker` is a regular file, so mkdirSync of `blocker/nested` cannot
    // succeed: an exact-path, real-filesystem I/O failure.
    write(root, 'blocker', 'occupied\n');
    const bodyPath = join(root, 'blocker', 'nested', 'api-map.json');

    const blocked = withWriteScope(root, () =>
      senseInventoryApi({ repoRoot: root, bodyPath, now: NOW }),
    );

    expect(blocked.reading.status).toBe('error');
    expect(blocked.bodyPath).toBeNull();
    expect(codes(blocked.reading)).toEqual(['API_INVENTORY_WRITE_FAILED']);
    expect(findingFor(blocked.reading, 'API_INVENTORY_WRITE_FAILED')?.message).toMatch(
      /ENOTDIR|EEXIST/,
    );
  });

  it('deduplicates repeated method guards before persisting the inventory', () => {
    const root = fixtureRoot();
    write(
      root,
      'dup.controller.ts',
      [
        `@Controller('dup')`,
        `class Dup {`,
        `  @Get()`,
        `  @UseGuards(SameGuard, SameGuard)`,
        `  list() {}`,
        `}`,
        ``,
      ].join('\n'),
    );

    const { result, requests } = withWriteScope(root, (recorded) => ({
      result: senseInventoryApi({ repoRoot: root, now: NOW }),
      requests: recorded,
    }));

    expect(result.reading.status).toBe('pass');
    expect(codes(result.reading)).toEqual([]);
    expect(result.body.endpoints[0]?.auth).toEqual({ guards: ['SameGuard'], required: true });
    expect(result.bodyPath).not.toBeNull();
    expect(requests.map((request) => request.symbol)).toEqual(['mkdirSync', 'writeFileSync']);
  });

  it('refuses an invalid stack body before any persistence request', () => {
    const root = fixtureRoot();
    write(root, 'a.controller.ts', `@Controller('a') class A { @Get() a() {} }`);
    const { result, requests } = withWriteScope(root, (requests) => ({
      result: senseInventoryApi({
        repoRoot: root,
        now: NOW,
        stack: { backend: '', frontend: 'react', db: 'postgres' },
      }),
      requests,
    }));
    expect(result.reading.status).toBe('error');
    expect(codes(result.reading)).toEqual(['API_MAP_SCHEMA_INVALID']);
    expect(findingFor(result.reading, 'API_MAP_SCHEMA_INVALID')?.message).toContain(
      'body fails api-map.schema.json: ',
    );
    expect(result.bodyPath).toBeNull();
    expect(requests).toEqual([]);
  });

  it('records stack and sourceRepo verbatim when supplied', () => {
    const root = fixtureRoot();
    write(root, 'a.controller.ts', `@Controller('a')\nclass A {\n  @Get()\n  a() {}\n}\n`);
    const stack = { backend: 'nestjs', frontend: 'angular', db: 'postgres' };

    const result = senseInventoryApi({ repoRoot: root, stack, persistBody: false, now: NOW });

    expect(result.body.stack).toEqual(stack);
    expect(result.body.sourceRepo).toBe(root);
    expect(result.reading.status).toBe('pass');
  });

  it('treats public markers as opt-in and cascades a class-level marker', () => {
    const root = fixtureRoot();
    write(
      root,
      'pub.controller.ts',
      [
        `@Public()`,
        `@Controller('pub')`,
        `class Pub {`,
        `  @Get('open')`,
        `  open() {}`,
        `}`,
        ``,
      ].join('\n'),
    );

    // Default configuration recognizes no marker at all.
    const unconfigured = senseInventoryApi({ repoRoot: root, persistBody: false, now: NOW });
    expect(unconfigured.body.endpoints[0]?.auth).toBeUndefined();

    const configured = senseInventoryApi({
      repoRoot: root,
      publicMarkerDecorators: ['Public'],
      persistBody: false,
      now: NOW,
    });
    expect(configured.body.endpoints[0]?.auth).toEqual({ required: false });

    // An unrelated marker name leaves the endpoint unclaimed.
    const other = senseInventoryApi({
      repoRoot: root,
      publicMarkerDecorators: ['Anonymous'],
      persistBody: false,
      now: NOW,
    });
    expect(other.body.endpoints[0]?.auth).toBeUndefined();
  });

  it('defaults generatedAt to wall-clock time when `now` is absent', () => {
    const root = fixtureRoot();
    write(root, 'a.controller.ts', `@Controller('a')\nclass A {\n  @Get()\n  a() {}\n}\n`);
    const before = Date.now();

    const result = senseInventoryApi({ repoRoot: root, persistBody: false });

    const generated = Date.parse(result.body.generatedAt);
    expect(Number.isNaN(generated)).toBe(false);
    expect(generated).toBeGreaterThanOrEqual(before - 1000);
    expect(result.reading.timestamp).toBe(result.body.generatedAt);
    expect(result.reading.duration_ms).toBeGreaterThanOrEqual(0);
  });
});

// =====================================================================
// inventory:routes — React and Angular route inventory
// =====================================================================

const REACT_ROUTES = [
  `import { Route, Routes } from 'react-router-dom';`,
  ``,
  `export function App() {`,
  `  return (`,
  `    <Routes>`,
  `      <Route path="/users/:id" element={<UserPage />} />`,
  `      <Route path={'/expr'} element={lazyLoad('settings')} />`,
  `      <Route path="/ident" element={Direct} />`,
  `      <Route path="/nameless" />`,
  `      <Route path element={<Empty />} />`,
  `      <Route element={<Missing />} />`,
  `      <Route path="/wrapped" element={<Wrapper />}>`,
  `        <Route path="/wrapped/inner" element={<Inner />} />`,
  `      </Route>`,
  `      <Link path="/not-a-route" element={<Nav />} />`,
  `    </Routes>`,
  `  );`,
  `}`,
  ``,
].join('\n');

const REACT_OBJECT_ROUTES = [
  `import { createBrowserRouter } from 'react-router-dom';`,
  ``,
  `export const router = createBrowserRouter([`,
  `  {`,
  `    path: '/dash',`,
  `    element: <Dash />,`,
  `    children: [`,
  `      { path: '/dash/reports', element: <Reports /> },`,
  `      { 'path': \`/dash/audit\`, element: Audit },`,
  `      { element: <NoPath /> },`,
  `    ],`,
  `  },`,
  `  { path: '/legacy', children: 'not-an-array' },`,
  `]);`,
  ``,
  `export const extra = ReactRouter.createRoutesFromElements([{ path: '/from-elements' }]);`,
  `export const hooked = useRoutes([{ path: '/hooked', element: <Hooked /> }]);`,
  ``,
].join('\n');

describe('senseInventoryRoutes React extraction', () => {
  it('extracts JSX routes with exact ids, components and evidence', () => {
    const root = fixtureRoot();
    write(root, 'web/App.tsx', REACT_ROUTES);

    const result = senseInventoryRoutes({
      repoRoot: root,
      scanDirs: ['web'],
      persistBody: false,
      now: NOW,
    });

    expect(result.reading.status).toBe('pass');
    expect(result.body.framework).toBe('react');
    expect(result.body.routes.map((route) => route.path)).toEqual([
      '',
      '/expr',
      '/ident',
      '/nameless',
      '/users/:id',
      '/wrapped',
      '/wrapped/inner',
    ]);

    const rel = join('web', 'App.tsx');
    const detailLine = lineOf(REACT_ROUTES, '/users/:id');
    expect(result.body.routes.find((route) => route.path === '/users/:id')).toEqual({
      id: routeId('react', rel, '/users/:id', detailLine),
      path: '/users/:id',
      component: { file: rel, name: 'UserPage' },
      evidence: [{ path: rel, startLine: detailLine, endLine: detailLine }],
    });

    // element={call(...)} names the callee; element={Ident} names the binding.
    expect(result.body.routes.find((route) => route.path === '/expr')?.component?.name).toBe(
      'lazyLoad',
    );
    expect(result.body.routes.find((route) => route.path === '/ident')?.component?.name).toBe(
      'Direct',
    );
    // A route without `element` carries no component at all.
    expect(
      result.body.routes.find((route) => route.path === '/nameless')?.component,
    ).toBeUndefined();
    // `<Route path ...>` with no initializer is the empty path.
    expect(result.body.routes.find((route) => route.path === '')?.component?.name).toBe('Empty');
    // A JSX-nested <Route> is a plain sibling: nesting only yields parentId
    // for the object-literal router form.
    expect(
      result.body.routes.find((route) => route.path === '/wrapped/inner')?.parentId,
    ).toBeUndefined();
    // The opening element of a wrapping <Route> is still an extracted route.
    expect(result.body.routes.find((route) => route.path === '/wrapped')?.component?.name).toBe(
      'Wrapper',
    );
    // Only elements tagged `Route` count: a `path` attribute on any other JSX
    // element is not a route.
    expect(result.body.routes.some((route) => route.path === '/not-a-route')).toBe(false);

    expect(result.reading.metrics).toEqual({
      route_count: 7,
      route_file_count: 1,
      routes_hash: expectedRoutesHash(
        result.body.routes.map(
          (route) => [route.path, route.id, route.component?.name ?? ''] as const,
        ),
      ),
    });
  });

  it('extracts router object literals, nested children and every recognised factory', () => {
    const root = fixtureRoot();
    write(root, 'web/router.tsx', REACT_OBJECT_ROUTES);

    const result = senseInventoryRoutes({
      repoRoot: root,
      scanDirs: ['web'],
      persistBody: false,
      now: NOW,
    });

    expect(result.body.routes.map((route) => route.path)).toEqual([
      '/dash',
      '/dash/audit',
      '/dash/reports',
      '/from-elements',
      '/hooked',
      '/legacy',
    ]);

    const rel = join('web', 'router.tsx');
    const parent = result.body.routes.find((route) => route.path === '/dash');
    // Evidence lines span the whole object literal, so the id is derived from
    // the `{` line rather than the `path:` line.
    expect(parent?.evidence).toEqual([
      {
        path: rel,
        startLine: lineOf(REACT_OBJECT_ROUTES, `path: '/dash',`) - 1,
        endLine: lineOf(REACT_OBJECT_ROUTES, `  },`),
      },
    ]);
    expect(parent?.id).toBe(
      routeId('react', rel, '/dash', lineOf(REACT_OBJECT_ROUTES, `path: '/dash',`) - 1),
    );
    expect(parent?.parentId).toBeUndefined();
    // Children inherit the parent's id; the child's own id is content-derived.
    for (const child of ['/dash/reports', '/dash/audit']) {
      expect(result.body.routes.find((route) => route.path === child)?.parentId).toBe(parent?.id);
    }
    // A no-substitution template literal is read like a string literal, and a
    // bare identifier element names the component.
    expect(result.body.routes.find((route) => route.path === '/dash/audit')?.component?.name).toBe(
      'Audit',
    );
    // An object without `path` is not a route; a non-array `children` is
    // ignored without disturbing its own route.
    expect(result.body.routes.filter((route) => route.path === '')).toEqual([]);
    expect(result.body.routes.find((route) => route.path === '/legacy')?.component).toBeUndefined();
    // The factory is matched by the trailing property name, so a namespaced
    // call is recognised too.
    expect(result.body.routes.find((route) => route.path === '/from-elements')).toBeDefined();
    expect(result.body.routes.find((route) => route.path === '/hooked')?.component?.name).toBe(
      'Hooked',
    );
  });

  it('walks tsx, ts, jsx and js sources, skipping declarations and ignored dirs', () => {
    const root = fixtureRoot();
    const objectRoute = (path: string) =>
      `export const r = createBrowserRouter([{ path: '${path}' }]);\n`;
    write(root, 'web/a.tsx', objectRoute('/tsx'));
    write(root, 'web/b.ts', objectRoute('/ts'));
    write(root, 'web/c.jsx', objectRoute('/jsx'));
    write(root, 'web/d.js', objectRoute('/js'));
    write(root, 'web/e.d.ts', objectRoute('/declaration'));
    write(root, 'web/node_modules/f.tsx', objectRoute('/vendor'));
    write(root, 'web/build/g.tsx', objectRoute('/build'));
    write(root, 'web/custom/h.tsx', objectRoute('/custom'));

    const defaults = senseInventoryRoutes({
      repoRoot: root,
      scanDirs: ['web'],
      persistBody: false,
      now: NOW,
    });
    expect(defaults.body.routes.map((route) => route.path)).toEqual([
      '/custom',
      '/js',
      '/jsx',
      '/ts',
      '/tsx',
    ]);
    expect(defaults.reading.metrics?.['route_file_count']).toBe(5);

    const custom = senseInventoryRoutes({
      repoRoot: root,
      scanDirs: ['web'],
      ignoreDirs: new Set(['custom', 'node_modules']),
      persistBody: false,
      now: NOW,
    });
    expect(custom.body.routes.map((route) => route.path)).toEqual([
      '/build',
      '/js',
      '/jsx',
      '/ts',
      '/tsx',
    ]);
  });

  it('parses JSX in both .jsx and .js sources', () => {
    const root = fixtureRoot();
    const jsx = `export const App = () => <Route path="/from-{ext}" element={<Page />} />;\n`;
    write(root, 'web/a.jsx', jsx.replace('{ext}', 'jsx'));
    write(root, 'web/b.js', jsx.replace('{ext}', 'js'));

    const result = senseInventoryRoutes({
      repoRoot: root,
      scanDirs: ['web'],
      persistBody: false,
      now: NOW,
    });

    expect(result.body.routes.map((route) => route.path)).toEqual(['/from-js', '/from-jsx']);
  });

  it('sorts by path then id and dedupes ids across overlapping scan dirs', () => {
    const root = fixtureRoot();
    write(
      root,
      'web/one/a.tsx',
      `export const r = createBrowserRouter([{ path: '/b' }, { path: '/a' }]);\n`,
    );
    write(root, 'web/two/b.tsx', `export const r = createBrowserRouter([{ path: '/a' }]);\n`);

    const result = senseInventoryRoutes({
      repoRoot: root,
      scanDirs: ['web/one', 'web', 'web/one'],
      persistBody: false,
      now: NOW,
    });

    const first = routeId('react', join('web', 'one', 'a.tsx'), '/a', 1);
    const second = routeId('react', join('web', 'two', 'b.tsx'), '/a', 1);
    expect(result.body.routes.map((route) => route.path)).toEqual(['/a', '/a', '/b']);
    expect(result.body.routes.slice(0, 2).map((route) => route.id)).toEqual(
      [first, second].sort((a, b) => (a < b ? -1 : 1)),
    );
    expect(result.reading.metrics).toMatchObject({ route_count: 3, route_file_count: 2 });
  });
});

const ANGULAR_ROUTES = [
  `import { Routes, RouterModule, provideRouter } from '@angular/router';`,
  ``,
  `export const routes: Routes = [`,
  `  { path: 'dashboard', component: DashboardComponent },`,
  `  {`,
  `    path: 'admin',`,
  `    loadComponent: () => import('./admin.component').then((m) => m.AdminComponent),`,
  `    children: [{ path: 'admin/users', component: AdminUsersComponent }],`,
  `  },`,
  `  { path: 'lazy', loadChildren: () => import('./lazy.routes') },`,
  `  { path: 'old', redirectTo: 'dashboard' },`,
  `  { path: 'broken', loadComponent: () => loadIt() },`,
  `  { component: Orphan },`,
  `];`,
  ``,
  `const untyped = [{ path: 'untyped', component: Untyped }];`,
  ``,
  `export const providers = [provideRouter([{ path: 'provided' }]), provideRouter(routes)];`,
  `export const rootModule = RouterModule.forRoot([{ path: 'root-child' }]);`,
  `export const childModule = RouterModule.forChild([{ path: 'feature-child' }]);`,
  `export const ignored = RouterModule.forFeature([{ path: 'unrecognised' }]);`,
  `export const other = Other.forRoot([{ path: 'other-namespace' }]);`,
  ``,
].join('\n');

describe('senseInventoryRoutes Angular extraction', () => {
  it('extracts typed, provided, module, lazy and redirect routes with parent links', () => {
    const root = fixtureRoot();
    write(root, 'app/app.routes.ts', ANGULAR_ROUTES);

    const result = senseInventoryRoutes({
      repoRoot: root,
      scanDirs: ['app'],
      framework: 'angular',
      persistBody: false,
      now: NOW,
    });

    expect(result.reading.status).toBe('pass');
    expect(result.body.framework).toBe('angular');
    expect(result.body.routes.map((route) => route.path)).toEqual([
      'admin',
      'admin/users',
      'broken',
      'dashboard',
      'feature-child',
      'lazy',
      'old',
      'provided',
      'root-child',
    ]);

    const rel = join('app', 'app.routes.ts');
    const dashboardLine = lineOf(ANGULAR_ROUTES, `path: 'dashboard', component:`);
    expect(result.body.routes.find((route) => route.path === 'dashboard')).toEqual({
      id: routeId('angular', rel, 'dashboard', dashboardLine),
      path: 'dashboard',
      component: { file: rel, name: 'DashboardComponent' },
      evidence: [{ path: rel, startLine: dashboardLine, endLine: dashboardLine }],
    });

    // `loadComponent: () => import(...).then((m) => m.X)` yields X.
    const admin = result.body.routes.find((route) => route.path === 'admin');
    expect(admin?.component?.name).toBe('AdminComponent');
    expect(result.body.routes.find((route) => route.path === 'admin/users')?.parentId).toBe(
      admin?.id,
    );
    // A `loadComponent` arrow that is not the import().then() shape yields no
    // component, and lazy `loadChildren` contributes only its own path.
    expect(result.body.routes.find((route) => route.path === 'broken')?.component).toBeUndefined();
    expect(result.body.routes.find((route) => route.path === 'lazy')?.component).toBeUndefined();
    // Redirects are routes without components.
    expect(result.body.routes.find((route) => route.path === 'old')?.component).toBeUndefined();
    // Only `Routes`-typed declarations, provideRouter and RouterModule
    // forRoot/forChild are surfaces; other calls and untyped arrays are not.
    for (const absent of ['untyped', 'unrecognised', 'other-namespace']) {
      expect(result.body.routes.some((route) => route.path === absent)).toBe(false);
    }
    // `provideRouter(routes)` passes an identifier; the typed declaration
    // already covered it, so nothing is duplicated.
    expect(result.body.routes.filter((route) => route.path === 'dashboard')).toHaveLength(1);
  });

  it('keeps the React and Angular adapters separate on the same fixture', () => {
    const root = fixtureRoot();
    write(root, 'app/app.routes.ts', ANGULAR_ROUTES);
    write(root, 'app/App.tsx', REACT_ROUTES);

    const asReact = senseInventoryRoutes({
      repoRoot: root,
      scanDirs: ['app'],
      framework: 'react',
      persistBody: false,
      now: NOW,
    });
    const asAngular = senseInventoryRoutes({
      repoRoot: root,
      scanDirs: ['app'],
      framework: 'angular',
      persistBody: false,
      now: NOW,
    });

    expect(asReact.body.routes.some((route) => route.path === 'dashboard')).toBe(false);
    expect(asReact.body.routes.every((route) => route.id.startsWith('react:'))).toBe(true);
    expect(asAngular.body.routes.some((route) => route.path === '/users/:id')).toBe(false);
    expect(asAngular.body.routes.every((route) => route.id.startsWith('angular:'))).toBe(true);
  });
});

describe('senseInventoryRoutes status, persistence and metrics', () => {
  it('reports an empty scan as review with a framework-specific message', () => {
    const root = fixtureRoot();
    write(root, 'web/plain.ts', 'export const plain = true;\n');

    const react = senseInventoryRoutes({
      repoRoot: root,
      scanDirs: ['web'],
      persistBody: false,
      now: NOW,
    });
    expect(react.reading.status).toBe('review');
    expect(react.reading.findings).toEqual([
      {
        severity: 'warning',
        code: 'ROUTES_INVENTORY_EMPTY',
        message:
          'No React routes (<Route .../> or createBrowserRouter([...])) discovered under scan path.',
      },
    ]);

    const angular = senseInventoryRoutes({
      repoRoot: root,
      scanDirs: ['web'],
      framework: 'angular',
      persistBody: false,
      now: NOW,
    });
    expect(angular.reading.status).toBe('review');
    expect(angular.reading.findings?.[0]?.message).toBe(
      'No Angular routes (Routes arrays, provideRouter([...]) or RouterModule.forRoot/forChild) discovered under scan path.',
    );
    expect(angular.reading.metrics).toEqual({
      route_count: 0,
      route_file_count: 0,
      routes_hash: expectedRoutesHash([]),
    });
  });

  it('persists per framework under the default path through the authority seam', () => {
    const root = fixtureRoot();
    write(root, 'web/a.tsx', `export const r = createBrowserRouter([{ path: '/a' }]);\n`);
    write(root, 'web/app.routes.ts', `export const routes: Routes = [{ path: 'a' }];\n`);

    const { react, angular, requests } = withWriteScope(root, (recorded) => ({
      react: senseInventoryRoutes({ repoRoot: root, scanDirs: ['web'], now: NOW }),
      angular: senseInventoryRoutes({
        repoRoot: root,
        scanDirs: ['web'],
        framework: 'angular',
        now: NOW,
      }),
      requests: recorded,
    }));

    const reactPath = join(root, 'record/proofs/sensors/inventory_routes/routes-react.json');
    const angularPath = join(root, 'record/proofs/sensors/inventory_routes/routes-angular.json');
    expect(react.bodyPath).toBe(reactPath);
    expect(react.reading.evidence_path).toBe(reactPath);
    expect(angular.bodyPath).toBe(angularPath);
    expect(readFileSync(reactPath, 'utf8')).toBe(`${JSON.stringify(react.body, null, 2)}\n`);
    expect(readFileSync(angularPath, 'utf8')).toBe(`${JSON.stringify(angular.body, null, 2)}\n`);
    expect(requests.map((request) => request.symbol)).toEqual([
      'mkdirSync',
      'writeFileSync',
      'mkdirSync',
      'writeFileSync',
    ]);
    expect(requests.every((request) => String(request.arguments[0]).startsWith(root))).toBe(true);
  });

  it('reports a refused or blocked write as ROUTES_INVENTORY_WRITE_FAILED', () => {
    const root = fixtureRoot();
    write(root, 'web/a.tsx', `export const r = createBrowserRouter([{ path: '/a' }]);\n`);
    const bodyPath = join(root, 'out', 'routes.json');

    const denied = withWriteScope(
      root,
      () => senseInventoryRoutes({ repoRoot: root, scanDirs: ['web'], bodyPath, now: NOW }),
      { denySymbol: 'mkdirSync' },
    );
    expect(denied.reading.status).toBe('error');
    expect(denied.bodyPath).toBeNull();
    expect(findingFor(denied.reading, 'ROUTES_INVENTORY_WRITE_FAILED')).toEqual({
      severity: 'critical',
      code: 'ROUTES_INVENTORY_WRITE_FAILED',
      message: 'SENSORS_TEST_WRITE_DENIED',
    });
    expect(existsSync(bodyPath)).toBe(false);

    // An empty (review) inventory persists too, so a blocked path fails there
    // as well: `blocker` is a file, not a directory. A separate root keeps the
    // scan genuinely empty (a missing scanDir falls back to the repo root).
    const emptyRoot = fixtureRoot();
    write(emptyRoot, 'blocker', 'occupied\n');
    const blocked = withWriteScope(emptyRoot, () =>
      senseInventoryRoutes({
        repoRoot: emptyRoot,
        scanDirs: ['missing'],
        bodyPath: join(emptyRoot, 'blocker', 'nested', 'routes.json'),
        now: NOW,
      }),
    );
    expect(blocked.reading.status).toBe('error');
    expect(blocked.bodyPath).toBeNull();
    expect(codes(blocked.reading)).toEqual([
      'ROUTES_INVENTORY_EMPTY',
      'ROUTES_INVENTORY_WRITE_FAILED',
    ]);
  });

  it('resolves scan dirs and falls back to the repo root like the API sensor', () => {
    const root = fixtureRoot();
    write(root, 'top.tsx', `export const r = createBrowserRouter([{ path: '/top' }]);\n`);
    write(root, 'web/nested.tsx', `export const r = createBrowserRouter([{ path: '/nested' }]);\n`);
    const filePath = write(root, 'notadir.txt', 'not a directory\n');

    expect(
      senseInventoryRoutes({
        repoRoot: root,
        scanDirs: [join(root, 'web'), 'web', 'missing', filePath],
        persistBody: false,
        now: NOW,
      }).body.routes.map((route) => route.path),
    ).toEqual(['/nested']);

    expect(
      senseInventoryRoutes({
        repoRoot: root,
        scanDirs: ['missing', filePath],
        persistBody: false,
        now: NOW,
      }).body.routes.map((route) => route.path),
    ).toEqual(['/nested', '/top']);

    expect(
      senseInventoryRoutes({ repoRoot: root, persistBody: false, now: NOW }).body.routes.map(
        (route) => route.path,
      ),
    ).toEqual(['/nested', '/top']);
  });

  it('reports the reading envelope and a content-derived routes hash', () => {
    const root = fixtureRoot();
    write(
      root,
      'web/a.tsx',
      `export const r = createBrowserRouter([{ path: '/a', element: <A /> }, { path: '/b' }]);\n`,
    );

    const result = senseInventoryRoutes({
      repoRoot: root,
      scanDirs: ['web'],
      persistBody: false,
      now: NOW,
    });

    expect(result.reading).toMatchObject({
      sensor: { name: 'inventory:routes', kind: 'inventory_routes', version: '1.0.0' },
      command: `devai sense routes --repo-root ${root}`,
      status: 'pass',
      deterministic: true,
      tier: 'L0',
      timestamp: NOW,
    });
    const rel = join('web', 'a.tsx');
    expect(result.reading.metrics).toEqual({
      route_count: 2,
      route_file_count: 1,
      routes_hash: expectedRoutesHash([
        ['/a', routeId('react', rel, '/a', 1), 'A'],
        ['/b', routeId('react', rel, '/b', 1), ''],
      ]),
    });
    expect(result.reading.duration_ms).toBeGreaterThanOrEqual(0);

    // Re-running over the same bytes is byte-identical.
    const again = senseInventoryRoutes({
      repoRoot: root,
      scanDirs: ['web'],
      persistBody: false,
      now: NOW,
    });
    expect(again.body).toEqual(result.body);
    expect(again.reading.metrics).toEqual(result.reading.metrics);
  });
});
