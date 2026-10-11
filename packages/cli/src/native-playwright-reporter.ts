interface Suite {
  type: string;
  title: string;
  parent?: Suite;
  allTests(): Test[];
  project(): { name: string } | undefined;
}
interface Test {
  title: string;
  parent: Suite;
  location: { file: string };
  results: { retry: number; status: string }[];
  outcome(): string;
}

/** Playwright's native onBegin collection and terminal test objects, from one run. */
export default class DevaiPlaywrightReporter {
  private tests: Test[] = [];
  private config?: {
    rootDir: string;
    projects: Record<string, unknown>[];
    globalSetup?: string | null;
    globalTeardown?: string | null;
  };
  private collected: { file: string; ancestors: string[]; title: string; project: string }[] = [];
  private errors: unknown[] = [];
  private resolvedSelection: Record<string, unknown>[] = [];

  onBegin(
    config: {
      rootDir: string;
      projects: Record<string, unknown>[];
      globalSetup?: string | null;
      globalTeardown?: string | null;
    },
    suite: Suite,
  ): void {
    this.config = { rootDir: config.rootDir, projects: [] };
    this.resolvedSelection = JSON.parse(
      JSON.stringify(
        config.projects.map((project) => ({
          project: project['name'],
          root: config.rootDir,
          globalSetup: config.globalSetup ?? null,
          globalTeardown: config.globalTeardown ?? null,
          testDir: project['testDir'],
          testMatch: String(project['testMatch']),
          testIgnore: String(project['testIgnore']),
          grep: String(project['grep']),
          grepInvert: String(project['grepInvert']),
          dependencies: project['dependencies'] ?? [],
        })),
      ),
    ) as Record<string, unknown>[];
    this.tests = suite.allTests();
    this.collected = this.tests.map((test) => ({
      file: test.location.file,
      ancestors: this.ancestors(test),
      title: test.title,
      project: test.parent.project()?.name ?? '',
    }));
  }

  private ancestors(test: Test): string[] {
    const out: string[] = [];
    let parent: Suite | undefined = test.parent;
    while (parent !== undefined) {
      if (parent.type === 'describe') out.unshift(parent.title);
      parent = parent.parent;
    }
    return out;
  }

  onError(error: unknown): void {
    this.errors.push(error);
  }

  onEnd(): void {
    if (this.config === undefined) throw new Error('DEVAI_NATIVE_REPORTER_NOT_INITIALIZED');
    const stats: Record<string, number> = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
    const suites = this.tests.map((test) => {
      const status = test.outcome();
      stats[status] = (stats[status] ?? 0) + 1;
      let suite: Record<string, unknown> = {
        title: '',
        file: test.location.file,
        specs: [
          {
            title: test.title,
            file: test.location.file,
            tests: [
              {
                projectName: test.parent.project()?.name ?? '',
                status,
                results: test.results.map((result) => ({
                  retry: result.retry,
                  status: result.status,
                })),
              },
            ],
          },
        ],
        suites: [],
      };
      for (const title of this.ancestors(test).reverse())
        suite = { title, specs: [], suites: [suite] };
      return { title: test.location.file, specs: [], suites: [suite] };
    });
    process.stdout.write(
      `${JSON.stringify({
        config: { rootDir: this.config.rootDir },
        suites,
        stats,
        errors: this.errors,
        devaiCollection: {
          schemaVersion: '1.0.0',
          reporter: 'playwright-v1',
          nonce: process.env['DEVAI_NATIVE_COLLECTION_NONCE'],
          plannedFiles: [...new Set(this.collected.map((test) => test.file))].sort(),
          tests: this.collected,
          resolvedSelection: this.resolvedSelection,
          invalid: [],
        },
      })}\n`,
    );
  }
}
