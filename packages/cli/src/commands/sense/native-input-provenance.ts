import { createRequire } from 'node:module';
import { moduleResolve } from 'import-meta-resolve';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import {
  accessSync,
  existsSync,
  lstatSync,
  statSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { readCandidateFile } from '@devai-nyx/sensors';
import { canonicalize } from '../../services/check-runner/canonical.js';
import { nativeInputPackageClosure } from './native-runner-selection.js';
import { isHarnessMutatedPath, trackedPaths } from '../../services/check-runner/policy-git.js';
import { assertNativeConfigCapabilities } from './native-config-capabilities.js';

import { nativeOutputCustody } from './native-output-custody.js';

type Row = Record<string, unknown>;
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Actual resolved native helper roots are declarations that require their own capability closure. */
export function inspectNativeConfigurationSelection(
  root: string,
  stdout: string,
): readonly string[] {
  try {
    const report = JSON.parse(stdout) as {
      devaiCollection?: { reporter?: string; resolvedSelection?: Row[] };
    };
    const collection = report.devaiCollection;
    if (collection === undefined || !Array.isArray(collection.resolvedSelection))
      throw new Error('NATIVE_CONFIGURATION_SELECTION_MISSING');
    for (const selection of collection.resolvedSelection) {
      if (
        collection.reporter === 'vitest-v1' &&
        (selection['environment'] !== 'node' ||
          !['threads', 'forks'].includes(String(selection['pool'])))
      )
        throw new Error('NATIVE_CONFIGURATION_RUNTIME_UNSUPPORTED');
      for (const key of ['setupFiles', 'globalSetup', 'globalTeardown', 'customProviderModule']) {
        const value = selection[key];
        const paths = value == null ? [] : Array.isArray(value) ? value : [value];
        for (const path of paths) {
          if (
            typeof path !== 'string' ||
            path.length === 0 ||
            !/\.(?:[cm]?js|[cm]?ts)$/u.test(path)
          )
            throw new Error('NATIVE_CONFIGURATION_HELPER_UNSUPPORTED');
          const absolute = resolve(
            typeof selection['root'] === 'string' ? selection['root'] : root,
            path,
          );
          assertNativeConfigCapabilities(root, relative(root, absolute));
        }
      }
    }
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : 'NATIVE_CONFIGURATION_SELECTION_INVALID'];
  }
}

