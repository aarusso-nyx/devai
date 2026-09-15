import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CAC } from 'cac';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_PASS, EXIT_REVIEW } from '@devai-nyx/utils';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { checkDependenciesCmd } from '../../src/commands/check/dependencies.js';

type Options = { readonly repoRoot: string; readonly human?: boolean };
type Capture = {
  command(): Capture;
  option(): Capture;
  action(callback: (options: Options) => void): Capture;
};

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${String(code)}`);
  }
}
const roots: string[] = [];
let oldExit: typeof process.exit;
let invoke: (options: Options) => void;
let oldCode: typeof process.exitCode;
let oldOut: typeof process.stdout.write;
let oldErr: typeof process.stderr.write;
const savedEnv: Record<string, string | undefined> = {};
const envKeys = [
  'VITEST',
  'NODE_ENV',
  'DEVAI_TEST_NOW',
  'DEVAI_TEST_PNPM_DEPENDENCY_SCAN_FIXTURE',
  'DEVAI_TEST_NPM_DEPENDENCY_SCAN_FIXTURE',
  'DEVAI_TEST_DEPENDENCY_SCANNER_UNAVAILABLE',
];

beforeAll(() => {
  const command: Capture = {
    command: () => command,
    option: () => command,
    action: (callback) => {
      invoke = callback;
      return command;
    },
  };
  checkDependenciesCmd.register({ command: () => command } as unknown as CAC);
  oldExit = process.exit;
  oldCode = process.exitCode;
  oldOut = process.stdout.write;
  oldErr = process.stderr.write;
  for (const key of envKeys) savedEnv[key] = process.env[key];
});

afterEach(() => {
  process.exit = oldExit;
  process.exitCode = oldCode;
  process.stdout.write = oldOut;
  process.stderr.write = oldErr;
  for (const key of envKeys) {
    const value = savedEnv[key];
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.VITEST = 'true';
  process.env.NODE_ENV = 'test';
  delete process.env.DEVAI_TEST_DEPENDENCY_SCANNER_UNAVAILABLE;
});

function put(root: string, path: string, body: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, body);
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-dependencies-cli-depth-'));
  roots.push(root);
  put(root, 'package.json', JSON.stringify({ packageManager: 'pnpm@10.0.0' }));
  put(root, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
  put(root, 'docs/site/package-lock.json', '{"lockfileVersion":3}\n');
  return root;
}

function cleanAudit(): string {
  return JSON.stringify({
    schemaVersion: '1.0.0',
    scanner: {
      name: 'devai-test-scanner',
      version: '1.0.0',
      database_updated_at: '2026-09-09T00:00:00.000Z',
      database_timestamp_basis: 'successful_registry_query_observed_at',
    },
    generated_at: '2026-09-09T00:00:00.000Z',
    advisories: [],
    waivers: [],
  });
}

function reviewAudit(): string {
  return JSON.stringify({
    schemaVersion: '1.0.0',
    scanner: {
      name: 'devai-test-scanner',
      version: '1.0.0',
      database_updated_at: '2026-09-09T00:00:00.000Z',
      database_timestamp_basis: 'successful_registry_query_observed_at',
    },
    generated_at: '2026-09-09T00:00:00.000Z',
    advisories: [
      {
        id: 'ADV-CLI-1',
        package: 'review-package',
        severity: 'moderate',
        affected_range: '<2',
        fixed_versions: ['2.0.0'],
        aliases: [],
      },
    ],
    waivers: [],
  });
}

async function run(options: Options): Promise<{ stdout: string; stderr: string; exit: number }> {
  let stdout = '';
  let stderr = '';
  let exit = 0;
  process.exitCode = undefined;
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as typeof process.exit;
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await withAuthorityHostTestScope(() => invoke(options));
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error;
    exit = error.code;
  } finally {
    exit = process.exitCode ?? exit;
    process.exit = oldExit;
    process.exitCode = oldCode;
    process.stdout.write = oldOut;
    process.stderr.write = oldErr;
  }
  return { stdout, stderr, exit };
}

describe('check dependencies CLI public output boundaries', () => {
  it('emits a pass JSON aggregate for clean pnpm and npm fixtures', async () => {
    const root = fixtureRoot();
    const pnpm = join(root, 'pnpm-audit.json');
    const npm = join(root, 'npm-audit.json');
    writeFileSync(pnpm, cleanAudit());
    writeFileSync(npm, cleanAudit());
    process.env.VITEST = 'true';
    process.env.DEVAI_TEST_NOW = '2026-09-09T00:00:00.000Z';
    process.env.DEVAI_TEST_PNPM_DEPENDENCY_SCAN_FIXTURE = pnpm;
    process.env.DEVAI_TEST_NPM_DEPENDENCY_SCAN_FIXTURE = npm;
    const result = await run({ repoRoot: root });
    expect(result.stderr).toBe('');
    expect(result.exit).toBe(EXIT_PASS);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'pass',
      advisories: [],
      universes: [
        { ecosystem: 'pnpm', status: 'pass', advisories: [] },
        { ecosystem: 'npm', status: 'pass', advisories: [] },
      ],
    });
  });

  it('emits a review human summary with universe and timestamp details', async () => {
    const root = fixtureRoot();
    const pnpm = join(root, 'pnpm-audit.json');
    const npm = join(root, 'npm-audit.json');
    writeFileSync(pnpm, reviewAudit());
    writeFileSync(npm, cleanAudit());
    process.env.VITEST = 'true';
    process.env.DEVAI_TEST_NOW = '2026-09-09T00:00:00.000Z';
    process.env.DEVAI_TEST_PNPM_DEPENDENCY_SCAN_FIXTURE = pnpm;
    process.env.DEVAI_TEST_NPM_DEPENDENCY_SCAN_FIXTURE = npm;
    const result = await run({ repoRoot: root, human: true });
    expect(result.stderr).toBe('');
    expect(result.exit).toBe(EXIT_REVIEW);
    expect(result.stdout).toContain(
      'check dependencies: REVIEW (1 advisory/advisories, 0 applied waiver(s))',
    );
    expect(result.stdout).toContain('  pnpm:pnpm-lock.yaml: REVIEW (1 advisory/advisories)');
    expect(result.stdout).toContain(
      '  npm:docs/site/package-lock.json: PASS (0 advisory/advisories)',
    );
    expect(result.stdout).toContain('[DEPENDENCY_');
  });
});
