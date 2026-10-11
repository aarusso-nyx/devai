import { existsSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readCandidateFile } from '@devai-nyx/sensors';
import { sha256Hex } from '../../services/check-runner/canonical.js';
import { trackedPaths, isHarnessMutatedPath } from '../../services/check-runner/policy-git.js';
import type { PlannedTask } from '../../services/check-runner/types.js';
import { assertNativeConfigCapabilities } from './native-config-capabilities.js';
import type { NativeTestResultContract } from './native-test-results.js';

/** Reconstruct the private execution recipe without changing the authored task identity. */
export function nativeExecutionCommand(root: string, task: PlannedTask, nonce: string) {
  if (!/^[0-9a-f]{64}$/u.test(nonce)) throw new Error('SENSE_NATIVE_NONCE_INVALID');
  const contract = task.outputContract['resultPopulation'] as NativeTestResultContract;
  const outputRoot =
    contract.selectionEvidence?.reporter === 'playwright-v1'
      ? resolve(root, '.devai/state/native-config-traces', nonce, 'runtime/playwright-results')
      : null;
  return Object.freeze({
    executable: realpathSync(process.execPath),
    argv: Object.freeze([
      task.executable.path,
      ...task.argv.slice(1),
      ...(outputRoot === null ? [] : ['--output', outputRoot]),
    ]),
    outputRoot,
  });
}

