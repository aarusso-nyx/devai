import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const INVALID = 'release-mutation-instrumentation-invalid';
const compare = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));
const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const refuse = () => {
  throw new Error(INVALID);
};
const plain = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const relative = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value === value.normalize('NFC') &&
  !value.startsWith('/') &&
  !/^[A-Za-z]:/u.test(value) &&
  !/[\\\p{Cc}\p{Cs}]/u.test(value) &&
  value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
const bounded = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff;
function frozenCopy(value) {
  const copy = structuredClone(value);
  const freeze = (node) => {
    if (node !== null && typeof node === 'object') {
      Object.values(node).forEach(freeze);
      Object.freeze(node);
    }
  };
  freeze(copy);
  return copy;
}

/**
 * Observe the SAME instrumenter result subsequently consumed by Stryker's
 * sandbox/checker/test stages. Neither a second discovery run nor the eventual
 * JSON report supplies any part of this census. Zero-mutant targets remain in
 * all three populations; the normalizer's emitted-only projection is separate.
 * This is data, not execution, compatibility, reuse or certification authority.
 */
export function observeProductionInstrumentation(spec, selected, result) {
  if (
    !plain(spec) ||
    !relative(spec.workspace) ||
    !bounded(spec.maximum_files) ||
    !bounded(spec.maximum_mutants) ||
    !Array.isArray(spec.targets) ||
    spec.targets.length === 0 ||
    spec.targets.length > spec.maximum_files ||
    !Array.isArray(selected) ||
    selected.length !== spec.targets.length ||
    !plain(result) ||
    !Array.isArray(result.files) ||
    result.files.length !== spec.targets.length ||
    !Array.isArray(result.mutants) ||
    result.mutants.length > spec.maximum_mutants
  )
    refuse();
  const root = `/workspace/candidate/${spec.workspace}/`;
  const targetMap = new Map();
  for (const entry of spec.targets) {
    if (
      !plain(entry) ||
      !relative(entry.path) ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
      targetMap.has(entry.path)
    )
      refuse();
    targetMap.set(entry.path, { path: entry.path, sha256: entry.sha256, mutants: [] });
  }
  const local = (name) => {
    if (typeof name !== 'string' || !name.startsWith(root)) return refuse();
    const value = name.slice(root.length);
    if (!relative(value) || !targetMap.has(value)) return refuse();
    return value;
  };
  const seen = new Set();
  for (const entry of selected) {
    if (!plain(entry) || typeof entry.content !== 'string' || entry.mutate !== true) refuse();
    const path = local(entry.name);
    if (seen.has(path) || hash(entry.content) !== targetMap.get(path).sha256) refuse();
    seen.add(path);
  }
  const instrumented = new Set();
  for (const entry of result.files) {
    if (!plain(entry) || typeof entry.content !== 'string') refuse();
    const path = local(entry.name);
    if (instrumented.has(path)) refuse();
    instrumented.add(path);
  }
  const ids = new Set();
  for (const mutant of result.mutants) {
    if (
      !plain(mutant) ||
      typeof mutant.id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(mutant.id) ||
      ids.has(mutant.id) ||
      typeof mutant.mutatorName !== 'string' ||
      mutant.mutatorName.length === 0 ||
      mutant.mutatorName.length > 160 ||
      /[/\\\p{Cc}\p{Cs}]/u.test(mutant.mutatorName) ||
      typeof mutant.replacement !== 'string' ||
      !plain(mutant.location)
    )
      refuse();
    const path = local(mutant.fileName);
    const location = {};
    for (const key of ['start', 'end']) {
      const point = mutant.location[key];
      if (
        !plain(point) ||
        !Number.isSafeInteger(point.line) ||
        point.line < 0 ||
        !Number.isSafeInteger(point.column) ||
        point.column < 0 ||
        !Number.isSafeInteger(point.line + 1) ||
        !Number.isSafeInteger(point.column + 1)
      )
        refuse();
      // Exact conversion used by Stryker 9.6.1 objectUtils.toSchemaLocation.
      location[key] = { line: point.line + 1, column: point.column + 1 };
    }
    if (
      location.end.line < location.start.line ||
      (location.end.line === location.start.line && location.end.column < location.start.column)
    )
      refuse();
    ids.add(mutant.id);
    targetMap.get(path).mutants.push({
      id: mutant.id,
      mutatorName: mutant.mutatorName,
      replacementDigest: hash(mutant.replacement),
      location,
    });
  }
  const source_files = [...targetMap.values()].sort((a, b) => compare(a.path, b.path));
  for (const file of source_files) file.mutants.sort((a, b) => compare(a.id, b.id));
  return frozenCopy({
    selected: source_files.map(({ path, sha256 }) => ({ path, sha256 })),
    instrumented: [...instrumented].sort(compare),
    source_files,
  });
}

