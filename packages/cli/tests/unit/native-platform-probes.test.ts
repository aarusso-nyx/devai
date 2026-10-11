// ADR-SCR-0017: framework platform facts never grant candidate access to host files.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  frameworkPlatformProbeCallers,
  inspectFrameworkPlatformCaller,
  nativePlatformProbeObservation,
} from '../../src/native-platform-probes.js';
import { nativeInputPreloadPath } from '../../src/commands/sense/native-runner-selection.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const roots: string[] = [];
const host = { platform: 'linux', osRelease: '6.12.0-generic' };
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Row = Record<string, unknown>;
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (process.env['KEEP_NATIVE_FIXTURES'] === '1') console.warn('KEEP_NATIVE_FIXTURE', root);
    else rmSync(root, { recursive: true, force: true });
  }
});

function installedCallers() {
  const vite = realpathSync(join(ROOT, 'node_modules/vite-native-fixture/package.json'));
  const playwright = realpathSync(
    join(ROOT, 'node_modules/playwright-native-fixture/package.json'),
  );
  const swc = realpathSync(join(ROOT, 'node_modules/swc-native-fixture/package.json'));
  const playwrightPackage = createRequire(playwright).resolve('playwright/package.json');
  const playwrightCore = createRequire(playwrightPackage).resolve('playwright-core/package.json');
  return frameworkPlatformProbeCallers.map((caller) => {
    const manifest =
      caller.packageName === 'vite'
        ? vite
        : caller.packageName === '@swc/core'
          ? swc
          : playwrightCore;
    return {
      caller,
      manifest: realpathSync(manifest),
      file: join(dirname(realpathSync(manifest)), caller.file),
    };
  });
}

function bootstrap(program: string, sealed = true, nodeFlags: readonly string[] = []) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai platform probes ç ')));
  roots.push(root);
  const nonce = 'b'.repeat(64);
  const runtime = join(root, '.devai/state/native-config-traces', nonce, 'runtime');
  const trace = join(dirname(runtime), 'inputs.ndjson');
  mkdirSync(runtime, { recursive: true });
  const result = spawnSync(
    process.execPath,
    [...nodeFlags, '--input-type=module', '--eval', program],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 16 * 1024 * 1024,
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
    },
  );
  expect(result.error, result.stderr).toBeUndefined();
  if (sealed) expect(result.status, result.stderr).toBe(0);
  const rows = readFileSync(trace, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Row);
  if (sealed) {
    expect(rows.filter((row) => row['kind'] === 'unsupported')).toEqual([]);
    expect(rows.at(-1)).toMatchObject({ kind: 'end', scope: 'main' });
  }
  return { result, rows };
}

