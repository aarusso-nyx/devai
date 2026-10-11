import { delimiter, dirname, isAbsolute, matchesGlob, relative, resolve } from 'node:path';
import { types } from 'node:util';
import type ts from 'typescript';
const isProxy = types.isProxy;
const isUint8Array = types.isUint8Array;
const isArrayBuffer = types.isArrayBuffer;

import type { NativeCoverageAdapterOptions } from './native-coverage-types.js';
export type { NativeCoverageAdapterOptions } from './native-coverage-types.js';

type CompilationMode = 'production' | 'coverage';
type Output = { path: string; text: string; sha256: string };
type Input = { path: string; sha256: string; origin: 'candidate' | 'dependency' };

const refuse = (reason: string): never => {
  throw new Error(`NATIVE_COVERAGE_ADAPTER_${reason}`);
};
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const intrinsicBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get;
const intrinsicOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')?.get;
const intrinsicLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;
const within = (root: string, path: string): boolean =>
  path === root || path.startsWith(`${root}/`);
const portable = (path: unknown): path is string =>
  typeof path === 'string' &&
  path.length > 0 &&
  !isAbsolute(path) &&
  !/[:\\?#]/u.test(path) &&
  !path.includes('\0') &&
  path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || isProxy(value)) return refuse('DATA_REQUIRED');
  if (Object.getPrototypeOf(value) !== Object.prototype) return refuse('DATA_REQUIRED');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    JSON.stringify(Reflect.ownKeys(descriptors).sort()) !== JSON.stringify([...keys].sort()) ||
    Object.values(descriptors).some((entry) => !('value' in entry) || !entry.enumerable)
  )
    return refuse('DATA_REQUIRED');
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]?.value]));
}

function array(value: unknown): unknown[] {
  if (value === null || typeof value !== 'object' || isProxy(value) || !Array.isArray(value))
    return refuse('ARRAY_REQUIRED');
  if (Object.getPrototypeOf(value) !== Array.prototype) return refuse('ARRAY_REQUIRED');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== value.length + 1 ||
    Array.from({ length: value.length }, (_, index) => descriptors[index]).some(
      (entry) => entry === undefined || !('value' in entry) || !entry.enumerable,
    )
  )
    return refuse('ARRAY_REQUIRED');
  return Array.from({ length: value.length }, (_, index) => descriptors[index]?.value);
}

function patterns(value: unknown, nonempty: boolean): string[] {
  const rows = array(value);
  if (
    (nonempty && rows.length === 0) ||
    rows.some((entry) => !portable(entry) || entry.startsWith('!')) ||
    new Set(rows).size !== rows.length
  )
    return refuse('PATTERN_INVALID');
  return rows as string[];
}

export interface NativeCoverageKernelHost {
  readonly io: {
    readonly createHash: typeof import('node:crypto').createHash;
    readonly execFileSync: typeof import('node:child_process').execFileSync;
    readonly accessSync: typeof import('node:fs').accessSync;
    readonly constants: typeof import('node:fs').constants;
    readonly lstatSync: typeof import('node:fs').lstatSync;
    readonly readFileSync: typeof import('node:fs').readFileSync;
    readonly readdirSync: typeof import('node:fs').readdirSync;
    readonly readlinkSync: typeof import('node:fs').readlinkSync;
    readonly realpathSync: typeof import('node:fs').realpathSync;
    readonly createRequire: typeof import('node:module').createRequire;
  };
  readonly path: string;
  readonly mode: 'diagnostic' | 'governed';
  readonly bound?: {
    readonly repository: string;
    readonly candidate: string;
    readonly packageDir: string;
    readonly git: { readonly path: string; readonly sha256: string };
    readonly tracked: readonly string[];
    readonly excludedPrefixes: readonly string[];
  };
}

