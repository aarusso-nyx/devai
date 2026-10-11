// ADR-SCR-0017: temporal output custody is a fact validator, never execution-origin authority.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nativeOutputCustody } from '../../src/commands/sense/native-output-custody.js';
import { nativeInputPreloadPath } from '../../src/commands/sense/native-runner-selection.js';
import {
  assertNativeScopeLifecycle,
  inspectNativeInputProvenance,
} from '../../src/commands/sense/native-input-provenance.js';

type Row = Record<string, unknown>;
const nonce = 'a'.repeat(64);
const project = 'p'.repeat(21);
const contentHash = createHash('sha256').update('owned output').digest('hex');
let root: string;
let runtime: string;
let physical: string;
let directory: string;
let file: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai output custody ç '));
  runtime = resolve(root, '.devai/state/native-config-traces', nonce, 'runtime');
  mkdirSync(runtime, { recursive: true });
  physical = realpathSync(runtime);
  directory = join(runtime, project, 'ssr');
  file = join(directory, 'b'.repeat(40));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const physicalPath = (path: string) => resolve(physical, relative(runtime, path));
function inspect(
  options: {
    initialEntries?: readonly string[];
    selectedRoots?: readonly string[];
    reporter?: 'vitest-v1' | 'playwright-v1';
    resultRoots?: readonly string[];
  } = {},
) {
  return nativeOutputCustody(
    root,
    nonce,
    [
      {
        kind: 'begin',
        scope: 'main',
        runtimeRoot: runtime,
        runtimePhysicalRoot: physical,
        runtimeRootMode: statSync(runtime).mode,
        initialRuntimeEntries: options.initialEntries ?? [],
      },
    ],
    JSON.stringify({
      devaiCollection: {
        reporter: options.reporter ?? 'vitest-v1',
        runtimeOutputRoots: options.selectedRoots ?? [join(runtime, project)],
        ...(options.reporter === 'playwright-v1'
          ? {
              runtimeResultRoot: join(runtime, 'playwright-results'),
              resolvedSelection: (options.resultRoots ?? [join(runtime, 'playwright-results')]).map(
                (outputDir) => ({ outputDir }),
              ),
            }
          : {}),
      },
    }),
  );
}
function createDirectories(accept: (row: Row) => boolean): void {
  expect(
    accept({
      kind: 'output-mkdir',
      path: directory,
      created: [join(runtime, project), directory].map((path) => ({
        path,
        realpath: physicalPath(path),
        mode: 0o40755,
      })),
    }),
  ).toBe(true);
}
function write(accept: (row: Row) => boolean, path = file, hash = contentHash): void {
  expect(accept({ kind: 'output-write-intent', path, present: false, sha256: null })).toBe(true);
  expect(
    accept({
      kind: 'output-write',
      path,
      realpath: physicalPath(path),
      sha256: hash,
      utf8Sha256: hash,
      mode: 0o100644,
      size: 12,
    }),
  ).toBe(true);
}
const read = (path = file, hash = contentHash): Row => ({
  kind: 'observation',
  operation: 'readFile',
  path,
  encoding: null,
  observation: { sha256: hash, realpath: physicalPath(path) },
});