describe('pure framework platform facts', () => {
  it('pins all four actual installed callers and rejects changed source, package or physical path', () => {
    expect(installedCallers()).toHaveLength(4);
    for (const { caller, file, manifest } of installedCallers()) {
      const bytes = readFileSync(file);
      const packageBytes = readFileSync(manifest);
      expect(inspectFrameworkPlatformCaller(file, caller, file, bytes, packageBytes)).toBe(
        dirname(manifest),
      );
      expect(() =>
        inspectFrameworkPlatformCaller(
          file,
          caller,
          file,
          Buffer.concat([bytes, Buffer.from('\n')]),
          packageBytes,
        ),
      ).toThrow('NATIVE_PLATFORM_CALLER_INVALID');
      expect(() =>
        inspectFrameworkPlatformCaller(file, caller, `${file}.other`, bytes, packageBytes),
      ).toThrow('NATIVE_PLATFORM_CALLER_INVALID');
      for (const changed of [
        { name: 'lookalike', version: caller.packageVersion },
        { name: caller.packageName, version: '0.0.0' },
      ]) {
        expect(() =>
          inspectFrameworkPlatformCaller(
            file,
            caller,
            file,
            bytes,
            Buffer.from(JSON.stringify(changed)),
          ),
        ).toThrow('NATIVE_PLATFORM_PACKAGE_INVALID');
      }
    }
  });

  it('preserves exact GNU, non-WSL and duplicate-last os-release semantics from supplied bytes', () => {
    const [vite, , playwright, swc] = frameworkPlatformProbeCallers;
    const kernel = 'Linux version 6.12.0 GNU/Linux\n';
    expect(
      nativePlatformProbeObservation(vite, host, '/proc/version', Buffer.from(kernel), kernel),
    ).toEqual({
      sha256: sha(kernel),
      rawSha256: sha(kernel),
      realpath: '/proc/version',
      semantics: { includesMicrosoft: false },
    });
    expect(
      nativePlatformProbeObservation(swc, host, '/usr/bin/ldd', Buffer.from('GNU libc\n'))
        .semantics,
    ).toEqual({ includesMusl: false });
    expect(
      nativePlatformProbeObservation(
        playwright,
        host,
        '/etc/os-release',
        Buffer.from('ID="\nVERSION_ID="\n'),
      ).semantics,
    ).toEqual({ id: '"', version: '"' });
    const distribution = 'ID=old\nID="debian"\nVERSION_ID="12"\nEXTRA=a=b\n';
    expect(
      nativePlatformProbeObservation(
        playwright,
        host,
        '/usr/lib/os-release',
        Buffer.from(distribution),
      ).semantics,
    ).toEqual({ id: 'debian', version: '12' });
    expect(
      nativePlatformProbeObservation(playwright, host, '/etc/os-release', Buffer.from(distribution))
        .realpath,
    ).toBe('/etc/os-release');
  });

  it.each([
    [
      'host WSL',
      0,
      { platform: 'linux', osRelease: '6.1-Microsoft' },
      '/proc/version',
      Buffer.from('Linux'),
      undefined,
      'NATIVE_PLATFORM_UNSUPPORTED',
    ],
    [
      'non-Linux',
      0,
      { platform: 'darwin', osRelease: '24' },
      '/proc/version',
      Buffer.from('Linux'),
      undefined,
      'NATIVE_PLATFORM_UNSUPPORTED',
    ],
    [
      'kernel WSL',
      0,
      host,
      '/proc/version',
      Buffer.from('Linux microsoft-standard'),
      undefined,
      'NATIVE_PLATFORM_WSL_UNSUPPORTED',
    ],
    [
      'musl',
      3,
      host,
      '/usr/bin/ldd',
      Buffer.from('musl libc'),
      undefined,
      'NATIVE_PLATFORM_MUSL_UNSUPPORTED',
    ],
    [
      'physical escape',
      2,
      host,
      '/tmp/os-release',
      Buffer.from('ID=debian'),
      undefined,
      'NATIVE_PLATFORM_PHYSICAL_PATH_UNSUPPORTED',
    ],
    [
      'kernel alias',
      0,
      host,
      '/tmp/version',
      Buffer.from('Linux'),
      undefined,
      'NATIVE_PLATFORM_PHYSICAL_PATH_UNSUPPORTED',
    ],
    [
      'invalid UTF8',
      0,
      host,
      '/proc/version',
      Buffer.from([0xff]),
      undefined,
      'NATIVE_PLATFORM_READ_CHANGED',
    ],
    [
      'returned mismatch',
      0,
      host,
      '/proc/version',
      Buffer.from('Linux'),
      'other',
      'NATIVE_PLATFORM_READ_CHANGED',
    ],
    [
      'nonstring result',
      0,
      host,
      '/proc/version',
      Buffer.from('Linux'),
      Buffer.from('Linux'),
      'NATIVE_PLATFORM_READ_CHANGED',
    ],
  ] as const)(
    'refuses %s without broadening host-file admission',
    (_name, index, identity, physical, bytes, returned, code) => {
      const caller = frameworkPlatformProbeCallers[index];
      expect(() =>
        nativePlatformProbeObservation(caller, identity, physical, bytes, returned),
      ).toThrow(code);
    },
  );
});

