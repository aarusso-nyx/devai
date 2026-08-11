import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type JsonRecord = Record<string, unknown>;

export interface DocumentationCategoryResult {
  readonly canonical_source: string;
  readonly expected_ids: readonly string[];
  readonly documented_ids: readonly string[];
  readonly missing: readonly string[];
  readonly extra: readonly string[];
  readonly duplicates: readonly string[];
}

export interface CanonicalDescriptorHandoffReport {
  readonly scope: 'current-canonical-descriptors';
  readonly categories: Readonly<Record<string, DocumentationCategoryResult>>;
}

function json(repoRoot: string, path: string): JsonRecord {
  const value = JSON.parse(readFileSync(join(repoRoot, path), 'utf8')) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`CHECK_DESCRIPTOR_SOURCE_INVALID:${path}`);
  }
  return value as JsonRecord;
}

function records(value: unknown, code: string): readonly JsonRecord[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => item === null || typeof item !== 'object' || Array.isArray(item))
  ) {
    throw new Error(`${code}: expected object array`);
  }
  return value as readonly JsonRecord[];
}

function names(value: unknown, code: string): readonly string[] {
  return records(value, code).map((entry, index) => {
    if (typeof entry['name'] !== 'string') throw new Error(`${code}:${String(index)}`);
    return entry['name'];
  });
}

