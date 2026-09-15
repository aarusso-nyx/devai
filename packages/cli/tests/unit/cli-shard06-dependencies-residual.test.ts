// S06-A dependency adapter residuals. These cases exercise only the exported
// checkDependencies service and bind normalization, waiver, universe, and
// subprocess behavior that remains observable to callers.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawnSync: boundary.spawnSync,
}));

import { checkDependencies } from '../../src/commands/check/dependencies.js';

const NOW = '2026-09-11T00:00:00.000Z';
const roots: string[] = [];

type ProcessResult = {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: Error | undefined;
};

function processResult(status: number, stdout = '', stderr = ''): ProcessResult {
  return { status, signal: null, stdout, stderr, error: undefined };
}

function temporaryRoot(): string {
  const root = mkdtempSync(join('/tmp', 'devai-s06-dependency-residual-'));
  roots.push(root);
  return root;
}

function put(root: string, path: string, value: unknown): string {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
  return target;
}

function repository(): string {
  const root = temporaryRoot();
  put(root, 'package.json', { packageManager: 'pnpm@10.0.0' });
  put(root, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
  put(root, 'docs/site/package-lock.json', '{"lockfileVersion":3}\n');
  return root;
}

function counts(
  overrides: Partial<Record<'info' | 'low' | 'moderate' | 'high' | 'critical', number>> = {},
) {
  return { info: 0, low: 0, moderate: 0, high: 0, critical: 0, ...overrides };
}

function classic(
  advisories: Record<string, unknown> = {},
  vulnerabilityCounts = counts(),
): Record<string, unknown> {
  return { advisories, metadata: { vulnerabilities: vulnerabilityCounts } };
}

function modern(
  vulnerabilities: Record<string, unknown> = {},
  vulnerabilityCounts = counts(),
): Record<string, unknown> {
  return { vulnerabilities, metadata: { vulnerabilities: vulnerabilityCounts } };
}

function advisory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'ADV-1',
    module_name: 'package-one',
    severity: 'low',
    vulnerable_versions: '<1',
    patched_versions: '>=1',
    ...overrides,
  };
}

function scannerFixture(
  advisories: readonly Record<string, unknown>[] = [],
): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    scanner: {
      name: 'devai-test-scanner',
      version: '1.0.0',
      database_updated_at: NOW,
      database_timestamp_basis: 'successful_registry_query_observed_at',
    },
    generated_at: NOW,
    advisories,
    waivers: [],
  };
}

function configureAudits(pnpm: unknown, npm: unknown = modern()): void {
  boundary.spawnSync.mockImplementation((executable?: string, args?: readonly string[]) => {
    if (args?.[0] === '--version') {
      return processResult(0, executable === 'pnpm' ? '10.0.0\n' : '11.14.1\n');
    }
    return processResult(1, JSON.stringify(executable === 'pnpm' ? pnpm : npm));
  });
}

function universe(result: ReturnType<typeof checkDependencies>, index: number) {
  expect(result).toHaveProperty('universes');
  if (!('universes' in result)) throw new Error('aggregate result required');
  const selected = result.universes[index];
  if (selected === undefined) throw new Error(`universe ${String(index)} missing`);
  return selected;
}

