import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CAC } from 'cac';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXIT_FAIL, EXIT_PASS, EXIT_REVIEW } from '@devai-nyx/utils';

const actionEffectBoundary = vi.hoisted(() => ({
  enforce: vi.fn(),
  sense: vi.fn(),
}));
const processBoundary = vi.hoisted(() => ({ spawnSync: vi.fn() }));

vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawnSync: processBoundary.spawnSync,
}));

vi.mock('@devai-nyx/effects-check', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/effects-check')>()),
  enforceEffectReport: actionEffectBoundary.enforce,
}));

vi.mock('@devai-nyx/sensors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/sensors')>()),
  senseActionEffectInference: actionEffectBoundary.sense,
}));

import { checkActionEffectsCmd } from '../../src/commands/check/action-effects.js';
import { executeCheckMember } from '../../src/commands/check/adapters.js';
import type { ResolvedCheckMember } from '../../src/commands/check/contracts.js';
import { checkGlobGuardsCmd } from '../../src/commands/check/glob-guards.js';
import { checkSensorIntegrityCmd } from '../../src/commands/check/sensor-integrity.js';

interface CommandOptions {
  readonly repoRoot?: string;
  readonly registry?: string;
  readonly readingsDir?: string;
  readonly tsconfig?: string;
  readonly human?: boolean;
}

interface Registration {
  readonly name: string;
  readonly description: string;
  readonly options: Array<readonly [flag: string, description: string]>;
  readonly invoke: (options: CommandOptions) => unknown;
}

const roots: string[] = [];
const originalStdout = process.stdout.write;
const originalStderr = process.stderr.write;
const originalExitCode = process.exitCode;

afterEach(() => {
  actionEffectBoundary.enforce.mockReset();
  actionEffectBoundary.sense.mockReset();
  processBoundary.spawnSync.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
  process.exitCode = originalExitCode;
});

function register(command: { readonly register: (cli: CAC) => void }): Registration {
  let registration: Registration | undefined;
  let invoke: ((options: CommandOptions) => unknown) | undefined;
  const options: Array<readonly [string, string]> = [];
  const chain = {
    option(flag: string, description: string) {
      options.push([flag, description]);
      return chain;
    },
    action(callback: (value: CommandOptions) => unknown) {
      invoke = callback;
      return chain;
    },
  };
  command.register({
    command(name: string, description: string) {
      registration = { name, description, options, invoke: (value) => invoke?.(value) };
      return chain;
    },
  } as unknown as CAC);
  if (registration === undefined || invoke === undefined)
    throw new Error('incomplete registration');
  return { ...registration, invoke };
}