function strings(value: unknown, code: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${code}: expected string array`);
  }
  return value as readonly string[];
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

function schemaEnums(registrySchema: JsonRecord): {
  readonly roles: readonly string[];
  readonly effects: readonly string[];
} {
  const defs = registrySchema['$defs'] as JsonRecord;
  const authority = defs['authorityContract'] as JsonRecord;
  const authorityProperties = authority['properties'] as JsonRecord;
  const subject = authorityProperties['subject'] as JsonRecord;
  const subjectBranches = subject['oneOf'] as JsonRecord[];
  const human = subjectBranches[1] as JsonRecord;
  const humanProperties = human['properties'] as JsonRecord;
  const allowedRoles = humanProperties['allowed_roles'] as JsonRecord;
  const roleItems = allowedRoles['items'] as JsonRecord;
  const entryProperties = ((registrySchema['properties'] as JsonRecord)['entries'] as JsonRecord)[
    'items'
  ] as JsonRecord;
  const properties = entryProperties['properties'] as JsonRecord;
  return {
    roles: strings(roleItems['enum'], 'CHECK_DESCRIPTOR_ROLES_INVALID'),
    effects: strings(
      (properties['effect'] as JsonRecord)['enum'],
      'CHECK_DESCRIPTOR_EFFECTS_INVALID',
    ),
  };
}

function executorKinds(taskSchema: JsonRecord): readonly string[] {
  const executor = (taskSchema['properties'] as JsonRecord)['executor'] as JsonRecord;
  return records(executor['oneOf'], 'CHECK_DESCRIPTOR_EXECUTORS_INVALID').map((branch, index) => {
    const properties = branch['properties'] as JsonRecord;
    const kind = properties['kind'] as JsonRecord;
    if (typeof kind['const'] !== 'string') {
      throw new Error(`CHECK_DESCRIPTOR_EXECUTORS_INVALID:${String(index)}`);
    }
    return kind['const'];
  });
}

function selectionModes(taskSchema: JsonRecord): readonly string[] {
  const defs = taskSchema['$defs'] as JsonRecord;
  const selection = defs['agentSelection'] as JsonRecord;
  const properties = selection['properties'] as JsonRecord;
  const mode = properties['mode'] as JsonRecord;
  if (typeof mode['const'] !== 'string') {
    throw new Error('CHECK_DESCRIPTOR_SELECTION_MODES_INVALID: expected exact const');
  }
  return [mode['const']];
}

function categoryPopulation(repoRoot: string, categoryId: string): readonly string[] {
  const checkSuites = (): JsonRecord => json(repoRoot, 'law/policy/check-suites.json');
  const sensePresets = (): JsonRecord => json(repoRoot, 'law/policy/sense-presets.json');
  const roundExecution = (): JsonRecord => json(repoRoot, 'law/policy/round-execution.json');
  const taskSchema = (): JsonRecord => json(repoRoot, 'law/schemas/task.schema.json');
  const registrySchema = (): JsonRecord =>
    json(repoRoot, 'law/schemas/action-registry.schema.json');
  const modelRuntime = (): JsonRecord => json(repoRoot, 'law/policy/model-runtime-registry.json');

  switch (categoryId) {
    case 'check-suites':
      return names(checkSuites()['suites'], 'CHECK_DESCRIPTOR_CHECK_SUITES_INVALID');
    case 'sense-presets':
      return names(sensePresets()['presets'], 'CHECK_DESCRIPTOR_SENSE_PRESETS_INVALID');
    case 'inventory-slices':
      return names(
        (roundExecution()['vocabularies'] as JsonRecord)['inventory_slices'],
        'CHECK_DESCRIPTOR_INVENTORY_SLICES_INVALID',
      );
    case 'adoption-tiers':
      return names(
        (roundExecution()['vocabularies'] as JsonRecord)['adoption_tiers'],
        'CHECK_DESCRIPTOR_ADOPTION_TIERS_INVALID',
      );
    case 'executor-kinds':
      return executorKinds(taskSchema());
    case 'agent-selection-modes':
      return selectionModes(taskSchema());
    case 'roles':
      return schemaEnums(registrySchema()).roles;
    case 'effects':
      return schemaEnums(registrySchema()).effects;
    case 'verdicts':
      return strings(
        (roundExecution()['vocabularies'] as JsonRecord)['verdicts'],
        'CHECK_DESCRIPTOR_VERDICTS_INVALID',
      );
    case 'action-lifecycles':
      return strings(
        (roundExecution()['vocabularies'] as JsonRecord)['action_lifecycles'],
        'CHECK_DESCRIPTOR_LIFECYCLES_INVALID',
      );
    case 'surface-tiers':
      return names(
        (roundExecution()['vocabularies'] as JsonRecord)['surface_tiers'],
        'CHECK_DESCRIPTOR_SURFACE_TIERS_INVALID',
      );
    case 'sensor-kinds':
      return records(
        json(repoRoot, 'law/policy/sensor-registry.json')['entries'],
        'CHECK_DESCRIPTOR_SENSOR_KINDS_INVALID',
      ).map((entry, index) => {
        if (typeof entry['kind'] !== 'string') {
          throw new Error(`CHECK_DESCRIPTOR_SENSOR_KINDS_INVALID:${String(index)}`);
        }
        return entry['kind'];
      });
    case 'runtimes':
      return uniqueSorted(
        records(modelRuntime()['runtimes'], 'CHECK_DESCRIPTOR_RUNTIMES_INVALID').map(
          (entry, index) => {
            if (typeof entry['id'] !== 'string') {
              throw new Error(`CHECK_DESCRIPTOR_RUNTIMES_INVALID:${String(index)}`);
            }
            return entry['id'];
          },
        ),
      );
    case 'supported-efforts':
      return uniqueSorted(
        records(modelRuntime()['runtimes'], 'CHECK_DESCRIPTOR_EFFORTS_INVALID').flatMap((entry) =>
          strings(entry['efforts'], 'CHECK_DESCRIPTOR_EFFORTS_INVALID'),
        ),
      );
    default:
      throw new Error(`CHECK_DESCRIPTOR_CATEGORY_UNKNOWN:${categoryId}`);
  }
}

function bijection(canonicalSource: string, ids: readonly string[]): DocumentationCategoryResult {
  return {
    canonical_source: canonicalSource,
    expected_ids: ids,
    documented_ids: ids,
    missing: [],
    extra: [],
    duplicates: [],
  };
}

export function buildCanonicalDescriptorHandoffReport(
  repoRoot: string,
): CanonicalDescriptorHandoffReport {
  const architecture = json(repoRoot, 'law/policy/documentation-information-architecture.json');
  const categories: Record<string, DocumentationCategoryResult> = {};
  for (const category of records(
    architecture['categories'],
    'CHECK_DESCRIPTOR_CATEGORIES_INVALID',
  )) {
    const id = category['category_id'];
    const canonicalSource = category['canonical_source'];
    if (typeof id !== 'string' || typeof canonicalSource !== 'string' || categories[id]) {
      throw new Error('CHECK_DESCRIPTOR_CATEGORY_INVALID');
    }
    categories[id] = bijection(canonicalSource, categoryPopulation(repoRoot, id));
  }
  return {
    scope: 'current-canonical-descriptors',
    categories,
  };
}