describe('actual native framework platform proof', () => {
  it.runIf(process.platform === 'linux')(
    'captures exact executing Vite, Playwright and SWC sources with identical seal rechecks',
    () => {
      const callers = installedCallers();
      const { rows } = bootstrap(
        callers
          .map(({ file }) => `await import(${JSON.stringify(pathToFileURL(file).href)});`)
          .join('\n'),
      );
      const facts = rows.filter((row) => row['kind'] === 'framework-platform-probe');
      const rechecks = rows.filter((row) => row['kind'] === 'framework-platform-probe-recheck');
      expect(facts).toHaveLength(4);
      expect(rechecks).toHaveLength(4);
      const begin = rows.find((row) => row['kind'] === 'begin');
      for (const { caller, file } of callers) {
        const fact = facts.find((row) => (row['caller'] as Row)['file'] === file);
        expect(fact).toMatchObject({
          probe: caller.probe,
          api: 'readFileSync',
          path: caller.path,
          encoding: caller.encoding,
        });
        expect(fact?.['caller']).toMatchObject({
          packageName: caller.packageName,
          packageVersion: caller.packageVersion,
          file,
          sha256: caller.sha256,
          sourceSha256: caller.sha256,
          line: caller.line,
          column: caller.column,
          scriptId: expect.stringMatching(/^[1-9][0-9]*$/u),
        });
        expect(fact).toMatchObject(begin?.['hostPlatform'] as object);
        expect(fact?.['observation']).toEqual(
          nativePlatformProbeObservation(
            caller,
            { platform: process.platform, osRelease: release() },
            realpathSync(caller.path),
            readFileSync(caller.path),
          ),
        );
        expect(rechecks.find((row) => row['probeId'] === fact?.['probeId'])).toEqual({
          ...fact,
          kind: 'framework-platform-probe-recheck',
        });
        expect(rows).not.toContainEqual(
          expect.objectContaining({
            kind: 'observation',
            operation: 'readFile',
            path: caller.path,
          }),
        );
      }
    },
  );

  it.runIf(process.platform === 'linux')(
    'keeps the genuine SWC executing script available through forced garbage collection at seal',
    () => {
      const swc = installedCallers().find(({ caller }) => caller.packageName === '@swc/core');
      if (swc === undefined) throw new Error('Pinned SWC caller missing');
      const { rows, result } = bootstrap(
        `
await import(${JSON.stringify(pathToFileURL(swc.file).href)});
if(typeof globalThis.gc!=='function') throw new Error('Actual garbage collection unavailable');
for(let cycle=0;cycle<12;cycle++){globalThis.gc();await new Promise(resolve=>setTimeout(resolve,10));}
console.log('actual-gc-completed:12');
`,
        true,
        ['--expose-gc'],
      );
      expect(result.stdout.trim()).toBe('actual-gc-completed:12');
      const facts = rows.filter((row) => row['kind'] === 'framework-platform-probe');
      expect(facts).toHaveLength(1);
      expect(facts[0]?.['caller']).toMatchObject({
        packageName: '@swc/core',
        packageVersion: '1.16.2',
        file: swc.file,
        sha256: swc.caller.sha256,
        sourceSha256: swc.caller.sha256,
        scriptId: expect.stringMatching(/^[1-9][0-9]*$/u),
      });
      expect(rows.filter((row) => row['kind'] === 'framework-platform-probe-recheck')).toEqual([
        { ...facts[0], kind: 'framework-platform-probe-recheck' },
      ]);
      expect(rows.filter((row) => row['kind'] === 'unsupported')).toEqual([]);
      expect(rows.at(-1)).toMatchObject({ kind: 'end', scope: 'main' });
    },
  );

  it.runIf(process.platform === 'linux').each(['/proc/version', '/etc/os-release', '/usr/bin/ldd'])(
    'keeps candidate reads of %s as ordinary external observations',
    (path) => {
      const { rows } = bootstrap(
        `import {readFileSync} from 'node:fs'; readFileSync(${JSON.stringify(path)}, 'utf8');`,
      );
      expect(
        rows.filter((row) => String(row['kind']).startsWith('framework-platform-probe')),
      ).toEqual([]);
      expect(rows).toContainEqual(
        expect.objectContaining({ kind: 'observation', operation: 'readFile', path }),
      );
    },
  );

  it('cannot obtain unobserved reads through a physical import of the public pure helper', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'devai outside probe ç ')));
    roots.push(outside);
    const secret = join(outside, 'owned-test-input.txt');
    writeFileSync(secret, 'fixture bytes');
    const helper = join(dirname(nativeInputPreloadPath()), 'native-platform-probes.js');
    const { rows, result } = bootstrap(`
import {readFileSync} from 'node:fs';
const helper = await import(${JSON.stringify(pathToFileURL(helper).href)});
const caller = {...helper.frameworkPlatformProbeCallers[0], path:${JSON.stringify(secret)}};
let missingFactsRefused=false;
try { helper.nativePlatformProbeObservation(caller); } catch {missingFactsRefused=true;}
if(!missingFactsRefused) throw new Error('Helper acquired host facts without supplied bytes');
console.log('missing-facts-refused');
const bytes = readFileSync(${JSON.stringify(secret)});
helper.nativePlatformProbeObservation(caller, {platform:'linux',osRelease:'6'}, ${JSON.stringify(secret)}, bytes);
`);
    expect(result.stdout.trim()).toBe('missing-facts-refused');
    expect(
      rows.filter((row) => String(row['kind']).startsWith('framework-platform-probe')),
    ).toEqual([]);
    expect(rows).toContainEqual(
      expect.objectContaining({ kind: 'observation', operation: 'readFile', path: secret }),
    );
  });

  it.runIf(process.platform === 'linux')(
    'refuses a V8 sourceURL spoof of the exact pinned filename, line and column',
    () => {
      const first = installedCallers()[0];
      if (first === undefined) throw new Error('Pinned Vite caller missing');
      const { caller, file } = first;
      const fakeSource =
        '\n'.repeat(caller.line - 1) +
        ' '.repeat(caller.column - 1) +
        `readFileSync('/proc/version','utf8');\n//# sourceURL=${pathToFileURL(file).href}`;
      const { rows } = bootstrap(
        `import {readFileSync} from 'node:fs'; globalThis.readFileSync=readFileSync; (0,eval)(${JSON.stringify(fakeSource)});`,
      );
      expect(
        rows.filter((row) => String(row['kind']).startsWith('framework-platform-probe')),
      ).toEqual([]);
      expect(rows).toContainEqual(
        expect.objectContaining({
          kind: 'observation',
          operation: 'readFile',
          path: '/proc/version',
        }),
      );
    },
  );

  it.runIf(process.platform === 'linux')(
    'rechecks actual executing source at seal after an in-process V8 live edit',
    () => {
      const first = installedCallers()[1];
      if (first === undefined) throw new Error('Pinned Playwright caller missing');
      const { file, caller } = first;
      const url = pathToFileURL(file).href;
      const { rows, result } = bootstrap(
        `
import {Session} from 'node:inspector';
import {createHash} from 'node:crypto';
const session=new Session(); session.connect();
const candidates=[];
session.on('Debugger.scriptParsed', ({params}) => {if(params.url===${JSON.stringify(url)} || params.url===${JSON.stringify(file)}) candidates.push(params.scriptId);});
session.post('Debugger.enable');
const framework=await import(${JSON.stringify(url)});
const originalResult=framework.default.mime.getType('fixture.txt');
const hash=(source)=>createHash('sha256').update(source).digest('hex');
let source,scriptId;
for(const id of [...candidates]) session.post('Debugger.getScriptSource',{scriptId:id},(error,result)=>{if(error) throw error;if(hash(result.scriptSource)===${JSON.stringify(caller.sha256)}){scriptId=id;source=result.scriptSource;}});
if(!scriptId) throw new Error('Exact executing Playwright source was not observed');
let edited;
const needle='Mime.prototype.getType = function(path) {';
if(!source.includes(needle)) throw new Error('Actual framework function missing');
const changed=source.replace(needle,needle+' return "inspector-live-body-marker";');
session.post('Debugger.setScriptSource',{scriptId,scriptSource:changed,dryRun:false},(error,result)=>{if(error) throw error; edited=result.status;});
if(edited!=='Ok') throw new Error('V8 live edit was not applied: '+edited);
const executedResult=framework.default.mime.getType('fixture.txt');
if(executedResult!=='inspector-live-body-marker') throw new Error('Edited function body did not execute');
let changedSourceSha256;
session.post('Debugger.getScriptSource',{scriptId},(error,result)=>{if(error) throw error;changedSourceSha256=hash(result.scriptSource);});
if(changedSourceSha256===hash(source)) throw new Error('V8 executing source did not change');
session.disconnect();
console.log(JSON.stringify({scriptId,originalSourceSha256:hash(source),changedSourceSha256,originalResult,executedResult}));
`,
        false,
      );
      const edited = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(edited['originalSourceSha256']).toBe(caller.sha256);
      expect(edited['changedSourceSha256']).not.toBe(caller.sha256);
      expect(edited['originalResult']).toBe('text/plain');
      expect(edited['executedResult']).toBe('inspector-live-body-marker');
      const facts = rows.filter((row) => row['kind'] === 'framework-platform-probe');
      expect(facts).toHaveLength(1);
      expect(facts[0]?.['caller']).toMatchObject({ scriptId: edited['scriptId'] });
      expect(result.status, result.stderr).toBe(1);
      expect(rows).toContainEqual(
        expect.objectContaining({
          kind: 'unsupported',
          operation: 'framework-platform-source-changed',
        }),
      );
      expect(rows.filter((row) => row['kind'] === 'end')).toEqual([]);
    },
  );
});
