import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const SCRIPT = resolve(
  import.meta.dirname,
  '../../../../scripts/release-host/mutation-production.mjs',
);
const RELATIVE_WORKSPACE = 'packages/driver ç';
const WORKSPACE = `/workspace/candidate/${RELATIVE_WORKSPACE}`;
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error('fixture entry missing');
  return value;
}

type Position = { line: number; column: number };
type Selected = { name: string; content: string; mutate: boolean };
type Instrumentation = {
  files: Array<{ name: string; content: string }>;
  mutants: Array<{
    id: string;
    fileName: string;
    mutatorName: string;
    replacement: string;
    location: { start: Position; end: Position };
  }>;
};
type Observation = {
  selected: Array<{ path: string; sha256: string }>;
  instrumented: string[];
  source_files: Array<{
    path: string;
    sha256: string;
    mutants: Array<{
      id: string;
      mutatorName: string;
      replacementDigest: string;
      location: { start: Position; end: Position };
    }>;
  }>;
};
type Driver = {
  observeProductionInstrumentation: (
    controls: {
      workspace: string;
      targets: Array<{ path: string; sha256: string }>;
      maximum_files: number;
      maximum_mutants: number;
    },
    selected: Selected[],
    result: Instrumentation,
  ) => Observation;
  runObservedStrykerPipeline: (input: Record<string, unknown>) => Promise<unknown>;
};
const driver = (await import(pathToFileURL(SCRIPT).href)) as Driver;

function fixture() {
  const content = 'export const value = true;\n';
  const zero = 'export type Value = boolean;\n';
  const selected = [
    { name: join(WORKSPACE, 'src/subject.ts'), content, mutate: true },
    { name: join(WORKSPACE, 'src/zero.ts'), content: zero, mutate: true },
  ];
  const result: Instrumentation = {
    files: selected.map(({ name, content: original }) => ({
      name,
      content: `/* instrumented */${original}`,
    })),
    mutants: [
      {
        id: '1',
        fileName: first(selected).name,
        mutatorName: 'BooleanLiteral',
        replacement: 'false',
        location: { start: { line: 0, column: 20 }, end: { line: 0, column: 24 } },
      },
    ],
  };
  return {
    controls: {
      workspace: RELATIVE_WORKSPACE,
      targets: [
        { path: 'src/subject.ts', sha256: sha256(content) },
        { path: 'src/zero.ts', sha256: sha256(zero) },
      ],
      maximum_files: 2,
      maximum_mutants: 2,
    },
    selected,
    result,
  };
}
type Fixture = ReturnType<typeof fixture>;
const observe = (value: Fixture) =>
  driver.observeProductionInstrumentation(value.controls, value.selected, value.result);

