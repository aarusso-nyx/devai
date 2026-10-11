import { createRequire } from 'node:module';
import { resolve } from 'node:path';

interface NativeProject {
  name: string;
  tmpDir: string;
  config: Record<string, unknown>;
  vite: { config: { configFile?: string; env: Record<string, string | boolean> } };
  globTestFiles(): Promise<{ testFiles: string[]; typecheckTestFiles: string[] }>;
}
interface NativeCase {
  name: string;
  parent: NativeSuite;
}
interface NativeSuite {
  type: string;
  name: string;
  parent?: NativeSuite;
  children: { allTests(): Iterable<NativeCase> };
}
interface NativeModule extends NativeSuite {
  moduleId: string;
  project: NativeProject;
}
interface NativeSpecification {
  moduleId: string;
  project: NativeProject;
  testLines?: number[];
  testNamePattern?: RegExp;
  testIds?: string[];
  testTagsFilter?: string[];
}
interface NativeJsonReporter {
  onInit(ctx: unknown): void;
  onTestRunEnd(modules: readonly NativeModule[]): Promise<void>;
  writeReport(report: string): Promise<void>;
}

/** Package-owned Vitest 4 collection and native JSON final result in one execution. */
export default class DevaiVitestReporter {
  private reporter?: NativeJsonReporter;
  private plannedFiles: string[] = [];
  private collected: { file: string; ancestors: string[]; title: string; project: string }[] = [];
  private resolvedSelection: Record<string, unknown>[] = [];
  private invalid: string[] = [];
  private runtimeOutputRoots: string[] = [];

  onInit(ctx: { config: { root: string }; version?: string; _tmpDir: string }): void {
    this.runtimeOutputRoots = [ctx._tmpDir];
    const require = createRequire(resolve(ctx.config.root, 'package.json'));
    const native = require('vitest/node') as {
      JsonReporter: new (options: Record<string, unknown>) => NativeJsonReporter;
    };
    this.reporter = new native.JsonReporter({});
    this.reporter.onInit(ctx);
    const write = this.reporter.writeReport.bind(this.reporter);
    this.reporter.writeReport = async (report) => {
      const parsed: unknown = JSON.parse(report);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('DEVAI_NATIVE_FINAL_INVALID');
      await write(
        JSON.stringify({
          ...parsed,
          devaiCollection: {
            schemaVersion: '1.0.0',
            reporter: 'vitest-v1',
            nonce: process.env['DEVAI_NATIVE_COLLECTION_NONCE'],
            plannedFiles: [...this.plannedFiles].sort(),
            tests: this.collected,
            resolvedSelection: this.resolvedSelection,
            invalid: this.invalid,
            runtimeOutputRoots: [...new Set(this.runtimeOutputRoots)],
          },
        }),
      );
    };
  }

  async onTestRunStart(specifications: readonly NativeSpecification[]): Promise<void> {
    this.plannedFiles = specifications.map((spec) => spec.moduleId);
    this.collected = [];
    this.resolvedSelection = [];
    this.invalid = [];
    const projects = new Set(specifications.map((spec) => spec.project));
    for (const project of projects) {
      this.runtimeOutputRoots.push(project.tmpDir);
      const discovered = await project.globTestFiles();
      const scheduled = specifications
        .filter((spec) => spec.project === project)
        .map((spec) => spec.moduleId)
        .sort();
      if (
        JSON.stringify([...discovered.testFiles].sort()) !== JSON.stringify(scheduled) ||
        discovered.typecheckTestFiles.length > 0
      )
        this.invalid.push('NATIVE_COLLECTION_FILTERED_FILE_SELECTION');
      const config = project.config;
      this.resolvedSelection.push(
        JSON.parse(
          JSON.stringify({
            project: project.name,
            root: config['root'],
            include: config['include'],
            exclude: config['exclude'],
            configFile: project.vite.config.configFile ?? null,
            setupFiles: config['setupFiles'] ?? [],
            globalSetup: config['globalSetup'] ?? [],
            customProviderModule:
              (config['coverage'] as Record<string, unknown> | undefined)?.[
                'customProviderModule'
              ] ?? null,
            pool: config['pool'],
            environment: config['environment'],
            viteEnvironment: Object.fromEntries(
              ['BASE_URL', 'DEV', 'MODE', 'PROD'].map((key) => [key, project.vite.config.env[key]]),
            ),
            testEnvironment: Object.fromEntries(
              ['BASE_URL', 'DEV', 'MODE', 'PROD']
                .filter((key) => Object.hasOwn((config['env'] ?? {}) as object, key))
                .map((key) => [key, (config['env'] as Record<string, unknown>)[key]]),
            ),
            forceTTY: process.stdout.isTTY === true ? 'true' : '',
          }),
        ) as Record<string, unknown>,
      );
    }
    for (const spec of specifications)
      if (
        spec.testLines !== undefined ||
        spec.testNamePattern !== undefined ||
        spec.testIds !== undefined ||
        spec.testTagsFilter !== undefined
      )
        this.invalid.push('NATIVE_COLLECTION_FILTERED_TEST_SELECTION');
  }

  onTestModuleCollected(module: NativeModule): void {
    for (const test of module.children.allTests()) {
      const ancestors: string[] = [];
      let parent: NativeSuite | undefined = test.parent;
      while (parent !== undefined && parent.type !== 'module') {
        ancestors.unshift(parent.name);
        parent = parent.parent;
      }
      this.collected.push({
        file: module.moduleId,
        ancestors,
        title: test.name,
        project: module.project.name,
      });
    }
  }

  async onTestRunEnd(modules: readonly NativeModule[]): Promise<void> {
    if (this.reporter === undefined) throw new Error('DEVAI_NATIVE_REPORTER_NOT_INITIALIZED');
    await this.reporter.onTestRunEnd(modules);
  }
}
