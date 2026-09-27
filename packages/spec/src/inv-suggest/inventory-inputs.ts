import { readFileSync } from '@devai-nyx/authority';

export const DEFAULT_COVERAGE = '.devai/state/sensors/inventory_coverage/coverage-matrix.json';
export const DEFAULT_DATA_HANDLING =
  '.devai/state/sensors/inventory_data_handling/data-model-pii.json';
export const DEFAULT_DEP_GRAPH = '.devai/state/sensors/inventory_dep_graph/dep-graph.json';
export const DEFAULT_RBAC = '.devai/state/sensors/inventory_rbac/rbac.json';
export const DEFAULT_OUT_DIR = '.devai/state/inv-candidates';

type InventoryKind = 'coverage' | 'rbac' | 'data-handling' | 'dep-graph';

function inventoryObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function inventoryList(value: unknown, accepts: (entry: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(accepts);
}
function inventoryString(value: unknown): boolean {
  return typeof value === 'string';
}
function optionalInventoryField(
  value: Record<string, unknown>,
  key: string,
  accepts: (entry: unknown) => boolean,
): boolean {
  return value[key] === undefined || accepts(value[key]);
}

// Validate the consumed projection, preserving richer sensor metadata and both
// current and legacy body shapes. Invalid inventory is unavailable evidence,
// never proof that a previously surfaced target has disappeared.
function validInventoryBody(value: unknown, kind: InventoryKind): boolean {
  if (!inventoryObject(value)) return false;
  const strings = (entry: unknown) => inventoryList(entry, inventoryString);
  const optional = optionalInventoryField;
  if (kind === 'coverage') {
    return optional(
      value,
      'unmapped',
      (entry) =>
        inventoryObject(entry) &&
        optional(entry, 'routes', strings) &&
        optional(entry, 'endpoints', strings),
    );
  }
  if (kind === 'rbac') {
    return (
      optional(
        value,
        'unmapped',
        (entry) => inventoryObject(entry) && optional(entry, 'endpointsWithoutRole', strings),
      ) &&
      optional(value, 'endpointsWithoutRole', (entry) =>
        inventoryList(entry, (row) => inventoryObject(row) && optional(row, 'id', inventoryString)),
      )
    );
  }
  if (kind === 'data-handling') {
    return (
      optional(value, 'tables', (entry) =>
        inventoryList(
          entry,
          (table) =>
            inventoryObject(table) &&
            inventoryString(table['name']) &&
            inventoryList(
              table['columns'],
              (column) =>
                inventoryObject(column) &&
                inventoryString(column['name']) &&
                optional(column, 'pii_class', inventoryString) &&
                optional(column, 'legal_basis', inventoryString) &&
                optional(column, 'retention', inventoryString),
            ) &&
            optional(table, 'evidence', (evidence) =>
              inventoryList(
                evidence,
                (row) =>
                  inventoryObject(row) &&
                  inventoryString(row['path']) &&
                  Number.isInteger(row['startLine']) &&
                  Number.isInteger(row['endLine']),
              ),
            ),
        ),
      ) &&
      optional(value, 'pii', (entry) =>
        inventoryList(
          entry,
          (row) =>
            inventoryObject(row) &&
            optional(row, 'table', inventoryString) &&
            optional(row, 'column', inventoryString),
        ),
      )
    );
  }
  return (
    optional(
      value,
      'graph',
      (entry) => inventoryObject(entry) && Object.values(entry).every(strings),
    ) &&
    optional(value, 'forbiddenEdges', (entry) =>
      inventoryList(
        entry,
        (row) =>
          inventoryObject(row) &&
          optional(row, 'from', inventoryString) &&
          optional(row, 'to', inventoryString),
      ),
    )
  );
}

export function readJson<T>(path: string, kind: InventoryKind): T | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return validInventoryBody(value, kind) ? (value as T) : null;
  } catch {
    return null;
  }
}