describe('production instrumentation observation (ADR-MUT-0008 independent emitted census)', () => {
  it('retains the zero-emission file and converts independently observed mutant metadata exactly once', () => {
    const value = fixture();
    const before = structuredClone(value);
    const observation = observe(value);
    expect(observation).toEqual({
      selected: value.controls.targets,
      instrumented: ['src/subject.ts', 'src/zero.ts'],
      source_files: [
        {
          ...value.controls.targets[0],
          mutants: [
            {
              id: '1',
              mutatorName: 'BooleanLiteral',
              replacementDigest: sha256('false'),
              location: { start: { line: 1, column: 21 }, end: { line: 1, column: 25 } },
            },
          ],
        },
        { ...value.controls.targets[1], mutants: [] },
      ],
    });
    expect(value).toEqual(before);
    expect(JSON.stringify(observation)).not.toContain('/* instrumented */');
  });

  it('keeps all selected and instrumented sources even when the complete emission census is empty', () => {
    const value = fixture();
    value.result.mutants = [];
    expect(observe(value)).toEqual({
      selected: value.controls.targets,
      instrumented: ['src/subject.ts', 'src/zero.ts'],
      source_files: value.controls.targets.map((target) => ({ ...target, mutants: [] })),
    });
  });

  it('normalizes order without accepting a different census', () => {
    const value = fixture();
    const expected = observe(value);
    value.selected.reverse();
    value.result.files.reverse();
    value.controls.targets.reverse();
    expect(observe(value)).toEqual(expected);
  });

  it.each<[string, (value: Fixture) => void]>([
    [
      'missing selected',
      (value) => {
        value.selected.pop();
      },
    ],
    [
      'extra selected',
      (value) => {
        value.selected.push({ name: join(WORKSPACE, 'src/extra.ts'), content: '', mutate: true });
      },
    ],
    [
      'duplicate selected',
      (value) => {
        value.selected[1] = { ...first(value.selected) };
      },
    ],
    [
      'missing instrumented',
      (value) => {
        value.result.files.pop();
      },
    ],
    [
      'extra instrumented',
      (value) => {
        value.result.files.push({ name: join(WORKSPACE, 'src/extra.ts'), content: '' });
      },
    ],
    [
      'duplicate instrumented',
      (value) => {
        value.result.files[1] = { ...first(value.result.files) };
      },
    ],
    [
      'selected source digest drift',
      (value) => {
        first(value.selected).content += '// changed\n';
      },
    ],
    [
      'partial mutate range',
      (value) => {
        Object.assign(first(value.selected), { mutate: [{ start: 0, end: 4 }] });
      },
    ],
    [
      'unselected source',
      (value) => {
        first(value.selected).mutate = false;
      },
    ],
    [
      'duplicate target',
      (value) => {
        value.controls.targets[1] = { ...first(value.controls.targets) };
      },
    ],
    [
      'escaping target',
      (value) => {
        first(value.controls.targets).path = '../outside.ts';
      },
    ],
    [
      'mutant outside target census',
      (value) => {
        first(value.result.mutants).fileName = join(WORKSPACE, 'src/extra.ts');
      },
    ],
    [
      'mutant outside workspace',
      (value) => {
        first(value.result.mutants).fileName = '/outside/subject.ts';
      },
    ],
    [
      'duplicate mutant id',
      (value) => {
        value.result.mutants.push(structuredClone(first(value.result.mutants)));
      },
    ],
    [
      'empty mutant id',
      (value) => {
        first(value.result.mutants).id = '';
      },
    ],
    [
      'non-string mutant id',
      (value) => {
        Object.assign(first(value.result.mutants), { id: 1 });
      },
    ],
    [
      'invalid mutator name',
      (value) => {
        first(value.result.mutants).mutatorName = '';
      },
    ],
    [
      'non-string replacement',
      (value) => {
        Object.assign(first(value.result.mutants), { replacement: null });
      },
    ],
    [
      'negative line',
      (value) => {
        first(value.result.mutants).location.start.line = -1;
      },
    ],
    [
      'negative column',
      (value) => {
        first(value.result.mutants).location.start.column = -1;
      },
    ],
    [
      'unsafe coordinate',
      (value) => {
        first(value.result.mutants).location.end.column = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      'fractional coordinate',
      (value) => {
        first(value.result.mutants).location.start.line = 0.5;
      },
    ],
    [
      'reversed location',
      (value) => {
        first(value.result.mutants).location.end.column = 0;
      },
    ],
    [
      'file limit',
      (value) => {
        value.controls.maximum_files = 1;
      },
    ],
    [
      'mutant limit',
      (value) => {
        value.controls.maximum_mutants = 1;
        value.result.mutants.push({ ...structuredClone(first(value.result.mutants)), id: '2' });
      },
    ],
    [
      'invalid limit',
      (value) => {
        value.controls.maximum_files = NaN;
      },
    ],
  ])('refuses %s', (_label, modify) => {
    const value = fixture();
    modify(value);
    expect(() => observe(value)).toThrow();
  });
});

function pipelineFixture() {
  const value = fixture();
  const events: string[] = [];
  class PrepareExecutor {
    readonly stage = 'prepare';
  }
  class MutantInstrumenterExecutor {
    readonly stage = 'instrument';
  }
  class DryRunExecutor {
    readonly stage = 'dry-run';
  }
  class MutationTestExecutor {
    readonly stage = 'mutation';
  }
  const stages = {
    PrepareExecutor,
    MutantInstrumenterExecutor,
    DryRunExecutor,
    MutationTestExecutor,
  };
  const results = [{ stage: 'mutation-test-double' }];
  const mutation = {
    execute: vi.fn(async () => {
      events.push('mutation');
      return results;
    }),
  };
  const stage4 = {
    injectClass: vi.fn((stage: unknown) => {
      expect(stage).toBe(MutationTestExecutor);
      return mutation;
    }),
  };
  const dryRun = {
    execute: vi.fn(async () => {
      events.push('dry-run');
      return stage4;
    }),
  };
  const stage3 = {
    injectClass: vi.fn((stage: unknown) => {
      expect(stage).toBe(DryRunExecutor);
      return dryRun;
    }),
  };
  const instrument = {
    readFilesToMutate: vi.fn(async () => {
      events.push('read-selected');
      return value.selected;
    }),
    writeInstrumentedFiles: vi.fn(async (result: Instrumentation) => {
      events.push('write-instrumented');
      expect(result).toBe(value.result);
    }),
    async execute() {
      events.push('instrument');
      await this.readFilesToMutate();
      await this.writeInstrumentedFiles(value.result);
      events.push('preprocess', 'worker-init');
      return stage3;
    },
  };
  const originalRead = instrument.readFilesToMutate;
  const originalWrite = instrument.writeInstrumentedFiles;
  const stage2 = {
    injectClass: vi.fn((stage: unknown) => {
      expect(stage).toBe(MutantInstrumenterExecutor);
      return instrument;
    }),
  };
  const prepare = {
    execute: vi.fn(async (_options: unknown) => {
      events.push('prepare');
      return stage2;
    }),
  };
  const prepareInjector = {
    injectClass: vi.fn((stage: unknown) => {
      expect(stage).toBe(PrepareExecutor);
      return prepare;
    }),
  };
  const rootInjector = {
    dispose: vi.fn(async () => {
      events.push('dispose');
    }),
  };
  const options = { reporters: ['json'], mutate: ['src/subject.ts', 'src/zero.ts'] };
  const observer = vi.fn((selected: Selected[], result: Instrumentation) => {
    events.push('observe');
    expect(selected).toEqual(value.selected);
    expect(result).toEqual(value.result);
    return driver.observeProductionInstrumentation(value.controls, selected, result);
  });
  const input = { rootInjector, prepareInjector, stages, options, observe: observer };
  return {
    ...value,
    events,
    input,
    results,
    instrument,
    prepare,
    dryRun,
    mutation,
    originalRead,
    originalWrite,
    stage2,
    stage3,
    stage4,
    observer,
  };
}

describe('single observed production pipeline ordering with stage doubles (ADR-MUT-0008)', () => {
  it('observes stage-two discovery before the original writer, preprocessing, and worker initialization', async () => {
    const value = pipelineFixture();
    const before = structuredClone({ selected: value.selected, result: value.result });
    value.observer.mockImplementation((selected, result) => {
      value.events.push('observe');
      expect(selected).toEqual(value.selected);
      expect(result).toEqual(value.result);
      expect(selected).not.toBe(value.selected);
      expect(result).not.toBe(value.result);
      expect(result.mutants[0]).not.toBe(value.result.mutants[0]);
      // A callback cannot rewrite the stage result supplied to the original writer.
      Reflect.set(first(selected), 'content', 'observer mutation');
      Reflect.set(first(result.mutants), 'replacement', 'observer mutation');
      return driver.observeProductionInstrumentation(value.controls, selected, result);
    });
    expect(await driver.runObservedStrykerPipeline(value.input)).toEqual({
      observation: observe(value),
      mutant_results: value.results,
    });
    expect(value.events).toEqual([
      'prepare',
      'instrument',
      'read-selected',
      'observe',
      'write-instrumented',
      'preprocess',
      'worker-init',
      'dry-run',
      'mutation',
      'dispose',
    ]);
    expect(value.prepare.execute).toHaveBeenCalledExactlyOnceWith({
      cliOptions: value.input.options,
      targetMutatePatterns: undefined,
    });
    for (const stage of [value.input.prepareInjector, value.stage2, value.stage3, value.stage4])
      expect(stage.injectClass).toHaveBeenCalledOnce();
    expect(value.originalRead).toHaveBeenCalledOnce();
    expect(value.originalWrite).toHaveBeenCalledOnce();
    expect(value.observer).toHaveBeenCalledOnce();
    expect(value.dryRun.execute).toHaveBeenCalledOnce();
    expect(value.mutation.execute).toHaveBeenCalledOnce();
    expect(value.input.rootInjector.dispose).toHaveBeenCalledOnce();
    expect(value.instrument.readFilesToMutate).toBe(value.originalRead);
    expect(value.instrument.writeInstrumentedFiles).toBe(value.originalWrite);
    expect({ selected: value.selected, result: value.result }).toEqual(before);
  });

  it.each(['prepare', 'read', 'observe', 'write', 'dry-run', 'mutation'] as const)(
    'disposes the root and restores hooks after %s failure without replaying the pipeline',
    async (stage) => {
      const value = pipelineFixture();
      const failure = new Error(`controlled ${stage} failure`);
      if (stage === 'prepare') value.prepare.execute.mockRejectedValue(failure);
      if (stage === 'read') value.originalRead.mockRejectedValue(failure);
      if (stage === 'observe')
        value.observer.mockImplementation(() => {
          value.events.push('observe');
          throw failure;
        });
      if (stage === 'write') value.originalWrite.mockRejectedValue(failure);
      if (stage === 'dry-run') value.dryRun.execute.mockRejectedValue(failure);
      if (stage === 'mutation') value.mutation.execute.mockRejectedValue(failure);
      await expect(driver.runObservedStrykerPipeline(value.input)).rejects.toThrow(failure);
      expect(value.input.rootInjector.dispose).toHaveBeenCalledOnce();
      expect(value.instrument.readFilesToMutate).toBe(value.originalRead);
      expect(value.instrument.writeInstrumentedFiles).toBe(value.originalWrite);
      expect(value.prepare.execute).toHaveBeenCalledOnce();
      if (stage === 'observe') {
        expect(value.originalWrite).not.toHaveBeenCalled();
        expect(value.events).not.toContain('preprocess');
        expect(value.events).not.toContain('worker-init');
        expect(value.dryRun.execute).not.toHaveBeenCalled();
        expect(value.mutation.execute).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['missing-read', 'missing-write', 'duplicate-read', 'duplicate-write'] as const)(
    'refuses %s instrumentation observation rather than replaying instrumentation',
    async (fault) => {
      const value = pipelineFixture();
      value.instrument.execute = async function () {
        if (fault !== 'missing-read') await this.readFilesToMutate();
        if (fault === 'duplicate-read') await this.readFilesToMutate();
        if (fault !== 'missing-write') await this.writeInstrumentedFiles(value.result);
        if (fault === 'duplicate-write') await this.writeInstrumentedFiles(value.result);
        return value.stage3;
      };
      await expect(driver.runObservedStrykerPipeline(value.input)).rejects.toThrow();
      expect(value.dryRun.execute).not.toHaveBeenCalled();
      expect(value.mutation.execute).not.toHaveBeenCalled();
      expect(value.input.rootInjector.dispose).toHaveBeenCalledOnce();
      expect(value.instrument.readFilesToMutate).toBe(value.originalRead);
      expect(value.instrument.writeInstrumentedFiles).toBe(value.originalWrite);
    },
  );
});
