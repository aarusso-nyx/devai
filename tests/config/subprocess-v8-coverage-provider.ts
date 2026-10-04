import { existsSync, promises } from 'node:fs';
import { resolve } from 'node:path';
import v8Module from '@vitest/coverage-v8';
import { V8CoverageProvider } from '@vitest/coverage-v8/dist/provider.js';
import { mergeProcessCovs } from '@bcoe/v8-coverage';
import type { Profiler } from 'node:inspector';
import type { CoverageProviderModule, ReportContext } from 'vitest/node';

const subprocessCoverageDirectory = resolve('scratch/coverage/rc-child-v8');
const subprocessCoverageEvidenceDirectory = resolve('scratch/coverage/rc/subprocess-v8');

interface ProcessCoverage {
  readonly result: Array<Profiler.ScriptCoverage & { startOffset?: number }>;
}

interface Position {
  readonly line?: number;
  readonly column?: number;
}

interface Location {
  readonly start: Position;
  readonly end: Position;
}

interface FunctionMapping {
  readonly decl: Location;
  readonly loc: Location;
}

interface BranchMapping {
  readonly loc?: Location;
  readonly locations: readonly Location[];
}

interface FileCoverageData {
  readonly statementMap: Readonly<Record<string, Location>>;
  readonly fnMap: Readonly<Record<string, FunctionMapping>>;
  readonly branchMap: Readonly<Record<string, BranchMapping>>;
  readonly s: Record<string, number>;
  readonly f: Record<string, number>;
  readonly b: Record<string, number[]>;
}

interface MutableCoverageMap {
  files(): string[];
  fileCoverageFor(filename: string): { toJSON(): object };
  addFileCoverage(coverage: FileCoverageData): void;
  filter(callback: (filename: string) => boolean): void;
}

function locationKey(location: Location): string | undefined {
  const positions = [
    location.start.line,
    location.start.column,
    location.end.line,
    location.end.column,
  ];
  if (!positions.every((position) => Number.isInteger(position))) return undefined;
  return positions.join(':');
}

function exactLocationHits(
  kind: 'statement' | 'function' | 'branch',
  mapName: 'parent' | 'subprocess',
  entries: ReadonlyArray<readonly [Location, number]>,
): Map<string, number> {
  const hits = new Map<string, number>();
  for (const [location, count] of entries) {
    const key = locationKey(location);
    if (key === undefined) continue;
    if (hits.has(key)) {
      if (mapName === 'parent') {
        throw new Error(`duplicate exact ${kind} location ${key} in ${mapName} coverage map`);
      }
      hits.set(key, (hits.get(key) ?? 0) + count);
      continue;
    }
    hits.set(key, count);
  }
  return hits;
}

function statementLocationHits(
  coverage: FileCoverageData,
  mapName: 'parent' | 'subprocess',
): Map<string, number> {
  return exactLocationHits(
    'statement',
    mapName,
    Object.entries(coverage.statementMap).map(([id, location]) => [location, coverage.s[id] ?? 0]),
  );
}

function functionLocationHits(
  coverage: FileCoverageData,
  mapName: 'parent' | 'subprocess',
): Map<string, number> {
  return exactLocationHits(
    'function',
    mapName,
    Object.entries(coverage.fnMap).map(([id, definition]) => [
      definition.decl,
      coverage.f[id] ?? 0,
    ]),
  );
}

function branchLocationHits(
  coverage: FileCoverageData,
  mapName: 'parent' | 'subprocess',
): Map<string, number> {
  return exactLocationHits(
    'branch',
    mapName,
    Object.entries(coverage.branchMap).flatMap(([id, definition]) =>
      definition.locations.map(
        (location, index) => [location, coverage.b[id]?.[index] ?? 0] as const,
      ),
    ),
  );
}

/**
 * The parent owner of every exact branch location. V8 source maps of a module that awaits a
 * dynamic import can report one expression as two branch entries with the same overall loc
 * that share an operand location; that operand is one counter, owned by its first entry. Any
 * other repeated location stays ambiguous and is refused.
 */
function parentBranchOwners(
  coverage: FileCoverageData,
): Map<string, { readonly id: string; readonly index: number }> {
  const owners = new Map<string, { readonly id: string; readonly index: number }>();
  for (const [id, definition] of Object.entries(coverage.branchMap)) {
    for (const [index, location] of definition.locations.entries()) {
      const key = locationKey(location);
      if (key === undefined) continue;
      const owner = owners.get(key);
      if (owner === undefined) {
        owners.set(key, { id, index });
        continue;
      }
      const ownerLoc = coverage.branchMap[owner.id]?.loc;
      const sameExpression =
        owner.id !== id &&
        ownerLoc !== undefined &&
        definition.loc !== undefined &&
        locationKey(ownerLoc) !== undefined &&
        locationKey(ownerLoc) === locationKey(definition.loc);
      if (!sameExpression) {
        throw new Error(`duplicate exact branch location ${key} in parent coverage map`);
      }
    }
  }
  return owners;
}

