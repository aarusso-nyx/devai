/**
 * Blueprint module: load, validate, diff, and plan.
 *
 * Public API:
 *   loadBlueprint(path)              — parse + AJV-validate
 *   validateBlueprint(blueprint)     — INV-BLUEPRINT-001/-002/-003 check
 *   diffBlueprintAgainstInventory()  — compare to brownfield inventory
 *   planScaffoldFromBlueprint()      — emit a deterministic scaffold plan
 *
 * Per the INV-BLUEPRINT-* invariants,
 * landed in 18.D.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { validators } from '@devai-nyx/schemas';
import { canonicalJson } from '@devai-nyx/utils';
import type { Blueprint } from './types.js';
import { toKebabSimple } from './diff.js';
export { diffBlueprintAgainstInventory } from './diff.js';
export type { BlueprintDiffEntry, BlueprintDiffOptions, BlueprintDiffResult } from './diff.js';

export type {
  Blueprint,
  BlueprintEntity,
  BlueprintField,
  BlueprintRbacPermission,
  BlueprintRelation,
  BlueprintResource,
  Operation,
  PiiLevel,
  Retention,
} from './types.js';

// ---------------------------------------------------------------------
// Load + schema-validate.
// ---------------------------------------------------------------------

export interface LoadBlueprintResult {
  readonly ok: boolean;
  readonly blueprint?: Blueprint;
  readonly errors: readonly string[];
}

/**
 * Parse a blueprint file and validate against module-blueprint.schema.json.
 * Schema failures are surfaced as structured error strings. Successful
 * load returns the typed blueprint.
 */