/** Validate ordered lifecycle facts only; this never creates execution authority. */
export function assertNativeScopeLifecycle(rows: readonly Row[]): void {
  type Phase = 'registered' | 'begun' | 'ready' | 'ended' | 'acknowledged';
  interface Scope {
    owner?: string;
    loader: boolean;
    phase: Phase;
    active: Map<number, string>;
    operations: Set<number>;
  }
  const scopes = new Map<string, Scope>();
  const invalid: () => never = () => {
    throw new Error('NATIVE_INPUT_SCOPE_LIFECYCLE_INVALID');
  };
  for (const row of rows) {
    const name = row['scope'];
    if (typeof name !== 'string') invalid();
    const kind = row['kind'];
    let scope = scopes.get(name);
    if (kind === 'begin') {
      if (name === 'main' && scope === undefined) {
        scope = { loader: false, phase: 'registered', active: new Map(), operations: new Set() };
        scopes.set(name, scope);
      }
      if (scope === undefined || scope.phase !== 'registered') invalid();
      scope.phase = 'begun';
      continue;
    }
    if (scope === undefined || scope.phase === 'ended' || scope.phase === 'acknowledged') invalid();
    if (kind === 'loader-hook-start' || kind === 'loader-hook-end') {
      const operation = row['operation'];
      const hook = row['hook'];
      if (
        !scope.loader ||
        typeof operation !== 'number' ||
        !Number.isSafeInteger(operation) ||
        operation <= 0 ||
        (hook !== 'resolve' && hook !== 'load')
      )
        invalid();
      if (kind === 'loader-hook-start') {
        if (scope.operations.has(operation)) invalid();
        scope.operations.add(operation);
        scope.active.set(operation, hook);
      } else {
        if (scope.active.get(operation) !== hook) invalid();
        scope.active.delete(operation);
      }
      continue;
    }
    // Only the trusted wrapper's balanced bootstrap hooks may precede its preload begin.
    if (scope.phase === 'registered') invalid();
    if (kind === 'child' || kind === 'loader-registration') {
      const child = row['childScope'];
      if (typeof child !== 'string' || !/^[0-9a-f]{32}$/u.test(child) || scopes.has(child))
        invalid();
      scopes.set(child, {
        owner: name,
        loader: kind === 'loader-registration',
        phase: 'registered',
        active: new Map(),
        operations: new Set(),
      });
    } else if (kind === 'loader-ready') {
      if (!scope.loader || scope.phase !== 'begun' || scope.active.size !== 0) invalid();
      scope.phase = 'ready';
    } else if (kind === 'end') {
      if ((scope.loader && scope.phase !== 'ready') || scope.active.size !== 0) invalid();
      for (const child of scopes.values()) {
        if (
          child.owner === name &&
          child.phase !== 'acknowledged' &&
          (child.loader || child.phase !== 'ended')
        )
          invalid();
      }
      scope.phase = 'ended';
    } else if (kind === 'loader-acknowledged' || kind === 'child-end') {
      const childName = row['childScope'];
      const child = typeof childName === 'string' ? scopes.get(childName) : undefined;
      if (
        child === undefined ||
        child.owner !== name ||
        child.active.size !== 0 ||
        child.loader !== (kind === 'loader-acknowledged') ||
        child.phase !== 'ended'
      )
        invalid();
      child.phase = 'acknowledged';
    }
  }
  if (scopes.get('main')?.phase !== 'ended') invalid();
  for (const [name, scope] of scopes) {
    if (
      scope.active.size !== 0 ||
      (name !== 'main' &&
        (scope.loader
          ? scope.phase !== 'acknowledged'
          : scope.phase !== 'ended' && scope.phase !== 'acknowledged'))
    )
      invalid();
  }
}

