// ADR-SCR-0019: diagnostic compiler evidence never mints native standing.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNativeCoverageAdapter } from '../../src/native-coverage-adapter.js';
import { createNativeCoverageAdapterKernel } from '../../src/native-coverage-kernel.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const require = createRequire(import.meta.url);
const compilerFixtureManifest = realpathSync(
  join(ROOT, 'node_modules/devai-native-coverage-compiler-fixture/package.json'),
);
const compilerManifest = realpathSync(
  createRequire(compilerFixtureManifest).resolve('typescript/package.json'),
);
const compilerRoot = dirname(compilerManifest);
const compiler: typeof import('typescript') = require(compilerRoot);
const roots: string[] = [];
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const sources = ['src/first.ts', 'src/second.ts'];
const config = {
  compilerOptions: {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    outDir: 'dist',
    rootDir: 'src',
    sourceMap: true,
    declaration: true,
    declarationMap: true,
    strict: true,
    skipLibCheck: true,
    types: [],
  },
  include: ['src/**/*.ts'],
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(root: string, path: string, value: string | object) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value));
}

function git(root: string, ...args: string[]) {
  const result = spawnSync(
    'git',
    [
      '-c',
      'maintenance.auto=false',
      '-c',
      'gc.auto=0',
      '-c',
      'user.name=DEVAI Inspector',
      '-c',
      'user.email=inspector@devai.local',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function snapshot(root: string) {
  const rows: Record<string, string> = {};
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      const name = relative(root, path);
      rows[name] = entry.isDirectory() ? 'directory' : sha(readFileSync(path));
      if (entry.isDirectory()) visit(path);
    }
  };
  visit(root);
  return rows;
}

function emitted(root: string, mode: 'production' | 'coverage') {
  const parsed = compiler.getParsedCommandLineOfConfigFile(
    join(root, 'tsconfig.json'),
    {},
    {
      ...compiler.sys,
      onUnRecoverableConfigFileDiagnostic: (error) => {
        throw new Error(String(error.code));
      },
    },
  );
  if (parsed === undefined) throw new Error('Fixture compiler configuration missing');
  const options =
    mode === 'production'
      ? parsed.options
      : {
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
  const program = compiler.createProgram(parsed.fileNames, options);
  expect(compiler.getPreEmitDiagnostics(program)).toEqual([]);
  const output = new Map<string, string>();
  const result = program.emit(undefined, (path, text) =>
    output.set(relative(root, path).split('\\').join('/'), text),
  );
  expect(result.emitSkipped).toBe(false);
  expect(result.diagnostics).toEqual([]);
  return output;
}

function fixture(copyCompiler = false) {
  expect(compiler.version).toBe('6.0.3');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai coverage kernel ç ')));
  roots.push(root);
  put(root, 'package.json', {
    name: 'native-coverage-adopter',
    version: '1.0.0',
    type: 'module',
    devDependencies: { typescript: '6.0.3' },
  });
  put(root, '.gitignore', 'node_modules/\ndist/\n');
  put(root, 'tsconfig.json', config);
  put(
    root,
    sources[0] as string,
    'export function first(value: number): number { return value + 1; }\n',
  );
  put(
    root,
    sources[1] as string,
    'export const second = (value: string): string => value.toUpperCase();\n',
  );
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  if (copyCompiler)
    cpSync(compilerRoot, join(root, 'node_modules/typescript'), { recursive: true });
  else symlinkSync(compilerRoot, join(root, 'node_modules/typescript'), 'dir');
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture inputs');
  const production = emitted(root, 'production');
  for (const [path, text] of production) put(root, path, text);
  const options = {
    packageDir: root,
    config: 'tsconfig.json' as const,
    modules: sources.map((source) => ({
      source,
      output: source.replace(/^src\//u, 'dist/').replace(/\.ts$/u, '.js'),
    })),
    includes: ['src/**/*.ts'],
    excludes: ['src/**/*.d.ts'],
  };
  return { root, options, production };
}

describe('finite package-owned native coverage adapter', () => {
  it('reproduces actual TypeScript6 production and coverage emission without writing or minting standing', () => {
    const { root, options, production } = fixture();
    const before = snapshot(root);
    const adapter = createNativeCoverageAdapter(options);
    expect(Object.keys(adapter).sort()).toEqual(
      [
        'candidate',
        'compile',
        'evidence',
        'readVerifiedOutput',
        'sha256',
        'sourceCensus',
        'verify',
      ].sort(),
    );
    expect(adapter.candidate()).toBe(git(root, 'rev-parse', '--verify', 'HEAD'));
    expect(adapter.sourceCensus()).toEqual(sources);
    const expectedCoverage = emitted(root, 'coverage');
    for (const mode of ['production', 'coverage'] as const) {
      const expected = mode === 'production' ? production : expectedCoverage;
      for (const source of sources) {
        const result = adapter.compile({ mode, source });
        expect(result.diagnostics).toEqual([]);
        const prefix = source.replace(/^src\//u, 'dist/').replace(/\.ts$/u, '');
        const paths = [...expected.keys()].filter((path) => path.startsWith(`${prefix}.`)).sort();
        expect(result.outputs.map((entry) => entry.path).sort()).toEqual(paths);
        for (const output of result.outputs) {
          expect(output.text).toBe(expected.get(output.path));
          expect(output.sha256).toBe(sha(output.text));
          if (mode === 'production')
            expect(adapter.readVerifiedOutput(output.path)).toBe(output.text);
          else if (output.path.endsWith('.map')) {
            const map = JSON.parse(output.text) as { sourcesContent: string[] };
            expect(map.sourcesContent).toEqual([readFileSync(join(root, source), 'utf8')]);
          }
        }
      }
    }
    adapter.verify();
    const evidence = adapter.evidence();
    expect(Object.keys(evidence).sort()).toEqual(
      [
        'schemaVersion',
        'mode',
        'candidate',
        'compiler',
        'git',
        'config',
        'sourceFiles',
        'inputs',
        'resolutionSha256',
        'outputs',
      ].sort(),
    );
    expect(evidence).toMatchObject({
      schemaVersion: '1.0.0',
      mode: 'diagnostic',
      candidate: git(root, 'rev-parse', 'HEAD'),
      compiler: { version: '6.0.3' },
      sourceFiles: sources,
    });
    expect(evidence.resolutionSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(evidence.git.path).toBe(realpathSync(evidence.git.path));
    expect(evidence.git.sha256).toBe(sha(readFileSync(evidence.git.path)));
    expect(adapter.evidence()).not.toBe(evidence);
    expect(adapter.sourceCensus()).not.toBe(adapter.sourceCensus());
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(join(root, 'record'))).toBe(false);
    expect(existsSync(join(root, '.devai'))).toBe(false);
  });

  it.each([
    'src/first.ts',
    'tsconfig.json',
    'dist/first.js',
    'dist/first.js.map',
    'dist/first.d.ts',
    'dist/first.d.ts.map',
  ])('refuses changed admitted input %s', (path) => {
    const { root, options } = fixture();
    const adapter = createNativeCoverageAdapter(options);
    adapter.compile({ mode: 'production', source: 'src/first.ts' });
    if (path.startsWith('dist/')) adapter.readVerifiedOutput(path);
    writeFileSync(join(root, path), `${readFileSync(join(root, path), 'utf8')}\n`);
    expect(() => adapter.verify()).toThrow();
  });

  it('refuses a changed actual candidate instead of answering a cached HEAD', () => {
    const { root, options } = fixture();
    const adapter = createNativeCoverageAdapter(options);
    const original = adapter.candidate();
    git(root, 'commit', '--allow-empty', '-qm', 'new candidate');
    expect(git(root, 'rev-parse', 'HEAD')).not.toBe(original);
    expect(() => adapter.candidate()).toThrow();
    expect(() => adapter.verify()).toThrow();
  });

  it('disables local Git fsmonitor callbacks for every finite candidate observation', () => {
    const { root, options } = fixture();
    const sentinel = join(root, 'fsmonitor-sentinel.sh');
    put(
      root,
      'fsmonitor-sentinel.sh',
      '#!/bin/sh\nprintf fired > "$0.fired"\nprintf "fixture-token\\0"\n',
    );
    chmodSync(sentinel, 0o700);
    git(root, 'add', 'fsmonitor-sentinel.sh');
    git(root, 'commit', '-qm', 'harmless fsmonitor control');
    const shellPath = `'${sentinel.replaceAll("'", "'\\''")}'`;
    git(root, 'config', 'core.fsmonitor', shellPath);
    git(root, 'status', '--porcelain=v1');
    expect(readFileSync(`${sentinel}.fired`, 'utf8')).toBe('fired');
    rmSync(`${sentinel}.fired`);
    const adapter = createNativeCoverageAdapter(options);
    expect(adapter.candidate()).toBe(git(root, '-c', 'core.fsmonitor=false', 'rev-parse', 'HEAD'));
    adapter.compile({ mode: 'production', source: 'src/first.ts' });
    adapter.verify();
    expect(adapter.evidence().mode).toBe('diagnostic');
    expect(existsSync(`${sentinel}.fired`)).toBe(false);
  });

  it('binds the actual compiler bytes rather than only its version label', () => {
    const { root, options } = fixture(true);
    const adapter = createNativeCoverageAdapter(options);
    const entry = createRequire(join(root, 'package.json')).resolve('typescript');
    writeFileSync(entry, `${readFileSync(entry, 'utf8')}\n// changed compiler\n`);
    expect(() => adapter.verify()).toThrow();
  });

  it('binds the complete compiler package, including dependency bytes not read by this Program', () => {
    const { root, options } = fixture(true);
    const adapter = createNativeCoverageAdapter(options);
    const declarations = join(root, 'node_modules/typescript/lib/typescript.d.ts');
    writeFileSync(
      declarations,
      `${readFileSync(declarations, 'utf8')}\n// changed package bytes\n`,
    );
    expect(() => adapter.verify()).toThrow();
  });

  it('observes the repository candidate correctly from a nested package cwd', () => {
    const { root, options } = fixture();
    const packageDir = join(root, 'packages/nested');
    mkdirSync(packageDir, { recursive: true });
    cpSync(join(root, 'src'), join(packageDir, 'src'), { recursive: true });
    cpSync(join(root, 'tsconfig.json'), join(packageDir, 'tsconfig.json'));
    cpSync(join(root, 'package.json'), join(packageDir, 'package.json'));
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'nested package input');
    const expected = emitted(packageDir, 'production');
    for (const [path, text] of expected) put(packageDir, path, text);
    const adapter = createNativeCoverageAdapter({ ...options, packageDir });
    expect(adapter.candidate()).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(adapter.sourceCensus()).toEqual(sources);
    for (const output of adapter.compile({ mode: 'production', source: 'src/first.ts' }).outputs) {
      expect(output.text).toBe(expected.get(output.path));
      expect(adapter.readVerifiedOutput(output.path)).toBe(output.text);
    }
    adapter.verify();
  });

  it.each(['external-symlink', 'untracked-workspace'] as const)(
    'refuses a declared dependency granting %s compiler input',
    (kind) => {
      const { root, options } = fixture();
      const external = realpathSync(mkdtempSync(join(tmpdir(), 'devai unbound compiler input ç ')));
      roots.push(external);
      put(external, 'index.d.ts', 'export declare const owned: number;\n');
      const dependency =
        kind === 'untracked-workspace'
          ? join(root, 'packages/untracked')
          : join(root, 'node_modules/owned-leaf');
      put(dependency, 'package.json', {
        name: 'owned-leaf',
        version: '1.0.0',
        types: 'index.d.ts',
      });
      if (kind === 'external-symlink')
        symlinkSync(join(external, 'index.d.ts'), join(dependency, 'index.d.ts'));
      else {
        cpSync(join(external, 'index.d.ts'), join(dependency, 'index.d.ts'));
        mkdirSync(join(root, 'node_modules'), { recursive: true });
        symlinkSync(dependency, join(root, 'node_modules/owned-leaf'), 'dir');
      }
      put(root, 'package.json', {
        name: 'native-coverage-adopter',
        version: '1.0.0',
        type: 'module',
        devDependencies: { typescript: '6.0.3', 'owned-leaf': '1.0.0' },
      });
      put(
        root,
        'src/first.ts',
        'import { owned } from "owned-leaf";\nexport const first: number = owned;\n',
      );
      git(root, 'add', 'package.json', 'src/first.ts');
      git(root, 'commit', '-qm', 'declared dependency compiler input');
      for (const [path, text] of emitted(root, 'production')) put(root, path, text);
      expect(() =>
        createNativeCoverageAdapter(options).compile({
          mode: 'production',
          source: 'src/first.ts',
        }),
      ).toThrow();
    },
  );

  it('refuses a dependency edge retargeted to identical bytes in a different physical instance', () => {
    const { root, options } = fixture();
    const alternate = realpathSync(mkdtempSync(join(tmpdir(), 'devai compiler replacement ç ')));
    roots.push(alternate);
    cpSync(compilerRoot, alternate, { recursive: true });
    const adapter = createNativeCoverageAdapter(options);
    rmSync(join(root, 'node_modules/typescript'));
    symlinkSync(alternate, join(root, 'node_modules/typescript'), 'dir');
    expect(() => adapter.verify()).toThrow();
  });

  it.each(['/outside-dependency', '../owned-leaf', './owned-leaf'])(
    'refuses nonpackage dependency name %s before treating it as a filesystem capability',
    (name) => {
      const { root, options } = fixture();
      put(root, 'package.json', {
        name: 'native-coverage-adopter',
        version: '1.0.0',
        type: 'module',
        devDependencies: { typescript: '6.0.3', [name]: '1.0.0' },
      });
      git(root, 'add', 'package.json');
      git(root, 'commit', '-qm', 'hostile dependency name');
      expect(() => createNativeCoverageAdapter(options)).toThrow(
        'NATIVE_COVERAGE_ADAPTER_DEPENDENCY_NAME_INVALID',
      );
    },
  );

  it.each(['available', 'hidden'] as const)(
    'binds an installed dependency manifest with %s exports even when its build entry is missing',
    (visibility) => {
      const { root, options } = fixture();
      const leaf = join(root, 'node_modules/owned-leaf');
      put(leaf, 'package.json', {
        name: 'owned-leaf',
        version: '1.0.0',
        main: './dist/index.js',
        exports: {
          '.': './dist/index.js',
          ...(visibility === 'available' ? { './package.json': './package.json' } : {}),
        },
      });
      put(root, 'package.json', {
        name: 'native-coverage-adopter',
        version: '1.0.0',
        type: 'module',
        devDependencies: { typescript: '6.0.3', 'owned-leaf': '1.0.0' },
      });
      git(root, 'add', 'package.json');
      git(root, 'commit', '-qm', 'declared unbuilt package manifest');
      const resolver = createRequire(join(root, 'package.json'));
      expect(() => resolver.resolve('owned-leaf')).toThrow();
      if (visibility === 'hidden')
        expect(() => resolver.resolve('owned-leaf/package.json')).toThrow();
      else expect(resolver.resolve('owned-leaf/package.json')).toBe(join(leaf, 'package.json'));
      const adapter = createNativeCoverageAdapter(options);
      expect(adapter.compile({ mode: 'production', source: 'src/first.ts' }).outputs).toHaveLength(
        4,
      );
      expect(adapter.evidence().inputs).toContainEqual({
        path: join(leaf, 'package.json'),
        sha256: sha(readFileSync(join(leaf, 'package.json'))),
        origin: 'dependency',
      });
      expect(existsSync(join(leaf, 'dist'))).toBe(false);
      adapter.verify();
    },
  );

  it.each(['direct', 'linked'] as const)(
    'refuses a %s compiler typeRoots ancestor before enumerating positive external directory entries',
    (route) => {
      const { root, options } = fixture();
      const external = realpathSync(mkdtempSync(join(tmpdir(), 'devai compiler ancestor ç ')));
      roots.push(external);
      cpSync(compilerRoot, join(external, 'typescript'), { recursive: true });
      rmSync(join(root, 'node_modules/typescript'));
      symlinkSync(join(external, 'typescript'), join(root, 'node_modules/typescript'), 'dir');
      const typeRoot = route === 'direct' ? external : join(root, 'node_modules/type-root');
      if (route === 'linked') symlinkSync(external, typeRoot, 'dir');
      // TypeScript6 enumerates automatic type roots only for an explicit wildcard.
      const compilerOptions = { ...config.compilerOptions, types: ['*'], typeRoots: [typeRoot] };
      put(root, 'tsconfig.json', { ...config, compilerOptions });
      git(root, 'add', 'tsconfig.json');
      git(root, 'commit', '-qm', 'explicit external compiler type root');
      const fs: typeof import('node:fs') = require('node:fs');
      const original = fs.readdirSync;
      const observed: string[] = [];
      let allowedEnumerations = 0;
      fs.readdirSync = ((...args: unknown[]) => {
        if (String(args[0]) === external || String(args[0]) === typeRoot)
          observed.push(String(args[0]));
        if (String(args[0]) === root) allowedEnumerations += 1;
        return Reflect.apply(original, fs, args);
      }) as typeof original;
      syncBuiltinESMExports();
      try {
        expect(() =>
          createNativeCoverageAdapterKernel(options, {
            mode: 'diagnostic',
            path: process.env.PATH ?? '',
            // Inject the real interposed operation explicitly: the public preload correctly
            // captures its private IO before candidate/test code can replace Node exports.
            io: {
              ...fs,
              createHash,
              execFileSync,
              createRequire,
              readdirSync: fs.readdirSync,
            },
          }).api.compile({
            mode: 'production',
            source: 'src/first.ts',
          }),
        ).toThrow();
        expect(allowedEnumerations).toBeGreaterThan(0);
        expect(observed).toEqual([]);
      } finally {
        fs.readdirSync = original;
        syncBuiltinESMExports();
      }
    },
  );

  it('compiles a real named import through an owned pnpm package symlink', () => {
    const { root, options } = fixture();
    const leaf = join(root, 'node_modules/.pnpm/owned-leaf@1.0.0/node_modules/owned-leaf');
    put(leaf, 'package.json', {
      name: 'owned-leaf',
      version: '1.0.0',
      type: 'module',
      exports: { '.': { types: './index.d.ts', default: './index.js' } },
    });
    put(leaf, 'index.d.ts', 'export declare const ownedValue: number;\n');
    symlinkSync(
      '.pnpm/owned-leaf@1.0.0/node_modules/owned-leaf',
      join(root, 'node_modules/owned-leaf'),
      'dir',
    );
    put(root, 'package.json', {
      name: 'native-coverage-adopter',
      version: '1.0.0',
      type: 'module',
      devDependencies: { typescript: '6.0.3', 'owned-leaf': '1.0.0' },
    });
    put(
      root,
      'src/first.ts',
      "import { ownedValue } from 'owned-leaf';\nexport const first = (value: number): number => value + ownedValue;\n",
    );
    git(root, 'add', 'package.json', 'src/first.ts');
    git(root, 'commit', '-qm', 'real linked dependency compiler input');
    const production = emitted(root, 'production');
    for (const [path, text] of production) put(root, path, text);
    const adapter = createNativeCoverageAdapter(options);
    const result = adapter.compile({ mode: 'production', source: 'src/first.ts' });
    expect(result.outputs).toHaveLength(4);
    for (const output of result.outputs) {
      expect(output.text).toBe(production.get(output.path));
      expect(adapter.readVerifiedOutput(output.path)).toBe(output.text);
    }
    expect(adapter.evidence().inputs).toContainEqual({
      path: join(leaf, 'index.d.ts'),
      sha256: sha(readFileSync(join(leaf, 'index.d.ts'))),
      origin: 'dependency',
    });
    expect(realpathSync(join(root, 'node_modules/owned-leaf'))).toBe(leaf);
    adapter.verify();
  });

  it('refuses compiler enumeration of Git administration before any Git directory listing', () => {
    const { root, options } = fixture();
    put(root, 'tsconfig.json', {
      ...config,
      compilerOptions: { ...config.compilerOptions, types: ['*'], typeRoots: [join(root, '.git')] },
    });
    git(root, 'add', 'tsconfig.json');
    git(root, 'commit', '-qm', 'Git-administration type root witness');
    const fs: typeof import('node:fs') = require('node:fs');
    const original = fs.readdirSync;
    let allowedEnumerations = 0;
    const forbidden: string[] = [];
    const observed = ((...args: unknown[]) => {
      const path = String(args[0]);
      if (path === root) allowedEnumerations += 1;
      if (path === join(root, '.git') || path.startsWith(`${join(root, '.git')}/`))
        forbidden.push(path);
      return Reflect.apply(original, fs, args);
    }) as typeof original;
    expect(() =>
      createNativeCoverageAdapterKernel(options, {
        mode: 'diagnostic',
        path: process.env.PATH ?? '',
        io: { ...fs, createHash, execFileSync, createRequire, readdirSync: observed },
      }).api.compile({ mode: 'production', source: 'src/first.ts' }),
    ).toThrow();
    expect(allowedEnumerations).toBeGreaterThan(0);
    expect(forbidden).toEqual([]);
  });

  it('returns detached outputs and evidence that callers cannot use to alter later compiler facts', () => {
    const { options } = fixture();
    const adapter = createNativeCoverageAdapter(options);
    const first = adapter.compile({ mode: 'production', source: 'src/first.ts' });
    const expected = JSON.stringify(first);
    const evidence = adapter.evidence();
    const evidenceBefore = JSON.stringify(evidence);
    const output = first.outputs[0];
    if (output === undefined) throw new Error('Expected real fixture output');
    output.text = 'forged output';
    evidence.sourceFiles[0] = 'forged source';
    expect(JSON.stringify(adapter.compile({ mode: 'production', source: 'src/first.ts' }))).toBe(
      expected,
    );
    expect(JSON.stringify(adapter.evidence())).toBe(evidenceBefore);
  });

  it('refuses stale production bytes before returning a verified generated input', () => {
    const { root, options } = fixture();
    put(root, 'dist/first.js', 'export function first() { return 0; }\n');
    expect(() => {
      const adapter = createNativeCoverageAdapter(options);
      adapter.compile({ mode: 'production', source: 'src/first.ts' });
      adapter.readVerifiedOutput('dist/first.js');
    }).toThrow();
  });

  it('does not grant production read credit from a coverage emission or an arbitrary dist pathname', () => {
    const { options } = fixture();
    const coverage = createNativeCoverageAdapter(options);
    coverage.compile({ mode: 'coverage', source: 'src/first.ts' });
    expect(() => coverage.readVerifiedOutput('dist/first.js')).toThrow();
    const production = createNativeCoverageAdapter(options);
    production.compile({ mode: 'production', source: 'src/first.ts' });
    expect(() => production.readVerifiedOutput('dist/second.js')).toThrow();
  });

  it('retains a detected output failure even if the physical bytes are restored afterward', () => {
    const { root, options } = fixture();
    const adapter = createNativeCoverageAdapter(options);
    adapter.compile({ mode: 'production', source: 'src/first.ts' });
    const original = adapter.readVerifiedOutput('dist/first.js');
    put(root, 'dist/first.js', `${original}\n`);
    expect(() => adapter.verify()).toThrow();
    put(root, 'dist/first.js', original);
    expect(() => adapter.verify()).toThrow();
    expect(() => adapter.evidence()).toThrow();
  });

  it('retains exact effective compiler selection when an unrelated report tree appears', () => {
    const { root, options } = fixture();
    const adapter = createNativeCoverageAdapter(options);
    const request = { mode: 'production' as const, source: 'src/first.ts' };
    const before = adapter.compile(request);
    const evidence = adapter.evidence();
    put(root, 'coverage-vitest/report.json', { covered: true });
    put(root, 'coverage-vitest/unselected.ts', 'export const reportOnly = true;\n');
    expect(() => adapter.verify()).not.toThrow();
    expect(adapter.sourceCensus()).toEqual(sources);
    expect(adapter.compile(request)).toEqual(before);
    expect(adapter.evidence().resolutionSha256).toBe(evidence.resolutionSha256);
  });

  it('refuses a new covered compiler root even when prior emitted bytes remain unchanged', () => {
    const { root, options } = fixture();
    const adapter = createNativeCoverageAdapter(options);
    adapter.compile({ mode: 'production', source: 'src/first.ts' });
    const original = readFileSync(join(root, 'dist/first.js'));
    put(root, 'src/new-root.ts', 'export const newRoot = true;\n');
    expect(readFileSync(join(root, 'dist/first.js'))).toEqual(original);
    expect(() => adapter.verify()).toThrow('COMPILER_ROOT_SELECTION_CHANGED');
  });

  it('refuses compiler root drift outside the narrower declared coverage census', () => {
    const { root, options } = fixture();
    const adapter = createNativeCoverageAdapter({
      ...options,
      modules: options.modules.slice(0, 1),
      includes: ['src/first.ts'],
    });
    adapter.compile({ mode: 'production', source: 'src/first.ts' });
    expect(adapter.sourceCensus()).toEqual(['src/first.ts']);
    put(root, 'src/not-covered.ts', 'export const notCovered = true;\n');
    expect(() => adapter.verify()).toThrow('COMPILER_ROOT_SELECTION_CHANGED');
  });

  it('refuses omitted or new source census members and invalid compiler diagnostics', () => {
    const { root, options } = fixture();
    expect(() =>
      createNativeCoverageAdapter({ ...options, modules: options.modules.slice(0, 1) }),
    ).toThrow();
    const adapter = createNativeCoverageAdapter(options);
    put(root, 'src/extra.ts', 'export const extra = true;\n');
    expect(() => adapter.verify()).toThrow();
    rmSync(join(root, 'src/extra.ts'));
    put(root, 'src/first.ts', 'export const wrong: number = "not a number";\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'invalid compiler input');
    expect(() =>
      createNativeCoverageAdapter(options).compile({ mode: 'production', source: 'src/first.ts' }),
    ).toThrow();
  });

  it.each([
    '../outside.ts',
    '/outside.ts',
    'src/first.ts?query',
    'src/first.ts#hash',
    'src\\first.ts',
    'file:src/first.ts',
  ])('refuses nonportable source %s', (source) => {
    const { options } = fixture();
    expect(() =>
      createNativeCoverageAdapter({ ...options, modules: [{ source, output: 'dist/first.js' }] }),
    ).toThrow();
  });

  it('refuses source and output component links without following them', () => {
    const { root, options } = fixture();
    const original = readFileSync(join(root, 'src/first.ts'));
    put(root, 'original.ts', original.toString('utf8'));
    rmSync(join(root, 'src/first.ts'));
    symlinkSync('../original.ts', join(root, 'src/first.ts'));
    expect(() => createNativeCoverageAdapter(options)).toThrow();
    rmSync(join(root, 'src/first.ts'));
    writeFileSync(join(root, 'src/first.ts'), original);
    rmSync(join(root, 'dist/first.js'));
    symlinkSync('second.js', join(root, 'dist/first.js'));
    expect(() => createNativeCoverageAdapter(options)).toThrow();
  });

  it('refuses a hardlinked source rather than granting its second pathname independent input identity', () => {
    const { root, options } = fixture();
    linkSync(join(root, 'src/first.ts'), join(root, 'first-alias.ts'));
    expect(() => createNativeCoverageAdapter(options)).toThrow();
  });

  it('rejects proxies, accessors, holes, duplicate bindings and authority overrides without invoking getters', () => {
    const { options } = fixture();
    let reads = 0;
    const reject = (value: unknown) =>
      expect(() =>
        createNativeCoverageAdapter(value as Parameters<typeof createNativeCoverageAdapter>[0]),
      ).toThrow();
    reject(
      new Proxy(options, {
        ownKeys() {
          reads += 1;
          return Reflect.ownKeys(options);
        },
      }),
    );
    reject({
      ...options,
      get modules() {
        reads += 1;
        return options.modules;
      },
    });
    reject({ ...options, modules: new Array(2) });
    reject({ ...options, modules: [options.modules[0], options.modules[0]] });
    reject({ ...options, includes: Object.assign(['src/**/*.ts'], { extra: true }) });
    reject({ ...options, authorityRoot: '/' });
    reject({ ...options, candidate: 'a'.repeat(40) });
    expect(reads).toBe(0);
  });

  it('hashes exact detached UTF8/Uint8Array and refuses shared, detached and proxied buffers', () => {
    const { options } = fixture();
    const adapter = createNativeCoverageAdapter(options);
    expect(adapter.sha256('João 日本語')).toBe(sha('João 日本語'));
    const bytes = new Uint8Array([0, 1, 2, 255]);
    expect(adapter.sha256(bytes)).toBe(sha(bytes));
    expect(bytes).toEqual(new Uint8Array([0, 1, 2, 255]));
    const detached = new Uint8Array(4);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    for (const invalid of [
      new Uint8Array(new SharedArrayBuffer(4)),
      detached,
      new Proxy(bytes, {}),
    ]) {
      const fresh = createNativeCoverageAdapter(options);
      expect(() => fresh.sha256(invalid)).toThrow();
    }
    let bufferReads = 0;
    const accessor = new Uint8Array([1, 2]);
    Object.defineProperty(accessor, 'buffer', {
      get() {
        bufferReads += 1;
        return new ArrayBuffer(2);
      },
    });
    let iteratorReads = 0;
    const iterable = new Uint8Array([1, 2]);
    Object.defineProperty(iterable, Symbol.iterator, {
      get() {
        iteratorReads += 1;
        return bytes[Symbol.iterator];
      },
    });
    // A finite refusal or intrinsic byte copying is safe; authored getters must never run.
    for (const value of [accessor, iterable]) {
      let digest: string | undefined;
      let refusal: unknown;
      try {
        digest = createNativeCoverageAdapter(options).sha256(value);
      } catch (error) {
        refusal = error;
      }
      if (refusal === undefined) expect(digest).toBe(sha(new Uint8Array([1, 2])));
      else expect(String(refusal)).toContain('NATIVE_COVERAGE_ADAPTER_HASH_INPUT_INVALID');
    }
    expect(bufferReads).toBe(0);
    expect(iteratorReads).toBe(0);
  });

  it('refuses governed environment without privately registered context and never falls back to diagnostic', () => {
    const { options } = fixture();
    const prior = process.env['DEVAI_NATIVE_COLLECTION_NONCE'];
    try {
      process.env['DEVAI_NATIVE_COLLECTION_NONCE'] = 'b'.repeat(64);
      expect(() => createNativeCoverageAdapter(options)).toThrow(
        'NATIVE_COVERAGE_ADAPTER_GOVERNED_CONTEXT_REQUIRED',
      );
    } finally {
      if (prior === undefined) delete process.env['DEVAI_NATIVE_COLLECTION_NONCE'];
      else process.env['DEVAI_NATIVE_COLLECTION_NONCE'] = prior;
    }
  });
});
