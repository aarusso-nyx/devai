// ADR-SCR-0017: native addon admission must preserve the actual Node dlopen call contract.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { constants, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { nativeInputPreloadPath } from '../../src/commands/sense/native-runner-selection.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function installedRollupAddon(): string {
  const vite = realpathSync(join(ROOT, 'node_modules/vite-native-fixture/package.json'));
  const manifest = createRequire(vite).resolve('rollup/package.json');
  const document = JSON.parse(readFileSync(manifest, 'utf8')) as {
    version: string;
    optionalDependencies: Record<string, string>;
  };
  expect(document.version).toBe('4.64.5');
  const resolver = createRequire(manifest);
  const platformPackage = `@rollup/rollup-${process.platform}-${process.arch}${process.platform === 'linux' ? '-gnu' : ''}`;
  expect(document.optionalDependencies[platformPackage]).toBe('4.64.5');
  return realpathSync(resolver.resolve(platformPackage));
}

interface NativeOutcome {
  status: 'pass' | 'fail';
  exports?: string[];
  code?: string;
  message?: string;
  forwardedArity?: number;
}

function loadAddon(addon: string, flag: string | undefined, guarded: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'devai dlopen parity ç '));
  roots.push(root);
  const nonce = 'a'.repeat(64);
  const runtime = join(root, '.devai/state/native-config-traces', nonce, 'runtime');
  const trace = join(dirname(runtime), 'inputs.ndjson');
  mkdirSync(runtime, { recursive: true });
  const program = `
const original = process.dlopen;
let forwardedArity;
${guarded ? `process.dlopen = (...args) => { forwardedArity = args.length; return original(...args); }; await import(${JSON.stringify(pathToFileURL(nativeInputPreloadPath()).href)});` : ''}
const module = {exports: {}};
let outcome;
try {
  process.dlopen(module, ${JSON.stringify(addon)}${flag === undefined ? '' : `, ${flag}`});
  outcome = {status:'pass', exports:Object.keys(module.exports).sort()};
} catch (error) {
  outcome = {status:'fail', code:error.code, message:error.message};
}
console.log(JSON.stringify({...outcome, forwardedArity}));
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', program], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      CI: '1',
      NO_COLOR: '1',
      NODE_V8_COVERAGE: '',
      ...(guarded
        ? {
            DEVAI_NATIVE_COLLECTION_NONCE: nonce,
            DEVAI_NATIVE_INPUT_TRACE: trace,
            DEVAI_NATIVE_INPUT_SCOPE: 'main',
            DEVAI_NATIVE_RUNTIME_ROOT: runtime,
            DEVAI_NATIVE_RUNNER: 'vitest-v1',
            TMPDIR: runtime,
            PWTEST_CACHE_DIR: join(runtime, 'playwright'),
          }
        : {}),
    },
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const outcome = JSON.parse(result.stdout) as NativeOutcome;
  const rows = guarded
    ? readFileSync(trace, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];
  return { outcome, rows };
}

describe('actual native addon argument forwarding', () => {
  it.each([
    { name: 'omitted flags', flag: undefined, arity: 2 },
    { name: 'explicit undefined flags', flag: 'undefined', arity: 3 },
    { name: 'explicit valid numeric flags', flag: String(constants.dlopen.RTLD_LAZY), arity: 3 },
    { name: 'zero numeric flags', flag: '0', arity: 3 },
  ])('preserves native behavior and exact argument count for $name', ({ flag, arity }) => {
    const addon = installedRollupAddon();
    const native = loadAddon(addon, flag, false);
    const guarded = loadAddon(addon, flag, true);
    const { forwardedArity, ...outcome } = guarded.outcome;
    expect(forwardedArity).toBe(arity);
    expect(outcome).toEqual(native.outcome);
    if (flag === undefined || flag === String(constants.dlopen.RTLD_LAZY)) {
      expect(outcome.status).toBe('pass');
      expect(outcome.exports).toEqual(expect.arrayContaining(['parse', 'parseAsync']));
    }
    if (process.platform === 'linux' && (flag === 'undefined' || flag === '0')) {
      expect(outcome.status).toBe('fail');
      expect(outcome.code).toBe('ERR_DLOPEN_FAILED');
      expect(outcome.message).toContain('invalid mode for dlopen()');
    }
    expect(guarded.rows.filter((row) => row['kind'] === 'unsupported')).toEqual([]);
    expect(guarded.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'begin', scope: 'main' }),
        expect.objectContaining({ kind: 'end', scope: 'main' }),
        expect.objectContaining({ kind: 'observation', operation: 'readFile', path: addon }),
      ]),
    );
  });
});