function captureOutput(): { stdout: () => string; stderr: () => string } {
  let stdout = '';
  let stderr = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  process.exitCode = undefined;
  return { stdout: () => stdout, stderr: () => stderr };
}

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function put(root: string, relativePath: string, value: unknown): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value)}\n`, 'utf8');
}

function reading(id: string, kind: string, commandHash: string): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    id,
    sensor: { name: `sensor-${kind}`, kind },
    timestamp: '2026-09-11T00:00:00.000Z',
    status: 'pass',
    deterministic: true,
    command: 'pnpm run governed-check',
    command_hash: commandHash,
  };
}

function member(serviceId: string, cost: ResolvedCheckMember['cost'] = 'low'): ResolvedCheckMember {
  return {
    id: serviceId,
    source: 'current-selector',
    service_id: serviceId,
    binding: { kind: 'runtime-gate', gate_id: `check-${serviceId}` },
    effect: 'read',
    cost,
    output: `action-envelope-plus-${serviceId}-report`,
  };
}

describe('S06-A residual command contracts', () => {
  it('preserves every glob-guard registration string', () => {
    expect(checkGlobGuardsCmd).toMatchObject({
      name: 'check glob-guards',
      description:
        'Evaluate .devai/config/glob-guards.json: every registered pattern must still match at least min_matches files. Catches a CI trigger path, generator input dir, or validation-loop target silently degrading to zero matches after a rename or format migration.',
      authority: 'policy_firewall',
    });
    expect(register(checkGlobGuardsCmd)).toMatchObject({
      name: 'check-glob-guards',
      description: 'Evaluate the glob-guards registry against the real tree',
      options: [
        ['--repo-root <path>', 'Repo root (default: .)'],
        [
          '--registry <path>',
          'Registry path (default: <repo-root>/.devai/config/glob-guards.json)',
        ],
        ['--human', 'Human-readable output'],
      ],
    });
  });

  it('preserves every sensor-integrity registration string', () => {
    expect(checkSensorIntegrityCmd).toMatchObject({
      name: 'check sensor-integrity',
      description:
        'Flag SensorReadings that share a command_hash across distinct sensor.kind values (relabeled, not independently measured). Advisory: exits REVIEW on findings, never FAIL.',
      authority: 'policy_firewall',
    });
    expect(register(checkSensorIntegrityCmd)).toMatchObject({
      name: 'check-sensor-integrity',
      description: 'Flag relabeled SensorReadings (shared command_hash, distinct kinds)',
      options: [
        ['--repo-root <path>', 'Repo root (default: .)'],
        [
          '--readings-dir <path>',
          'SensorReadings directory (default: <repo-root>/.devai/state/sensor-readings)',
        ],
        ['--human', 'Human-readable output'],
      ],
    });
  });

  it('preserves every action-effects registration string', () => {
    expect(checkActionEffectsCmd).toMatchObject({
      name: 'check action-effects',
      description:
        'Run the binding action-effect analyzer and emit its deterministic SensorReading (F5×T4).',
      authority: 'policy_firewall',
      lifecycle: 'supported',
    });
    expect(register(checkActionEffectsCmd)).toMatchObject({
      name: 'check-action-effects',
      description: 'Run the shadow action-effect analyzer',
      options: [
        ['--repo-root <path>', 'Repository root (default: .)'],
        ['--tsconfig <path>', 'Analyzer tsconfig (default: tests/config/tsconfig.effects.json)'],
        [
          '--registry <path>',
          'Subprocess-effects registry (default: law/policy/subprocess-effects.json)',
        ],
        ['--human', 'Human-readable summary'],
      ],
    });
  });
});

describe('S06-A residual command effects', () => {
  it('uses the default glob registry and emits the exact failing human contract', () => {
    const root = temporaryRoot('devai-s06-glob-residual-');
    put(root, '.devai/config/glob-guards.json', {
      schemaVersion: '1.0.0',
      guards: [{ id: 'MISSING', pattern: 'src/*.ts' }],
    });
    const output = captureOutput();

    register(checkGlobGuardsCmd).invoke({ repoRoot: root, human: true });

    expect(output.stdout()).toBe(
      "check glob-guards: FAIL (1 guard(s), 1 failing)\n  [✗] MISSING: 'src/*.ts' matched 0 (need ≥1)\n",
    );
    expect(process.exitCode).toBe(EXIT_FAIL);
  });

  it('honors the glob registry override and emits exact sample and JSON branches', () => {
    const root = temporaryRoot('devai-s06-glob-override-');
    put(root, 'src/one.ts', {});
    put(root, 'src/two.ts', {});
    put(root, 'custom/guards.json', {
      schemaVersion: '1.0.0',
      guards: [{ id: 'THREE', pattern: 'src/*.ts', min_matches: 3 }],
    });
    const human = captureOutput();

    register(checkGlobGuardsCmd).invoke({
      repoRoot: root,
      registry: join(root, 'custom/guards.json'),
      human: true,
    });

    expect(human.stdout()).toBe(
      "check glob-guards: FAIL (1 guard(s), 1 failing)\n  [✗] THREE: 'src/*.ts' matched 2 (need ≥3)\n      sample matches: src/one.ts, src/two.ts\n",
    );
    expect(process.exitCode).toBe(EXIT_FAIL);

    const json = captureOutput();
    register(checkGlobGuardsCmd).invoke({
      repoRoot: root,
      registry: join(root, 'custom/guards.json'),
    });
    expect(json.stdout()).toBe(
      `${JSON.stringify({
        registry_entries: 1,
        results: [
          {
            id: 'THREE',
            pattern: 'src/*.ts',
            min_matches: 3,
            match_count: 2,
            ok: false,
            sample_matches: ['src/one.ts', 'src/two.ts'],
          },
        ],
        failing: ['THREE'],
        ok: false,
      })}\n`,
    );
  });

  it('renders the exact passing glob marker and status', () => {
    const root = temporaryRoot('devai-s06-glob-pass-');
    put(root, 'src/one.ts', {});
    put(root, '.devai/config/glob-guards.json', {
      schemaVersion: '1.0.0',
      guards: [{ id: 'ONE', pattern: 'src/*.ts' }],
    });
    const output = captureOutput();

    register(checkGlobGuardsCmd).invoke({ repoRoot: root, human: true });

    expect(output.stdout()).toBe(
      "check glob-guards: OK (1 guard(s), 0 failing)\n  [✓] ONE: 'src/*.ts' matched 1 (need ≥1)\n",
    );
    expect(process.exitCode).toBe(EXIT_PASS);
  });

  it('uses the default sensor directory and emits exact review details', () => {
    const root = temporaryRoot('devai-s06-sensor-residual-');
    const hash = 'a'.repeat(64);
    put(root, '.devai/state/sensor-readings/one.json', reading('one', 'lint', hash));
    put(root, '.devai/state/sensor-readings/two.json', reading('two', 'typecheck', hash));
    const output = captureOutput();

    register(checkSensorIntegrityCmd).invoke({ repoRoot: root, human: true });

    expect(output.stdout()).toBe(
      [
        'check sensor-integrity: REVIEW (2 reading(s) scanned, 1 relabeled group(s))',
        `  [!] command_hash ${hash.slice(0, 12)}… shared by kinds: lint, typecheck`,
        '      readings: one, two',
        '',
      ].join('\n'),
    );
    expect(process.exitCode).toBe(EXIT_REVIEW);
  });

  it('honors the readings override and emits exact pass human and JSON branches', () => {
    const root = temporaryRoot('devai-s06-sensor-override-');
    const override = join(root, 'custom-readings');
    put(override, 'one.json', reading('one', 'lint', 'b'.repeat(64)));
    const human = captureOutput();

    register(checkSensorIntegrityCmd).invoke({
      repoRoot: root,
      readingsDir: override,
      human: true,
    });

    expect(human.stdout()).toBe(
      'check sensor-integrity: PASS (1 reading(s) scanned, 0 relabeled group(s))\n',
    );
    expect(process.exitCode).toBe(EXIT_PASS);

    const json = captureOutput();
    register(checkSensorIntegrityCmd).invoke({ repoRoot: root, readingsDir: override });
    expect(json.stdout()).toBe(
      `${JSON.stringify({ verdict: 'pass', readings_scanned: 1, groups: [] })}\n`,
    );
    expect(process.exitCode).toBe(EXIT_PASS);
  });

  it('forwards action-effects defaults and emits exact human findings', async () => {
    const root = temporaryRoot('devai-s06-effects-residual-');
    put(root, 'law/policy/subprocess-effects.json', { templates: [] });
    const output = captureOutput();
    actionEffectBoundary.sense.mockResolvedValue({
      reading: { status: 'review' },
      report: {
        metrics: { catalog_actions: 2, duration_ms: 7 },
        findings: [
          { code: 'EFFECT_UNBOUND', message: 'missing binding' },
          { code: 'EFFECT_DRIFT', action_id: 'release-publish', message: 'declared effect drift' },
        ],
      },
    });

    await register(checkActionEffectsCmd).invoke({ repoRoot: root, human: true });

    expect(actionEffectBoundary.sense).toHaveBeenCalledOnce();
    expect(actionEffectBoundary.sense.mock.calls[0]?.[0]).toMatchObject({
      tsconfigPath: join(root, 'tests/config/tsconfig.effects.json'),
      subprocessRegistry: expect.objectContaining({ templates: expect.any(Array) }),
    });
    expect(output.stdout()).toBe(
      [
        'policy check action effects: REVIEW (2 actions, 2 findings, 7ms)',
        '  [EFFECT_UNBOUND] <program>: missing binding',
        '  [EFFECT_DRIFT] release-publish: declared effect drift',
        '',
      ].join('\n'),
    );
    expect(output.stderr()).toBe('');
    expect(process.exitCode).toBe(EXIT_PASS);
  });

  it('forwards explicit action-effects paths and emits the exact JSON branch', async () => {
    const root = temporaryRoot('devai-s06-effects-json-');
    put(root, 'custom/effects.json', { templates: [] });
    const sensed = {
      reading: { status: 'pass' },
      report: { metrics: { catalog_actions: 0, duration_ms: 1 }, findings: [] },
    };
    actionEffectBoundary.sense.mockResolvedValue(sensed);
    const output = captureOutput();

    await register(checkActionEffectsCmd).invoke({
      repoRoot: root,
      tsconfig: 'custom/effects.tsconfig.json',
      registry: 'custom/effects.json',
    });

    expect(actionEffectBoundary.sense.mock.calls[0]?.[0]).toMatchObject({
      tsconfigPath: join(root, 'custom/effects.tsconfig.json'),
      subprocessRegistry: { templates: [] },
    });
    expect(output.stdout()).toBe(`${JSON.stringify({ ok: true, ...sensed })}\n`);
    expect(process.exitCode).toBe(EXIT_PASS);
  });

  it('emits a bounded enforcement failure and failing exit status', async () => {
    const root = temporaryRoot('devai-s06-effects-enforcement-');
    put(root, 'law/policy/subprocess-effects.json', { templates: [] });
    const output = captureOutput();
    actionEffectBoundary.sense.mockResolvedValue({
      reading: { status: 'fail' },
      report: { metrics: { catalog_actions: 1, duration_ms: 3 }, findings: [] },
    });
    actionEffectBoundary.enforce.mockImplementation(() => {
      throw new Error('effect report rejected');
    });

    await register(checkActionEffectsCmd).invoke({ repoRoot: root, human: true });

    expect(output.stdout()).toBe(
      'policy check action effects: FAIL (1 actions, 0 findings, 3ms)\n',
    );
    expect(output.stderr()).toBe(
      'policy check action effects: BINDING FAIL — effect report rejected\n',
    );
    expect(process.exitCode).toBe(EXIT_FAIL);
  });

  it('uses the process root by default and emits enforcement failure JSON', async () => {
    const sensed = {
      reading: { status: 'fail' },
      report: { metrics: { catalog_actions: 1, duration_ms: 2 }, findings: [] },
    };
    actionEffectBoundary.sense.mockResolvedValue(sensed);
    actionEffectBoundary.enforce.mockImplementation(() => {
      throw new Error('default-root rejection');
    });
    const output = captureOutput();

    await register(checkActionEffectsCmd).invoke({});

    expect(actionEffectBoundary.sense.mock.calls[0]?.[0]).toMatchObject({
      tsconfigPath: join(process.cwd(), 'tests/config/tsconfig.effects.json'),
    });
    expect(output.stdout()).toBe(
      `${JSON.stringify({
        ok: false,
        ...sensed,
        enforcement_error: 'default-root rejection',
      })}\n`,
    );
    expect(output.stderr()).toBe('');
    expect(process.exitCode).toBe(EXIT_FAIL);
  });
});

describe('S06-A residual subprocess adapter routes', () => {
  it.each([
    [
      'harness-integrity',
      'high',
      ['pnpm', 'vitest', 'run', '--config', 'tests/config/rc.containment.config.ts'],
    ],
    [
      'coverage',
      'high',
      [
        'pnpm',
        'vitest',
        'run',
        '--config',
        'tests/config/rc.coverage.config.ts',
        '--coverage.reportsDirectory=scratch/coverage/rc',
      ],
    ],
  ] as const)('binds %s to its exact argv', async (serviceId, cost, expectedArgv) => {
    processBoundary.spawnSync.mockReturnValue({
      status: 0,
      signal: null,
      stdout: '{"status":"pass"}\n',
      stderr: '',
      error: undefined,
    });

    const result = await executeCheckMember(member(serviceId, cost), { repoRoot: process.cwd() });

    expect(processBoundary.spawnSync).toHaveBeenCalledOnce();
    expect(processBoundary.spawnSync.mock.calls[0]?.[0]).toBe(expectedArgv[0]);
    expect(processBoundary.spawnSync.mock.calls[0]?.[1]).toEqual(expectedArgv.slice(1));
    expect(result).toMatchObject({
      id: serviceId,
      status: 'pass',
      value: { status: 'pass' },
      stdout: '{"status":"pass"}\n',
      stderr: '',
      exit_code: 0,
    });
    expect(result).not.toHaveProperty('message');
  });

  async function structuredProcessStatus(status: 'error' | 'killed') {
    processBoundary.spawnSync.mockReturnValue({
      status: 0,
      signal: null,
      stdout: `${JSON.stringify({ status })}\n`,
      stderr: '',
      error: undefined,
    });

    const result = await executeCheckMember(member('full-tests', 'medium'), {
      repoRoot: process.cwd(),
    });

    expect(processBoundary.spawnSync.mock.calls[0]?.slice(0, 2)).toEqual([
      'pnpm',
      ['vitest', 'run'],
    ]);
    expect(result).toMatchObject({ status: 'error', value: { status }, exit_code: 0 });
    return result;
  }

  it('preserves a structured error process outcome', async () => {
    expect(await structuredProcessStatus('error')).toMatchObject({ value: { status: 'error' } });
  });

  it('preserves a structured killed process outcome', async () => {
    expect(await structuredProcessStatus('killed')).toMatchObject({ value: { status: 'killed' } });
  });

  it('preserves a missing subprocess exit as an explicit adapter error', async () => {
    processBoundary.spawnSync.mockReturnValue({
      status: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: 'terminated',
      error: undefined,
    });

    const result = await executeCheckMember(member('full-tests', 'medium'), {
      repoRoot: process.cwd(),
    });

    expect(result).toMatchObject({
      status: 'error',
      code: 'CHECK_PROCESS_NO_EXIT',
      stdout: '',
      stderr: 'terminated',
      exit_code: null,
    });
  });

  it('returns only the defined error fields for an unknown service', async () => {
    const result = await executeCheckMember(member('missing-service'), {
      repoRoot: process.cwd(),
    });

    expect(result).toMatchObject({
      id: 'missing-service',
      status: 'error',
      code: 'CHECK_SERVICE_ERROR',
      message: 'CHECK_SERVICE_UNKNOWN:missing-service',
    });
    expect(result).not.toHaveProperty('value');
    expect(result).not.toHaveProperty('stdout');
    expect(result).not.toHaveProperty('stderr');
    expect(result).not.toHaveProperty('exit_code');
  });
});