/** Actual native collection, package-owned instrumentation, and complete candidate input closure. */
export function nativeRunnerSelection(
  root: string,
  task: PlannedTask,
  contract: NativeTestResultContract,
): string {
  const selection = contract.selectionEvidence;
  if (selection === undefined) throw new Error('SENSE_NATIVE_COLLECTION_REQUIRED');
  const vitest = selection.reporter === 'vitest-v1';
  if ((vitest ? 'vitest-json' : 'playwright-json') !== contract.format)
    throw new Error('SENSE_NATIVE_REPORTER_FORMAT_MISMATCH');
  const require = createRequire(resolve(root, task.cwd, 'package.json'));
  const packageName = vitest ? 'vitest' : '@playwright/test';
  const manifestPath = require.resolve(`${packageName}/package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    name?: string;
    version?: string;
    bin?: string | Record<string, string>;
  };
  const executableName = vitest ? 'vitest' : 'playwright';
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[executableName];
  if (
    manifest.name !== packageName ||
    typeof bin !== 'string' ||
    (vitest ? manifest.version !== '4.1.11' : manifest.version !== '1.60.0') ||
    realpathSync(resolve(dirname(manifestPath), bin)) !== realpathSync(task.executable.path)
  )
    throw new Error('SENSE_NATIVE_EXECUTABLE_UNRECOGNIZED');
  const viteManifest = vitest
    ? (JSON.parse(
        readFileSync(createRequire(manifestPath).resolve('vite/package.json'), 'utf8'),
      ) as { version?: string })
    : undefined;
  if (vitest && viteManifest?.version !== '7.3.6')
    throw new Error('SENSE_NATIVE_VITE_VERSION_UNSUPPORTED');
  const exportName = `@aarusso-nyx/devai/native-${vitest ? 'vitest' : 'playwright'}-reporter`;
  const argv = task.argv.slice(1);
  if (argv.shift() !== (vitest ? 'run' : 'test')) throw new Error('SENSE_NATIVE_RUN_MODE_REQUIRED');
  let configPath: string | undefined;
  let reporter = false;
  let loader = !vitest;
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index];
    if (word === '--reporter' || word === `--reporter=${exportName}`) {
      if (reporter || (word === '--reporter' && argv[++index] !== exportName))
        throw new Error('SENSE_NATIVE_REPORTER_SELECTION_INVALID');
      reporter = true;
    } else if (vitest && word === '--configLoader') {
      if (loader || argv[++index] !== 'native')
        throw new Error('SENSE_NATIVE_CONFIG_LOADER_UNSUPPORTED');
      loader = true;
    } else if (word === '--config' || word === '-c') {
      const path = argv[++index];
      if (path === undefined) throw new Error('SENSE_NATIVE_CONFIG_REQUIRED');
      if (!path.startsWith('./')) throw new Error('SENSE_NATIVE_CONFIG_PATH_REQUIRED');
      const relativePath = relative(root, resolve(root, task.cwd, path));
      if (isHarnessMutatedPath(relativePath))
        throw new Error('SENSE_NATIVE_CONFIG_IN_MUTATED_NAMESPACE');
      readCandidateFile(root, relativePath);
      if (configPath !== undefined) throw new Error('SENSE_NATIVE_CONFIG_REPEATED');
      configPath = relativePath;
    } else if (!vitest && word === '--project') {
      if (argv[++index] !== selection.projectName)
        throw new Error('SENSE_NATIVE_PROJECT_SELECTION_INVALID');
    } else if (vitest && ['--no-cache', '--no-file-parallelism'].includes(word ?? '')) {
      // Execution controls do not select files or test names.
    } else throw new Error('SENSE_NATIVE_SELECTION_UNSUPPORTED');
  }
  if (configPath === undefined) throw new Error('SENSE_NATIVE_EXPLICIT_CONFIG_REQUIRED');
  assertNativeConfigCapabilities(root, configPath);
  if (!loader) throw new Error('SENSE_NATIVE_CONFIG_LOADER_REQUIRED');
  if (!reporter) throw new Error('SENSE_NATIVE_REPORTER_REQUIRED');
  const reporterPath = require.resolve(exportName);
  const asset = vitest ? 'native-test-reporter.js' : 'native-playwright-reporter.js';
  const besideBundle = new URL(`./${asset}`, import.meta.url);
  const hostPath = existsSync(besideBundle)
    ? besideBundle
    : new URL(`../../../dist/runtime/index/${asset}`, import.meta.url);
  const reporterSha = sha256Hex(readFileSync(fileURLToPath(hostPath)));
  if (sha256Hex(readFileSync(reporterPath)) !== reporterSha)
    throw new Error('SENSE_NATIVE_REPORTER_BYTES_MISMATCH');
  const inputs = new Set(task.inputPaths);
  for (const path of trackedPaths(root)) {
    if (isHarnessMutatedPath(path)) continue;
    if (!inputs.has(path)) throw new Error('SENSE_NATIVE_CONFIG_CLOSURE_INCOMPLETE');
    readCandidateFile(root, path);
  }
  const packages: Record<string, string> = {};
  const visited = new Set<string>();
  const resolveManifest = (from: string, name: string): string => {
    const resolver = createRequire(from);
    try {
      return resolver.resolve(`${name}/package.json`);
    } catch {
      let directory = dirname(resolver.resolve(name));
      for (;;) {
        const path = resolve(directory, 'package.json');
        if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).name === name) return path;
        const parent = dirname(directory);
        if (parent === directory) throw new Error('SENSE_NATIVE_DEPENDENCY_MANIFEST_MISSING');
        directory = parent;
      }
    }
  };
  const hashPackage = (
    directory: string,
    packageRoot: string,
    files: Record<string, string>,
  ): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) hashPackage(path, packageRoot, files);
      else if (entry.isFile()) files[relative(packageRoot, path)] = sha256Hex(readFileSync(path));
      else throw new Error('SENSE_NATIVE_RUNNER_PACKAGE_NONREGULAR');
    }
  };
  const visitPackage = (path: string): void => {
    path = realpathSync(path);
    if (visited.has(path)) return;
    visited.add(path);
    const document = JSON.parse(readFileSync(path, 'utf8')) as {
      name: string;
      version: string;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    const files: Record<string, string> = {};
    hashPackage(dirname(path), dirname(path), files);
    packages[path] = sha256Hex({ name: document.name, version: document.version, files });
    const optional = new Set(Object.keys(document.optionalDependencies ?? {}));
    for (const [name, metadata] of Object.entries(document.peerDependenciesMeta ?? {}))
      if (metadata.optional === true) optional.add(name);
    const names = new Set([
      ...Object.keys(document.dependencies ?? {}),
      ...Object.keys(document.optionalDependencies ?? {}),
      ...Object.keys(document.peerDependencies ?? {}),
    ]);
    for (const name of [...names].sort()) {
      let dependency: string;
      try {
        dependency = resolveManifest(path, name);
      } catch {
        if (optional.has(name)) continue;
        throw new Error(`SENSE_NATIVE_DEPENDENCY_UNRESOLVED:${name}`);
      }
      visitPackage(dependency);
    }
  };
  visitPackage(manifestPath);
  const inputPackages = nativeInputPackageClosure(root);
  return sha256Hex({
    executionRecipe: vitest ? 'node-native-v1' : 'node-native-owned-playwright-results-v1',
    nodeExecutable: realpathSync(process.execPath),
    nodeExecutableSha256: sha256Hex(readFileSync(process.execPath)),
    nodeVersion: process.version,
    reporterSha,
    provenancePreloadSha: sha256Hex(readFileSync(nativeInputPreloadPath())),
    playwrightLoaderSha: sha256Hex(
      readFileSync(
        new URL('./native-playwright-loader.js', pathToFileURL(nativeInputPreloadPath())),
      ),
    ),
    runnerManifest: sha256Hex(readFileSync(manifestPath)),
    runnerExecutable: task.executable.sha256,
    packages,
    inputPackages,
    selection,
  });
}

/** Adopter-declared installed instances, reached through their actual manifest dependency edges. */
export function nativeInputPackageClosure(root: string): {
  readonly manifests: Readonly<Record<string, string>>;
  readonly edges: readonly { from: string; request: string; to: string }[];
} {
  const manifests: Record<string, string> = {};
  const edges: { from: string; request: string; to: string }[] = [];
  const pending = [resolve(root, 'package.json')];
  for (let index = 0; index < pending.length; index += 1) {
    const path = realpathSync(pending[index] as string);
    if (Object.hasOwn(manifests, path)) continue;
    const bytes = readFileSync(path);
    manifests[path] = sha256Hex(bytes);
    const document = JSON.parse(bytes.toString()) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    const resolver = createRequire(path);
    const names = {
      ...document.dependencies,
      ...document.optionalDependencies,
      ...document.peerDependencies,
      ...(index === 0 ? document.devDependencies : {}),
    };
    for (const name of Object.keys(names).sort()) {
      try {
        let dependency: string;
        try {
          dependency = resolver.resolve(`${name}/package.json`);
        } catch {
          let directory = dirname(resolver.resolve(name));
          for (;;) {
            const candidate = resolve(directory, 'package.json');
            if (
              existsSync(candidate) &&
              JSON.parse(readFileSync(candidate, 'utf8')).name === name
            ) {
              dependency = candidate;
              break;
            }
            const parent = dirname(directory);
            if (parent === directory) throw new Error('NATIVE_INPUT_PACKAGE_MANIFEST_MISSING');
            directory = parent;
          }
        }
        edges.push({ from: path, request: name, to: realpathSync(dependency) });
        pending.push(dependency);
      } catch {
        if (
          Object.hasOwn(document.optionalDependencies ?? {}, name) ||
          document.peerDependenciesMeta?.[name]?.optional === true
        )
          continue;
        throw new Error(`SENSE_NATIVE_INPUT_PACKAGE_UNRESOLVED:${name}`);
      }
    }
  }
  return Object.freeze({
    manifests: Object.freeze(manifests),
    edges: Object.freeze(edges.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))),
  });
}

/** Asset identity comes from this installed host, never from the adopter. */
export function nativeInputPreloadPath(): string {
  const beside = new URL('./native-input-provenance.js', import.meta.url);
  return fileURLToPath(
    existsSync(beside)
      ? beside
      : new URL('../../../dist/runtime/index/native-input-provenance.js', import.meta.url),
  );
}
