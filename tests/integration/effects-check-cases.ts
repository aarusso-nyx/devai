import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyzeEffectProgram,
  enforceEffectReport,
  loadJson,
  parseActionEffectsSource,
  validateDeclaredCapabilityConsistency,
} from '../../packages/effects-check/src/index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-effects-'));
  roots.push(root);
  return root;
}

function write(root: string, rel: string, body: string): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

describe('effect report enforcement and source parsing', () => {
  it('parses only literal action-effect entries through expression wrappers', () => {
    expect(
      parseActionEffectsSource(`
        const ignored = { no: 'read' };
        const ACTION_EFFECTS = ({
          simple: 'read',
          'docs publish': ('remote-write' as const),
          computed: dynamic,
          [dynamic]: 'ignored',
        } satisfies Record<string, unknown>);
      `),
    ).toEqual({ simple: 'read', 'docs publish': 'remote-write' });
    expect(parseActionEffectsSource('const ACTION_EFFECTS = dynamic;')).toEqual({});
  });

  it('rejects every binding finding while retaining advisory findings', () => {
    expect(() => enforceEffectReport({ findings: [] })).not.toThrow();
    expect(() =>
      enforceEffectReport({
        findings: [{ code: 'EFFECT_UNANALYZABLE_PATTERN', message: 'advisory' }],
      }),
    ).not.toThrow();
    expect(() =>
      enforceEffectReport({
        findings: [
          { code: 'EFFECT_UNDER_DECLARED', action_id: 'one', message: 'under' },
          { code: 'EFFECT_CONTRACT_MISSING', message: 'missing' },
        ],
      }),
    ).toThrow('EFFECT_UNDER_DECLARED:one\nEFFECT_CONTRACT_MISSING');
  });

  it('validates missing capabilities, missing contracts, extras, and aligned catalogs', () => {
    expect(() =>
      validateDeclaredCapabilityConsistency({
        catalog: ['one'],
        contracts: [{ action_id: 'one', effect: 'read', capabilities: [] }],
      }),
    ).not.toThrow();
    expect(() =>
      validateDeclaredCapabilityConsistency({ catalog: ['one'], contracts: [] }),
    ).toThrow('one: EFFECT_CONTRACT_MISSING');
    expect(() =>
      validateDeclaredCapabilityConsistency({
        catalog: ['one'],
        contracts: [{ action_id: 'one', effect: 'read' }],
      }),
    ).toThrow('one: EFFECT_CAPABILITIES_MISSING');
    expect(() =>
      validateDeclaredCapabilityConsistency({
        catalog: [],
        contracts: [{ action_id: 'extra', effect: 'read', capabilities: [] }],
      }),
    ).toThrow('EFFECT_CONTRACT_CATALOG_MISMATCH');
  });
});

