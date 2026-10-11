export interface NativeCoverageAdapterOptions {
  readonly packageDir: string;
  readonly config: 'tsconfig.json';
  readonly modules: readonly {
    readonly source: string;
    readonly output: string;
  }[];
  readonly includes: readonly string[];
  readonly excludes: readonly string[];
}
type CompilationMode = 'production' | 'coverage';
type Output = {
  path: string;
  text: string;
  sha256: string;
};
type Input = {
  path: string;
  sha256: string;
  origin: 'candidate' | 'dependency';
};
export type NativeCoverageAdapter = Readonly<{
  sha256(value: string | Uint8Array): string;
  candidate: () => string;
  sourceCensus: () => string[];
  compile: (request: { mode: CompilationMode; source: string }) => {
    outputs: Output[];
    diagnostics: {
      category: 0 | 1 | 2 | 3;
      code: number;
      message: string;
    }[];
  };
  readVerifiedOutput(path: string): string;
  verify: () => void;
  evidence: () => {
    schemaVersion: string;
    mode: 'governed' | 'diagnostic';
    candidate: string;
    git: {
      path: string;
      sha256: string;
    };
    compiler: {
      version: string;
      entrySha256: string;
      manifestSha256: string;
    };
    config: {
      path: string;
      sha256: string;
      productionOptionsSha256: string;
      coverageOptionsSha256: string;
    };
    sourceFiles: string[];
    inputs: Input[];
    resolutionSha256: string;
    outputs: {
      path: string;
      sha256: string;
      source: string;
      mode: CompilationMode;
    }[];
  };
}>;
