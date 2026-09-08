import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';

const fixtureState = vi.hoisted(() => ({ root: '', anchors: [] as string[] }));

// The adapter is imported as the protected host would import it. Only its
// package-resolution seam is controlled; the adapter bytes and export wiring
// remain real.
vi.mock('node:module', () => ({
  createRequire: (anchor: string) => ({
    resolve: (name: string) => {
      fixtureState.anchors.push(anchor);
      if (
        name === '@stryker-mutator/typescript-checker/package.json' &&
        anchor !== '/workspace/candidate/package.json'
      )
        throw new Error('unexpected checker anchor');
      if (name === '@stryker-mutator/typescript-checker/package.json')
        return join(fixtureState.root, 'checker/package.json');
      if (
        anchor === join(fixtureState.root, 'checker/package.json') &&
        name === 'typescript/package.json'
      )
        return join(fixtureState.root, 'checker/node_modules/typescript/package.json');
      if (anchor === join(fixtureState.root, 'checker/package.json') && name === 'typescript')
        return join(fixtureState.root, 'checker/node_modules/typescript/index.mjs');
      throw new Error(`unexpected protected resolution: ${name}`);
    },
  }),
}));

interface FixtureOptions {
  checkerVersion?: string;
  typescriptVersion?: string;
  invalidScriptFileApi?: boolean;
  invalidChangedApi?: boolean;
}

function fixture(options: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'devai mutation typescript adapter '));
  mkdirSync(join(root, 'checker/dist/src/fs'), { recursive: true });
  mkdirSync(join(root, 'checker/node_modules/typescript'), { recursive: true });
  writeFileSync(
    join(root, 'checker/package.json'),
    JSON.stringify({
      type: 'module',
      version: options.checkerVersion ?? '9.6.1',
    }),
  );
  writeFileSync(
    join(root, 'checker/node_modules/typescript/package.json'),
    JSON.stringify({
      type: 'module',
      version: options.typescriptVersion ?? '5.9.3',
    }),
  );
  writeFileSync(
    join(root, 'checker/dist/src/fs/script-file.js'),
    `export class ScriptFile {
  constructor(fileName = 'fixture.ts') {
    this.fileName = fileName;
    this.modifiedTime = new Date(0);
  }
  ${options.invalidScriptFileApi ? '' : "touch() { throw new Error('adapter did not install touch'); }"}
}
`,
  );
  writeFileSync(
    join(root, 'checker/node_modules/typescript/index.mjs'),
    options.invalidChangedApi
      ? 'const api = { FileWatcherEventKind: { Changed: "17" } }; export default api;\n'
      : 'const api = { FileWatcherEventKind: { Changed: 17 } }; export default api; export const FileWatcherEventKind = api.FileWatcherEventKind;\n',
  );
  writeFileSync(
    join(root, 'checker/dist/src/index.js'),
    `export const strykerPlugins = [{ name: 'fixture-typescript-checker' }];
export const strykerValidationSchema = { type: 'fixture-schema' };
export const createTypescriptChecker = () => 'fixture-checker';
`,
  );
  return root;
}

async function importAdapter(root: string, label: string) {
  fixtureState.root = root;
  fixtureState.anchors = [];
  return import(
    `${new URL('../../../../scripts/release-host/mutation-typescript-plugin.mjs', import.meta.url).href}?${label}`
  );
}

let roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  // Each fixture is deliberately isolated so dynamic-import caching cannot
  // leak a checker implementation or timestamp state between cases.
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