afterEach(() => {
  boundary.spawnSync.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('S06-A dependency normalization residuals', () => {
  it('trims fallback identities and keeps missing, sentinel, and empty patch sets empty', () => {
    const root = repository();
    configureAudits(
      classic(
        {
          trimmed: advisory({ source: '  ADV-TRIMMED  ', patched_versions: undefined }),
          sentinel: advisory({ source: 'ADV-SENTINEL', patched_versions: '<0.0.0' }),
          empty: advisory({ source: 'ADV-EMPTY', patched_versions: '' }),
        },
        counts({ low: 3 }),
      ),
    );

    const result = checkDependencies({ repoRoot: root, now: NOW, environment: {} });

    expect(universe(result, 0).advisories).toEqual([
      expect.objectContaining({ id: 'ADV-EMPTY', fixed_versions: [] }),
      expect.objectContaining({ id: 'ADV-SENTINEL', fixed_versions: [] }),
      expect.objectContaining({ id: 'ADV-TRIMMED', fixed_versions: [] }),
    ]);
  });

  it('extracts one exact GHSA identity without inventing aliases from case or regex drift', () => {
    const root = repository();
    configureAudits(
      classic(
        {
          ghsa: advisory({
            source: 'ADV-FALLBACK',
            url: 'https://github.com/advisories/GHSA-abcd-1234-efgh',
            cves: ['CVE-2', 'CVE-1', 'CVE-2'],
            aliases: ['ALIAS-1'],
          }),
        },
        counts({ low: 1 }),
      ),
    );

    expect(
      universe(checkDependencies({ repoRoot: root, now: NOW, environment: {} }), 0).advisories,
    ).toEqual([
      expect.objectContaining({
        id: 'GHSA-ABCD-1234-EFGH',
        aliases: ['ALIAS-1', 'CVE-1', 'CVE-2'],
      }),
    ]);
  });

  it('does not recognize invalid GHSA characters as an advisory alias', () => {
    const root = repository();
    configureAudits(
      classic(
        {
          invalid: advisory({
            source: 'ADV-FALLBACK',
            url: 'https://example.invalid/GHSA-?not-an-id',
          }),
        },
        counts({ low: 1 }),
      ),
    );

    expect(
      universe(checkDependencies({ repoRoot: root, now: NOW, environment: {} }), 0).advisories,
    ).toEqual([expect.objectContaining({ id: 'ADV-FALLBACK', aliases: [] })]);
  });

  it('preserves distinct advisory keys and emits them in canonical id/package order', () => {
    const root = repository();
    configureAudits(
      classic(
        {
          later: advisory({ source: 'B', module_name: 'alpha' }),
          earlier: advisory({ source: 'A', module_name: 'zulu' }),
          sameId: advisory({ source: 'A', module_name: 'alpha' }),
        },
        counts({ low: 3 }),
      ),
    );

    const result = checkDependencies({ repoRoot: root, now: NOW, environment: {} });
    expect(universe(result, 0)).toMatchObject({ status: 'review' });
    expect(
      universe(result, 0).advisories.map(({ id, package: packageName }) => [id, packageName]),
    ).toEqual([
      ['A', 'alpha'],
      ['A', 'zulu'],
      ['B', 'alpha'],
    ]);
  });

  it('deduplicates byte-identical repeated advisories without treating them as a conflict', () => {
    const root = repository();
    const repeated = advisory({ source: 'ADV-REPEATED', module_name: 'same-package' });
    configureAudits(classic({ first: repeated, second: { ...repeated } }, counts({ low: 2 })));

    const result = checkDependencies({ repoRoot: root, now: NOW, environment: {} });
    expect(universe(result, 0)).toMatchObject({ status: 'review' });
    expect(universe(result, 0).advisories).toEqual([
      expect.objectContaining({ id: 'ADV-REPEATED', package: 'same-package' }),
    ]);
  });

  it('sorts an already canonical two-advisory population without reversing it', () => {
    const root = repository();
    configureAudits(
      classic(
        {
          first: advisory({ source: 'A', module_name: 'alpha' }),
          second: advisory({ source: 'B', module_name: 'bravo' }),
        },
        counts({ low: 2 }),
      ),
    );

    expect(
      universe(checkDependencies({ repoRoot: root, now: NOW, environment: {} }), 0).advisories.map(
        ({ id }) => id,
      ),
    ).toEqual(['A', 'B']);
  });

  it.each([
    ['missing metadata', { advisories: { one: advisory() } }],
    ['positive count with no advisories', classic({}, counts({ low: 1 }))],
    ['zero count with one advisory', classic({ one: advisory() }, counts())],
    ['negative count', classic({ one: advisory() }, counts({ low: -1 }))],
  ])('refuses inconsistent audit population: %s', (_name, raw) => {
    const root = repository();
    configureAudits(raw);

    expect(
      universe(checkDependencies({ repoRoot: root, now: NOW, environment: {} }), 0),
    ).toMatchObject({ status: 'unknown' });
  });

  it('preserves malformed severity as an unknown scanner result', () => {
    const root = repository();
    configureAudits(classic({ one: advisory({ severity: 'urgent' }) }, counts({ low: 1 })));

    const result = checkDependencies({ repoRoot: root, now: NOW, environment: {} });
    expect(universe(result, 0)).toMatchObject({ status: 'unknown', advisories: [] });
  });
});

describe('S06-A dependency waiver residuals', () => {
  it('reports malformed JSON with the exact waiver path and duplicates the failure per universe', () => {
    const root = repository();
    put(root, '.devai/config/dependency-waivers.json', '{');

    const result = checkDependencies({ repoRoot: root, now: NOW, environment: {} });

    expect(result).toMatchObject({ status: 'fail' });
    expect(result.findings).toHaveLength(2);
    expect(result.findings.map(({ code }) => code)).toEqual([
      'DEPENDENCY_WAIVER_INVALID',
      'DEPENDENCY_WAIVER_INVALID',
    ]);
    for (const finding of result.findings) {
      expect(finding.message).toContain('cannot parse .devai/config/dependency-waivers.json:');
    }
  });

  it.each(['{}', '{"waivers":{}}'])('requires an actual waiver array in %s', (document) => {
    const root = repository();
    put(root, '.devai/config/dependency-waivers.json', document);

    const result = checkDependencies({ repoRoot: root, now: NOW, environment: {} });
    expect(result.findings).toEqual([
      {
        code: 'DEPENDENCY_WAIVER_INVALID',
        message:
          '[pnpm:pnpm-lock.yaml] .devai/config/dependency-waivers.json must contain a waivers array',
      },
      {
        code: 'DEPENDENCY_WAIVER_INVALID',
        message:
          '[npm:docs/site/package-lock.json] .devai/config/dependency-waivers.json must contain a waivers array',
      },
    ]);
  });

  it('passes the exact loaded waiver population into both audit universes', () => {
    const root = repository();
    const waiver = {
      advisory_id: 'ADV-HIGH',
      package: 'high-package',
      reason: 'Owner accepted this bounded fixture exposure.',
      approved_by: 'owner',
      expires_at: '2026-09-12T00:00:00.000Z',
    };
    put(root, '.devai/config/dependency-waivers.json', { waivers: [waiver] });
    const high = advisory({
      source: 'ADV-HIGH',
      module_name: 'high-package',
      severity: 'high',
    });
    configureAudits(classic({ high }, counts({ high: 1 })), modern());

    const result = checkDependencies({ repoRoot: root, now: NOW, environment: {} });
    expect(universe(result, 0)).toMatchObject({ status: 'pass', applied_waivers: [waiver] });
    expect(result.applied_waivers).toEqual([waiver]);
  });
});

describe('S06-A dependency universe and fixture routing residuals', () => {
  it('gives FAIL precedence when one fixture universe fails and the other passes', () => {
    const root = repository();
    const pnpm = put(
      root,
      'fixtures/pnpm.json',
      scannerFixture([
        {
          id: 'ADV-HIGH',
          package: 'high-package',
          severity: 'high',
          affected_range: '<1',
          fixed_versions: ['1.0.0'],
          aliases: [],
        },
      ]),
    );
    const npm = put(root, 'fixtures/npm.json', scannerFixture());

    const result = checkDependencies({
      repoRoot: root,
      now: NOW,
      environment: {
        VITEST: 'true',
        DEVAI_TEST_PNPM_DEPENDENCY_SCAN_FIXTURE: pnpm,
        DEVAI_TEST_NPM_DEPENDENCY_SCAN_FIXTURE: npm,
      },
    });

    expect(result).toMatchObject({
      status: 'fail',
      universes: [{ status: 'fail' }, { status: 'pass' }],
    });
  });

  it.each([
    ['VITEST', { VITEST: 'true' }],
    ['NODE_ENV', { NODE_ENV: 'test' }],
  ])('enters fixture mode through %s alone', (_name, activation) => {
    const root = repository();
    const pnpm = put(root, 'fixtures/pnpm.json', scannerFixture());
    const npm = put(root, 'fixtures/npm.json', scannerFixture());

    const result = checkDependencies({
      repoRoot: root,
      now: NOW,
      environment: {
        ...activation,
        DEVAI_TEST_PNPM_DEPENDENCY_SCAN_FIXTURE: pnpm,
        DEVAI_TEST_NPM_DEPENDENCY_SCAN_FIXTURE: npm,
      },
    });

    expect(result).toMatchObject({
      status: 'pass',
      universes: [{ status: 'pass' }, { status: 'pass' }],
    });
    expect(boundary.spawnSync).not.toHaveBeenCalled();
  });

  it('ignores fixture controls unless explicit test mode is active', () => {
    const root = repository();
    const fixture = put(root, 'fixtures/clean.json', scannerFixture());
    boundary.spawnSync.mockReturnValue(processResult(2));

    const result = checkDependencies({
      repoRoot: root,
      now: NOW,
      environment: {
        DEVAI_TEST_DEPENDENCY_SCANNER_UNAVAILABLE: '1',
        DEVAI_TEST_PNPM_DEPENDENCY_SCAN_FIXTURE: fixture,
        DEVAI_TEST_NPM_DEPENDENCY_SCAN_FIXTURE: fixture,
      },
    });

    expect(result).toMatchObject({
      status: 'unknown',
      universes: [{ status: 'unknown' }, { status: 'unknown' }],
    });
    expect(boundary.spawnSync).toHaveBeenCalled();
  });

  it('honors the explicit unavailable control only under test mode', () => {
    const root = repository();

    const result = checkDependencies({
      repoRoot: root,
      now: NOW,
      environment: { NODE_ENV: 'test', DEVAI_TEST_DEPENDENCY_SCANNER_UNAVAILABLE: '1' },
    });

    expect(result).toEqual({
      schemaVersion: '1.0.0',
      status: 'unknown',
      advisories: [],
      applied_waivers: [],
      findings: [
        { code: 'DEPENDENCY_SCANNER_UNAVAILABLE', message: 'dependency scanner is unavailable' },
      ],
      counts: counts(),
    });
  });

  it.each([
    ['pnpm', 'DEVAI_TEST_PNPM_DEPENDENCY_SCAN_FIXTURE', 1, 'npm:docs/site/package-lock.json'],
    ['npm', 'DEVAI_TEST_NPM_DEPENDENCY_SCAN_FIXTURE', 0, 'pnpm:pnpm-lock.yaml'],
  ] as const)(
    'keeps the missing %s companion universe explicitly unknown',
    (_name, key, missingIndex, label) => {
      const root = repository();
      const fixture = put(root, 'fixtures/clean.json', scannerFixture());

      const result = checkDependencies({
        repoRoot: root,
        now: NOW,
        environment: { VITEST: 'true', [key]: fixture },
      });

      expect(result.status).toBe('unknown');
      expect(universe(result, missingIndex).findings).toEqual([
        {
          code: 'DEPENDENCY_SCANNER_UNAVAILABLE',
          message: `${label.startsWith('npm:') ? 'npm' : 'pnpm'} scanner fixture is unavailable`,
        },
      ]);
      expect(result.findings).toContainEqual({
        code: 'DEPENDENCY_SCANNER_UNAVAILABLE',
        message: `[${label}] ${label.startsWith('npm:') ? 'npm' : 'pnpm'} scanner fixture is unavailable`,
      });
    },
  );

  it('supports the legacy single-fixture route without producing universes', () => {
    const root = repository();
    const fixture = put(root, 'fixtures/legacy.json', scannerFixture());

    const result = checkDependencies({
      repoRoot: root,
      now: NOW,
      environment: { NODE_ENV: 'test', DEVAI_TEST_DEPENDENCY_SCAN_FIXTURE: fixture },
    });

    expect(result.status).toBe('pass');
    expect(result).not.toHaveProperty('universes');
  });

  it('returns an exact bounded finding for malformed fixture JSON', () => {
    const root = repository();
    const fixture = put(root, 'fixtures/broken.json', '{');

    const result = checkDependencies({
      repoRoot: root,
      now: NOW,
      environment: { VITEST: 'true', DEVAI_TEST_DEPENDENCY_SCAN_FIXTURE: fixture },
    });

    expect(result).toMatchObject({
      status: 'unknown',
      findings: [
        {
          code: 'DEPENDENCY_SCANNER_UNAVAILABLE',
          message: expect.stringContaining(
            'dependency scanner output is unavailable or malformed JSON:',
          ),
        },
      ],
    });
  });
});

describe('S06-A dependency subprocess residuals', () => {
  it('binds version and audit argv, cwd, environment, encoding, and stdio exactly', () => {
    const root = repository();
    configureAudits(classic(), modern());

    expect(
      checkDependencies({ repoRoot: root, now: NOW, environment: { CUSTOM: 'value' } }).status,
    ).toBe('pass');

    expect(boundary.spawnSync.mock.calls).toEqual([
      [
        'pnpm',
        ['--version'],
        {
          cwd: root,
          env: { CUSTOM: 'value', NO_COLOR: '1', FORCE_COLOR: '0' },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ],
      [
        'pnpm',
        ['audit', '--json'],
        {
          cwd: root,
          env: { CUSTOM: 'value', NO_COLOR: '1', FORCE_COLOR: '0' },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ],
      [
        'npm',
        ['--version'],
        {
          cwd: join(root, 'docs/site'),
          env: { CUSTOM: 'value', NO_COLOR: '1', FORCE_COLOR: '0' },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ],
      [
        'npm',
        ['audit', '--json', '--package-lock-only'],
        {
          cwd: join(root, 'docs/site'),
          env: { CUSTOM: 'value', NO_COLOR: '1', FORCE_COLOR: '0' },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ],
    ]);
  });

  it('stops one universe at a mismatched scanner version while the other still passes', () => {
    const root = repository();
    boundary.spawnSync.mockImplementation((executable?: string, args?: readonly string[]) => {
      if (args?.[0] === '--version') {
        return processResult(0, executable === 'pnpm' ? 'wrong\n' : '11.14.1\n');
      }
      return processResult(0, JSON.stringify(modern()));
    });

    const result = checkDependencies({ repoRoot: root, now: NOW, environment: {} });
    expect(result).toMatchObject({
      status: 'unknown',
      universes: [{ status: 'unknown' }, { status: 'pass' }],
    });
    expect(universe(result, 0).findings).toEqual([
      {
        code: 'DEPENDENCY_SCANNER_UNAVAILABLE',
        message: 'expected pnpm@10.0.0; received wrong',
      },
    ]);
    expect(boundary.spawnSync.mock.calls.filter((call) => call[0] === 'pnpm')).toHaveLength(1);
  });

  it('rejects a failed version command even when stdout contains the expected version', () => {
    const root = repository();
    boundary.spawnSync.mockImplementation((executable?: string, args?: readonly string[]) => {
      if (args?.[0] === '--version') {
        return processResult(
          executable === 'pnpm' ? 2 : 0,
          executable === 'pnpm' ? '10.0.0\n' : '11.14.1\n',
        );
      }
      return processResult(0, JSON.stringify(modern()));
    });

    const result = checkDependencies({ repoRoot: root, now: NOW, environment: {} });
    expect(universe(result, 0).findings).toEqual([
      {
        code: 'DEPENDENCY_SCANNER_UNAVAILABLE',
        message: 'expected pnpm@10.0.0; received 10.0.0',
      },
    ]);
    expect(boundary.spawnSync.mock.calls.filter((call) => call[0] === 'pnpm')).toHaveLength(1);
    expect(universe(result, 1).status).toBe('pass');
  });

  it('names an empty version response unavailable', () => {
    const root = repository();
    boundary.spawnSync.mockImplementation((executable?: string, args?: readonly string[]) => {
      if (args?.[0] === '--version')
        return processResult(0, executable === 'pnpm' ? '' : '11.14.1\n');
      return processResult(0, JSON.stringify(modern()));
    });

    expect(
      universe(checkDependencies({ repoRoot: root, now: NOW, environment: {} }), 0).findings,
    ).toEqual([
      {
        code: 'DEPENDENCY_SCANNER_UNAVAILABLE',
        message: 'expected pnpm@10.0.0; received unavailable',
      },
    ]);
  });

  it('rejects abnormal audit exit status before parsing output', () => {
    const root = repository();
    boundary.spawnSync.mockImplementation((executable?: string, args?: readonly string[]) =>
      args?.[0] === '--version'
        ? processResult(0, executable === 'pnpm' ? '10.0.0\n' : '11.14.1\n')
        : processResult(2, JSON.stringify(modern())),
    );

    const result = checkDependencies({ repoRoot: root, now: NOW, environment: {} });
    expect(result).toMatchObject({
      status: 'unknown',
      universes: [{ status: 'unknown' }, { status: 'unknown' }],
    });
    for (const item of 'universes' in result ? result.universes : []) {
      expect(item.findings[0]?.message).toBe(
        `${item.ecosystem} audit failed before producing a trustworthy result`,
      );
    }
  });

  it('reports malformed audit JSON with its exact executable and parse cause', () => {
    const root = repository();
    boundary.spawnSync.mockImplementation((executable?: string, args?: readonly string[]) =>
      args?.[0] === '--version'
        ? processResult(0, executable === 'pnpm' ? '10.0.0\n' : '11.14.1\n')
        : processResult(0, '{'),
    );

    const result = checkDependencies({ repoRoot: root, now: NOW, environment: {} });
    expect(universe(result, 0).findings[0]?.message).toContain(
      'pnpm audit returned malformed JSON:',
    );
    expect(universe(result, 1).findings[0]?.message).toContain(
      'npm audit returned malformed JSON:',
    );
  });

  it('reports a thrown scanner error with its exact executable and cause', () => {
    const root = repository();
    boundary.spawnSync.mockImplementation((executable?: string) => {
      throw new Error(`${executable ?? 'missing'} exploded`);
    });

    const result = checkDependencies({ repoRoot: root, now: NOW, environment: {} });
    expect(universe(result, 0).findings).toEqual([
      {
        code: 'DEPENDENCY_SCANNER_UNAVAILABLE',
        message: 'pnpm dependency scanner process is unavailable: pnpm exploded',
      },
    ]);
    expect(universe(result, 1).findings).toEqual([
      {
        code: 'DEPENDENCY_SCANNER_UNAVAILABLE',
        message: 'npm dependency scanner process is unavailable: npm exploded',
      },
    ]);
  });
});
