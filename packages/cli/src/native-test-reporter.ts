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
interface DiagnosticStream {
  write(content: string): unknown;
}
interface NativeLogger {
  outputStream: DiagnosticStream;
  errorStream: DiagnosticStream;
  console: { log: (...args: unknown[]) => unknown };
  log: (...args: unknown[]) => unknown;
}
interface NativeReporterContext {
  config: { root: string };
  version?: string;
  _tmpDir: string;
  logger: NativeLogger;
  onClose(callback: () => void): void;
}
interface DiagnosticRouting {
  readonly context: NativeReporterContext;
  readonly logger: NativeLogger;
  readonly originalOutput: DiagnosticStream;
  readonly diagnosticOutput: DiagnosticStream;
  readonly originalConsole: NativeLogger['console'];
  readonly originalConsoleLog: NativeLogger['console']['log'];
  readonly originalLog: NativeLogger['log'];
}

/** Package-owned Vitest 4 collection and native JSON final result in one execution. */
export default class DevaiVitestReporter {
  private reporter?: NativeJsonReporter;
  private plannedFiles: string[] = [];
  private collected: { file: string; ancestors: string[]; title: string; project: string }[] = [];
  private resolvedSelection: Record<string, unknown>[] = [];
  private invalid: string[] = [];
  private runtimeOutputRoots: string[] = [];
  private diagnosticRouting?: DiagnosticRouting;

  onInit(ctx: NativeReporterContext): void {
    const previous = this.diagnosticRouting;
    if (previous !== undefined) {
      if (
        previous.context !== ctx ||
        ctx.logger !== previous.logger ||
        previous.logger.outputStream !== previous.diagnosticOutput ||
        previous.logger.errorStream !== previous.diagnosticOutput ||
        previous.logger.console !== previous.originalConsole ||
        previous.logger.console.log !== previous.originalConsoleLog ||
        typeof previous.logger.outputStream.write !== 'function' ||
        typeof previous.logger.errorStream.write !== 'function' ||
        previous.logger.log !== previous.originalLog
      )
        throw new Error('DEVAI_NATIVE_REPORTER_LOGGER_CHANGED');
      return;
    }
    const logger = ctx.logger;
    if (
      logger === null ||
      typeof logger !== 'object' ||
      typeof logger.outputStream?.write !== 'function' ||
      typeof logger.errorStream?.write !== 'function' ||
      logger.outputStream === logger.errorStream ||
      typeof logger.console?.log !== 'function' ||
      typeof logger.log !== 'function' ||
      typeof ctx.onClose !== 'function'
    )
      throw new Error('DEVAI_NATIVE_REPORTER_LOGGER_UNSUPPORTED');
    const routing: DiagnosticRouting = {
      context: ctx,
      logger,
      originalOutput: logger.outputStream,
      diagnosticOutput: logger.errorStream,
      originalConsole: logger.console,
      originalConsoleLog: logger.console.log,
      originalLog: logger.log,
    };
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
    // Vitest 4.1.11 snapshots this stream when constructing fork/thread workers.
    // Its logger Console was bound earlier, so the native JSON writer keeps its
    // original stdout sink. Main-process/config/globalSetup output is not rerouted.
    if (
      logger.outputStream !== routing.originalOutput ||
      logger.errorStream !== routing.diagnosticOutput ||
      logger.console !== routing.originalConsole ||
      logger.console.log !== routing.originalConsoleLog ||
      logger.log !== routing.originalLog
    )
      throw new Error('DEVAI_NATIVE_REPORTER_LOGGER_CHANGED');
    try {
      logger.outputStream = routing.diagnosticOutput;
    } catch (error) {
      this.reporter = undefined;
      throw new Error('DEVAI_NATIVE_REPORTER_LOGGER_UNSUPPORTED', { cause: error });
    }
    if (logger.outputStream !== routing.diagnosticOutput) {
      this.reporter = undefined;
      throw new Error('DEVAI_NATIVE_REPORTER_LOGGER_UNSUPPORTED');
    }
    this.diagnosticRouting = routing;
    try {
      ctx.onClose(() => {
        if (this.diagnosticRouting !== routing) return;
        // Never overwrite routing installed by another owner after initialization.
        if (
          logger.outputStream === routing.diagnosticOutput &&
          logger.errorStream === routing.diagnosticOutput
        )
          logger.outputStream = routing.originalOutput;
        this.diagnosticRouting = undefined;
        this.reporter = undefined;
      });
    } catch (error) {
      // Initialization failed before any worker is constructed; undo only our write.
      if (
        logger.outputStream === routing.diagnosticOutput &&
        logger.errorStream === routing.diagnosticOutput
      )
        logger.outputStream = routing.originalOutput;
      this.diagnosticRouting = undefined;
      this.reporter = undefined;
      throw error;
    }
  }

  onUserConsoleLog(log: { content: string; type: 'stdout' | 'stderr' }): void {
    const routing = this.diagnosticRouting;
    if (routing === undefined) throw new Error('DEVAI_NATIVE_REPORTER_NOT_INITIALIZED');
    if (typeof log.content !== 'string') throw new Error('DEVAI_NATIVE_DIAGNOSTIC_INVALID');
    // Both channels retain the original content, including warnings and JSON-shaped
    // diagnostics. No shouldLog/onConsoleLog filter or silent setting is applied.
    routing.diagnosticOutput.write(log.content);
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
