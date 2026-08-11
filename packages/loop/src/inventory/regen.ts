import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { extractComponents } from './component-extractor.js';
import { extractDependencies } from './dependency-graph.js';
import { sha256Hex } from './id.js';
import { extractModules } from './module-extractor.js';
import { extractRoutes } from './route-extractor.js';
import { discoverSchemas } from './schemas-discoverer.js';
import { discoverTests } from './test-discoverer.js';
import { walkFiles } from './walker.js';

export interface RegenOptions {
  readonly repoRoot: string;
  /** ISO-8601 timestamp to embed in `generated_at`. Tests pin this for determinism. */
  readonly timestamp: string;
  /**
   * Integration head SHA (typically `git rev-parse HEAD`). Required: the
   * inventory schema does not accept null. Use `'0'.repeat(40)` as a
   * sentinel when no real git head is available.
   */
  readonly integrationHead: string;
  /**
   * Files to checksum into the `checksums` map. Defaults to the F5
   * governance set: the root constitutional/session files, generated
   * governance register inputs under law/, and the public schemas.
   */
  readonly checksumPaths?: readonly string[];
  /** Forwarded to every extractor; see walker WalkOptions. */
  readonly ignoreDirs?: ReadonlySet<string>;
}

/**
 * InventoryRecord carries
 * per-surface `{id, file}` metadata so `computeReverseAdherence`
 * can read it. Pre-22.G, `modules` was `readonly string[]` and
 * `routes` carried `{method, path, module}` only — neither had
 * the `{id, file}` shape adherence-reverse needs, so the audit
 * reported 0 surfaces against any inventory.
 */
export interface InventoryRecord {
  readonly schemaVersion: '1.0.0';
  readonly generated_at: string;
  readonly integration_head: string;
  readonly modules: readonly { id: string; file: string }[];
  readonly routes: readonly {
    method: string;
    path: string;
    module: string;
    protected?: boolean;
    id: string;
    file: string;
  }[];
  readonly schemas: readonly { kind: string; name: string; path?: string }[];
  readonly components: readonly {
    kind: string;
    name: string;
    module: string;
    path?: string;
    id: string;
    file: string;
  }[];
  readonly test_inventory: readonly {
    path: string;
    suite: string;
    invariants: readonly string[];
  }[];
  /**
   * Per-node dependency-graph surface
   * entries. Each entry carries `{id: DEP-<hash8>, file:
   * <source path>}` so `computeReverseAdherence` can read the
   * dependency surface with the same shape as the other three
   * surface kinds.
   */
  readonly dependency_graph: readonly { id: string; file: string }[];
  readonly dependency_graph_hash: string;
  readonly checksums: Record<string, string>;
}

const DEFAULT_GOVERNANCE_FILES = [
  'law/constitution.md',
  'law/register/DECISIONS.md',
  'law/register/REJECTIONS.md',
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
];

export async function regenerateInventory(opts: RegenOptions): Promise<InventoryRecord> {
  const { repoRoot, timestamp, integrationHead, ignoreDirs } = opts;
  const modulesArr = extractModules({ repoRoot, ignoreDirs });
  const routesArr = extractRoutes({ repoRoot, ignoreDirs });
  const componentsArr = extractComponents({ repoRoot, ignoreDirs });
  const schemasArr = await discoverSchemas({ repoRoot, ignoreDirs });
  const testsArr = discoverTests({ repoRoot, ignoreDirs });
  const depGraph = extractDependencies({ repoRoot, ignoreDirs });

  const checksumPaths = computeChecksumPaths(repoRoot, opts.checksumPaths);
  const checksums = computeChecksums(repoRoot, checksumPaths);

  // Derive per-route, per-component, and
  // per-dependency-node ids so adherence-reverse can read the
  // {id, file} surface tuples.
  return {
    schemaVersion: '1.0.0',
    generated_at: timestamp,
    integration_head: integrationHead,
    modules: modulesArr.map((m) => ({ id: m.id, file: m.path })),
    routes: routesArr.map((r) => ({
      method: r.method,
      path: r.path,
      module: r.module,
      ...(r.protected === true && { protected: true }),
      id: routeId(r.method, r.path, r.module),
      file: routeFile(r.module, modulesArr),
    })),
    schemas: schemasArr.map((s) => ({
      kind: s.kind,
      name: s.name,
      ...(s.path !== undefined && { path: s.path }),
    })),
    components: componentsArr.map((c) => ({
      kind: c.kind,
      name: c.name,
      module: c.module,
      path: c.path,
      id: componentId(c.kind, c.name, c.module),
      file: c.path,
    })),
    test_inventory: testsArr.map((t) => ({
      path: t.path,
      suite: t.suite,
      invariants: t.invariants,
    })),
    dependency_graph: depGraph.nodes.map((node) => ({
      id: dependencyId(node),
      file: node,
    })),
    dependency_graph_hash: depGraph.hash,
    checksums,
  };
}

/**
 * Stable derived id for a per-route surface
 * entry. The route extractor doesn't synthesize ids by default;
 * computeReverseAdherence reads `route.id`, so we derive a
 * deterministic id from the (method, path, module) triple.
 */
function routeId(method: string, path: string, module: string): string {
  const seed = `${method.toUpperCase()}|${path}|${module}`;
  return `ROUTE-${createHash('sha256').update(seed).digest('hex').slice(0, 8)}`;
}

/**
 * Map a route's `module` MOD-id back to the module's source file
 * path. The route extractor records the owning module but not
 * the source file the route was declared in; for adherence-reverse
 * purposes the module's file is the closest sensible attribution
 * (the module's @Controller declaration is where the route lives
 * in NestJS).
 */
function routeFile(
  moduleId: string,
  modulesArr: ReadonlyArray<{ id: string; path: string }>,
): string {
  const found = modulesArr.find((m) => m.id === moduleId);
  return found?.path ?? '';
}

/**
 * Stable derived id for a per-component
 * surface entry. Derived from (kind, name, module) so two
 * components with the same name in different modules don't
 * collide.
 */
function componentId(kind: string, name: string, module: string): string {
  const seed = `${kind}|${name}|${module}`;
  return `COMP-${createHash('sha256').update(seed).digest('hex').slice(0, 8)}`;
}

/**
 * Stable derived id for a per-dependency-
 * graph-node surface entry. Each node is a source file path; the
 * id is `DEP-<sha256_hex_8>` derived from the path so the same
 * file regenerated across runs produces the same id.
 */
function dependencyId(filePath: string): string {
  return `DEP-${createHash('sha256').update(filePath).digest('hex').slice(0, 8)}`;
}

function computeChecksumPaths(repoRoot: string, override?: readonly string[]): readonly string[] {
  if (override !== undefined) return override;
  const paths: string[] = [];
  for (const name of DEFAULT_GOVERNANCE_FILES) {
    const p = join(repoRoot, name);
    if (existsSync(p)) paths.push(p);
  }
  const schemasDir = join(repoRoot, 'law/schemas');
  if (existsSync(schemasDir)) {
    for (const f of walkFiles(schemasDir, { extensions: ['.schema.json'] })) {
      paths.push(f);
    }
  }
  return paths;
}

function computeChecksums(repoRoot: string, paths: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of paths) {
    try {
      const text = readFileSync(p, 'utf8');
      const rel = relative(repoRoot, p);
      out[rel] = sha256Hex(text);
    } catch {
      // Skip unreadable file.
    }
  }
  // Stable insertion order via sorted keys.
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(out).sort()) {
    sorted[k] = out[k] ?? '';
  }
  return sorted;
}
