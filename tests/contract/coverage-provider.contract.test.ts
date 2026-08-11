import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const FILE = '/fixture/source.ts';

interface Position {
  readonly line: number;
  readonly column: number;
}

interface Location {
  readonly start: Position;
  readonly end: Position;
}

interface CoverageData {
  readonly path: string;
  readonly statementMap: Record<string, Location>;
  readonly fnMap: Record<string, { decl: Location; loc: Location }>;
  readonly branchMap: Record<string, { locations: Location[] }>;
  readonly s: Record<string, number>;
  readonly f: Record<string, number>;
  readonly b: Record<string, number[]>;
}

class FixtureCoverageMap {
  readonly #entries: Map<string, CoverageData>;

  constructor(data: CoverageData | readonly CoverageData[]) {
    const population = Array.isArray(data) ? data : [data];
    this.#entries = new Map(
      population.map((coverage) => [coverage.path, structuredClone(coverage)]),
    );
  }

  files(): string[] {
    return [...this.#entries.keys()];
  }

  fileCoverageFor(filename: string): { toJSON(): CoverageData } {
    const coverage = this.#entries.get(filename);
    if (coverage === undefined) throw new Error(`missing fixture coverage for ${filename}`);
    return { toJSON: () => coverage };
  }

  addFileCoverage(coverage: CoverageData): void {
    const current = this.#entries.get(coverage.path);
    if (current === undefined) {
      this.#entries.set(coverage.path, structuredClone(coverage));
      return;
    }
    for (const [id, count] of Object.entries(coverage.s)) {
      current.s[id] = (current.s[id] ?? 0) + count;
    }
    for (const [id, count] of Object.entries(coverage.f)) {
      current.f[id] = (current.f[id] ?? 0) + count;
    }
    for (const [id, counts] of Object.entries(coverage.b)) {
      current.b[id] ??= [];
      for (const [index, count] of counts.entries()) {
        current.b[id][index] = (current.b[id][index] ?? 0) + count;
      }
    }
  }

  filter(callback: (filename: string) => boolean): void {
    for (const filename of this.files()) {
      if (!callback(filename)) this.#entries.delete(filename);
    }
  }

  data(): CoverageData {
    return structuredClone(this.fileCoverageFor(FILE).toJSON());
  }
}

const outer: Location = {
  start: { line: 1, column: 0 },
  end: { line: 12, column: 1 },
};
const inner: Location = {
  start: { line: 4, column: 2 },
  end: { line: 6, column: 3 },
};
const second: Location = {
  start: { line: 8, column: 2 },
  end: { line: 10, column: 3 },
};
const degenerate = { start: {}, end: {} } as Location;

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixtureCoverage(outerHit: number, innerHit: number): CoverageData {
  return {
    path: FILE,
    statementMap: { outer, inner },
    fnMap: {
      outer: { decl: outer, loc: outer },
      inner: { decl: inner, loc: inner },
    },
    branchMap: {},
    s: { outer: outerHit, inner: innerHit },
    f: { outer: outerHit, inner: innerHit },
    b: {},
  };
}

