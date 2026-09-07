import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => ({ root: '' }));
// Import the real installed-host wrapper against a deliberately small runner
// dependency fixture. This verifies wrapping behavior, not installed acceptance.
vi.mock('node:module', () => ({
  createRequire: () => ({
    resolve: (name: string) => {
      if (name === '@stryker-mutator/api/plugin') return `${control.root}/plugin.js`;
      if (name === '@stryker-mutator/api/test-runner') return `${control.root}/test-runner.js`;
      return `${control.root}/package.json`;
    },
  }),
}));
control.root = mkdtempSync(join(tmpdir(), 'devai phase dependencies '));
mkdirSync(join(control.root, 'dist/src'), { recursive: true });
writeFileSync(join(control.root, 'package.json'), '{"type":"module"}');
writeFileSync(
  join(control.root, 'dist/src/vitest-test-runner.js'),
  'export const vitestTestRunnerFactory = (injector) => injector.runner; vitestTestRunnerFactory.inject = [];',
);
writeFileSync(
  join(control.root, 'dist/src/index.js'),
  'export const strykerValidationSchema = {};',
);
writeFileSync(
  join(control.root, 'dist/src/vitest-wrapper.js'),
  'export const vitestWrapper = { createVitest() { throw new Error("fixture must not create Vitest"); } };',
);
writeFileSync(
  join(control.root, 'plugin.js'),
  'export const PluginKind = { TestRunner: "testRunner" }; export const declareFactoryPlugin = (kind, name, factory) => ({kind, name, factory});',
);
writeFileSync(
  join(control.root, 'test-runner.js'),
  'export const DryRunStatus = {Complete:"complete", Error:"error"}; export const MutantRunStatus = {Survived:"survived", Killed:"killed"}; export const TestStatus = {Failed:"failed"};',
);
interface Runner {
  log: { error(message: string): void };
  init(): Promise<void>;
  dispose(): Promise<void>;
  ctx: { config: Record<string, unknown>; projects: { config: Record<string, unknown> }[] };
}
const module = (await import(
  pathToFileURL(resolve('scripts/release-host/mutation-vitest-plugin.mjs')).href
)) as {
  strykerPlugins: { factory(input: { runner: Runner }): Runner }[];
};
const factory = module.strykerPlugins[0]?.factory;
if (!factory) throw new Error('protected plugin factory missing');
const create = factory;
let lines: string[] = [];
beforeEach(() => {
  lines = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(() => {
    throw new Error('worker stderr is buffered; use the logger');
  });
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => rmSync(control.root, { recursive: true, force: true }));
function inner(): Runner {
  return {
    log: {
      error: (message) => {
        lines.push(message);
      },
    },
    async init() {},
    async dispose() {},
    ctx: {
      config: { exclude: ['secret-path'], allowOnly: true },
      projects: [{ config: { passWithNoTests: true } }],
    },
  };
}
function events() {
  return lines.map((line) => {
    expect(line.startsWith('DEVAI_MUTATION_RUNNER_PHASE ')).toBe(true);
    expect(Buffer.byteLength(line)).toBeLessThan(256);
    const value = JSON.parse(line.slice('DEVAI_MUTATION_RUNNER_PHASE '.length)) as Record<
      string,
      unknown
    >;
    expect(Object.keys(value).sort()).toEqual([
      'elapsed_ms',
      'phase',
      'pid',
      'sequence',
      'status',
      'version',
    ]);
    expect(value['version']).toBe(1);
    expect(value['pid']).toBe(process.pid);
    expect(Number.isSafeInteger(value['elapsed_ms'])).toBe(true);
    expect(Number(value['elapsed_ms'])).toBeGreaterThanOrEqual(0);
    return value;
  });
}
it('reports init completion only after preserving the complete test population', async () => {
  const raw = inner();
  const runner = create({ runner: raw });
  await runner.init();
  for (const config of [raw.ctx.config, ...raw.ctx.projects.map((project) => project.config)]) {
    expect(config).toMatchObject({ exclude: [], passWithNoTests: false, allowOnly: false });
  }
  await runner.dispose();
  expect(events().map(({ phase, status, sequence }) => ({ phase, status, sequence }))).toEqual([
    { phase: 'init', status: 'begin', sequence: 1 },
    { phase: 'init', status: 'complete', sequence: 1 },
    { phase: 'dispose', status: 'begin', sequence: 2 },
    { phase: 'dispose', status: 'complete', sequence: 2 },
  ]);
  expect(lines.join('')).not.toContain('secret-path');
});
it.each(['init', 'dispose'] as const)(
  'keeps a pending %s phase observable without claiming completion',
  async (phase) => {
    const raw = inner();
    let release = () => {};
    raw[phase] = () =>
      new Promise<void>((resolveWait) => {
        release = resolveWait;
      });
    const runner = create({ runner: raw });
    const pending = runner[phase]();
    await Promise.resolve();
    expect(events().map((event) => event['status'])).toEqual(['begin']);
    release();
    await pending;
    expect(events().map((event) => event['status'])).toEqual(['begin', 'complete']);
  },
);
it.each(['init', 'dispose'] as const)(
  'preserves the exact %s error without logging exception data',
  async (phase) => {
    const raw = inner();
    const error = new Error('candidate secret /private/path');
    raw[phase] = async () => {
      throw error;
    };
    const runner = create({ runner: raw });
    await expect(runner[phase]()).rejects.toBe(error);
    expect(events().map((event) => event['status'])).toEqual(['begin', 'failed']);
    expect(lines.join('')).not.toContain(error.message);
  },
);
it('does not report successful initialization for an invalid project population', async () => {
  const raw = inner();
  raw.ctx.projects = [];
  const runner = create({ runner: raw });
  await expect(runner.init()).rejects.toThrow('release-mutation-test-population-invalid');
  expect(events().map((event) => event['status'])).toEqual(['begin', 'failed']);
});
