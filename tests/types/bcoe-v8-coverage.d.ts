declare module '@bcoe/v8-coverage' {
  import type { Profiler } from 'node:inspector';

  interface ProcessCoverage {
    readonly result: Array<Profiler.ScriptCoverage & { startOffset?: number }>;
  }

  export function mergeProcessCovs(coverages: readonly ProcessCoverage[]): ProcessCoverage;
}