export function loadBlueprint(path: string): LoadBlueprintResult {
  if (!existsSync(path)) {
    return { ok: false, errors: [`blueprint file not found: ${path}`] };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return {
      ok: false,
      errors: [`failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      errors: [`JSON parse error: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  const valid = validators.moduleBlueprint(parsed);
  if (!valid) {
    const errs = (validators.moduleBlueprint.errors ?? []).map(
      (e) => `${e.instancePath || '/'}: ${e.message ?? 'invalid'}`,
    );
    return { ok: false, errors: errs };
  }
  return { ok: true, blueprint: parsed as Blueprint, errors: [] };
}

// ---------------------------------------------------------------------
// Invariant check: INV-BLUEPRINT-001/-002/-003.
// ---------------------------------------------------------------------

export interface InvariantViolation {
  readonly invariant_id: 'INV-BLUEPRINT-001' | 'INV-BLUEPRINT-002' | 'INV-BLUEPRINT-003';
  readonly severity: 'gate' | 'hard-fail';
  readonly pointer: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly violations: readonly InvariantViolation[];
}

/**
 * Check a blueprint against the BLUEPRINT-domain invariants.
 * Schema validation is upstream (loadBlueprint); this function checks
 * invariants that go beyond JSON-Schema reach (cross-field consistency).
 */
export function validateBlueprint(bp: Blueprint): ValidationResult {
  const violations: InvariantViolation[] = [];

  // INV-BLUEPRINT-001: every entity has primaryKey with length >= 1.
  if (bp.database.entities.length === 0) {
    violations.push({
      invariant_id: 'INV-BLUEPRINT-001',
      severity: 'gate',
      pointer: '/database/entities',
      message: 'database.entities[] must have length >= 1',
    });
  }
  bp.database.entities.forEach((entity, idx) => {
    const pk = entity.primaryKey ?? ['id'];
    if (pk.length === 0) {
      violations.push({
        invariant_id: 'INV-BLUEPRINT-001',
        severity: 'gate',
        pointer: `/database/entities/${String(idx)}/primaryKey`,
        message: `entity '${entity.name}' primaryKey must have length >= 1`,
      });
    }
  });

  // INV-BLUEPRINT-002: every PII-flagged field has retention != 'default'.
  bp.database.entities.forEach((entity, eIdx) => {
    entity.fields.forEach((field, fIdx) => {
      const pii = field.pii ?? 'none';
      const retention = field.retention ?? 'default';
      if (pii !== 'none' && retention === 'default') {
        violations.push({
          invariant_id: 'INV-BLUEPRINT-002',
          severity: 'hard-fail',
          pointer: `/database/entities/${String(eIdx)}/fields/${String(fIdx)}`,
          message: `field '${entity.name}.${field.name}' has pii='${pii}' but retention='default' (PII requires explicit retention per INV-INVENTORY-002 + INV-BLUEPRINT-002)`,
        });
      }
    });
  });

  // INV-BLUEPRINT-003: every API operation maps to >= 1 RBAC permission.
  const resources = bp.api?.resources ?? [];
  const permissions = bp.auth?.rbac?.permissions ?? [];
  const grantsByAction = new Map<string, number>(); // action → count of roles granting
  let hasWildcard = false;
  let hasManage = false;
  for (const perm of permissions) {
    for (const allow of perm.allow) {
      if (allow === '*') hasWildcard = true;
      if (allow === 'manage') hasManage = true;
      grantsByAction.set(allow, (grantsByAction.get(allow) ?? 0) + 1);
    }
  }
  resources.forEach((resource, rIdx) => {
    const ops = resource.operations ?? [];
    ops.forEach((op, oIdx) => {
      const grantedDirectly = (grantsByAction.get(op) ?? 0) > 0;
      if (!grantedDirectly && !hasManage && !hasWildcard) {
        violations.push({
          invariant_id: 'INV-BLUEPRINT-003',
          severity: 'gate',
          pointer: `/api/resources/${String(rIdx)}/operations/${String(oIdx)}`,
          message: `operation '${op}' on resource '${resource.entity}' is declared but no rbac.permission grants it (need direct grant, 'manage' alias, or '*' wildcard)`,
        });
      }
    });
  });

  return { ok: violations.length === 0, violations };
}

export function blueprintSha256(bp: Blueprint): string {
  const canonical = canonicalJson(bp as unknown as Record<string, unknown>);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------
// Scaffold plan: deterministic preview of what scaffolders would emit.
// ---------------------------------------------------------------------

export interface ScaffoldPlanTask {
  readonly operation_id: string;
  readonly target_paths: readonly string[];
  readonly templates: readonly string[];
}

export interface ScaffoldPlanResult {
  readonly blueprint_id: string;
  readonly blueprint_version: string;
  readonly blueprint_sha256: string;
  readonly module_slug: string;
  readonly tasks: readonly ScaffoldPlanTask[];
}

/**
 * Emit a scaffold plan: per-operation target paths and template ids.
 * No file writes; pure data. The plan
 * is deterministic for a given (blueprint, version) pair — its sha
 * lines up with the scaffold-evidence's blueprint_sha256.
 */
export function planScaffoldFromBlueprint(bp: Blueprint): ScaffoldPlanResult {
  const ns = bp.module.namespace;
  const moduleKebab = toKebabSimple(bp.module.name);
  const moduleSlug = `${ns}-${moduleKebab}`;
  const tasks: ScaffoldPlanTask[] = [
    {
      operation_id: 'scaffold.db',
      target_paths: [`domain/${moduleSlug}/db/migration.sql`, `domain/${moduleSlug}/db/seed.sql`],
      templates: ['db.migration', 'db.seed'],
    },
    {
      operation_id: 'scaffold.api',
      target_paths: [
        `domain/${moduleSlug}/api/src/${moduleSlug}/${moduleSlug}.module.ts`,
        ...bp.database.entities.flatMap((e) => [
          `domain/${moduleSlug}/api/src/${moduleSlug}/controllers/${toKebabSimple(e.name)}.controller.ts`,
          `domain/${moduleSlug}/api/src/${moduleSlug}/services/${toKebabSimple(e.name)}.service.ts`,
          `domain/${moduleSlug}/api/src/${moduleSlug}/dto/create-${toKebabSimple(e.name)}.dto.ts`,
          `domain/${moduleSlug}/api/src/${moduleSlug}/dto/update-${toKebabSimple(e.name)}.dto.ts`,
        ]),
      ],
      templates: [
        'api.module',
        'api.controller',
        'api.service',
        'api.dto.create',
        'api.dto.update',
      ],
    },
    {
      operation_id: 'scaffold.ui',
      target_paths: [
        `domain/${moduleSlug}/web/src/app/${moduleSlug}/${moduleSlug}.module.ts`,
        ...bp.database.entities.flatMap((e) => [
          `domain/${moduleSlug}/web/src/app/${moduleSlug}/${toKebabSimple(e.name)}-list.component.ts`,
          `domain/${moduleSlug}/web/src/app/${moduleSlug}/${toKebabSimple(e.name)}-detail.component.ts`,
          `domain/${moduleSlug}/web/src/app/${moduleSlug}/${toKebabSimple(e.name)}.service.ts`,
        ]),
      ],
      templates: ['ui.module', 'ui.list-component', 'ui.detail-component', 'ui.service'],
    },
    {
      operation_id: 'scaffold.tests',
      target_paths: bp.database.entities.flatMap((e) => [
        `domain/${moduleSlug}/api/test/${toKebabSimple(e.name)}.controller.spec.ts`,
        `domain/${moduleSlug}/api/test/${toKebabSimple(e.name)}.service.spec.ts`,
      ]),
      templates: ['tests.controller-spec', 'tests.service-spec'],
    },
    {
      operation_id: 'scaffold.docs',
      target_paths: [
        `domain/${moduleSlug}/docs/README.md`,
        `domain/${moduleSlug}/docs/ADR-0001.md`,
      ],
      templates: ['docs.readme', 'docs.adr'],
    },
    {
      operation_id: 'scaffold.ci',
      target_paths: [`.github/workflows/module-${moduleSlug}.yml`],
      templates: ['ci.workflow'],
    },
  ];
  return {
    blueprint_id: bp.id,
    blueprint_version: bp.module.version,
    blueprint_sha256: blueprintSha256(bp),
    module_slug: moduleSlug,
    tasks,
  };
}