it('preserves checker exports and installs a strict-future Changed watcher touch', async () => {
  const root = fixture();
  roots.push(root);
  const adapter = await importAdapter(root, 'valid');
  expect(fixtureState.anchors).toEqual([
    '/workspace/candidate/package.json',
    join(root, 'checker/package.json'),
    join(root, 'checker/package.json'),
  ]);
  const scriptFile = (await import(
    pathToFileURL(join(root, 'checker/dist/src/fs/script-file.js')).href
  )) as {
    ScriptFile: new (fileName?: string) => {
      fileName: string;
      modifiedTime: Date;
      watcher?: (path: string, kind: number) => void;
      touch(): void;
    };
  };
  expect(adapter.strykerPlugins).toBe(
    (await import(pathToFileURL(join(root, 'checker/dist/src/index.js')).href)).strykerPlugins,
  );
  expect(adapter.strykerValidationSchema).toBe(
    (await import(pathToFileURL(join(root, 'checker/dist/src/index.js')).href))
      .strykerValidationSchema,
  );
  expect(adapter.createTypescriptChecker).toBe(
    (await import(pathToFileURL(join(root, 'checker/dist/src/index.js')).href))
      .createTypescriptChecker,
  );

  const first = new scriptFile.ScriptFile('first.ts');
  const second = new scriptFile.ScriptFile('second.ts');
  const events: Array<{ path: string; kind: number }> = [];
  first.watcher = (path, kind) => events.push({ path, kind });
  second.watcher = (path, kind) => events.push({ path, kind });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100);
  first.modifiedTime = new Date(500);
  first.touch();
  second.touch();
  clock.mockReturnValue(50);
  first.touch();

  expect(first.modifiedTime.getTime()).toBe(503);
  expect(second.modifiedTime.getTime()).toBe(502);
  expect(first.modifiedTime.getTime()).toBeGreaterThan(second.modifiedTime.getTime());
  expect(events).toEqual([
    { path: 'first.ts', kind: 17 },
    { path: 'second.ts', kind: 17 },
    { path: 'first.ts', kind: 17 },
  ]);
});

it('keeps timestamps strictly newer under a fixed backwards clock', async () => {
  const root = fixture();
  roots.push(root);
  await importAdapter(root, 'backwards');
  const { ScriptFile } = (await import(
    pathToFileURL(join(root, 'checker/dist/src/fs/script-file.js')).href
  )) as {
    ScriptFile: new () => { modifiedTime: Date; touch(): void };
  };
  const file = new ScriptFile();
  const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
  file.touch();
  now.mockReturnValue(9_000);
  file.touch();
  now.mockReturnValue(8_000);
  file.touch();
  expect(file.modifiedTime.getTime()).toBe(10_003);
});

it('refuses a checker or TypeScript version outside the protected toolchain', async () => {
  const checkerMismatch = fixture({ checkerVersion: '9.6.0' });
  roots.push(checkerMismatch);
  await expect(importAdapter(checkerMismatch, 'checker-mismatch')).rejects.toThrow(
    'devai-mutation-typescript-plugin-toolchain-invalid',
  );

  const typescriptMismatch = fixture({ typescriptVersion: '5.8.3' });
  roots.push(typescriptMismatch);
  await expect(importAdapter(typescriptMismatch, 'typescript-mismatch')).rejects.toThrow(
    'devai-mutation-typescript-plugin-toolchain-invalid',
  );
});

it('refuses an invalid protected API before changing ScriptFile.touch', async () => {
  const scriptApiMismatch = fixture({ invalidScriptFileApi: true });
  roots.push(scriptApiMismatch);
  await expect(importAdapter(scriptApiMismatch, 'script-api-mismatch')).rejects.toThrow(
    'devai-mutation-typescript-plugin-api-invalid',
  );

  const changedApiMismatch = fixture({ invalidChangedApi: true });
  roots.push(changedApiMismatch);
  await expect(importAdapter(changedApiMismatch, 'changed-api-mismatch')).rejects.toThrow(
    'devai-mutation-typescript-plugin-api-invalid',
  );
  const { ScriptFile } = (await import(
    pathToFileURL(join(changedApiMismatch, 'checker/dist/src/fs/script-file.js')).href
  )) as { ScriptFile: new () => { touch(): void } };
  expect(() => new ScriptFile().touch()).toThrow('adapter did not install touch');
});
