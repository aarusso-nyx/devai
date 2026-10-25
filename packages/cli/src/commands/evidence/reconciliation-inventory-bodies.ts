import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { ReconciliationPlan } from '@devai-nyx/authority';
import { getValidator } from '@devai-nyx/schemas';
import { canonicalJson } from '@devai-nyx/utils';
import {
  senseInventoryApi,
  senseInventoryRoutes,
  senseInventoryDataModel,
  senseInventoryDataHandling,
  senseInventoryRbac,
  senseInventoryDepGraph,
  senseInventoryCoverage,
  type InventorySourceReader,
} from '@devai-nyx/sensors';
import {
  resolveInventoryDataModelInputs,
  resolveInventoryRouteInputs,
} from '../sense/inventory-inputs.js';
import { resolveDeclaredSensorInputs } from '../sense/shared.js';

const sha = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
function fail(): never {
  throw new Error('RECONCILIATION_INVENTORY_SOURCE_INVALID');
}

/** Pure staged byte namespace. Symlinks are metadata and cannot become producer inputs. */
export function createReconciliationInventoryReader(
  root: string,
  plan: ReconciliationPlan,
  blobs: ReadonlyMap<string, Uint8Array>,
): InventorySourceReader {
  if (
    !isAbsolute(root) ||
    root !== resolve(root) ||
    sha(canonicalJson(plan.source_manifest)) !== plan.source_manifest_sha256 ||
    sha(canonicalJson(plan.effect_plan)) !== plan.effect_plan_sha256
  )
    fail();
  const entries = plan.source_manifest.index.entries.filter(
    (entry) =>
      entry.stage === 0 &&
      !plan.effect_plan.inventory.excluded_paths.includes(
        entry.path as 'record/proofs/chain.json' | 'law/security/authorization.json',
      ),
  );
  const projection = entries.map((entry) => ({
    assume_valid: entry.assume_valid,
    mode: entry.mode,
    oid: entry.oid,
    path: entry.path,
    stage: entry.stage,
  }));
  if (
    sha(JSON.stringify(projection)) !== plan.effect_plan.inventory.source_sha256 ||
    entries.length > 100000
  )
    fail();
  const files = new Map<string, { mode: string; bytes: Buffer }>(),
    directories = new Map<string, Map<string, 'file' | 'directory'>>([[root, new Map()]]);
  let total = 0;
  const staged = new Map(
    plan.source_manifest.staged_files
      .filter((file) => file.stage === 0)
      .map((file) => [file.path, file]),
  );
  for (const entry of entries) {
    if (
      !entry.path ||
      entry.path.includes('\\') ||
      entry.path.includes('\0') ||
      entry.path
        .split('/')
        .some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
    )
      fail();
    const supplied = blobs.get(entry.oid),
      descriptor = staged.get(entry.path);
    if (
      !supplied ||
      !descriptor ||
      descriptor.mode !== entry.mode ||
      descriptor.blob_oid !== entry.oid ||
      supplied.byteLength > 33554432
    )
      fail();
    const bytes = Buffer.from(supplied);
    total += bytes.length;
    if (
      total > 536870912 ||
      bytes.length !== descriptor.bytes ||
      sha(bytes) !== descriptor.sha256 ||
      createHash(plan.identity.object_format)
        .update(`blob ${String(bytes.length)}\0`)
        .update(bytes)
        .digest('hex') !== entry.oid
    )
      fail();
    const path = join(root, entry.path);
    if (files.has(path)) fail();
    files.set(path, { mode: entry.mode, bytes });
    const parts = entry.path.split('/');
    let directory = root;
    for (const [index, name] of parts.entries()) {
      const kind = index === parts.length - 1 ? 'file' : 'directory';
      const children = directories.get(directory);
      if (!children || (children.has(name) && children.get(name) !== kind)) fail();
      children.set(name, kind);
      if (kind === 'directory') {
        directory = join(directory, name);
        if (!directories.has(directory)) directories.set(directory, new Map());
      }
    }
  }
  const inside = (path: string): void => {
    const rel = relative(root, path);
    if (!isAbsolute(path) || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) fail();
  };
  return Object.freeze({
    readFile(path: string): string {
      inside(path);
      const file = files.get(path);
      if (!file || !['100644', '100755'].includes(file.mode)) fail();
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes);
    },
    listDirectory(path: string) {
      inside(path);
      const children = directories.get(path);
      if (!children) fail();
      return Object.freeze(
        [...children]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, kind]) => Object.freeze({ name, kind })),
      );
    },
    exists(path: string): boolean {
      inside(path);
      return files.has(path) || directories.has(path);
    },
    isDirectory(path: string): boolean {
      inside(path);
      return directories.has(path);
    },
  });
}