describe('ordered native output custody', () => {
  it('admits an owned full write before a matching read', () => {
    const accept = inspect();
    createDirectories(accept);
    write(accept);
    expect(accept(read())).toBe(true);
  });

  it('refuses read-before-write even if a later full write would match', () => {
    const accept = inspect();
    createDirectories(accept);
    expect(() => accept(read())).toThrow('NATIVE_OUTPUT_READ_BEFORE_WRITE');
    write(accept);
    expect(accept(read())).toBe(true);
  });

  it('does not grant read credit from a write intention alone', () => {
    const accept = inspect();
    createDirectories(accept);
    accept({ kind: 'output-write-intent', path: file, present: false, sha256: null });
    expect(() => accept(read())).toThrow('NATIVE_OUTPUT_READ_BEFORE_WRITE');
  });

  it('transfers complete byte custody through rename and removes the old path', () => {
    const accept = inspect();
    createDirectories(accept);
    const temporary = join(directory, '.tmp-123-abc');
    write(accept, temporary);
    accept({ kind: 'output-rename-intent', path: temporary, target: file, targetPresent: false });
    expect(
      accept({
        kind: 'output-rename',
        path: temporary,
        target: file,
        realpath: physicalPath(file),
      }),
    ).toBe(true);
    expect(accept(read())).toBe(true);
    expect(() => accept(read(temporary))).toThrow('NATIVE_OUTPUT_READ_BEFORE_WRITE');
  });

  it('refuses an overwrite of a pre-existing file that the ledger does not own', () => {
    const accept = inspect();
    createDirectories(accept);
    expect(() =>
      accept({ kind: 'output-write-intent', path: file, present: true, sha256: contentHash }),
    ).toThrow('NATIVE_OUTPUT_UNOWNED_OVERWRITE');
  });

  it('refuses overwriting owned bytes when the pre-write digest changed', () => {
    const accept = inspect();
    createDirectories(accept);
    write(accept);
    expect(() =>
      accept({ kind: 'output-write-intent', path: file, present: true, sha256: 'c'.repeat(64) }),
    ).toThrow('NATIVE_OUTPUT_UNOWNED_OVERWRITE');
  });

  it('refuses a renamed output when the target is already owned', () => {
    const accept = inspect();
    createDirectories(accept);
    const temporary = join(directory, '.tmp-123-abc');
    write(accept, temporary);
    write(accept);
    expect(() =>
      accept({
        kind: 'output-rename-intent',
        path: temporary,
        target: file,
        targetPresent: false,
      }),
    ).toThrow('NATIVE_OUTPUT_UNOWNED_OVERWRITE');
  });

  it('refuses a write whose physical target escapes the runtime root', () => {
    const accept = inspect();
    createDirectories(accept);
    accept({ kind: 'output-write-intent', path: file, present: false, sha256: null });
    expect(() =>
      accept({
        kind: 'output-write',
        path: file,
        realpath: join(root, 'outside'),
        sha256: contentHash,
        utf8Sha256: contentHash,
        mode: 0o100644,
        size: 12,
      }),
    ).toThrow('NATIVE_OUTPUT_WRITE_INVALID');
  });

  it('refuses cleanup containing an entry absent from the ownership ledger', () => {
    const accept = inspect();
    createDirectories(accept);
    expect(() =>
      accept({
        kind: 'output-cleanup',
        path: directory,
        entries: [
          { path: directory, realpath: physicalPath(directory), mode: 0o40755, sha256: null },
          { path: file, realpath: physicalPath(file), mode: 0o100644, sha256: contentHash },
        ],
      }),
    ).toThrow('NATIVE_OUTPUT_CLEANUP_UNOWNED');
  });

  it('refuses cleanup after owned output bytes changed', () => {
    const accept = inspect();
    createDirectories(accept);
    write(accept);
    expect(() =>
      accept({
        kind: 'output-cleanup',
        path: directory,
        entries: [
          { path: directory, realpath: physicalPath(directory), mode: 0o40755, sha256: null },
          { path: file, realpath: physicalPath(file), mode: 0o100644, sha256: 'c'.repeat(64) },
        ],
      }),
    ).toThrow('NATIVE_OUTPUT_CLEANUP_CHANGED');
  });

  it('admits complete owned cleanup then refuses subsequent reads', () => {
    const accept = inspect();
    createDirectories(accept);
    write(accept);
    expect(
      accept({
        kind: 'output-cleanup',
        path: directory,
        entries: [
          { path: directory, realpath: physicalPath(directory), mode: 0o40755, sha256: null },
          { path: file, realpath: physicalPath(file), mode: 0o100644, sha256: contentHash },
        ],
      }),
    ).toBe(true);
    expect(accept({ kind: 'output-remove', path: directory })).toBe(true);
    expect(() => accept(read())).toThrow('NATIVE_OUTPUT_READ_BEFORE_WRITE');
  });

  it('refuses a successful write event without a preceding write intention', () => {
    const accept = inspect();
    createDirectories(accept);
    expect(() =>
      accept({
        kind: 'output-write',
        path: file,
        realpath: physicalPath(file),
        sha256: contentHash,
        utf8Sha256: contentHash,
        mode: 0o100644,
        size: 12,
      }),
    ).toThrow(/NATIVE_OUTPUT_/u);
  });

  it('refuses a rename destination that differs from the inspected target', () => {
    const accept = inspect();
    createDirectories(accept);
    const temporary = join(directory, '.tmp-123-abc');
    write(accept, temporary);
    accept({ kind: 'output-rename-intent', path: temporary, target: file, targetPresent: false });
    const changedTarget = join(directory, 'c'.repeat(40));
    expect(() =>
      accept({
        kind: 'output-rename',
        path: temporary,
        target: changedTarget,
        realpath: physicalPath(changedTarget),
      }),
    ).toThrow(/NATIVE_OUTPUT_/u);
  });

  it('refuses removal without a complete prior cleanup observation', () => {
    const accept = inspect();
    createDirectories(accept);
    write(accept);
    expect(() => accept({ kind: 'output-remove', path: directory })).toThrow(/NATIVE_OUTPUT_/u);
  });

  it('retains repeated output occurrences across remove and recreate', () => {
    const accept = inspect();
    for (let occurrence = 0; occurrence < 2; occurrence += 1) {
      createDirectories(accept);
      write(accept);
      expect(accept(read())).toBe(true);
      const projectDirectory = dirname(directory);
      expect(
        accept({
          kind: 'output-cleanup',
          path: projectDirectory,
          entries: [
            {
              path: projectDirectory,
              realpath: physicalPath(projectDirectory),
              mode: 0o40755,
              sha256: null,
            },
            { path: directory, realpath: physicalPath(directory), mode: 0o40755, sha256: null },
            { path: file, realpath: physicalPath(file), mode: 0o100644, sha256: contentHash },
          ],
        }),
      ).toBe(true);
      expect(accept({ kind: 'output-remove', path: projectDirectory })).toBe(true);
      expect(() => accept(read())).toThrow('NATIVE_OUTPUT_READ_BEFORE_WRITE');
    }
    expect(() => accept.finish()).not.toThrow();
  });

  it('refuses a pre-existing runtime cache root before granting any output custody', () => {
    writeFileSync(join(runtime, 'preexisting'), 'cached');
    expect(() => inspect({ initialEntries: ['preexisting'] })).toThrow(
      'NATIVE_OUTPUT_ROOT_NOT_FRESH',
    );
  });

  it.each(['unexpected', '../escape', `${project}/client`])(
    'refuses unsupported output path %s',
    (suffix) => {
      const accept = inspect();
      expect(() =>
        accept({
          kind: 'output-write-intent',
          path: resolve(runtime, suffix),
          present: false,
          sha256: null,
        }),
      ).toThrow('NATIVE_OUTPUT_PATH_INVALID');
    },
  );

  it('refuses completion in a different native scope than the write intention', () => {
    const accept = inspect();
    createDirectories(accept);
    accept({
      kind: 'output-write-intent',
      scope: 'main',
      path: file,
      present: false,
      sha256: null,
    });
    expect(() =>
      accept({
        kind: 'output-write',
        scope: 'worker',
        path: file,
        realpath: physicalPath(file),
        sha256: contentHash,
        utf8Sha256: contentHash,
        mode: 0o100644,
        size: 12,
      }),
    ).toThrow('NATIVE_OUTPUT_OPERATION_INCOMPLETE');
  });

  it('refuses an unfinished intention at the end of the native execution', () => {
    const accept = inspect();
    createDirectories(accept);
    accept({ kind: 'output-write-intent', path: file, present: false, sha256: null });
    expect(() => accept.finish()).toThrow('NATIVE_OUTPUT_OPERATION_INCOMPLETE');
  });

  it('grants transformed Playwright source custody only after its full owned JavaScript write', () => {
    const accept = inspect({ reporter: 'playwright-v1' });
    const cache = join(runtime, 'playwright');
    const bucket = join(cache, 'ab');
    const output = join(bucket, 'abcdef1234_abcdef1_config.js');
    expect(accept.hasTransformedSource(contentHash)).toBe(false);
    accept({
      kind: 'output-mkdir',
      path: bucket,
      created: [cache, bucket].map((path) => ({
        path,
        realpath: physicalPath(path),
        mode: 0o40755,
      })),
    });
    accept({ kind: 'output-write-intent', path: output, present: false, sha256: null });
    expect(accept.hasTransformedSource(contentHash)).toBe(false);
    accept({
      kind: 'output-write',
      path: output,
      realpath: physicalPath(output),
      sha256: contentHash,
      utf8Sha256: contentHash,
      mode: 0o100644,
      size: 12,
    });
    expect(accept.hasTransformedSource(contentHash)).toBe(true);
    expect(accept.hasTransformedSource('c'.repeat(64))).toBe(false);
    expect(() => accept.finish()).not.toThrow();
  });

  it('does not grant transformed source custody from an owned source map', () => {
    const accept = inspect({ reporter: 'playwright-v1' });
    const cache = join(runtime, 'playwright');
    const bucket = join(cache, 'ab');
    const output = join(bucket, 'abcdef1234_abcdef1_config.map');
    accept({
      kind: 'output-mkdir',
      path: bucket,
      created: [cache, bucket].map((path) => ({
        path,
        realpath: physicalPath(path),
        mode: 0o40755,
      })),
    });
    write(accept, output);
    expect(accept.hasTransformedSource(contentHash)).toBe(false);
  });

  it('refuses a selected cache root outside the exact fresh runtime directory', () => {
    expect(() => inspect({ selectedRoots: [join(dirname(runtime), project)] })).toThrow(
      'NATIVE_OUTPUT_ROOT_SELECTION_INVALID',
    );
  });

  function createResultDirectories(accept: (row: Row) => boolean): string {
    const resultRoot = join(runtime, 'playwright-results');
    const artifact = join(resultRoot, '.playwright-artifacts-0');
    expect(
      accept({
        kind: 'output-mkdir',
        path: artifact,
        created: [resultRoot, artifact].map((path) => ({
          path,
          realpath: physicalPath(path),
          mode: 0o40755,
        })),
      }),
    ).toBe(true);
    return resultRoot;
  }

  it('owns finite result directory metadata and full last-run writes without source credit', () => {
    const accept = inspect({ reporter: 'playwright-v1' });
    const results = createResultDirectories(accept);
    expect(
      accept({
        kind: 'observation',
        path: join(results, '.playwright-artifacts-0'),
        operation: 'lstat',
        observation: { present: true },
      }),
    ).toBe(true);
    write(accept, join(results, '.last-run.json'));
    expect(accept.hasTransformedSource(contentHash)).toBe(false);
    expect(() => accept(read(join(results, '.last-run.json')))).toThrow(
      'NATIVE_OUTPUT_RESULT_INPUT_REFUSED',
    );
    expect(() => accept.finish()).not.toThrow();
  });

  it.each(
    [[], ['/outside'], ['/outside', 'second-project']].map((resultRoots) => ({ resultRoots })),
  )('refuses unresolved or mismatching selected project result roots %j', ({ resultRoots }) => {
    expect(() => inspect({ reporter: 'playwright-v1', resultRoots })).toThrow(
      'NATIVE_OUTPUT_ROOT_SELECTION_INVALID',
    );
  });

  it.each(['unexpected.js', 'slug/deeper.js', '.last-run.json/deeper'])(
    'refuses unsupported result artifact %s',
    (part) => {
      const accept = inspect({ reporter: 'playwright-v1' });
      const results = createResultDirectories(accept);
      expect(() =>
        accept({
          kind: 'output-write-intent',
          path: join(results, part),
          present: false,
          sha256: null,
        }),
      ).toThrow('NATIVE_OUTPUT_PATH_INVALID');
    },
  );

  it('refuses treating result metadata as a directory', () => {
    const accept = inspect({ reporter: 'playwright-v1' });
    const results = createResultDirectories(accept);
    const path = join(results, '.last-run.json');
    expect(() =>
      accept({
        kind: 'output-mkdir',
        path,
        created: [{ path, realpath: physicalPath(path), mode: 0o40755 }],
      }),
    ).toThrow('NATIVE_OUTPUT_CREATION_INVALID');
  });

  it('refuses renaming result metadata into a transform-cache source', () => {
    const accept = inspect({ reporter: 'playwright-v1' });
    const results = createResultDirectories(accept);
    const path = join(results, '.last-run.json');
    write(accept, path);
    const target = join(runtime, 'playwright/ab/abcdef1234_abcdef1_config.js');
    expect(() =>
      accept({ kind: 'output-rename-intent', path, target, targetPresent: false }),
    ).toThrow();
    expect(accept.hasTransformedSource(contentHash)).toBe(false);
  });

  it('refuses interpreting even owned result metadata as a loaded module', () => {
    const accept = inspect({ reporter: 'playwright-v1' });
    const results = createResultDirectories(accept);
    const path = join(results, '.last-run.json');
    write(accept, path);
    expect(() => accept({ kind: 'module-load', path, sourceSha256: contentHash })).toThrow(
      'NATIVE_OUTPUT_EVENT_INVALID',
    );
  });
});

