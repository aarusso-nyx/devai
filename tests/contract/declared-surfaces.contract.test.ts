// ADR-SCR-0003 IA-004 (framework contract): DEVAI declares only the actions surface in
// .devai/config/sensor-inputs.json. With that declaration and the real
// law/policy/action-registry.json, plant_coverage and inventory_coverage measure the
// registered actions against their specification links and report a percentage; they
// neither skip nor fail on the absent HTTP inventory.
//
// Two readings are pinned:
//   - A fixture mirroring DEVAI (its committed declaration, its committed registry, and
//     a use case linking every registered action) reads pass at 100 percent.
//   - The repository itself is measured, not skipped: the metrics equal the linkage
//     derived here from product/use-cases, and the reading is pass exactly when every
//     registered action is linked (review otherwise, the way an unmapped route reads).
//
// Interface assumptions the engineer (TASK-0228) must meet, shared with
// packages/sensors/tests/declared-surfaces.test.ts:
//   - sensePlantCoverage and senseInventoryCoverage accept an optional `surfaces` option
//     `{ http, database, rbac, actions }` (all booleans). NEW: passed through the widened
//     local type `Surfaced<T>` because no options type declares it today.
//   - With actions true they read `<repoRoot>/law/policy/action-registry.json`
//     (`entries[].action_id`), link entries through `refs.actionRefs[].id` in the use
//     cases under `<repoRoot>/product/use-cases`, and report metrics `action_count`,
//     `linked_action_count`, and `action_coverage_pct` (0 to 100).
//   - With http false they raise no finding for a missing api-map or routes body.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  senseInventoryCoverage,
  type InventoryCoverageOptions,
} from '../../packages/sensors/src/inventory-coverage.js';
import {
  sensePlantCoverage,
  type PlantCoverageOptions,
} from '../../packages/sensors/src/plant-coverage.js';
import type { SensorReading } from '../../packages/sensors/src/sensor-reading.js';

interface DeclaredSurfaces {
  readonly http: boolean;
  readonly database: boolean;
  readonly rbac: boolean;
  readonly actions: boolean;
}
type Surfaced<T> = T & { readonly surfaces?: DeclaredSurfaces };

const ROOT = resolve(import.meta.dirname, '../..');
const NOW = '2026-09-27T00:00:00.000Z';
const REGISTRY_REL = 'law/policy/action-registry.json';
const DECLARATION_REL = '.devai/config/sensor-inputs.json';
const USE_CASES_REL = 'product/use-cases';

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const declaration = readJson<{ readonly surfaces?: DeclaredSurfaces }>(join(ROOT, DECLARATION_REL));
const registryText = readFileSync(join(ROOT, REGISTRY_REL), 'utf8');
const registry = JSON.parse(registryText) as {
  readonly entries: ReadonlyArray<{ readonly action_id: string }>;
};
const actionIds = registry.entries.map((entry) => entry.action_id);

interface UseCaseStep {
  readonly refs?: { readonly actionRefs?: ReadonlyArray<{ readonly id: string }> };
}
interface UseCaseFile {
  readonly cases?: ReadonlyArray<{
    readonly mainFlow?: readonly UseCaseStep[];
    readonly alternateFlows?: ReadonlyArray<{ readonly steps?: readonly UseCaseStep[] }>;
  }>;
}

/** Registered action ids that some committed use-case step references. */
function linkedActionIds(): Set<string> {
  const registered = new Set(actionIds);
  const linked = new Set<string>();
  const dir = join(ROOT, USE_CASES_REL);
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.json'))) {
    const file = readJson<UseCaseFile>(join(dir, name));
    for (const useCase of file.cases ?? []) {
      const steps = [
        ...(useCase.mainFlow ?? []),
        ...(useCase.alternateFlows ?? []).flatMap((flow) => flow.steps ?? []),
      ];
      for (const step of steps) {
        for (const ref of step.refs?.actionRefs ?? []) {
          if (registered.has(ref.id)) linked.add(ref.id);
        }
      }
    }
  }
  return linked;
}

function measure(repoRoot: string, surfaces: DeclaredSurfaces): SensorReading[] {
  const plant: Surfaced<PlantCoverageOptions> = { repoRoot, now: NOW, surfaces };
  const coverage: Surfaced<InventoryCoverageOptions> = {
    repoRoot,
    persistBody: false,
    now: NOW,
    surfaces,
  };
  return [sensePlantCoverage(plant), senseInventoryCoverage(coverage).reading];
}

function expectNoHttpInventoryDemand(reading: SensorReading): void {
  const codes = (reading.findings ?? []).map((finding) => finding.code);
  expect(
    codes.filter((code) => /NO_INVENTORY|REQUIRES_API_MAP|REQUIRES_ROUTES/.test(code)),
  ).toEqual([]);
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('DEVAI declares only the actions surface', () => {
  it('commits http, database, and rbac absent and actions present', () => {
    expect(declaration.surfaces).toEqual({
      http: false,
      database: false,
      rbac: false,
      actions: true,
    });
    expect(actionIds.length).toBeGreaterThan(0);
  });
});

describe('plant_coverage and inventory_coverage measure the DEVAI action registry', () => {
  it('read pass at 100 percent on a fixture mirroring DEVAI with every action linked', () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-declared-surfaces-contract-'));
    roots.push(root);
    const put = (rel: string, content: string): void => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    };
    put(DECLARATION_REL, readFileSync(join(ROOT, DECLARATION_REL), 'utf8'));
    put(REGISTRY_REL, registryText);
    put(
      `${USE_CASES_REL}/devai-cli.json`,
      JSON.stringify({
        schemaVersion: '1.0.0',
        roles: ['operator'],
        cases: [
          {
            id: 'UC-devai-registered-actions',
            title: 'Use every registered DEVAI action',
            mainFlow: actionIds.map((id, index) => ({
              id: `step-${String(index + 1).padStart(2, '0')}`,
              action: `Use \`${id}\`.`,
              actorRole: 'operator',
              refs: { actionRefs: [{ id }] },
            })),
          },
        ],
      }),
    );
    const surfaces = declaration.surfaces as DeclaredSurfaces;
    for (const reading of measure(root, surfaces)) {
      expect(reading.status, `${reading.sensor.kind} ${JSON.stringify(reading.findings)}`).toBe(
        'pass',
      );
      expect(reading.metrics).toMatchObject({
        action_count: actionIds.length,
        linked_action_count: actionIds.length,
        action_coverage_pct: 100,
      });
      expectNoHttpInventoryDemand(reading);
    }
  });

  it('measure the repository itself as a percentage of linked actions, never a skip', () => {
    const linked = linkedActionIds();
    const pct = (linked.size / actionIds.length) * 100;
    const surfaces = declaration.surfaces as DeclaredSurfaces;
    for (const reading of measure(ROOT, surfaces)) {
      const label = `${reading.sensor.kind} ${JSON.stringify(reading.findings)}`;
      expect(reading.status, label).toBe(linked.size === actionIds.length ? 'pass' : 'review');
      expect(reading.metrics?.action_count, label).toBe(actionIds.length);
      expect(reading.metrics?.linked_action_count, label).toBe(linked.size);
      expect(Number(reading.metrics?.action_coverage_pct), label).toBeCloseTo(pct, 0);
      expectNoHttpInventoryDemand(reading);
    }
  });
});
