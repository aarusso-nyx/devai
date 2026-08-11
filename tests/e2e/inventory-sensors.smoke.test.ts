import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  senseInventoryApi,
  senseInventoryCoverage,
  senseInventoryDataHandling,
  senseInventoryDataModel,
  senseInventoryDepGraph,
  senseInventoryRbac,
  senseInventoryRoutes,
} from '../../packages/sensors/src/index.js';

/**
 * Phase 19.C (D-61): performance smoke for the 7 L0 inventory sensors
 * against a structure-only monorepo-scale fixture. Confirms that
 * `devai sense` end-to-end stays well under the wall-clock budget
 * expected of an adopter-pilot environment (stynx-class repos:
 * ~17 packages, ~10k LOC).
 *
 * This is a SMOKE test, not a regression gate: it establishes a
 * first-run baseline and surfaces order-of-magnitude regressions.
 * Per-millisecond drift is out of scope; tightening to a hard ceiling
 * is a follow-on after we accumulate enough cross-environment
 * measurements.
 *
 * Fixture is generated programmatically (deterministic, no on-disk
 * checked-in bloat) and torn down after the run.
 */

const PACKAGE_COUNT = 17;
const FILES_PER_PACKAGE = 12; // 4 controllers + 4 services + 4 entities
const LINES_PER_FILE_BODY = 30;
const SQL_MIGRATION_COUNT = 20;
const ROUTE_FILE_COUNT = 4;
// 60s wall-clock per the Phase 19.C budget. Generous on purpose — the
// goal is to catch a hung walker or an O(n²) bug, not benchmark drift.
const TOTAL_BUDGET_MS = 60_000;

let fixtureRoot = '';

function controllerSource(pkg: number, idx: number): string {
  const lines = [
    "import { Controller, Get, Post, Param, UseGuards } from '@nestjs/common';",
    `import { ResourceService } from './resource-${idx}.service';`,
    '',
    "@Controller('resources')",
    `export class Resource${pkg}_${idx}Controller {`,
    `  constructor(private readonly svc: ResourceService) {}`,
    '',
    '  @Get()',
    `  list() { return this.svc.findAll(); }`,
    '',
    "  @Get(':id')",
    `  get(@Param('id') id: string) { return this.svc.findOne(id); }`,
    '',
    '  @Post()',
    '  @UseGuards()',
    `  create() { return this.svc.create({}); }`,
    '}',
    '',
  ];
  while (lines.length < LINES_PER_FILE_BODY) lines.push(`// pad-${pkg}-${idx}-${lines.length}`);
  return lines.join('\n');
}

function serviceSource(pkg: number, idx: number): string {
  const lines = [
    "import { Injectable } from '@nestjs/common';",
    '',
    '@Injectable()',
    `export class Resource${pkg}_${idx}Service {`,
    `  findAll() { return []; }`,
    `  findOne(_id: string) { return null; }`,
    `  create(_dto: unknown) { return null; }`,
    '}',
    '',
  ];
  while (lines.length < LINES_PER_FILE_BODY) lines.push(`// svc-pad-${pkg}-${idx}-${lines.length}`);
  return lines.join('\n');
}

function entitySource(pkg: number, idx: number): string {
  const lines = [
    `export interface Resource${pkg}_${idx} {`,
    `  readonly id: string;`,
    `  readonly name: string;`,
    `  readonly createdAt: Date;`,
    '}',
    '',
  ];
  while (lines.length < LINES_PER_FILE_BODY) lines.push(`// ent-pad-${pkg}-${idx}-${lines.length}`);
  return lines.join('\n');
}

function sqlMigration(idx: number): string {
  return [
    `-- migration ${String(idx).padStart(4, '0')}`,
    `CREATE TABLE IF NOT EXISTS resource_${idx} (`,
    `  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),`,
    `  email varchar(255),`,
    `  full_name varchar(140),`,
    `  created_at timestamptz NOT NULL DEFAULT now()`,
    `);`,
    '',
    `CREATE TABLE IF NOT EXISTS audit_${idx} (`,
    `  id bigserial PRIMARY KEY,`,
    `  actor_id uuid,`,
    `  occurred_at timestamptz NOT NULL DEFAULT now()`,
    `);`,
    '',
  ].join('\n');
}