describe('actual native preload bootstrap', () => {
  function bootstrap(program: string) {
    const trace = join(dirname(runtime), 'inputs.ndjson');
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', program], {
      cwd: root,
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
        PWTEST_CACHE_DIR: join(runtime, 'playwright'),
        NODE_OPTIONS: `--import=${pathToFileURL(nativeInputPreloadPath()).href}`,
      },
    });
    const rows = readFileSync(trace, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Row);
    return { result, rows };
  }

  it('installs its own trusted hooks and emits the complete native lifetime', () => {
    const { result, rows } = bootstrap("console.log('native-preload-ready');");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('native-preload-ready\n');
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'begin', scope: 'main', nonce, runtimeRoot: runtime }),
        expect.objectContaining({ kind: 'end', scope: 'main', nonce }),
      ]),
    );
    expect(rows.filter((row) => row['kind'] === 'unsupported')).toEqual([]);
  });

  it.each([undefined, { owned: ['original', 17], nested: { value: true } }])(
    'seals an ordinary worker before termination and preserves original workerData %j',
    (data) => {
      const worker = join(root, 'worker.mjs');
      writeFileSync(
        worker,
        "import { parentPort, workerData } from 'node:worker_threads'; parentPort.postMessage(workerData); setInterval(() => {}, 1000);",
      );
      const { result, rows } = bootstrap(
        `import { Worker } from 'node:worker_threads'; import { once } from 'node:events';
const worker = new Worker(new URL(${JSON.stringify(pathToFileURL(worker).href)}), { execArgv: [], workerData: ${JSON.stringify(data)} });
const [data] = await once(worker, 'message'); console.log(JSON.stringify({data})); await worker.terminate();`,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(data === undefined ? {} : { data });
      expect(rows.filter((row) => row['kind'] === 'unsupported')).toEqual([]);
      const registration = rows.find((row) => row['kind'] === 'child');
      expect(registration).toBeDefined();
      const childScope = registration?.['childScope'];
      expect(rows.some((row) => row['kind'] === 'end' && row['scope'] === childScope)).toBe(true);
      expect(() => assertNativeScopeLifecycle(rows)).not.toThrow();
    },
  );

  it('refuses a private worker seal while a real filesystem read is still pending', () => {
    const fifo = join(root, 'pending-worker-input');
    execFileSync('/usr/bin/mkfifo', [fifo]);
    const worker = join(root, 'pending-worker.mjs');
    writeFileSync(
      worker,
      `import fs from 'node:fs'; import { parentPort } from 'node:worker_threads';
fs.readFile(${JSON.stringify(fifo)}, () => {}); parentPort.postMessage('read-pending'); setInterval(() => {}, 1000);`,
    );
    const { result, rows } = bootstrap(
      `import fs from 'node:fs'; import { Worker } from 'node:worker_threads'; import { once } from 'node:events';
const worker = new Worker(new URL(${JSON.stringify(pathToFileURL(worker).href)}), { execArgv: [] });
worker.on('error', () => {}); await once(worker, 'message');
try { await worker.terminate(); throw new Error('unexpected seal success'); }
catch (error) { console.log(error.message); }
fs.writeFileSync(${JSON.stringify(fifo)}, 'release actual pending read');
await once(worker, 'exit');`,
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.stdout).toContain('DEVAI_NATIVE_INPUT_UNSUPPORTED:worker-seal-not-acknowledged');
    const registration = rows.find((row) => row['kind'] === 'child');
    const childScope = registration?.['childScope'];
    expect(childScope).toEqual(expect.any(String));
    expect(
      rows.some(
        (row) =>
          row['scope'] === childScope &&
          row['kind'] === 'unsupported' &&
          row['operation'] === 'pending-filesystem-io',
      ),
    ).toBe(true);
    expect(rows.some((row) => row['kind'] === 'end' && row['scope'] === childScope)).toBe(false);
    expect(() => assertNativeScopeLifecycle(rows)).toThrow('NATIVE_INPUT_SCOPE_LIFECYCLE_INVALID');
  });

  it('refuses sealing while a supported filesystem callback is still pending', () => {
    const input = join(root, 'pending-input.txt');
    writeFileSync(input, 'actual input bytes');
    const { result, rows } = bootstrap(
      `import fs from 'node:fs'; fs.readFile(${JSON.stringify(input)}, () => {}); process.exit(0);`,
    );
    // Node's explicit process.exit(0) retains zero even if an exit listener throws.
    expect(result.status, JSON.stringify({ stderr: result.stderr, rows })).toBe(0);
    expect(
      inspectNativeInputProvenance(
        root,
        nonce,
        rows.map((row) => JSON.stringify(row)).join('\n'),
        JSON.stringify({ devaiCollection: { reporter: 'vitest-v1' } }),
        { argv: ['vitest', 'run', '--config', './vitest.config.mjs'], cwd: '.' },
      ),
    ).toEqual(['NATIVE_INPUT_TRACE_INCOMPLETE']);
    expect(
      rows.some(
        (row) => row['kind'] === 'unsupported' && String(row['operation']).includes('pending'),
      ),
    ).toBe(true);
    expect(rows.filter((row) => row['kind'] === 'end')).toEqual([]);
  });

  it('still refuses adopter-installed synchronous module hooks', () => {
    const { result, rows } = bootstrap(
      "const module = await import('node:module'); module.registerHooks({});",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'DEVAI_NATIVE_INPUT_UNSUPPORTED:unreviewed-module-register-hooks',
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'unsupported',
          operation: 'unreviewed-module-register-hooks',
        }),
      ]),
    );
  });
});