/**
 * The pinned core's four-stage orchestration, with a read-only observation at
 * its existing writeInstrumentedFiles boundary. Dependency injection is the
 * core API, not a production caller-selected runner. The installed entry point
 * resolves all four classes from the exact frozen core below.
 */
export async function runObservedStrykerPipeline({
  rootInjector,
  prepareInjector,
  stages,
  options,
  observe,
}) {
  let instrumenter;
  let originalRead;
  let originalWrite;
  try {
    const next = await prepareInjector.injectClass(stages.PrepareExecutor).execute({
      cliOptions: options,
      targetMutatePatterns: undefined,
    });
    instrumenter = next.injectClass(stages.MutantInstrumenterExecutor);
    originalRead = instrumenter.readFilesToMutate;
    originalWrite = instrumenter.writeInstrumentedFiles;
    let reads = 0;
    let writes = 0;
    let selected;
    let observation;
    instrumenter.readFilesToMutate = async function () {
      if (++reads !== 1) return refuse();
      const files = await originalRead.call(this);
      selected = structuredClone(files);
      return files;
    };
    instrumenter.writeInstrumentedFiles = function (result) {
      if (reads !== 1 || ++writes !== 1 || selected === undefined) return refuse();
      // Candidate code has not run: this precedes preprocessing, checker pool
      // initialization, sandbox creation and the dry run. Clones ensure even a
      // faulty observer cannot alter the instrumenter's actual execution data.
      const captured = observe(frozenCopy(selected), frozenCopy(result));
      if (
        captured === undefined ||
        captured === null ||
        typeof captured !== 'object' ||
        typeof captured.then === 'function'
      )
        refuse();
      observation = frozenCopy(captured);
      return originalWrite.call(this, result);
    };
    const dryRunInjector = await instrumenter.execute();
    if (reads !== 1 || writes !== 1 || observation === undefined) refuse();
    const mutationInjector = await dryRunInjector.injectClass(stages.DryRunExecutor).execute();
    const mutant_results = await mutationInjector
      .injectClass(stages.MutationTestExecutor)
      .execute();
    return { observation, mutant_results };
  } finally {
    if (instrumenter !== undefined) {
      instrumenter.readFilesToMutate = originalRead;
      instrumenter.writeInstrumentedFiles = originalWrite;
    }
    await rootInjector.dispose();
  }
}

/**
 * Actual pinned dependency loader for the protected container driver. Not a
 * CLI command: only the protected host supplies options and observation spec.
 * The caller must retain the observation outside candidate custody BEFORE
 * returning from onObservation. Raw reports and process results remain separate.
 */
export async function runPinnedProductionMutation({ options, observationSpec, onObservation }) {
  if (
    process.cwd() !== '/workspace/candidate' ||
    options?.configFile !== '/devai-host/stryker.config.json'
  )
    refuse();
  const require = createRequire('/workspace/candidate/package.json');
  const corePath = require.resolve('@stryker-mutator/core/package.json');
  const coreRequire = createRequire(corePath);
  for (const name of [
    '@stryker-mutator/core',
    '@stryker-mutator/instrumenter',
    '@stryker-mutator/typescript-checker',
    '@stryker-mutator/vitest-runner',
  ]) {
    const resolver = name === '@stryker-mutator/instrumenter' ? coreRequire : require;
    if (
      JSON.parse(readFileSync(resolver.resolve(`${name}/package.json`), 'utf8')).version !== '9.6.1'
    )
      refuse();
  }
  const base = join(dirname(corePath), 'dist/src');
  const [{ createInjector }, stages, { coreTokens }, logging] = await Promise.all([
    import(pathToFileURL(coreRequire.resolve('typed-inject')).href),
    import(pathToFileURL(join(base, 'process/index.js')).href),
    import(pathToFileURL(join(base, 'di/index.js')).href),
    import(pathToFileURL(join(base, 'logging/index.js')).href),
  ]);
  const rootInjector = createInjector();
  let prepareInjector;
  try {
    prepareInjector = logging
      .provideLogging(await logging.provideLoggingBackend(rootInjector, process.stdout))
      .provideValue(coreTokens.reporterOverride, undefined);
  } catch (error) {
    await rootInjector.dispose();
    throw error;
  }
  return runObservedStrykerPipeline({
    rootInjector,
    prepareInjector,
    stages,
    options,
    observe(selected, result) {
      const observation = observeProductionInstrumentation(observationSpec, selected, result);
      // Synchronous channel custody: no async callback can race test startup.
      if (onObservation(observation) !== undefined) refuse();
      return observation;
    },
  });
}
