// ADR-SCR-0019: compiler rows are independently replayed facts, never execution-origin authority.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nativeCoverageGitIdentity } from '../../src/commands/sense/native-coverage-host.js';
import { replayNativeCoverageAdapters } from '../../src/commands/sense/native-coverage-replay.js';
import { nativeInputPreloadPath } from '../../src/commands/sense/native-runner-selection.js';
import {
  isHarnessMutatedPath,
  RELEASE_INPUT_PROJECTION,
  trackedPaths,
} from '../../src/services/check-runner/policy-git.js';

type Row = Record<string, unknown>;
const ROOT = resolve(import.meta.dirname, '../../../..');
const compilerManifest = realpathSync(
  createRequire(
    realpathSync(join(ROOT, 'node_modules/devai-native-coverage-compiler-fixture/package.json')),
  ).resolve('typescript/package.json'),
);
const compiler: typeof import('typescript') = createRequire(import.meta.url)(
  dirname(compilerManifest),
);
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const roots: string[] = [];
const preload = nativeInputPreloadPath();
const adapterURL = pathToFileURL(
  createRequire(join(ROOT, 'packages/cli/package.json')).resolve(
    '@aarusso-nyx/devai/native-coverage-adapter',
  ),
).href;
const gitIdentity = nativeCoverageGitIdentity();
function put(root: string, path: string, value: string | object) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value));
}
function git(root: string, ...args: string[]) {
  const result = spawnSync(
    gitIdentity.path,
    [
      '-c',
      'core.fsmonitor=false',
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
function fixture() {
  expect(compiler.version).toBe('6.0.3');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai governed compiler ç ')));
  roots.push(root);
  put(root, 'package.json', {
    name: 'governed-compiler-fixture',
    version: '1.0.0',
    type: 'module',
    devDependencies: { typescript: '6.0.3' },
  });
  put(root, '.gitignore', 'node_modules/\ndist/\n.devai/\n');
  put(root, 'tsconfig.json', {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      rootDir: 'src',
      outDir: 'dist',
      sourceMap: true,
      declaration: true,
      declarationMap: true,
      strict: true,
      skipLibCheck: true,
      types: [],
    },
    include: ['src/**/*.ts'],
  });
  put(root, 'src/index.ts', 'export const owned = (value: number): number => value + 1;\n');
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(dirname(compilerManifest), join(root, 'node_modules/typescript'), 'dir');
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture inputs');
  const parsed = compiler.getParsedCommandLineOfConfigFile(
    join(root, 'tsconfig.json'),
    {},
    {
      ...compiler.sys,
      onUnRecoverableConfigFileDiagnostic: () => {
        throw new Error('fixture config');
      },
    },
  );
  if (parsed === undefined) throw new Error('fixture config');
  const program = compiler.createProgram(parsed.fileNames, parsed.options);
  expect(compiler.getPreEmitDiagnostics(program)).toEqual([]);
  const production = new Map<string, string>();
  const emitted = program.emit(undefined, (path, text) => {
    production.set(relative(root, path), text);
    put(root, relative(root, path), text);
  });
  expect(emitted.emitSkipped).toBe(false);
  expect(emitted.diagnostics).toEqual([]);
  return {
    root,
    production,
    candidate: git(root, 'rev-parse', 'HEAD'),
    options: {
      packageDir: root,
      config: 'tsconfig.json',
      modules: [{ source: 'src/index.ts', output: 'dist/index.js' }],
      includes: ['src/**/*.ts'],
      excludes: ['src/**/*.d.ts'],
    },
  };
}
function bootstrap(
  f: ReturnType<typeof fixture>,
  body: string,
  missingContext = false,
  contextRoute: 'regular' | 'symlink' | 'hardlink' = 'regular',
) {
  const nonce = randomBytes(32).toString('hex');
  const directory = join(f.root, '.devai/state/native-config-traces', nonce);
  const runtime = join(directory, 'runtime');
  mkdirSync(runtime, { recursive: true });
  const trace = join(directory, 'inputs.ndjson');
  const context = JSON.stringify({
    nonce,
    repository: f.root,
    candidate: f.candidate,
    packageDir: f.root,
    git: gitIdentity,
    tracked: trackedPaths(f.root).filter((path) => !isHarnessMutatedPath(path)),
    excludedPrefixes: RELEASE_INPUT_PROJECTION.excludedPrefixes,
  });
  if (!missingContext) {
    const path = join(directory, 'adapter-context.json');
    if (contextRoute === 'regular') writeFileSync(path, context, { flag: 'wx', mode: 0o400 });
    else {
      const outside = realpathSync(mkdtempSync(join(tmpdir(), 'devai copied context ç ')));
      roots.push(outside);
      const source = join(outside, 'same-byte-context.json');
      writeFileSync(source, context, { flag: 'wx', mode: 0o400 });
      if (contextRoute === 'symlink') symlinkSync(source, path);
      else linkSync(source, path);
    }
  }
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', body], {
    cwd: f.root,
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      CI: '1',
      NO_COLOR: '1',
      NODE_V8_COVERAGE: '',
      DEVAI_NATIVE_COLLECTION_NONCE: nonce,
      DEVAI_NATIVE_INPUT_TRACE: trace,
      DEVAI_NATIVE_INPUT_SCOPE: 'main',
      DEVAI_NATIVE_RUNTIME_ROOT: runtime,
      DEVAI_NATIVE_RUNNER: 'vitest-v1',
      TMPDIR: runtime,
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      ...(!missingContext
        ? {
            DEVAI_NATIVE_ADAPTER_CONTEXT_SHA256: hash(context),
          }
        : {}),
    },
  });
  const rows = (existsSync(trace) ? readFileSync(trace, 'utf8') : '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Row);
  if (process.env['KEEP_NATIVE_FIXTURES'] === '1') {
    put(f.root, `.devai/state/native-coverage-inspector/${nonce}.json`, {
      root: f.root,
      trace,
      status: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
      stdout: result.stdout,
      stderr: result.stderr,
      rows,
    });
    console.log(`NATIVE_COVERAGE_FIXTURE=${f.root}`);
  }
  return { result, rows };
}
const create = (f: ReturnType<typeof fixture>, url = adapterURL) =>
  `const {createNativeCoverageAdapter}=await import(${JSON.stringify(url)}); const adapterOptions=${JSON.stringify(f.options)};const adapter=createNativeCoverageAdapter(adapterOptions);`;