export function mergeCanonicalHits(
  coverageMap: MutableCoverageMap,
  subprocessMap: MutableCoverageMap,
): void {
  for (const filename of coverageMap.files()) {
    const current = coverageMap.fileCoverageFor(filename).toJSON() as FileCoverageData;
    try {
      statementLocationHits(current, 'parent');
      functionLocationHits(current, 'parent');
      parentBranchOwners(current);
    } catch (error) {
      // Name the source file: the location alone cannot be traced back after a full run.
      throw new Error(`${(error as Error).message}: ${filename}`, { cause: error });
    }
  }

  for (const filename of subprocessMap.files()) {
    if (!coverageMap.files().includes(filename)) continue;
    const candidate = subprocessMap.fileCoverageFor(filename).toJSON() as FileCoverageData;
    const current = coverageMap.fileCoverageFor(filename).toJSON() as FileCoverageData;

    const statementHits = statementLocationHits(candidate, 'subprocess');
    const functionHits = functionLocationHits(candidate, 'subprocess');
    const branchHits = branchLocationHits(candidate, 'subprocess');

    for (const [id, location] of Object.entries(current.statementMap)) {
      const key = locationKey(location);
      const count = key === undefined ? undefined : statementHits.get(key);
      if (count !== undefined) current.s[id] = (current.s[id] ?? 0) + count;
    }

    for (const [id, definition] of Object.entries(current.fnMap)) {
      const key = locationKey(definition.decl);
      const count = key === undefined ? undefined : functionHits.get(key);
      if (count !== undefined) current.f[id] = (current.f[id] ?? 0) + count;
    }

    const owners = parentBranchOwners(current);
    for (const [key, count] of branchHits) {
      const owner = owners.get(key);
      const counts = owner === undefined ? undefined : current.b[owner.id];
      if (owner !== undefined && counts !== undefined) {
        counts[owner.index] = (counts[owner.index] ?? 0) + count;
      }
    }
  }
}

export async function retainSubprocessCoverageInputs(
  sourceDirectory = subprocessCoverageDirectory,
  evidenceDirectory = subprocessCoverageEvidenceDirectory,
): Promise<number> {
  await promises.rm(evidenceDirectory, { recursive: true, force: true });
  if (!existsSync(sourceDirectory)) return 0;
  await promises.cp(sourceDirectory, evidenceDirectory, { recursive: true });
  return (await promises.readdir(evidenceDirectory)).filter((name) => name.endsWith('.json'))
    .length;
}

/**
 * Vitest's worker profiler does not observe spawned CLI processes.
 * NODE_V8_COVERAGE records those exact executions. This provider folds
 * the resulting V8 process records into the same source-mapped coverage map so
 * the merged gate measures every lane it runs, rather than only parent workers.
 */
class SubprocessV8CoverageProvider extends V8CoverageProvider {
  override async clean(clean = true): Promise<void> {
    await super.clean(clean);
    if (clean) {
      await promises.rm(subprocessCoverageDirectory, { recursive: true, force: true });
    }
    await promises.mkdir(subprocessCoverageDirectory, { recursive: true });
  }

  override isIncluded(filename: string, root?: string): boolean {
    if (/\/packages\/[^/]+\/dist\/.*\.js$/u.test(filename)) return true;
    return super.isIncluded(filename, root);
  }

  override generateCoverage(
    ...args: Parameters<V8CoverageProvider['generateCoverage']>
  ): ReturnType<V8CoverageProvider['generateCoverage']> {
    return this.generateMergedCoverage(...args) as ReturnType<
      V8CoverageProvider['generateCoverage']
    >;
  }

  private async generateMergedCoverage(context: ReportContext): Promise<unknown> {
    const coverageMap = (await super.generateCoverage(context)) as unknown as MutableCoverageMap;
    try {
      if (!existsSync(subprocessCoverageDirectory)) return coverageMap;

      const subprocessCoverages: ProcessCoverage[] = [];
      for (const name of await promises.readdir(subprocessCoverageDirectory)) {
        if (!name.endsWith('.json')) continue;
        let raw: ProcessCoverage;
        try {
          raw = JSON.parse(
            await promises.readFile(resolve(subprocessCoverageDirectory, name), 'utf8'),
          ) as ProcessCoverage;
        } catch (error) {
          throw new Error(`malformed subprocess coverage input ${name}: ${String(error)}`);
        }
        if (!Array.isArray(raw.result)) {
          throw new Error(`malformed subprocess coverage input ${name}: result is not an array`);
        }
        subprocessCoverages.push(raw);
      }
      if (subprocessCoverages.length === 0) return coverageMap;

      const provider = this as unknown as {
        convertCoverage(
          coverage: ProcessCoverage,
          project?: unknown,
          environment?: string,
        ): Promise<unknown>;
      };
      const merged = mergeProcessCovs(subprocessCoverages) as ProcessCoverage;
      merged.result.splice(
        0,
        merged.result.length,
        ...merged.result.filter((result) => result.url.startsWith('file://')),
      );
      for (const result of merged.result) result.startOffset ??= 0;
      const subprocessMap = (await provider.convertCoverage(merged)) as MutableCoverageMap;
      mergeCanonicalHits(coverageMap, subprocessMap);
      return coverageMap;
    } finally {
      coverageMap.filter((filename) => super.isIncluded(filename));
      await retainSubprocessCoverageInputs();
      await promises.rm(subprocessCoverageDirectory, { recursive: true, force: true });
    }
  }
}

// pnpm exposes the provider's bundled Vitest type instance separately from the
// workspace Vitest type instance. The runtime interface is the same module contract.
const providerModule = {
  ...v8Module,
  getProvider: () => new SubprocessV8CoverageProvider(),
} as unknown as CoverageProviderModule;

export default providerModule;