describe('subprocess coverage measurement integrity', () => {
  it('does not project an enclosing hit onto an exact zero-hit statement or function', async () => {
    const provider = (await import('../config/subprocess-v8-coverage-provider.js')) as unknown as {
      mergeCanonicalHits?: (current: FixtureCoverageMap, subprocess: FixtureCoverageMap) => void;
    };
    expect(
      provider.mergeCanonicalHits,
      'the merge is an independently testable contract',
    ).toBeTypeOf('function');

    const current = new FixtureCoverageMap(fixtureCoverage(0, 0));
    const subprocess = new FixtureCoverageMap(fixtureCoverage(1, 0));
    provider.mergeCanonicalHits?.(current, subprocess);

    expect(current.data().s).toEqual({ outer: 1, inner: 0 });
    expect(current.data().f).toEqual({ outer: 1, inner: 0 });
  });

  it('does not cross-attribute multiple degenerate implicit branch locations', async () => {
    const provider = (await import('../config/subprocess-v8-coverage-provider.js')) as unknown as {
      mergeCanonicalHits?: (current: FixtureCoverageMap, subprocess: FixtureCoverageMap) => void;
    };
    const current = new FixtureCoverageMap({
      ...fixtureCoverage(0, 0),
      branchMap: {
        currentFirst: { locations: [outer, degenerate] },
        currentSecond: { locations: [second, degenerate] },
      },
      b: { currentFirst: [0, 0], currentSecond: [0, 0] },
    });
    const subprocess = new FixtureCoverageMap({
      ...fixtureCoverage(0, 0),
      branchMap: {
        subprocessAlpha: { locations: [outer, degenerate] },
        subprocessBeta: { locations: [second, degenerate] },
      },
      b: { subprocessAlpha: [3, 1], subprocessBeta: [7, 9] },
    });

    provider.mergeCanonicalHits?.(current, subprocess);

    expect(current.data().b).toEqual({ currentFirst: [3, 0], currentSecond: [7, 0] });
  });

  it('preserves exact counters instead of additively re-merging the live coverage object', async () => {
    const provider = (await import('../config/subprocess-v8-coverage-provider.js')) as unknown as {
      mergeCanonicalHits?: (current: FixtureCoverageMap, subprocess: FixtureCoverageMap) => void;
    };
    const current = new FixtureCoverageMap(fixtureCoverage(2, 0));
    const subprocess = new FixtureCoverageMap(fixtureCoverage(3, 0));

    provider.mergeCanonicalHits?.(current, subprocess);

    expect(current.data().s.outer).toBe(5);
    expect(current.data().f.outer).toBe(5);
  });

  it('adds each repeated subprocess observation exactly once', async () => {
    const provider = (await import('../config/subprocess-v8-coverage-provider.js')) as unknown as {
      mergeCanonicalHits?: (current: FixtureCoverageMap, subprocess: FixtureCoverageMap) => void;
    };
    const current = new FixtureCoverageMap(fixtureCoverage(2, 0));
    const subprocess = new FixtureCoverageMap(fixtureCoverage(3, 0));

    provider.mergeCanonicalHits?.(current, subprocess);
    provider.mergeCanonicalHits?.(current, subprocess);

    expect(current.data().s.outer).toBe(8);
    expect(current.data().f.outer).toBe(8);
  });

  it('aggregates duplicate subprocess observations at one canonical location', async () => {
    const provider = (await import('../config/subprocess-v8-coverage-provider.js')) as unknown as {
      mergeCanonicalHits?: (current: FixtureCoverageMap, subprocess: FixtureCoverageMap) => void;
    };
    const duplicateStatement = {
      ...fixtureCoverage(0, 0),
      statementMap: { first: outer, second: outer },
      s: { first: 1, second: 2 },
    };
    const duplicateFunction = {
      ...fixtureCoverage(0, 0),
      fnMap: {
        first: { decl: outer, loc: outer },
        second: { decl: outer, loc: outer },
      },
      f: { first: 1, second: 2 },
    };
    const duplicateBranch = {
      ...fixtureCoverage(0, 0),
      branchMap: { duplicate: { locations: [outer, outer] } },
      b: { duplicate: [1, 2] },
    };

    const statementCurrent = new FixtureCoverageMap(fixtureCoverage(0, 0));
    provider.mergeCanonicalHits?.(statementCurrent, new FixtureCoverageMap(duplicateStatement));
    expect(statementCurrent.data().s.outer).toBe(3);

    const functionCurrent = new FixtureCoverageMap(fixtureCoverage(0, 0));
    provider.mergeCanonicalHits?.(functionCurrent, new FixtureCoverageMap(duplicateFunction));
    expect(functionCurrent.data().f.outer).toBe(3);

    const branchCurrent = new FixtureCoverageMap({
      ...fixtureCoverage(0, 0),
      branchMap: { canonical: { locations: [outer] } },
      b: { canonical: [0] },
    });
    provider.mergeCanonicalHits?.(branchCurrent, new FixtureCoverageMap(duplicateBranch));
    expect(branchCurrent.data().b.canonical).toEqual([3]);
  });

  it('fails closed on duplicate complete locations in the canonical parent map', async () => {
    const provider = (await import('../config/subprocess-v8-coverage-provider.js')) as unknown as {
      mergeCanonicalHits?: (current: FixtureCoverageMap, subprocess: FixtureCoverageMap) => void;
    };
    const duplicateStatement = {
      ...fixtureCoverage(0, 0),
      statementMap: { first: outer, second: outer },
      s: { first: 1, second: 2 },
    };
    const duplicateFunction = {
      ...fixtureCoverage(0, 0),
      fnMap: {
        first: { decl: outer, loc: outer },
        second: { decl: outer, loc: outer },
      },
      f: { first: 1, second: 2 },
    };
    const duplicateBranch = {
      ...fixtureCoverage(0, 0),
      branchMap: { duplicate: { locations: [outer, outer] } },
      b: { duplicate: [1, 2] },
    };

    for (const duplicate of [duplicateStatement, duplicateFunction, duplicateBranch]) {
      expect(() =>
        provider.mergeCanonicalHits?.(
          new FixtureCoverageMap(duplicate),
          new FixtureCoverageMap(fixtureCoverage(0, 0)),
        ),
      ).toThrow(/duplicate exact .* location/u);
    }
  });

  it('fails closed on a duplicate parent location in a file absent from subprocess coverage', async () => {
    const provider = (await import('../config/subprocess-v8-coverage-provider.js')) as unknown as {
      mergeCanonicalHits?: (current: FixtureCoverageMap, subprocess: FixtureCoverageMap) => void;
    };
    expect(
      'tests/config/subprocess-v8-coverage-provider.ts',
      'the red must bind the exact prospective Inspector implementation path',
    ).toContain('subprocess-v8-coverage-provider.ts');
    const parentOnlyDuplicate: CoverageData = {
      ...fixtureCoverage(0, 0),
      path: '/fixture/parent-only.ts',
      statementMap: { first: outer, second: outer },
      s: { first: 1, second: 2 },
    };
    const current = new FixtureCoverageMap([fixtureCoverage(0, 0), parentOnlyDuplicate]);
    const subprocess = new FixtureCoverageMap(fixtureCoverage(0, 0));

    expect(() => provider.mergeCanonicalHits?.(current, subprocess)).toThrow(
      /duplicate exact statement location/u,
    );
  });

  it('configures an auditable statement-level coverage artifact', async () => {
    const config = (await import('../config/rc.coverage.config.js')).default as {
      test?: { coverage?: { reporter?: string[] } };
    };
    expect(config.test?.coverage?.reporter).toContain('json');
  });

  it('retains observable raw subprocess inputs beside the final coverage artifact', async () => {
    const provider = (await import('../config/subprocess-v8-coverage-provider.js')) as unknown as {
      retainSubprocessCoverageInputs?: (source: string, evidence: string) => Promise<number>;
    };
    expect(provider.retainSubprocessCoverageInputs).toBeTypeOf('function');
    const root = mkdtempSync(join(tmpdir(), 'devai-coverage-retention-'));
    temporaryDirectories.push(root);
    const source = join(root, 'source');
    const evidence = join(root, 'evidence');
    const raw = join(source, 'coverage-fixture.json');
    const payload = `${JSON.stringify({ result: [{ url: 'file:///fixture/source.ts' }] })}\n`;
    await import('node:fs/promises').then(({ mkdir }) => mkdir(source, { recursive: true }));
    writeFileSync(raw, payload);

    const retained = await provider.retainSubprocessCoverageInputs?.(source, evidence);

    expect(retained).toBe(1);
    expect(existsSync(join(evidence, 'coverage-fixture.json'))).toBe(true);
    expect(readFileSync(join(evidence, 'coverage-fixture.json'), 'utf8')).toBe(payload);
  });
});