/** Pure callback kernel: importing this module captures no filesystem or process authority. */
export function createNativeCoverageAdapterKernel(
  options: NativeCoverageAdapterOptions,
  host: NativeCoverageKernelHost,
) {
  const {
    createHash,
    execFileSync,
    accessSync,
    constants,
    lstatSync,
    readFileSync,
    readdirSync,
    readlinkSync,
    realpathSync,
    createRequire,
  } = host.io;
  const hash = (value: string | Uint8Array): string =>
    createHash('sha256').update(value).digest('hex');
  const data = record(options, ['packageDir', 'config', 'modules', 'includes', 'excludes']);
  if (typeof data['packageDir'] !== 'string' || data['config'] !== 'tsconfig.json')
    return refuse('OPTIONS_INVALID');
  const packageDir = resolve(data['packageDir']);
  if (realpathSync(packageDir) !== packageDir) return refuse('PACKAGE_LINK');
  if (host.bound !== undefined && packageDir !== host.bound.packageDir)
    return refuse('PACKAGE_CONTEXT_MISMATCH');
  let gitExecutable: string | undefined = host.bound?.git.path;
  for (const directory of (gitExecutable === undefined ? host.path : '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    try {
      const path = realpathSync(resolve(directory, 'git'));
      accessSync(path, constants.X_OK);
      if (!lstatSync(path).isFile()) continue;
      gitExecutable = path;
      break;
    } catch {
      /* An unavailable search entry grants no executable identity. */
    }
  }
  if (gitExecutable === undefined) return refuse('GIT_EXECUTABLE_MISSING');
  const gitPath = gitExecutable;
  if (!isAbsolute(gitPath) || realpathSync(gitPath) !== gitPath || !lstatSync(gitPath).isFile())
    return refuse('GIT_EXECUTABLE_INVALID');
  const gitSha256 = hash(readFileSync(gitPath));
  if (host.bound !== undefined && gitSha256 !== host.bound.git.sha256)
    return refuse('GIT_EXECUTABLE_CHANGED');
  const git = (argv: readonly string[]): string =>
    execFileSync(gitPath, ['-c', 'core.fsmonitor=false', ...argv], {
      cwd: packageDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_COUNT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      },
    });
  const repository =
    host.bound?.repository ?? realpathSync(git(['rev-parse', '--show-toplevel']).trim());
  const candidate = git(['rev-parse', '--verify', 'HEAD']).trim();
  if (!/^[0-9a-f]{40}$/u.test(candidate) || !within(repository, packageDir))
    return refuse('CANDIDATE_INVALID');
  if (
    host.bound !== undefined &&
    (repository !== host.bound.repository || candidate !== host.bound.candidate)
  )
    return refuse('CANDIDATE_CONTEXT_MISMATCH');
  const trackedArgs = ['-C', repository, 'ls-files', '--full-name', '-z'];
  const trackedBytes =
    host.bound === undefined ? git(trackedArgs) : `${host.bound.tracked.join('\0')}\0`;
  const tracked = new Set(trackedBytes.split('\0').filter(Boolean));
  const includes = patterns(data['includes'], true);
  const excludes = patterns(data['excludes'], false);
  const modules = array(data['modules']).map((entry) => {
    const module = record(entry, ['source', 'output']);
    const source = module['source'];
    const output = module['output'];
    if (
      !portable(source) ||
      !portable(output) ||
      !source.endsWith('.ts') ||
      source.endsWith('.d.ts') ||
      !output.endsWith('.js')
    )
      return refuse('MODULE_INVALID');
    return { source, output };
  });
  if (modules.length === 0) return refuse('MODULES_EMPTY');
  const names = modules.flatMap(({ source, output }) => [source, output, `${output}.map`]);
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length)
    return refuse('MODULE_AMBIGUOUS');
  const input = new Map<string, Input>();
  const readRoutes = new Map<string, string>();
  const observations = new Map<string, string>();
  const dependencyRoots = new Set<string>();
  const edges: { from: string; request: string; to: string; route: string }[] = [];
  const missing: { from: string; request: string; route: string }[] = [];
  const derived = new Map<string, { text: string; source: string; mode: CompilationMode }>();
  const verifiedOutputs = new Map<string, string>();
  let failed: unknown;
  const guard = <T>(operation: () => T): T => {
    if (failed !== undefined) throw failed;
    try {
      return operation();
    } catch (error) {
      failed = error;
      throw error;
    }
  };
  const regular = (path: string): string => {
    path = resolve(path);
    let current = path;
    while (within(repository, current) && current !== repository) {
      if (lstatSync(current).isSymbolicLink()) return refuse('INPUT_LINK');
      current = dirname(current);
    }
    if (!lstatSync(path).isFile() || lstatSync(path).nlink !== 1 || realpathSync(path) !== path)
      return refuse('INPUT_NOT_REGULAR');
    return path;
  };
  const origin = (path: string): Input['origin'] => {
    if (
      within(repository, path) &&
      !relative(repository, path).split('/').includes('node_modules')
    ) {
      if (tracked.has(relative(repository, path))) return 'candidate';
      return refuse('INPUT_UNBOUND');
    }
    if ([...dependencyRoots].some((root) => within(root, path))) return 'dependency';
    return refuse('INPUT_UNBOUND');
  };
  const read = (path: string): string => {
    path = resolve(path);
    if (relative(repository, path).split('/').includes('.git'))
      return refuse('REPOSITORY_ADMINISTRATION_INPUT');
    // Declared dependency links resolve to an exact manifest instance, never a repository link grant.
    if (within(repository, path) && !relative(repository, path).split('/').includes('node_modules'))
      regular(path);
    const physical = realpathSync(path);
    const priorRoute = readRoutes.get(path);
    if (priorRoute !== undefined && priorRoute !== physical)
      return refuse('INPUT_RESOLUTION_CHANGED');
    readRoutes.set(path, physical);
    const source = origin(physical);
    if (source === 'candidate') regular(physical);
    else if (!lstatSync(physical).isFile()) return refuse('INPUT_NOT_REGULAR');
    const bytes = readFileSync(physical);
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) return refuse('UTF8_INVALID');
    const observation = { path: physical, sha256: hash(bytes), origin: source };
    const prior = input.get(physical);
    if (prior !== undefined && prior.sha256 !== observation.sha256) return refuse('INPUT_CHANGED');
    input.set(physical, observation);
    return text;
  };
  const negativeResolutionRoots = new Set<string>();
  for (let directory = dirname(repository); ; directory = dirname(directory)) {
    negativeResolutionRoots.add(resolve(directory, 'node_modules'));
    if (dirname(directory) === directory) break;
  }
  const observe = (kind: 'file' | 'directory' | 'entries' | 'scan', path: string): unknown => {
    path = resolve(path);
    if (relative(repository, path).split('/').includes('.git'))
      return refuse('REPOSITORY_ADMINISTRATION_INPUT');
    const candidateRelative = relative(repository, path);
    if (
      host.bound?.excludedPrefixes.some(
        (prefix) =>
          candidateRelative === prefix.slice(0, -1) || candidateRelative.startsWith(prefix),
      )
    )
      return refuse('INPUT_EXCLUDED_NAMESPACE');
    if (!within(repository, path) && ![...dependencyRoots].some((root) => within(root, path))) {
      // TypeScript's ordinary upward node_modules search can observe only absence.
      // Existing external directories/files, listings and arbitrary typeRoots stay refused.
      if (
        kind === 'entries' ||
        kind === 'scan' ||
        ![...negativeResolutionRoots].some((root) => within(root, path))
      )
        return refuse('RESOLUTION_UNBOUND');
      try {
        lstatSync(path);
        return refuse('RESOLUTION_UNBOUND');
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw error;
      }
      const key = JSON.stringify([kind, path]);
      if (observations.has(key) && observations.get(key) !== 'false')
        return refuse('RESOLUTION_CHANGED');
      observations.set(key, 'false');
      return false;
    }
    // Lexical containment cannot grant a link's external target metadata or listings.
    // Resolve the finite requested path before any positive filesystem observation.
    try {
      const physical = realpathSync(path);
      if (
        !within(repository, physical) &&
        ![...dependencyRoots].some((root) => within(root, physical))
      )
        return refuse('RESOLUTION_UNBOUND');
      if (
        within(repository, path) &&
        !relative(repository, path).split('/').includes('node_modules') &&
        physical !== path
      )
        return refuse('INPUT_LINK');
      const priorRoute = readRoutes.get(path);
      if (priorRoute !== undefined && priorRoute !== physical)
        return refuse('INPUT_RESOLUTION_CHANGED');
      if (kind !== 'scan') readRoutes.set(path, physical);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    let value: unknown;
    if (kind === 'entries' || kind === 'scan') value = readdirSync(path).sort();
    else {
      try {
        const stat = lstatSync(readRoutes.get(path) ?? path);
        value = kind === 'file' ? stat.isFile() : stat.isDirectory();
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw error;
        value = false;
      }
    }
    // A traversal is not an unfiltered compiler resolution observation. Its effective
    // selected file census is independently replayed below; unrelated output creation
    // cannot change the compiler's root-file selection.
    if (kind === 'scan') return value;
    const key = JSON.stringify([kind, path]);
    const serialized = JSON.stringify(value);
    const prior = observations.get(key);
    if (prior !== undefined && prior !== serialized) return refuse('RESOLUTION_CHANGED');
    observations.set(key, serialized);
    return value;
  };
  const candidateManifests = new Set([
    resolve(repository, 'package.json'),
    resolve(packageDir, 'package.json'),
  ]);
  const pending = [...candidateManifests];
  const manifests = new Set<string>();
  const resolveManifest = (manifest: string, name: string): string => {
    if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u.test(name))
      return refuse('DEPENDENCY_NAME_INVALID');
    // Manifest identity does not require an already-built package entrypoint.
    // The finite declared node_modules slot is the owning installed instance;
    // export-hidden package.json and missing dist outputs cannot change that slot.
    for (let directory = dirname(manifest); ; directory = dirname(directory)) {
      const logical = resolve(directory, 'node_modules', name);
      let physical: string;
      try {
        physical = realpathSync(logical);
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw error;
        if (dirname(directory) === directory) break;
        continue;
      }
      if (!lstatSync(physical).isDirectory()) return refuse('DEPENDENCY_INSTANCE_INVALID');
      const owner = resolve(physical, 'package.json');
      if (realpathSync(owner) !== owner || !lstatSync(owner).isFile())
        return refuse('DEPENDENCY_MANIFEST_INVALID');
      return owner;
    }
    const error = new Error(`Declared dependency missing: ${name}`) as NodeJS.ErrnoException;
    error.code = 'MODULE_NOT_FOUND';
    throw error;
  };
  const resolutionRoute = (manifest: string, request: string): string => {
    const route: { path: string; physical: string | null; link: string | null }[] = [];
    for (let directory = dirname(manifest); ; directory = dirname(directory)) {
      const path = resolve(directory, 'node_modules', request);
      try {
        const stat = lstatSync(path);
        route.push({
          path,
          physical: realpathSync(path),
          link: stat.isSymbolicLink() ? readlinkSync(path) : null,
        });
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw error;
        route.push({ path, physical: null, link: null });
      }
      if (dirname(directory) === directory) break;
    }
    return JSON.stringify(route);
  };
  for (let index = 0; index < pending.length; index += 1) {
    const manifest = realpathSync(pending[index] as string);
    if (manifests.has(manifest)) continue;
    manifests.add(manifest);
    if (manifest !== resolve(repository, 'package.json')) dependencyRoots.add(dirname(manifest));
    const document = JSON.parse(read(manifest)) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    for (const name of Object.keys({
      ...document.dependencies,
      ...document.optionalDependencies,
      ...document.peerDependencies,
      ...(candidateManifests.has(manifest) ? document.devDependencies : {}),
    }).sort()) {
      let target: string;
      try {
        target = resolveManifest(manifest, name);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND' &&
          (document.optionalDependencies?.[name] !== undefined ||
            document.peerDependenciesMeta?.[name]?.optional === true)
        ) {
          missing.push({ from: manifest, request: name, route: resolutionRoute(manifest, name) });
          continue;
        }
        throw error;
      }
      dependencyRoots.add(dirname(target));
      const targetName = (JSON.parse(read(target)) as { name?: string }).name;
      const version = {
        ...document.dependencies,
        ...document.optionalDependencies,
        ...document.peerDependencies,
        ...(candidateManifests.has(manifest) ? document.devDependencies : {}),
      }[name];
      const alias =
        typeof version === 'string' ? /^npm:((?:@[^/]+\/)?[^@]+)@/u.exec(version)?.[1] : undefined;
      if (targetName !== (alias ?? name)) return refuse('DEPENDENCY_OWNER_MISMATCH');
      edges.push({
        from: manifest,
        request: name,
        to: realpathSync(target),
        route: resolutionRoute(manifest, name),
      });
      pending.push(target);
    }
  }
  const compilerRequire = createRequire(resolve(packageDir, 'package.json'));
  const compilerManifest = realpathSync(compilerRequire.resolve('typescript/package.json'));
  if (!manifests.has(compilerManifest)) return refuse('COMPILER_UNBOUND');
  const compilerEntry = realpathSync(compilerRequire.resolve('typescript'));
  const compilerDocument = JSON.parse(read(compilerManifest)) as { version?: string };
  if (compilerDocument.version !== '6.0.3') return refuse('COMPILER_VERSION_UNSUPPORTED');
  // Freeze every compiler file, including files not reached by this compilation.
  // A partial entry/lib snapshot does not identify the installed compiler instance.
  const captureCompiler = (directory: string): void => {
    for (const name of observe('entries', directory) as string[]) {
      const path = resolve(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return refuse('COMPILER_LINK');
      if (stat.isDirectory()) captureCompiler(path);
      else if (stat.isFile()) read(path);
      else return refuse('COMPILER_SPECIAL_FILE');
    }
  };
  captureCompiler(dirname(compilerManifest));
  const compilerEntrySha256 = hash(read(compilerEntry));
  const compiler = compilerRequire(compilerEntry) as typeof ts;
  const sourceCensus = (): string[] => {
    const selected: string[] = [];
    const visit = (directory: string): void => {
      for (const name of observe('scan', directory) as string[]) {
        if (name === 'node_modules' || name === '.git') continue;
        const path = resolve(directory, name);
        const candidateRelative = relative(repository, path);
        if (
          host.bound?.excludedPrefixes.some(
            (prefix) =>
              candidateRelative === prefix.slice(0, -1) || candidateRelative.startsWith(prefix),
          )
        )
          continue;
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) return refuse('CENSUS_LINK');
        if (stat.isDirectory()) visit(path);
        else if (stat.isFile()) {
          const portablePath = relative(packageDir, path);
          if (
            includes.some((pattern) => matchesGlob(portablePath, pattern)) &&
            !excludes.some((pattern) => matchesGlob(portablePath, pattern))
          ) {
            read(path);
            selected.push(portablePath);
          }
        } else return refuse('CENSUS_SPECIAL_FILE');
      }
    };
    visit(packageDir);
    return selected.sort();
  };
  const expectedSources = modules.map((entry) => entry.source).sort();
  const census = sourceCensus();
  if (JSON.stringify(census) !== JSON.stringify(expectedSources))
    return refuse('SOURCE_CENSUS_MISMATCH');
  const configPath = resolve(packageDir, 'tsconfig.json');
  const configText = read(configPath);
  const diagnostics = (values: readonly ts.Diagnostic[]) => {
    const rows = values.map((entry) => ({
      category: entry.category,
      code: entry.code,
      message: compiler.flattenDiagnosticMessageText(entry.messageText, '\n'),
    }));
    if (values.some((entry) => entry.category === compiler.DiagnosticCategory.Error))
      return refuse(`COMPILER_DIAGNOSTICS:${JSON.stringify(rows)}`);
    return rows;
  };
  const walk = (directory: string): string[] => {
    const files: string[] = [];
    for (const name of observe('scan', directory) as string[]) {
      if (name === 'node_modules' || name === '.git') continue;
      const path = resolve(directory, name);
      const candidateRelative = relative(repository, path);
      if (
        host.bound?.excludedPrefixes.some(
          (prefix) =>
            candidateRelative === prefix.slice(0, -1) || candidateRelative.startsWith(prefix),
        )
      )
        continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return refuse('CENSUS_LINK');
      if (stat.isDirectory()) files.push(...walk(path));
      else if (stat.isFile()) files.push(path);
      else return refuse('CENSUS_SPECIAL_FILE');
    }
    return files;
  };
  const config = compiler.parseConfigFileTextToJson(configPath, configText);
  diagnostics(config.error === undefined ? [] : [config.error]);
  const configHost: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: true,
    fileExists: (path) => Boolean(observe('file', path)),
    readFile: (path) => (observe('file', path) ? read(path) : undefined),
    readDirectory: (path, extensions, exclude, include, depth) => {
      if (depth !== undefined) return refuse('COMPILER_DIRECTORY_DEPTH_UNSUPPORTED');
      return walk(path).filter((file) => {
        const name = relative(path, file);
        return (
          (extensions === undefined || extensions.some((extension) => file.endsWith(extension))) &&
          !(exclude ?? []).some((pattern) => matchesGlob(name, pattern)) &&
          (include === undefined || include.some((pattern) => matchesGlob(name, pattern)))
        );
      });
    },
  };
  const parseConfig = () =>
    compiler.parseJsonConfigFileContent(
      config.config,
      configHost,
      packageDir,
      undefined,
      configPath,
    );
  const parsed = parseConfig();
  const configuredFiles = JSON.stringify([...parsed.fileNames].sort());
  diagnostics(parsed.errors);
  if (
    parsed.projectReferences?.length ||
    parsed.options.outFile ||
    parsed.options.noEmit ||
    parsed.options.emitDeclarationOnly ||
    parsed.options.inlineSourceMap ||
    !parsed.options.sourceMap
  )
    return refuse('COMPILER_CONFIGURATION_UNSUPPORTED');
  const coverageOptions = {
    ...parsed.options,
    module: compiler.ModuleKind.ESNext,
    moduleResolution: compiler.ModuleResolutionKind.Bundler,
    sourceMap: true,
    inlineSourceMap: false,
    inlineSources: true,
    declaration: false,
    declarationMap: false,
    noEmit: false,
    emitDeclarationOnly: false,
  };
  const verify = (): void =>
    guard(() => {
      if (hash(readFileSync(gitPath)) !== gitSha256) return refuse('GIT_EXECUTABLE_CHANGED');
      if (
        git(['rev-parse', '--verify', 'HEAD']).trim() !== candidate ||
        (host.bound === undefined && git(trackedArgs) !== trackedBytes)
      )
        return refuse('CANDIDATE_CHANGED');
      for (const edge of edges) {
        if (
          resolveManifest(edge.from, edge.request) !== edge.to ||
          resolutionRoute(edge.from, edge.request) !== edge.route
        )
          return refuse('DEPENDENCY_RESOLUTION_CHANGED');
      }
      for (const edge of missing) {
        if (resolutionRoute(edge.from, edge.request) !== edge.route)
          return refuse('DEPENDENCY_RESOLUTION_CHANGED');
        try {
          resolveManifest(edge.from, edge.request);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') continue;
          throw error;
        }
        return refuse('DEPENDENCY_RESOLUTION_CHANGED');
      }
      for (const [path, physical] of readRoutes) {
        if (realpathSync(path) !== physical) return refuse('INPUT_RESOLUTION_CHANGED');
      }
      for (const row of input.values()) {
        if (row.origin === 'candidate') regular(row.path);
        if (realpathSync(row.path) !== row.path || hash(readFileSync(row.path)) !== row.sha256)
          return refuse('INPUT_CHANGED');
      }
      for (const [path, sha256] of verifiedOutputs) {
        if (hash(readFileSync(regular(path))) !== sha256) return refuse('OUTPUT_CHANGED');
      }
      for (const [key, prior] of observations) {
        const [kind, path] = JSON.parse(key) as ['file' | 'directory' | 'entries', string];
        if (JSON.stringify(observe(kind, path)) !== prior) return refuse('RESOLUTION_CHANGED');
      }
      const currentConfig = parseConfig();
      diagnostics(currentConfig.errors);
      if (JSON.stringify([...currentConfig.fileNames].sort()) !== configuredFiles)
        return refuse('COMPILER_ROOT_SELECTION_CHANGED');
      if (JSON.stringify(sourceCensus()) !== JSON.stringify(census))
        return refuse('SOURCE_CENSUS_CHANGED');
    });
  const programs = new Map<
    CompilationMode,
    { program: ts.Program; diagnostics: ReturnType<typeof diagnostics> }
  >();
  let lastCompilation: { mode: CompilationMode; source: string } | undefined;
  const compile = (request: { mode: CompilationMode; source: string }) =>
    guard(() => {
      const parameters = record(request, ['mode', 'source']);
      if (
        (parameters['mode'] !== 'production' && parameters['mode'] !== 'coverage') ||
        typeof parameters['source'] !== 'string'
      )
        return refuse('COMPILE_REQUEST_INVALID');
      const mode = parameters['mode'];
      const binding = modules.find((entry) => entry.source === parameters['source']);
      if (binding === undefined) return refuse('COMPILE_SOURCE_UNBOUND');
      lastCompilation = { mode, source: binding.source };
      verify();
      const options = mode === 'production' ? parsed.options : coverageOptions;
      const host: ts.CompilerHost = {
        getSourceFile: (path, languageVersion) =>
          observe('file', path)
            ? compiler.createSourceFile(path, read(path), languageVersion, true)
            : undefined,
        getDefaultLibFileName: (settings) =>
          resolve(dirname(compilerEntry), compiler.getDefaultLibFileName(settings)),
        writeFile: () => refuse('COMPILER_WRITE_FORBIDDEN'),
        getCurrentDirectory: () => packageDir,
        getDirectories: (path) =>
          (observe('entries', path) as string[]).filter((name) =>
            observe('directory', resolve(path, name)),
          ),
        fileExists: (path) => Boolean(observe('file', path)),
        readFile: (path) => (observe('file', path) ? read(path) : undefined),
        getCanonicalFileName: (path) => resolve(path),
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => '\n',
        directoryExists: (path) => Boolean(observe('directory', path)),
        realpath: (path) => {
          path = resolve(path);
          const physical = realpathSync(path);
          origin(physical);
          const prior = readRoutes.get(path);
          if (prior !== undefined && prior !== physical) return refuse('INPUT_RESOLUTION_CHANGED');
          readRoutes.set(path, physical);
          return physical;
        },
      };
      let cached = programs.get(mode);
      if (cached === undefined) {
        const program = compiler.createProgram({ rootNames: parsed.fileNames, options, host });
        cached = { program, diagnostics: diagnostics(compiler.getPreEmitDiagnostics(program)) };
        programs.set(mode, cached);
      }
      const program = cached.program;
      const observedDiagnostics = [...cached.diagnostics];
      const source = program.getSourceFile(resolve(packageDir, binding.source));
      if (
        source === undefined ||
        source.getFullText() !== read(resolve(packageDir, binding.source))
      )
        return refuse('PROGRAM_SOURCE_MISMATCH');
      const expected = [binding.output, `${binding.output}.map`];
      if (mode === 'production' && options.declaration) {
        const declarationRoot = options.declarationDir ?? options.outDir ?? packageDir;
        const declaration = relative(
          packageDir,
          resolve(
            declarationRoot,
            relative(options.outDir ?? packageDir, resolve(packageDir, binding.output)).replace(
              /\.js$/u,
              '.d.ts',
            ),
          ),
        );
        expected.push(declaration);
        if (options.declarationMap) expected.push(`${declaration}.map`);
      }
      const outputs = new Map<string, Output>();
      const result = program.emit(source, (path, text) => {
        const name = relative(packageDir, resolve(path));
        if (!portable(name) || !expected.includes(name) || outputs.has(name))
          return refuse('EMIT_OUTPUT_UNEXPECTED');
        outputs.set(name, { path: name, text, sha256: hash(text) });
      });
      observedDiagnostics.push(...diagnostics(result.diagnostics));
      if (result.emitSkipped || outputs.size !== expected.length) return refuse('EMIT_INCOMPLETE');
      for (const output of outputs.values())
        derived.set(`${mode}:${output.path}`, { text: output.text, source: binding.source, mode });
      verify();
      return structuredClone({
        outputs: [...outputs.values()].sort((a, b) => a.path.localeCompare(b.path)),
        diagnostics: observedDiagnostics,
      });
    });
  return {
    lastCompilation: () => structuredClone(lastCompilation),
    request: { packageDir, config: 'tsconfig.json' as const, modules, includes, excludes },
    api: Object.freeze({
      sha256(value: string | Uint8Array): string {
        return guard(() => {
          if (typeof value === 'string') return hash(value);
          if (
            isProxy(value) ||
            !isUint8Array(value) ||
            ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(value)) ||
            Reflect.ownKeys(value).some(
              (key) => typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(key),
            )
          )
            return refuse('HASH_INPUT_INVALID');
          try {
            const buffer = intrinsicBuffer?.call(value) as ArrayBuffer;
            const offset = intrinsicOffset?.call(value) as number;
            const length = intrinsicLength?.call(value) as number;
            if (!isArrayBuffer(buffer)) return refuse('HASH_INPUT_INVALID');
            return hash(Buffer.from(new Uint8Array(buffer, offset, length)));
          } catch {
            return refuse('HASH_INPUT_INVALID');
          }
        });
      },
      candidate: () => {
        verify();
        return candidate;
      },
      sourceCensus: () => {
        verify();
        return [...census];
      },
      compile,
      readVerifiedOutput(path: string): string {
        return guard(() => {
          if (!portable(path)) return refuse('OUTPUT_PATH_INVALID');
          const expected = derived.get(`production:${path}`);
          if (expected === undefined) return refuse('OUTPUT_NOT_DERIVED');
          verify();
          const bytes = readFileSync(regular(resolve(packageDir, path)));
          if (!bytes.equals(Buffer.from(expected.text)))
            return refuse('OUTPUT_DIFFERS_FROM_PRODUCTION');
          verifiedOutputs.set(resolve(packageDir, path), hash(bytes));
          return bytes.toString('utf8');
        });
      },
      verify,
      evidence: () => {
        verify();
        return structuredClone({
          schemaVersion: '1.0.0',
          mode: host.mode,
          candidate,
          git: { path: gitPath, sha256: gitSha256 },
          compiler: {
            version: compiler.version,
            entrySha256: compilerEntrySha256,
            manifestSha256: hash(read(compilerManifest)),
          },
          config: {
            path: 'tsconfig.json',
            sha256: hash(configText),
            productionOptionsSha256: hash(JSON.stringify(parsed.options)),
            coverageOptionsSha256: hash(JSON.stringify(coverageOptions)),
          },
          sourceFiles: census,
          inputs: [...input.values()].sort((a, b) => a.path.localeCompare(b.path)),
          resolutionSha256: hash(
            JSON.stringify({ edges, missing, observations: [...observations].sort() }),
          ),
          outputs: [...derived]
            .map(([key, value]) => ({
              path: key.slice(key.indexOf(':') + 1),
              sha256: hash(value.text),
              source: value.source,
              mode: value.mode,
            }))
            .sort((a, b) => `${a.mode}:${a.path}`.localeCompare(`${b.mode}:${b.path}`)),
        });
      },
    }),
  };
}