function routeSource(idx: number): string {
  return [
    "import { createBrowserRouter } from 'react-router-dom';",
    "import { HomePage } from './HomePage';",
    '',
    `export const router${idx} = createBrowserRouter([`,
    `  { path: '/page-${idx}-home', element: <HomePage /> },`,
    `  { path: '/page-${idx}-detail/:id', element: <HomePage /> },`,
    `]);`,
    '',
  ].join('\n');
}

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'devai-perf-smoke-'));
  for (let p = 0; p < PACKAGE_COUNT; p += 1) {
    const pkgSrc = join(fixtureRoot, 'packages', `pkg-${p}`, 'src');
    mkdirSync(pkgSrc, { recursive: true });
    for (let i = 0; i < FILES_PER_PACKAGE; i += 1) {
      const kind = i % 3;
      if (kind === 0) {
        writeFileSync(join(pkgSrc, `resource-${i}.controller.ts`), controllerSource(p, i));
      } else if (kind === 1) {
        writeFileSync(join(pkgSrc, `resource-${i}.service.ts`), serviceSource(p, i));
      } else {
        writeFileSync(join(pkgSrc, `resource-${i}.entity.ts`), entitySource(p, i));
      }
    }
  }
  mkdirSync(join(fixtureRoot, 'db/migrations'), { recursive: true });
  for (let i = 0; i < SQL_MIGRATION_COUNT; i += 1) {
    writeFileSync(
      join(fixtureRoot, 'db/migrations', `${String(i).padStart(4, '0')}-resource.sql`),
      sqlMigration(i),
    );
  }
  const webSrc = join(fixtureRoot, 'packages-web/web/src');
  mkdirSync(webSrc, { recursive: true });
  for (let i = 0; i < ROUTE_FILE_COUNT; i += 1) {
    writeFileSync(join(webSrc, `routes-${i}.tsx`), routeSource(i));
  }
});

afterAll(() => {
  try {
    rmSync(fixtureRoot, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

interface Timing {
  readonly sensor: string;
  readonly ms: number;
}

describe('Phase 19.C — inventory sensors performance smoke', () => {
  it(
    'all 7 L0 sensors complete under 60s wall-clock against a 17-package fixture',
    () => {
      const timings: Timing[] = [];
      const t0 = Date.now();

      const api = senseInventoryApi({ repoRoot: fixtureRoot });
      timings.push({ sensor: 'api', ms: api.reading.duration_ms ?? 0 });

      const routes = senseInventoryRoutes({ repoRoot: fixtureRoot });
      timings.push({ sensor: 'routes', ms: routes.reading.duration_ms ?? 0 });

      const dataModel = senseInventoryDataModel({
        repoRoot: fixtureRoot,
        migrationDirs: ['db/migrations'],
      });
      timings.push({ sensor: 'data-model', ms: dataModel.reading.duration_ms ?? 0 });

      const depGraph = senseInventoryDepGraph({ repoRoot: fixtureRoot });
      timings.push({ sensor: 'dep-graph', ms: depGraph.reading.duration_ms ?? 0 });

      const rbac = senseInventoryRbac({
        repoRoot: fixtureRoot,
        ...(dataModel.bodyPath !== null && { dataModelPath: dataModel.bodyPath }),
        ...(api.bodyPath !== null && { apiMapPath: api.bodyPath }),
      });
      timings.push({ sensor: 'rbac', ms: rbac.reading.duration_ms ?? 0 });

      const dataHandling = senseInventoryDataHandling({
        repoRoot: fixtureRoot,
        ...(dataModel.bodyPath !== null && { dataModelPath: dataModel.bodyPath }),
      });
      timings.push({ sensor: 'data-handling', ms: dataHandling.reading.duration_ms ?? 0 });

      const coverage = senseInventoryCoverage({
        repoRoot: fixtureRoot,
        ...(api.bodyPath !== null && { apiMapPath: api.bodyPath }),
        ...(routes.bodyPath !== null && { routesPath: routes.bodyPath }),
      });
      timings.push({ sensor: 'coverage', ms: coverage.reading.duration_ms ?? 0 });

      const totalMs = Date.now() - t0;

      // Forensic record: print per-sensor timings + total. Surfaces
      // first-run baseline in CI logs so future Phase-19 follow-ons
      // can compare without needing structured artifacts.
      process.stdout.write(
        `[perf-smoke] total=${String(totalMs)}ms ` +
          timings.map((t) => `${t.sensor}=${String(t.ms)}ms`).join(' ') +
          '\n',
      );

      expect(totalMs).toBeLessThan(TOTAL_BUDGET_MS);

      // Sanity: at least the api sensor discovered some endpoints
      // (1/3 of 12 files × 17 packages × 3 endpoints per controller).
      expect(api.body.endpoints.length).toBeGreaterThan(50);
    },
    TOTAL_BUDGET_MS + 5_000,
  );
});
// Invariants: INV-DEVAI-002, INV-DEVAI-012
