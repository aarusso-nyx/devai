import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
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
const coreRequire = createRequire(require.resolve('@stryker-mutator/core/package.json'));
const { declareFactoryPlugin, PluginKind } = await import(
  pathToFileURL(coreRequire.resolve('@stryker-mutator/api/plugin')).href
);

function createProtectedVitest(injector) {
  const runner = vitestTestRunnerFactory(injector);
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
