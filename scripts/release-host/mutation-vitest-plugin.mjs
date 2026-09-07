import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { sandboxWorkspaceAliases } from './mutation-workspace-aliases.mjs';
import { pathToFileURL } from 'node:url';

// Loaded only from the host's read-only program mount, including in Stryker's
// workers. Candidate configuration supplies aliases/setup/environment, but its
// exclusion list cannot subtract from the complete bound test population.
const require = createRequire('/workspace/candidate/package.json');
const base = dirname(require.resolve('@stryker-mutator/vitest-runner/package.json'));
const { vitestTestRunnerFactory } = await import(
  pathToFileURL(join(base, 'dist/src/vitest-test-runner.js')).href
);
const { strykerValidationSchema } = await import(
  pathToFileURL(join(base, 'dist/src/index.js')).href
);
// Vite bundles a TypeScript config into <root>/node_modules/.vite-temp, and the
// protected container mounts every node_modules read-only, so the bundling loader
// cannot run here. The candidate's own test tasks already avoid it with
// `--configLoader runner`; the runner loader resolves the same config through the
// module runner and writes nothing. The wrapper is a plain object, so the option is
// injected without forking Stryker's runner.
const { vitestWrapper } = await import(
  pathToFileURL(join(base, 'dist/src/vitest-wrapper.js')).href
);
const createVitestWithRunnerLoader = vitestWrapper.createVitest;
// Workspace links in a symlinked node_modules still point at the original checkout.
// Resolve declared development entrypoints to the sandbox so tests observe the
// instrumented source and share one authority runtime with relative test imports.

vitestWrapper.createVitest = (mode, options, ...rest) => {
  const inline = rest[0] ?? {};
  return createVitestWithRunnerLoader(
    mode,
    { ...options, configLoader: 'runner' },
    {
      ...inline,
      plugins: [
        ...(inline.plugins ?? []),
        {
          name: 'devai-mutation-sandbox-workspace',
          enforce: 'pre',
          config: () => ({ resolve: { alias: sandboxWorkspaceAliases(process.cwd()) } }),
        },
      ],
    },
    ...rest.slice(1),
  );
};

const coreRequire = createRequire(require.resolve('@stryker-mutator/core/package.json'));
const { declareFactoryPlugin, PluginKind } = await import(
  pathToFileURL(coreRequire.resolve('@stryker-mutator/api/plugin')).href
);

function createProtectedVitest(injector) {
  const runner = vitestTestRunnerFactory(injector);
  // Stryker 9.6.1 uses a global file filter for the explicit testFiles roster,
  // but labels that filter as runtime activation even for static mutants. The
  // pinned Vitest runner's per-test IDs are relative "file#test" strings; the
  // global filter consists of absolute sandbox file paths. Activate before
  // module evaluation for that full-file selection, retaining the exact filter.
  const originalMutantRun = runner.mutantRun;
  runner.mutantRun = function (options) {
    const fullFileSelection =
      Array.isArray(options.testFilter) &&
      options.testFilter.length > 0 &&
      options.testFilter.every((file) => typeof file === 'string' && isAbsolute(file));
    return originalMutantRun.call(this, {
      ...options,
      mutantActivation: fullFileSelection ? 'static' : options.mutantActivation,
    });
  };
  const originalInit = runner.init;
  runner.init = async function () {
    await originalInit.call(this);
    if (!this.ctx || !Array.isArray(this.ctx.projects) || this.ctx.projects.length === 0)
      throw new Error('release-mutation-test-population-invalid');
    for (const config of [this.ctx.config, ...this.ctx.projects.map((project) => project.config)]) {
      config.exclude = [];
      config.passWithNoTests = false;
      config.allowOnly = false;
    }
  };
  return runner;
}
createProtectedVitest.inject = vitestTestRunnerFactory.inject;
export { strykerValidationSchema };
export const strykerPlugins = [
  declareFactoryPlugin(PluginKind.TestRunner, 'devai-vitest', createProtectedVitest),
];