describe('effect program analysis', () => {
  it('walks callbacks, factories, methods, subprocesses, and advisory patterns', async () => {
    const root = fixtureRoot();
    const tsconfigPath = write(
      root,
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
        },
        include: ['*.ts'],
      }),
    );
    write(
      root,
      'commands.ts',
      `
        import { writeFileSync } from 'node:fs';
        import { spawnSync } from 'node:child_process';
        declare function defineCommand(input: {
          name: string;
          run?: () => void;
          register?: (program: { action(fn: () => void): void }) => void;
        }): unknown;
        const dynamicExecutable = process.env.RUNNER ?? 'git';
        const dynamicModule = process.env.MODULE ?? './other.js';
        const dynamicTarget: Function = () => undefined;
        function sink(): void {
          writeFileSync('out.txt', 'x');
        }
        function returnsSink(): () => void {
          return sink;
        }
        class Runner {
          run(): void { sink(); }
        }
        const callback = (): void => returnsSink()();
        defineCommand({ name: 'write file', run: () => callback() });
        defineCommand({ name: 'method call', run: () => new Runner().run() });
        defineCommand({
          name: 'literal process',
          run: () => spawnSync('git', ['status', '--short']),
        });
        defineCommand({
          name: 'dynamic process',
          register(program) {
            program.action(() => {
              spawnSync(dynamicExecutable, ['status', process.env.FLAG ?? '--short']);
              eval('void 0');
              new Function('return 1');
              Reflect.apply(dynamicTarget, undefined, []);
              void import(dynamicModule);
            });
          },
        });
      `,
    );
    write(root, 'other.ts', 'export const other = true;');

    const catalog = ['write file', 'method call', 'literal process', 'dynamic process'];
    const contracts = [
      { action_id: 'write file', effect: 'write', capabilities: ['fs:repo'] },
      { action_id: 'method call', effect: 'write', capabilities: ['fs:repo'] },
      { action_id: 'literal process', effect: 'read', capabilities: ['proc:git'] },
      { action_id: 'dynamic process', effect: 'read', capabilities: ['proc:dynamic'] },
    ];
    const report = await analyzeEffectProgram({
      tsconfigPath,
      catalog,
      contracts,
      subprocessRegistry: {
        templates: [{ executable: 'git', argv_shape: ['status', '--short'] }],
      },
    });
    expect(report.metrics).toMatchObject({
      program_files: 2,
      catalog_actions: 4,
      extracted_actions: 4,
      unresolved_edges: 0,
    });
    expect(report.actions['write file']?.capabilities).toContain('fs:repo');
    expect(report.actions['literal process']?.capabilities).toContain('proc:git');
    expect(report.actions['dynamic process']?.capabilities).toContain('proc:dynamic');
    expect(report.subprocess_templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ executable: 'git', actions: ['literal process'] }),
      ]),
    );
    expect(report.advisory_patterns.violations).toBeGreaterThanOrEqual(4);
    expect(report.findings.map((finding) => finding.code)).not.toContain('SPAWN_EFFECT_UNDECLARED');
  }, 30_000);

  it('reports under-declaration, unregistered templates, and catalog mismatch', async () => {
    const fixture = resolve(
      'packages/effects-check/tests/contract/fixtures/adversarial/tsconfig.json',
    );
    const catalog = [
      'fixture callback',
      'fixture factory',
      'fixture union',
      'fixture higher-order',
      'fixture method',
      'fixture spawn',
    ];
    const contracts = catalog.map((action_id) => ({
      action_id,
      effect: 'read',
      capabilities: [] as const,
    }));
    const report = await analyzeEffectProgram({
      tsconfigPath: fixture,
      catalog,
      contracts,
      subprocessRegistry: { templates: [] },
    });
    expect(report.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(['EFFECT_UNDER_DECLARED', 'SPAWN_EFFECT_UNDECLARED']),
    );
    expect(() => enforceEffectReport(report)).toThrow();

    await expect(
      analyzeEffectProgram({
        tsconfigPath: fixture,
        catalog: [...catalog, 'missing'],
        contracts,
        subprocessRegistry: { templates: [] },
      }),
    ).rejects.toThrow('EFFECT_EXTRACTOR_CATALOG_MISMATCH');
  }, 30_000);

  it('surfaces malformed TypeScript configuration and loads JSON', async () => {
    const root = fixtureRoot();
    const json = write(root, 'value.json', '{"value":42}');
    expect(loadJson<{ value: number }>(json)).toEqual({ value: 42 });
    const malformed = write(root, 'tsconfig.json', '{bad');
    await expect(
      analyzeEffectProgram({
        tsconfigPath: malformed,
        catalog: [],
        contracts: [],
        subprocessRegistry: { templates: [] },
      }),
    ).rejects.toThrow();
    const semantic = write(
      root,
      'bad-tsconfig.json',
      JSON.stringify({ compilerOptions: { definitelyUnknownOption: true } }),
    );
    await expect(
      analyzeEffectProgram({
        tsconfigPath: semantic,
        catalog: [],
        contracts: [],
        subprocessRegistry: { templates: [] },
      }),
    ).rejects.toThrow('Unknown compiler option');
  });
});
