import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CAC } from 'cac';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_FAIL, EXIT_PASS } from '@devai-nyx/utils';
import { checkGlobGuards, checkGlobGuardsCmd } from '../../src/commands/check/glob-guards.js';

const roots: string[] = [];
const originalStdout = process.stdout.write;
const originalExitCode = process.exitCode;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.stdout.write = originalStdout;
  process.exitCode = originalExitCode;
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'devai-glob-guards-cli-depth-'));
  roots.push(value);
  return value;
}

function put(base: string, relativePath: string, value: string): void {
  const path = join(base, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, 'utf8');
}

function registry(
  base: string,
  guards: readonly object[],
  relativePath = '.devai/config/glob-guards.json',
): string {
  const path = join(base, relativePath);
  put(base, relativePath, `${JSON.stringify({ schemaVersion: '1.0.0', guards })}\n`);
  return path;
}

interface CommandOptions {
  readonly repoRoot?: string;
  readonly registry?: string;
  readonly human?: boolean;
}

interface RegisteredCommand {
  readonly command: readonly [string, string];
  readonly options: readonly (readonly [string, string])[];
  readonly invoke: (options: CommandOptions) => void;
}

function registeredCommand(): RegisteredCommand {
  let action: ((options: CommandOptions) => void) | undefined;
  let commandCall: readonly [string, string] | undefined;
  const optionCalls: Array<readonly [string, string]> = [];
  const chain = {
    option(flag: string, description: string) {
      optionCalls.push([flag, description]);
      return chain;
    },
    action(callback: (options: CommandOptions) => void) {
      action = callback;
      return chain;
    },
  };
  checkGlobGuardsCmd.register({
    command: (name: string, description: string) => {
      commandCall = [name, description];
      return chain;
    },
  } as unknown as CAC);
  if (commandCall === undefined || action === undefined) {
    throw new Error('glob-guards command was not completely registered');
  }
  return { command: commandCall, options: optionCalls, invoke: action };
}

function invokeCommand(options: CommandOptions): {
  readonly stdout: string;
  readonly exitCode: number | undefined;
} {
  let stdout = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.exitCode = undefined;
  registeredCommand().invoke(options);
  return { stdout, exitCode: process.exitCode };
}

describe('check glob-guards report aggregation', () => {
  it('reports every guard and fails only the guard whose population is below its minimum', () => {
    const base = root();
    put(base, 'docs/invariants/INV-001.json', '{}');
    const report = checkGlobGuards({
      repoRoot: base,
      registryPath: registry(base, [
        { id: 'PRESENT', pattern: 'docs/invariants/*.json' },
        { id: 'MISSING', pattern: 'docs/missing/*.json' },
      ]),
    });

    expect(report.registry_entries).toBe(2);
    expect(report.results).toEqual([
      expect.objectContaining({
        id: 'PRESENT',
        pattern: 'docs/invariants/*.json',
        min_matches: 1,
        match_count: 1,
        ok: true,
      }),
      expect.objectContaining({
        id: 'MISSING',
        pattern: 'docs/missing/*.json',
        min_matches: 1,
        match_count: 0,
        ok: false,
        sample_matches: [],
      }),
    ]);
    expect(report.failing).toEqual(['MISSING']);
    expect(report.ok).toBe(false);
  });

  it('returns an all-pass report when every declared guard meets its threshold', () => {
    const base = root();
    put(base, 'src/one.ts', 'export {}');
    put(base, 'src/two.ts', 'export {}');
    const report = checkGlobGuards({
      repoRoot: base,
      registryPath: registry(base, [{ id: 'SOURCE_FILES', pattern: 'src/*.ts', min_matches: 2 }]),
    });

    expect(report.registry_entries).toBe(1);
    expect(report.results).toEqual([
      expect.objectContaining({
        id: 'SOURCE_FILES',
        min_matches: 2,
        match_count: 2,
        ok: true,
      }),
    ]);
    expect(report.failing).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

describe('check glob-guards command boundary', () => {
  it('registers the stable command name and public options', () => {
    const command = registeredCommand();
    expect(command.command).toEqual([
      'check-glob-guards',
      'Evaluate the glob-guards registry against the real tree',
    ]);
    expect(command.options).toEqual([
      ['--repo-root <path>', 'Repo root (default: .)'],
      ['--registry <path>', 'Registry path (default: <repo-root>/.devai/config/glob-guards.json)'],
      ['--human', 'Human-readable output'],
    ]);
  });

  it('uses the default registry and emits the exact passing JSON contract', () => {
    const base = root();
    registry(base, []);
    const result = invokeCommand({ repoRoot: base });
    expect(JSON.parse(result.stdout)).toEqual({
      registry_entries: 0,
      results: [],
      failing: [],
      ok: true,
    });
    expect(result.stdout.endsWith('\n')).toBe(true);
    expect(result.exitCode).toBe(EXIT_PASS);
  });

  it('honors a registry override and renders a failing guard with its sample', () => {
    const base = root();
    put(base, 'src/one.ts', 'export {}');
    const customRegistry = registry(
      base,
      [{ id: 'TOO_FEW', pattern: 'src/*.ts', min_matches: 2 }],
      'policy/custom-guards.json',
    );
    const result = invokeCommand({ repoRoot: base, registry: customRegistry, human: true });
    expect(result.stdout).toBe(
      [
        'check glob-guards: FAIL (1 guard(s), 1 failing)',
        "  [✗] TOO_FEW: 'src/*.ts' matched 1 (need ≥2)",
        '      sample matches: src/one.ts',
        '',
      ].join('\n'),
    );
    expect(result.exitCode).toBe(EXIT_FAIL);
  });

  it('renders passing human output without a failure sample', () => {
    const base = root();
    put(base, 'src/one.ts', 'export {}');
    registry(base, [{ id: 'SOURCE', pattern: 'src/*.ts' }]);
    const result = invokeCommand({ repoRoot: base, human: true });
    expect(result.stdout).toBe(
      [
        'check glob-guards: OK (1 guard(s), 0 failing)',
        "  [✓] SOURCE: 'src/*.ts' matched 1 (need ≥1)",
        '',
      ].join('\n'),
    );
    expect(result.exitCode).toBe(EXIT_PASS);
  });
});