/** Reconstruct actual native input observations; an incomplete or changed trace has no standing. */
export function inspectNativeInputProvenance(
  root: string,
  nonce: string,
  raw: string,
  stdout: string,
  task: { readonly argv: readonly string[]; readonly cwd: string },
): readonly string[] {
  try {
    if (!/^[0-9a-f]{64}$/u.test(nonce) || Buffer.byteLength(raw) > 64 * 1024 * 1024)
      throw new Error('NATIVE_INPUT_TRACE_INVALID');
    const rows = raw
      .trim()
      .split('\n')
      .map((line): Row => {
        const row: unknown = JSON.parse(line);
        if (row === null || typeof row !== 'object' || Array.isArray(row))
          throw new Error('NATIVE_INPUT_TRACE_INVALID');
        const object = row as Row;
        if (object['nonce'] !== nonce || typeof object['scope'] !== 'string')
          throw new Error('NATIVE_INPUT_TRACE_CUSTODY_INVALID');
        return object;
      });
    const begins = new Set(
      rows.filter((row) => row['kind'] === 'begin').map((row) => row['scope']),
    );
    if (
      !begins.has('main') ||
      !rows.some((row) => row['kind'] === 'end' && row['scope'] === 'main')
    )
      throw new Error('NATIVE_INPUT_TRACE_INCOMPLETE');
    assertNativeScopeLifecycle(rows);
    const output = nativeOutputCustody(root, nonce, rows, stdout);
    const report = JSON.parse(stdout) as { devaiCollection?: { reporter?: string } };
    const loaderOperations = new Map<string, string>();
    const packageClosure = nativeInputPackageClosure(root);
    const resolutionManifests = new Set(
      packageClosure.edges.flatMap(({ from, request }) => {
        const paths: string[] = [];
        let directory = dirname(from);
        for (;;) {
          paths.push(resolve(directory, 'node_modules', request, 'package.json'));
          const parent = dirname(directory);
          if (parent === directory) break;
          directory = parent;
        }
        return paths;
      }),
    );
    const ancestorManifests = new Set<string>();
    for (let directory = dirname(root); ; directory = dirname(directory)) {
      for (const name of [
        'package.json',
        'pnpm-workspace.yaml',
        'lerna.json',
        'tsconfig.json',
        'jsconfig.json',
      ])
        ancestorManifests.add(resolve(directory, name));
      if (dirname(directory) === directory) break;
    }
    const taskRoot = resolve(root, task.cwd);
    const argv = task.argv;
    const configIndex = argv.findIndex((argument) => argument === '--config' || argument === '-c');
    const configPath = argv[configIndex + 1];
    if (configIndex < 0 || configPath === undefined || !configPath.startsWith('./'))
      throw new Error('NATIVE_INPUT_CONFIGURATION_PATH_INVALID');
    readCandidateFile(root, relative(root, resolve(taskRoot, configPath)));
    const configProbes = new Set<string>();
    for (let directory = taskRoot; ; directory = dirname(directory)) {
      for (const name of new Set([configPath.slice(2), basename(configPath)]))
        for (const extension of [
          '',
          '.js',
          '.mjs',
          '.cjs',
          '.ts',
          '.mts',
          '.cts',
          '.jsx',
          '.tsx',
          '.json',
          '.node',
        ])
          configProbes.add(resolve(directory, 'node_modules', name + extension));
      if (dirname(directory) === directory) break;
    }
    const packageRoots = Object.keys(packageClosure.manifests)
      .filter((path) => path !== resolve(root, 'package.json'))
      .map(dirname);
    const admitted = (path: string): boolean => {
      let directory = existsSync(path) && lstatSync(path).isDirectory() ? path : dirname(path);
      for (;;) {
        const manifestPath = resolve(directory, 'package.json');
        if (existsSync(manifestPath)) {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<
            string,
            unknown
          >;
          if (typeof manifest['name'] === 'string' && typeof manifest['version'] === 'string')
            return packageRoots.includes(directory);
        }
        const parent = dirname(directory);
        if (parent === directory) return false;
        directory = parent;
      }
    };
    const tracked = new Set(trackedPaths(root));
    for (const row of rows) {
      if (!begins.has(row['scope'])) throw new Error('NATIVE_INPUT_TRACE_SCOPE_MISSING');
      if (row['kind'] === 'unsupported')
        throw new Error(`NATIVE_INPUT_UNSUPPORTED:${String(row['operation'])}`);
      if (row['kind'] === 'child') {
        if (
          !begins.has(row['childScope']) ||
          !rows.some(
            (end) =>
              (end['kind'] === 'end' && end['scope'] === row['childScope']) ||
              (end['kind'] === 'child-end' && end['childScope'] === row['childScope']),
          )
        )
          throw new Error('NATIVE_INPUT_CHILD_TRACE_MISSING');
        continue;
      }
      if (row['kind'] === 'loader-registration') {
        const childScope = row['childScope'];
        if (
          report.devaiCollection?.reporter !== 'playwright-v1' ||
          typeof childScope !== 'string' ||
          !/^[0-9a-f]{32}$/u.test(childScope) ||
          !begins.has(childScope) ||
          !rows.some(
            (entry) => entry['kind'] === 'loader-ready' && entry['scope'] === childScope,
          ) ||
          !rows.some((entry) => entry['kind'] === 'end' && entry['scope'] === childScope) ||
          !rows.some(
            (entry) =>
              entry['kind'] === 'loader-acknowledged' &&
              entry['childScope'] === childScope &&
              entry['scope'] === row['scope'],
          )
        )
          throw new Error('NATIVE_INPUT_LOADER_SCOPE_INCOMPLETE');
        continue;
      }
      if (row['kind'] === 'loader-ready' || row['kind'] === 'loader-acknowledged') continue;
      if (row['kind'] === 'loader-hook-start' || row['kind'] === 'loader-hook-end') {
        const key = `${String(row['scope'])}:${String(row['operation'])}`;
        if (
          typeof row['operation'] !== 'number' ||
          !Number.isSafeInteger(row['operation']) ||
          row['operation'] <= 0 ||
          !['resolve', 'load'].includes(String(row['hook']))
        )
          throw new Error('NATIVE_INPUT_LOADER_OPERATION_INVALID');
        if (row['kind'] === 'loader-hook-start') {
          if (loaderOperations.has(key)) throw new Error('NATIVE_INPUT_LOADER_OPERATION_INVALID');
          loaderOperations.set(key, String(row['hook']));
        } else {
          if (loaderOperations.get(key) !== row['hook'])
            throw new Error('NATIVE_INPUT_LOADER_OPERATION_INCOMPLETE');
          loaderOperations.delete(key);
        }
        continue;
      }
      if (row['kind'] === 'begin') {
        if (row['version'] !== process.version || row['node'] !== process.execPath)
          throw new Error('NATIVE_INPUT_INTERPRETER_CHANGED');
        continue;
      }
      if (row['kind'] === 'end' || row['kind'] === 'child-end') continue;
      if (output(row)) continue;
      if (row['kind'] === 'module-load') {
        if (
          typeof row['path'] !== 'string' ||
          digest(readFileSync(row['path'])) !== row['rawSha256'] ||
          typeof row['sourceSha256'] !== 'string' ||
          !/^[0-9a-f]{64}$/u.test(row['sourceSha256']) ||
          (row['sourceSha256'] !== row['rawSha256'] &&
            (report.devaiCollection?.reporter !== 'playwright-v1' ||
              !(
                output.hasTransformedSource(row['sourceSha256']) ||
                (row['moduleUrl'] === `${pathToFileURL(row['path']).href}.esm.preflight` &&
                  row['sourceSha256'] === digest(Buffer.from('void 0;')))
              )))
        )
          throw new Error('NATIVE_INPUT_MODULE_SOURCE_CHANGED');
        continue;
      }
      if (row['kind'] === 'runtime-environment') {
        const report = JSON.parse(stdout) as {
          devaiCollection?: { reporter?: string; resolvedSelection?: Row[] };
        };
        const environment = row['environment'];
        const initial = rows.find(
          (entry) =>
            entry['kind'] === 'begin' &&
            entry['scope'] === (row['runtime'] === 'esbuild' ? row['scope'] : 'main'),
        )?.['initialRuntimeEnvironment'] as Record<string, unknown> | undefined;
        const keys = [
          'BASE_URL',
          'DEV',
          'MODE',
          'PROD',
          'FORCE_TTY',
          'PLAYWRIGHT_TEST',
          'FORCE_COLOR',
          'DEBUG_COLORS',
        ];
        if (
          environment === null ||
          typeof environment !== 'object' ||
          Array.isArray(environment) ||
          initial === undefined ||
          JSON.stringify(Object.keys(environment).sort()) !== JSON.stringify([...keys].sort())
        )
          throw new Error('NATIVE_INPUT_RUNTIME_ENVIRONMENT_INVALID');
        const actual = environment as Record<string, unknown>;
        const same = (expected: Record<string, unknown>): boolean =>
          keys.every((key) => actual[key] === expected[key]);
        if (row['runtime'] === 'esbuild' && same(initial)) continue;
        if (
          report.devaiCollection?.reporter === 'playwright-v1' &&
          row['runtime'] === 'node' &&
          same({
            ...initial,
            PLAYWRIGHT_TEST: '1',
            FORCE_COLOR: '1',
            DEBUG_COLORS: initial['DEBUG_COLORS'] ?? '1',
          })
        )
          continue;
        if (
          report.devaiCollection?.reporter !== 'vitest-v1' ||
          !report.devaiCollection.resolvedSelection?.some((selection) => {
            const vite = selection['viteEnvironment'] as Record<string, unknown> | undefined;
            const test = selection['testEnvironment'] as Record<string, unknown> | undefined;
            if (vite === undefined || test === undefined) return false;
            const expected = Object.fromEntries(
              keys.map((key) => {
                if (['PLAYWRIGHT_TEST', 'FORCE_COLOR', 'DEBUG_COLORS'].includes(key))
                  return [key, initial[key]];
                if (key === 'FORCE_TTY')
                  return [key, row['runtime'] === 'esbuild' ? initial[key] : selection['forceTTY']];
                const parent =
                  initial[key] ??
                  (key === 'DEV' || key === 'PROD' ? (vite[key] ? '1' : '') : vite[key]);
                return [key, row['runtime'] === 'esbuild' ? parent : (test[key] ?? parent)];
              }),
            );
            return (row['runtime'] === 'node' || row['runtime'] === 'esbuild') && same(expected);
          })
        )
          throw new Error('NATIVE_INPUT_RUNTIME_ENVIRONMENT_CHANGED');
        continue;
      }
      if (row['kind'] === 'resolve') {
        if (
          typeof row['specifier'] !== 'string' ||
          typeof row['parent'] !== 'string' ||
          (typeof row['url'] !== 'string' && typeof row['error'] !== 'string') ||
          !Array.isArray(row['conditions']) ||
          !row['conditions'].every((condition) => typeof condition === 'string')
        )
          throw new Error('NATIVE_INPUT_RESOLUTION_INVALID');
        let resolved: string | undefined;
        let failure: string | undefined;
        try {
          try {
            const report = JSON.parse(stdout) as { devaiCollection?: { reporter?: string } };
            const preflight =
              report.devaiCollection?.reporter === 'playwright-v1' &&
              row['specifier'].startsWith('file:') &&
              row['specifier'].endsWith('.esm.preflight');
            // Playwright 1.60 resolves the real ESM input before appending its synthetic
            // preflight suffix. Loading and file-byte admission remain independently checked.
            resolved = moduleResolve(
              preflight ? row['specifier'].slice(0, -'.esm.preflight'.length) : row['specifier'],
              new URL(row['parent']),
              new Set(row['conditions'] as string[]),
            ).href;
            if (preflight) resolved += '.esm.preflight';
          } catch (error) {
            if (!row['conditions'].includes('require')) throw error;
            resolved = pathToFileURL(createRequire(row['parent']).resolve(row['specifier'])).href;
          }
        } catch (error) {
          failure = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
        }
        if (resolved !== row['url'] || failure !== row['error'])
          throw new Error(`NATIVE_INPUT_RESOLUTION_CHANGED:${rows.indexOf(row)}`);
        continue;
      }
      const operation = row['operation'];
      const path = row['path'];
      if (
        row['kind'] !== 'observation' ||
        ![
          'readFile',
          'readdir',
          'stat',
          'lstat',
          'access',
          'realpath',
          'readlink',
          'exists',
          'stat-field',
        ].includes(String(operation)) ||
        typeof path !== 'string' ||
        !isAbsolute(path) ||
        resolve(path) !== path
      )
        throw new Error('NATIVE_INPUT_TRACE_OBSERVATION_INVALID');
      const portable = relative(root, path).replaceAll('\\', '/');
      const candidate = portable !== '..' && !portable.startsWith('../') && !isAbsolute(portable);
      if (candidate && isHarnessMutatedPath(portable))
        throw new Error('NATIVE_INPUT_MUTATED_NAMESPACE');
      let observation: Row;
      try {
        const physical = existsSync(path) ? realpathSync(path) : path;
        const packageInput = admitted(physical);
        const ancestor =
          root === path ||
          root.startsWith(`${path}/`) ||
          packageRoots.some((directory) => directory.startsWith(`${path}/`));
        const absentResolutionManifest =
          operation === 'exists' &&
          (row['observation'] as Row)?.['value'] === false &&
          resolutionManifests.has(path) &&
          !existsSync(path);
        const absentAncestorManifest =
          ancestorManifests.has(path) &&
          !existsSync(path) &&
          ((['readFile', 'stat', 'lstat'].includes(String(operation)) &&
            (row['observation'] as Row)?.['error'] === 'ENOENT') ||
            (operation === 'exists' && (row['observation'] as Row)?.['value'] === false));
        const absentConfigProbe =
          configProbes.has(path) &&
          !existsSync(path) &&
          ['stat', 'lstat'].includes(String(operation)) &&
          (row['observation'] as Row)?.['error'] === 'ENOENT';
        if (
          !candidate &&
          !packageInput &&
          !ancestor &&
          !absentResolutionManifest &&
          !absentAncestorManifest &&
          !absentConfigProbe
        )
          throw new Error(`NATIVE_INPUT_EXTERNAL_PATH:${path}`);
        if (candidate && physical !== path && !packageInput)
          throw new Error('NATIVE_INPUT_COMPONENT_LINK');
        if (absentAncestorManifest && operation === 'readFile') readFileSync(path);
        if (operation === 'readFile') {
          const physicalRelative = relative(root, physical);
          const physicalCandidate =
            physicalRelative !== '..' &&
            !physicalRelative.startsWith('../') &&
            !isAbsolute(physicalRelative);
          if (physicalCandidate && !physicalRelative.split('/').includes('node_modules')) {
            if (!tracked.has(physicalRelative)) throw new Error('NATIVE_INPUT_UNTRACKED_FILE');
            readCandidateFile(root, physicalRelative);
          }
          if (candidate && !packageInput) {
            if (!tracked.has(portable)) throw new Error('NATIVE_INPUT_UNTRACKED_FILE');
            readCandidateFile(root, portable);
          } else if (!packageInput) throw new Error('NATIVE_INPUT_EXTERNAL_FILE');
          const encoding = row['encoding'];
          if (encoding !== null && (typeof encoding !== 'string' || !Buffer.isEncoding(encoding)))
            throw new Error('NATIVE_INPUT_ENCODING_INVALID');
          const bytes =
            encoding === null
              ? readFileSync(path)
              : Buffer.from(readFileSync(path, encoding as BufferEncoding));
          observation = { sha256: digest(bytes), realpath: realpathSync(path) };
        } else if (operation === 'readdir') {
          const entries =
            row['dirents'] === true
              ? readdirSync(path, { withFileTypes: true }).map((entry) => [
                  entry.name,
                  entry.isDirectory()
                    ? 'directory'
                    : entry.isFile()
                      ? 'file'
                      : entry.isSymbolicLink()
                        ? 'symlink'
                        : 'other',
                ])
              : readdirSync(path).map((entry) => [entry]);
          observation = { entries };
        } else if (operation === 'stat' || operation === 'lstat') {
          if (operation === 'stat') statSync(path);
          else lstatSync(path);
          observation = {
            present: true,
            ...(operation === 'stat' ? { realpath: realpathSync(path) } : {}),
          };
        } else if (operation === 'stat-field') {
          if (
            (row['statOperation'] !== 'stat' && row['statOperation'] !== 'lstat') ||
            typeof row['field'] !== 'string'
          )
            throw new Error('NATIVE_INPUT_STAT_FIELD_INVALID');
          const stat =
            row['bigint'] === true
              ? row['statOperation'] === 'stat'
                ? statSync(path, { bigint: true })
                : lstatSync(path, { bigint: true })
              : row['statOperation'] === 'stat'
                ? statSync(path)
                : lstatSync(path);
          const value: unknown = Reflect.get(stat, row['field']);
          if (typeof value === 'function' || typeof value === 'symbol')
            throw new Error('NATIVE_INPUT_STAT_FIELD_INVALID');
          observation = {
            value:
              typeof value === 'bigint'
                ? value.toString()
                : value instanceof Date
                  ? value.toISOString()
                  : (value ?? null),
          };
        } else if (operation === 'realpath') observation = { value: realpathSync(path) };
        else if (operation === 'readlink') observation = { value: readlinkSync(path) };
        else if (operation === 'exists') observation = { value: existsSync(path) };
        else {
          const mode = row['accessMode'];
          if (typeof mode !== 'number' || !Number.isSafeInteger(mode))
            throw new Error('NATIVE_INPUT_ACCESS_MODE_INVALID');
          accessSync(path, mode);
          observation = { value: null };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (message.startsWith('NATIVE_INPUT_')) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        observation = { error: typeof code === 'string' ? code : 'UNKNOWN' };
      }
      if (canonicalize(observation) !== canonicalize(row['observation']))
        throw new Error('NATIVE_INPUT_OBSERVATION_CHANGED');
    }
    if (loaderOperations.size !== 0) throw new Error('NATIVE_INPUT_LOADER_OPERATION_INCOMPLETE');
    output.finish();
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : 'NATIVE_INPUT_TRACE_INVALID'];
  }
}