/** Existing seven native producers, immutable staged inputs and explicit body dependencies only. */
export function buildReconciliationInventoryBodies(
  root: string,
  plan: ReconciliationPlan,
  blobs: ReadonlyMap<string, Uint8Array>,
  now: string,
) {
  if (!Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now) fail();
  const base = createReconciliationInventoryReader(root, plan, blobs),
    overlay = new Map<string, string>();
  const sourceReader: InventorySourceReader = Object.freeze({
    readFile: (path: string) => overlay.get(path) ?? base.readFile(path),
    listDirectory: (path: string) => base.listDirectory(path),
    exists: (path: string) => overlay.has(path) || base.exists(path),
    isDirectory: (path: string) => base.isDirectory(path),
  });
  const common = { repoRoot: root, sourceReader, now, persistBody: false };
  const declared = (sensorKind: string) =>
    resolveDeclaredSensorInputs({ repoRoot: root, sensorKind, sourceReader });
  const outputs: { path: string; schema: string; sha256: string; bytes: number; text: string }[] =
    [];
  const emit = (
    index: number,
    produced: { reading: { status: string }; body: unknown },
  ): string => {
    if (produced.reading.status === 'error') fail();
    const body = produced.body;
    const descriptor = plan.effect_plan.inventory.outputs[index];
    if (!descriptor || !getValidator(descriptor.schema)(body)) fail();
    const text = `${canonicalJson(body)}\n`,
      bytes = Buffer.byteLength(text);
    if (bytes > plan.effect_plan.inventory.body_bytes_limit) fail();
    const result = Object.freeze({
      path: descriptor.path,
      schema: descriptor.schema,
      sha256: sha(text),
      bytes,
      text,
    });
    outputs.push(result);
    const path = join(root, descriptor.path);
    overlay.set(path, text);
    return path;
  };
  const api = emit(0, senseInventoryApi({ ...declared('inventory_api'), ...common }));
  const routesOptions = resolveInventoryRouteInputs(root, undefined, sourceReader);
  if (
    routesOptions.framework !== undefined &&
    routesOptions.framework !== plan.effect_plan.inventory.routes_framework
  )
    fail();
  const routes = emit(
    1,
    senseInventoryRoutes({
      ...declared('inventory_routes'),
      ...routesOptions,
      ...common,
      framework: plan.effect_plan.inventory.routes_framework,
    }),
  );
  const model = emit(
    2,
    senseInventoryDataModel({
      ...declared('inventory_data_model'),
      ...resolveInventoryDataModelInputs(root, undefined, sourceReader),
      ...common,
    }),
  );
  emit(
    3,
    senseInventoryDataHandling({
      ...declared('inventory_data_handling'),
      ...common,
      dataModelPath: model,
    }),
  );
  emit(
    4,
    senseInventoryRbac({
      ...declared('inventory_rbac'),
      ...common,
      dataModelPath: model,
      apiMapPath: api,
    }),
  );
  emit(5, senseInventoryDepGraph({ ...declared('inventory_dep_graph'), ...common }));
  emit(
    6,
    senseInventoryCoverage({
      ...declared('inventory_coverage'),
      ...common,
      apiMapPath: api,
      routesPath: routes,
      framework: plan.effect_plan.inventory.routes_framework,
    }),
  );
  if (
    outputs.length !== 7 ||
    outputs.reduce((sum, output) => sum + output.bytes, 0) >
      plan.effect_plan.inventory.aggregate_bytes_limit
  )
    fail();
  return Object.freeze({
    kind: 'reconciliation-inventory-byte-plan',
    phase: '04',
    source_sha256: plan.effect_plan.inventory.source_sha256,
    outputs: Object.freeze(outputs),
    outputs_manifest_sha256: sha(
      canonicalJson({
        schemaVersion: '1.0.0',
        kind: 'reconciliation-domain-outputs',
        phase: '04',
        outputs: outputs.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })),
      }),
    ),
    grants_authority: false,
    publishes_readings: false,
    grants_readiness: false,
  });
}