const exercise = `const result=adapter.compile({mode:'production',source:'src/index.ts'}); const fs=await import('node:fs'); for(const output of result.outputs) {const verified=adapter.readVerifiedOutput(output.path);const actual=fs.readFileSync(adapterOptions.packageDir+'/'+output.path,'utf8');if(actual!==verified)throw new Error('output mismatch')} console.log(JSON.stringify({mode:adapter.evidence().mode,candidate:adapter.candidate(),outputs:result.outputs}));`;
let genuine: ReturnType<typeof fixture>;
let capture: ReturnType<typeof bootstrap>;
const copyRows = () => structuredClone(capture.rows);
const index = (rows: Row[], kind: string) => {
  const found = rows.findIndex((row) => row['kind'] === kind);
  expect(found).toBeGreaterThanOrEqual(0);
  return found;
};
const replay = (rows: Row[]) => replayNativeCoverageAdapters(genuine.root, { cwd: '.' }, rows);
beforeAll(() => {
  genuine = fixture();
  capture = bootstrap(genuine, create(genuine) + exercise);
  expect(
    capture.result.status,
    `${capture.result.stderr}\n${JSON.stringify(capture.rows.filter((row) => row['kind'] === 'unsupported'))}`,
  ).toBe(0);
  expect(capture.rows.some((row) => row['kind'] === 'unsupported')).toBe(false);
  expect(capture.rows.at(-1)?.['kind']).toBe('end');
});
afterAll(() => {
  if (process.env['KEEP_NATIVE_FIXTURES'] !== '1')
    for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('actual package-owned native coverage context and independent replay', () => {
  it('resolves the public adapter export to this assembled preload package', () => {
    expect(adapterURL).toBe(
      pathToFileURL(join(dirname(preload), 'native-coverage-adapter.js')).href,
    );
  });
  it('captures real production outputs and replays every verified JS/map/declaration byte', () => {
    const value = JSON.parse(capture.result.stdout) as {
      mode: string;
      candidate: string;
      outputs: { path: string; text: string; sha256: string }[];
    };
    expect(value.mode).toBe('governed');
    expect(value.candidate).toBe(genuine.candidate);
    expect(value.outputs).toHaveLength(4);
    for (const output of value.outputs) {
      expect(output.text).toBe(genuine.production.get(output.path));
      expect(output.sha256).toBe(hash(output.text));
    }
    const accepted = replay(capture.rows);
    for (const output of value.outputs) {
      const path = join(genuine.root, output.path);
      const observed = capture.rows.find(
        (row) =>
          row['kind'] === 'observation' && row['operation'] === 'readFile' && row['path'] === path,
      );
      expect(observed).toBeDefined();
      expect(accepted.has(path, observed as Row)).toBe(true);
    }
    expect(
      capture.rows
        .filter((row) => String(row['kind']).startsWith('adapter-'))
        .map((row) => row['kind']),
    ).toEqual([
      'adapter-begin',
      'adapter-derived',
      ...Array(4).fill('adapter-verified-output'),
      'adapter-evidence',
      'adapter-end',
    ]);
  });

  it('retains governed context after the candidate clears all native environment fields', () => {
    const f = fixture();
    const actual = bootstrap(
      f,
      `for(const key of Object.keys(process.env)) if(key.startsWith('DEVAI_NATIVE_')) delete process.env[key];` +
        create(f) +
        exercise,
    );
    expect(actual.result.status, actual.result.stderr).toBe(0);
    expect(JSON.parse(actual.result.stdout).mode).toBe('governed');
    expect(actual.rows.some((row) => row['kind'] === 'adapter-end')).toBe(true);
    expect(actual.rows.at(-1)?.['kind']).toBe('end');
  });

  it('refuses a canonical active preload without its private host context', () => {
    const f = fixture();
    const actual = bootstrap(f, create(f), true);
    expect(actual.result.status).not.toBe(0);
    expect(actual.rows).toContainEqual(
      expect.objectContaining({ kind: 'unsupported', operation: 'native-coverage-context' }),
    );
    expect(actual.rows.some((row) => row['kind'] === 'adapter-begin')).toBe(false);
  });

  it.each(['symlink', 'hardlink'] as const)(
    'refuses a same-byte %s substitute for the private context file',
    (route) => {
      const f = fixture();
      const actual = bootstrap(f, create(f) + exercise, false, route);
      expect(actual.result.status).not.toBe(0);
      expect(actual.result.stderr).toContain('native-coverage-context');
      expect(actual.rows.some((row) => row['kind'] === 'adapter-begin')).toBe(false);
      expect(actual.rows.some((row) => row['kind'] === 'end')).toBe(false);
    },
  );

  it('cannot clear environment then obtain a diagnostic factory from a copied physical preload', () => {
    const f = fixture();
    const copied = join(f.root, '.devai/copied-runtime');
    cpSync(dirname(preload), copied, { recursive: true });
    const actual = bootstrap(
      f,
      `for(const key of Object.keys(process.env)) if(key.startsWith('DEVAI_NATIVE_')) delete process.env[key];process.env.PATH=${JSON.stringify(dirname(gitIdentity.path))};` +
        create(f, pathToFileURL(join(copied, 'native-coverage-adapter.js')).href) +
        exercise,
    );
    expect(actual.result.status).not.toBe(0);
    expect(actual.rows.some((row) => row['kind'] === 'unsupported')).toBe(true);
    expect(actual.rows.some((row) => row['kind'] === 'adapter-end')).toBe(false);
  });

  it('cannot register generated credit through a physically imported kernel and self-created host IO', () => {
    const f = fixture();
    const kernelURL = pathToFileURL(join(dirname(preload), 'native-coverage-kernel.js')).href;
    const actual = bootstrap(
      f,
      `
      const {createNativeCoverageAdapterKernel}=await import(${JSON.stringify(kernelURL)});
      const fs=await import('node:fs');
      const {createHash}=await import('node:crypto');
      const {execFileSync}=await import('node:child_process');
      const {createRequire}=await import('node:module');
      let refused=false;
      try {
        const kernel=createNativeCoverageAdapterKernel(${JSON.stringify(f.options)}, {
          mode:'governed',path:'',
          bound:{repository:${JSON.stringify(f.root)},packageDir:${JSON.stringify(f.root)},candidate:${JSON.stringify(f.candidate)},git:${JSON.stringify(gitIdentity)}},
          io:{...fs,createHash,execFileSync,createRequire}
        });
        kernel.api.compile({mode:'production',source:'src/index.ts'});
      } catch {refused=true}
      console.log(JSON.stringify({refused}));
    `,
    );
    expect(JSON.parse(actual.result.stdout)).toEqual({ refused: true });
    expect(actual.rows.some((row) => row['kind'] === 'unsupported')).toBe(true);
    expect(actual.rows.some((row) => String(row['kind']).startsWith('adapter-'))).toBe(false);
    expect(
      replayNativeCoverageAdapters(f.root, { cwd: '.' }, actual.rows).has(
        join(f.root, 'dist/index.js'),
        actual.rows.at(-1) as Row,
      ),
    ).toBe(false);
  });

  it('refuses its own seal even when candidate code catches a failed adapter method', () => {
    const f = fixture();
    const actual = bootstrap(
      f,
      create(f) +
        `try{adapter.compile({mode:'production',source:'src/missing.ts'})}catch{} console.log('caught');`,
    );
    expect(actual.result.stdout).toBe('caught\n');
    expect(actual.rows).toContainEqual(
      expect.objectContaining({ kind: 'unsupported', operation: 'native-coverage-operation' }),
    );
    expect(actual.rows.some((row) => row['kind'] === 'end')).toBe(false);
    expect(actual.result.status).not.toBe(0);
  });

  it('cannot disable proxy refusal by replacing the public util.types.isProxy predicate', () => {
    const f = fixture();
    const actual = bootstrap(
      f,
      `
      const {types}=await import('node:util'); types.isProxy=()=>false;
      const {createNativeCoverageAdapter}=await import(${JSON.stringify(adapterURL)});
      let traps=0;
      const request=new Proxy(${JSON.stringify(f.options)},{
        ownKeys(target){traps++;return Reflect.ownKeys(target)},
        getOwnPropertyDescriptor(target,key){traps++;return Reflect.getOwnPropertyDescriptor(target,key)},
        get(target,key){traps++;return Reflect.get(target,key)}
      });
      let refused=false;try{createNativeCoverageAdapter(request)}catch{refused=true}
      console.log(JSON.stringify({refused,traps}));
    `,
    );
    expect(JSON.parse(actual.result.stdout)).toEqual({ refused: true, traps: 0 });
    expect(actual.rows.some((row) => row['kind'] === 'adapter-begin')).toBe(false);
    expect(actual.rows.some((row) => row['kind'] === 'unsupported')).toBe(true);
  });

  it('captures pure helper intrinsics at preload before the first public adapter import', () => {
    const f = fixture();
    const actual = bootstrap(
      f,
      `
      const {types}=await import('node:util');
      const originalProxy=types.isProxy;
      const originalDescriptors=Object.getOwnPropertyDescriptors;
      let traps=0,descriptorCalls=0;
      const value=new Proxy({}, {
        ownKeys(){traps++;throw new Error('keys trap')},
        getOwnPropertyDescriptor(){traps++;throw new Error('descriptor trap')},
        getPrototypeOf(){traps++;throw new Error('prototype trap')}
      });
      let result;
      try {
        types.isProxy=()=>false;
        Object.getOwnPropertyDescriptors=()=>{descriptorCalls++;throw new Error('authored descriptors')};
        const {isProxy,sameNativeData}=await import(${JSON.stringify(adapterURL)});
        const detected=isProxy(value);
        let refused=false;try{sameNativeData(value,value)}catch{refused=true}
        const ordinary=sameNativeData({nested:[1,2]},{nested:[1,2]});
        result={detected,refused,ordinary,traps,descriptorCalls};
      } finally {
        types.isProxy=originalProxy;
        Object.getOwnPropertyDescriptors=originalDescriptors;
      }
      console.log(JSON.stringify(result));
      `,
    );
    expect(actual.result.status, actual.result.stderr).toBe(0);
    expect(JSON.parse(actual.result.stdout)).toEqual({
      detected: true,
      refused: true,
      ordinary: true,
      traps: 0,
      descriptorCalls: 0,
    });
    expect(actual.rows.some((row) => row['kind'] === 'adapter-begin')).toBe(false);
    expect(actual.rows.some((row) => row['kind'] === 'unsupported')).toBe(false);
    expect(actual.rows.at(-1)?.['kind']).toBe('end');
  });

  it('cannot use a tracked planner-mutated namespace as governed compiler source', () => {
    const f = fixture();
    put(f.root, '.devai/state/hidden.ts', 'export const hidden: number = 17;\n');
    put(f.root, 'tsconfig.json', {
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        rootDir: '.devai/state',
        outDir: 'dist',
        sourceMap: true,
        declaration: true,
        declarationMap: true,
        strict: true,
        types: [],
        skipLibCheck: true,
      },
      include: ['.devai/state/**/*.ts'],
    });
    git(f.root, 'add', '-f', '.devai/state/hidden.ts', 'tsconfig.json');
    git(f.root, 'commit', '-qm', 'tracked mutated-namespace witness');
    f.candidate = git(f.root, 'rev-parse', 'HEAD');
    const parsed = compiler.getParsedCommandLineOfConfigFile(
      join(f.root, 'tsconfig.json'),
      {},
      {
        ...compiler.sys,
        onUnRecoverableConfigFileDiagnostic: () => {
          throw new Error('fixture config');
        },
      },
    );
    if (parsed === undefined) throw new Error('fixture config');
    const program = compiler.createProgram(parsed.fileNames, parsed.options);
    expect(compiler.getPreEmitDiagnostics(program)).toEqual([]);
    expect(
      program.emit(undefined, (path, text) => put(f.root, relative(f.root, path), text))
        .emitSkipped,
    ).toBe(false);
    const options = {
      ...f.options,
      modules: [{ source: '.devai/state/hidden.ts', output: 'dist/hidden.js' }],
      includes: ['.devai/state/**/*.ts'],
    };
    const actual = bootstrap(
      f,
      `const {createNativeCoverageAdapter}=await import(${JSON.stringify(adapterURL)});const adapter=createNativeCoverageAdapter(${JSON.stringify(options)});adapter.compile({mode:'production',source:'.devai/state/hidden.ts'});`,
    );
    expect(actual.result.status).not.toBe(0);
    expect(actual.rows.some((row) => row['kind'] === 'unsupported')).toBe(true);
    expect(actual.rows.some((row) => row['kind'] === 'adapter-end')).toBe(false);
  });

  it.each(['adapter-begin', 'adapter-derived', 'adapter-evidence', 'adapter-end'])(
    'refuses a missing %s from the genuine trace',
    (kind) => {
      expect(() => replay(copyRows().filter((row) => row['kind'] !== kind))).toThrow();
    },
  );
  it.each(['adapter-begin', 'adapter-evidence', 'adapter-end'])(
    'refuses a duplicated %s',
    (kind) => {
      const rows = copyRows();
      const position = index(rows, kind);
      rows.splice(position, 0, structuredClone(rows[position] as Row));
      expect(() => replay(rows)).toThrow();
    },
  );
  it('refuses a verified output reordered before its genuine derivation', () => {
    const rows = copyRows();
    const [output] = rows.splice(index(rows, 'adapter-verified-output'), 1);
    rows.splice(index(rows, 'adapter-derived'), 0, output as Row);
    expect(() => replay(rows)).toThrow();
  });
  it('cannot lend one scope its independently derived output in another scope', () => {
    const rows = copyRows();
    (rows[index(rows, 'adapter-verified-output')] as Row)['scope'] = 'worker:other';
    expect(() => replay(rows)).toThrow();
  });
  it('does not retroactively credit an actual generated read moved before verification', () => {
    const rows = copyRows();
    const path = join(genuine.root, 'dist/index.js');
    const position = rows.findIndex(
      (row) =>
        row['kind'] === 'observation' && row['operation'] === 'readFile' && row['path'] === path,
    );
    expect(position).toBeGreaterThan(index(rows, 'adapter-verified-output'));
    const [observed] = rows.splice(position, 1);
    rows.splice(index(rows, 'adapter-verified-output'), 0, observed as Row);
    expect(replay(rows).has(path, observed as Row)).toBe(false);
  });
  it('does not lend verified output to an unrelated scope or an unrecorded row', () => {
    const rows = copyRows();
    const path = join(genuine.root, 'dist/index.js');
    const observed = rows.find(
      (row) =>
        row['kind'] === 'observation' && row['operation'] === 'readFile' && row['path'] === path,
    ) as Row;
    expect(observed).toBeDefined();
    const detached = structuredClone(observed);
    expect(replay(rows).has(path, detached)).toBe(false);
    observed['scope'] = 'worker:unrelated';
    expect(replay(rows).has(path, observed)).toBe(false);
  });
  it('does not credit an output when its genuine verification row is omitted', () => {
    const path = join(genuine.root, 'dist/index.js');
    const rows = copyRows().filter(
      (row) => !(row['kind'] === 'adapter-verified-output' && row['path'] === 'dist/index.js'),
    );
    const observed = rows.find(
      (row) =>
        row['kind'] === 'observation' && row['operation'] === 'readFile' && row['path'] === path,
    ) as Row;
    expect(observed).toBeDefined();
    expect(replay(rows).has(path, observed)).toBe(false);
  });
  it('independently rejects self-consistent forged output hashes', () => {
    const rows = copyRows();
    const derived = rows[index(rows, 'adapter-derived')] as Row;
    const outputs = derived['outputs'] as { path: string; sha256: string }[];
    (outputs[0] as { sha256: string }).sha256 = '0'.repeat(64);
    derived['derivationSha256'] = hash(
      JSON.stringify({ outputs, diagnostics: derived['diagnostics'] }),
    );
    expect(() => replay(rows)).toThrow();
  });
  it('refuses omitted source bindings even with a recomputed request hash', () => {
    const rows = copyRows();
    const begin = rows[index(rows, 'adapter-begin')] as Row;
    (begin['request'] as { modules: unknown[] }).modules = [];
    begin['requestSha256'] = hash(JSON.stringify(begin['request']));
    expect(() => replay(rows)).toThrow();
  });
  it.each(['dist/index.js', 'src/index.ts', 'tsconfig.json', 'package.json'])(
    'refuses current %s drift before host replay',
    (path) => {
      const file = join(genuine.root, path);
      const original = readFileSync(file);
      try {
        writeFileSync(
          file,
          path.endsWith('.json')
            ? `${original.toString()}\n`
            : `${original.toString()}\n// changed\n`,
        );
        expect(() => replay(copyRows())).toThrow();
      } finally {
        writeFileSync(file, original);
      }
    },
  );
  it('refuses a request for a different package context even with a consistent request hash', () => {
    const rows = copyRows();
    const begin = rows[index(rows, 'adapter-begin')] as Row;
    (begin['request'] as { packageDir: string }).packageDir = dirname(genuine.root);
    begin['requestSha256'] = hash(JSON.stringify(begin['request']));
    expect(() => replay(rows)).toThrow();
  });
});
