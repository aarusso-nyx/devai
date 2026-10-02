// Invariants: INV-DEVAI-012; Constitution Articles 29, 32, 39, 41.
// CMP-0006 / R-0602 / CTG-0621 / TASK-0622; Owner ruling on issue #233: no waiver.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawnSync: mocks.spawnSync,
}));

// Only the actual emitter's process seam is controlled; parsing, grading and
// buildSensorReading execute unchanged. No substitute vulnerability evaluator.
import { senseSecurityScan } from '../../src/security-scan.js';

const repoRoot = '/controlled/security-audit';
const now = '2026-10-02T02:59:25.625Z';
const severities = ['critical', 'high', 'moderate', 'low', 'info'] as const;
const cleanCounts = { critical: 0, high: 0, moderate: 0, low: 0, info: 0 };

// Frozen diagnostic, not a live acceptance result or a permanent advisory count.
// pnpm 9.15.0 / Node v24.15.0, audit --json observed 2026-10-02T02:59:25.625620Z,
// process exit 1, HEAD fb3ea266ca00e882afa34c5440cf46f0722de623,
// tree f1be7a1c2a1bcee599c1e56d9faf90201abd4e99.
// Raw stdout SHA-256: 98d80cdedc7891af71918e60b0e0dbc7e503305a84cae774df5b11c366fb4dd5.
// Projection preserves all 18 advisory identities/severities, all 20 findings'
// versions (including duplicate Vitest findings), complete metadata and muted=[];
// each finding retains its shortest original path. Descriptions and redundant
// paths are omitted. The separate projection digest binds these exact fixture bytes.
const observedAudit = {
  advisories: {
    '1193683': {
      id: 1193683,
      module_name: 'vitest',
      severity: 'moderate',
      github_advisory_id: 'GHSA-82fw-gwwq-j7x9',
      vulnerable_versions: '>=2.1.0 <4.1.11',
      patched_versions: '>=4.1.11',
      findings: [
        { version: '4.1.10', paths: ['. > @vitest/coverage-v8@4.1.10 > vitest@4.1.10'] },
        { version: '4.1.10', paths: ['. > @vitest/coverage-v8@4.1.10 > vitest@4.1.10'] },
      ],
    },
    '1193684': {
      id: 1193684,
      module_name: '@vitest/mocker',
      severity: 'moderate',
      github_advisory_id: 'GHSA-82fw-gwwq-j7x9',
      vulnerable_versions: '>=2.1.0 <4.1.11',
      patched_versions: '>=4.1.11',
      findings: [
        { version: '4.1.10', paths: ['. > vitest@4.1.10 > @vitest/mocker@4.1.10'] },
        { version: '4.1.10', paths: ['. > vitest@4.1.10 > @vitest/mocker@4.1.10'] },
      ],
    },
    '1239943': {
      id: 1239943,
      module_name: 'fast-uri',
      severity: 'high',
      github_advisory_id: 'GHSA-qw65-cvwx-89v3',
      vulnerable_versions: '>=3.0.0 <3.1.7',
      patched_versions: '>=3.1.7',
      findings: [{ version: '3.1.6', paths: ['. > ajv@8.20.0 > fast-uri@3.1.6'] }],
    },
    '1239946': {
      id: 1239946,
      module_name: 'fast-uri',
      severity: 'high',
      github_advisory_id: 'GHSA-58mr-gqgx-xq4g',
      vulnerable_versions: '=3.1.6',
      patched_versions: '>=3.1.7',
      findings: [{ version: '3.1.6', paths: ['. > ajv@8.20.0 > fast-uri@3.1.6'] }],
    },
    '1239948': {
      id: 1239948,
      module_name: 'ip-address',
      severity: 'moderate',
      github_advisory_id: 'GHSA-rpw4-54j3-4h4q',
      vulnerable_versions: '<=10.5.0',
      patched_versions: '>=10.5.1',
      findings: [
        {
          version: '10.5.0',
          paths: [
            '. > @cyclonedx/cyclonedx-npm@6.0.1 > libxmljs2@0.37.0 > node-gyp@11.5.0 > make-fetch-happen@14.0.3 > @npmcli/agent@3.0.0 > socks-proxy-agent@8.0.5 > socks@2.8.9 > ip-address@10.5.0',
          ],
        },
      ],
    },
    '1239949': {
      id: 1239949,
      module_name: 'ip-address',
      severity: 'moderate',
      github_advisory_id: 'GHSA-2vr4-cq9g-pvrc',
      vulnerable_versions: '>=10.2.0 <=10.5.0',
      patched_versions: '>=10.5.1',
      findings: [
        {
          version: '10.5.0',
          paths: [
            '. > @cyclonedx/cyclonedx-npm@6.0.1 > libxmljs2@0.37.0 > node-gyp@11.5.0 > make-fetch-happen@14.0.3 > @npmcli/agent@3.0.0 > socks-proxy-agent@8.0.5 > socks@2.8.9 > ip-address@10.5.0',
          ],
        },
      ],
    },
    '1240091': {
      id: 1240091,
      module_name: 'fast-uri',
      severity: 'moderate',
      github_advisory_id: 'GHSA-hrr3-gc8f-f4qj',
      vulnerable_versions: '>=3.0.0 <3.1.8',
      patched_versions: '>=3.1.8',
      findings: [{ version: '3.1.6', paths: ['. > ajv@8.20.0 > fast-uri@3.1.6'] }],
    },
    '1240097': {
      id: 1240097,
      module_name: 'ip-address',
      severity: 'moderate',
      github_advisory_id: 'GHSA-j6r3-76f7-8jcv',
      vulnerable_versions: '<=10.7.0',
      patched_versions: '>=10.7.1',
      findings: [
        {
          version: '10.5.0',
          paths: [
            '. > @cyclonedx/cyclonedx-npm@6.0.1 > libxmljs2@0.37.0 > node-gyp@11.5.0 > make-fetch-happen@14.0.3 > @npmcli/agent@3.0.0 > socks-proxy-agent@8.0.5 > socks@2.8.9 > ip-address@10.5.0',
          ],
        },
      ],
    },
    '1240098': {
      id: 1240098,
      module_name: 'ip-address',
      severity: 'moderate',
      github_advisory_id: 'GHSA-h3mg-xc3c-68pw',
      vulnerable_versions: '<=10.7.0',
      patched_versions: '>=10.7.1',
      findings: [
        {
          version: '10.5.0',
          paths: [
            '. > @cyclonedx/cyclonedx-npm@6.0.1 > libxmljs2@0.37.0 > node-gyp@11.5.0 > make-fetch-happen@14.0.3 > @npmcli/agent@3.0.0 > socks-proxy-agent@8.0.5 > socks@2.8.9 > ip-address@10.5.0',
          ],
        },
      ],
    },
    '1240100': {
      id: 1240100,
      module_name: 'brace-expansion',
      severity: 'moderate',
      github_advisory_id: 'GHSA-q2hr-2g5m-vwhr',
      vulnerable_versions: '<1.1.21',
      patched_versions: '>=1.1.21',
      findings: [
        {
          version: '1.1.18',
          paths: ['. > eslint@9.39.5 > minimatch@3.1.5 > brace-expansion@1.1.18'],
        },
      ],
    },
    '1240101': {
      id: 1240101,
      module_name: 'brace-expansion',
      severity: 'moderate',
      github_advisory_id: 'GHSA-q2hr-2g5m-vwhr',
      vulnerable_versions: '>=2.0.0 <2.1.7',
      patched_versions: '>=2.1.7',
      findings: [
        { version: '2.1.4', paths: ['packages/cli > minimatch@9.0.9 > brace-expansion@2.1.4'] },
      ],
    },
    '1240103': {
      id: 1240103,
      module_name: 'brace-expansion',
      severity: 'moderate',
      github_advisory_id: 'GHSA-q2hr-2g5m-vwhr',
      vulnerable_versions: '>=4.0.0 <5.0.12',
      patched_versions: '>=5.0.12',
      findings: [
        {
          version: '5.0.9',
          paths: [
            '. > typescript-eslint@8.65.0 > @typescript-eslint/typescript-estree@8.65.0 > minimatch@10.2.5 > brace-expansion@5.0.9',
          ],
        },
      ],
    },
    '1240104': {
      id: 1240104,
      module_name: 'brace-expansion',
      severity: 'high',
      github_advisory_id: 'GHSA-qhr7-859c-m2p7',
      vulnerable_versions: '<1.1.20',
      patched_versions: '>=1.1.20',
      findings: [
        {
          version: '1.1.18',
          paths: ['. > eslint@9.39.5 > minimatch@3.1.5 > brace-expansion@1.1.18'],
        },
      ],
    },
    '1240105': {
      id: 1240105,
      module_name: 'brace-expansion',
      severity: 'high',
      github_advisory_id: 'GHSA-qhr7-859c-m2p7',
      vulnerable_versions: '>=2.0.0 <2.1.6',
      patched_versions: '>=2.1.6',
      findings: [
        { version: '2.1.4', paths: ['packages/cli > minimatch@9.0.9 > brace-expansion@2.1.4'] },
      ],
    },
    '1240107': {
      id: 1240107,
      module_name: 'brace-expansion',
      severity: 'high',
      github_advisory_id: 'GHSA-qhr7-859c-m2p7',
      vulnerable_versions: '>=4.0.0 <5.0.11',
      patched_versions: '>=5.0.11',
      findings: [
        {
          version: '5.0.9',
          paths: [
            '. > typescript-eslint@8.65.0 > @typescript-eslint/typescript-estree@8.65.0 > minimatch@10.2.5 > brace-expansion@5.0.9',
          ],
        },
      ],
    },
    '1240108': {
      id: 1240108,
      module_name: 'brace-expansion',
      severity: 'high',
      github_advisory_id: 'GHSA-6j4f-fj2g-mc7p',
      vulnerable_versions: '<1.1.19',
      patched_versions: '>=1.1.19',
      findings: [
        {
          version: '1.1.18',
          paths: ['. > eslint@9.39.5 > minimatch@3.1.5 > brace-expansion@1.1.18'],
        },
      ],
    },
    '1240109': {
      id: 1240109,
      module_name: 'brace-expansion',
      severity: 'high',
      github_advisory_id: 'GHSA-6j4f-fj2g-mc7p',
      vulnerable_versions: '>=2.0.0 <2.1.5',
      patched_versions: '>=2.1.5',
      findings: [
        { version: '2.1.4', paths: ['packages/cli > minimatch@9.0.9 > brace-expansion@2.1.4'] },
      ],
    },
    '1240111': {
      id: 1240111,
      module_name: 'brace-expansion',
      severity: 'high',
      github_advisory_id: 'GHSA-6j4f-fj2g-mc7p',
      vulnerable_versions: '>=4.0.0 <5.0.10',
      patched_versions: '>=5.0.10',
      findings: [
        {
          version: '5.0.9',
          paths: [
            '. > typescript-eslint@8.65.0 > @typescript-eslint/typescript-estree@8.65.0 > minimatch@10.2.5 > brace-expansion@5.0.9',
          ],
        },
      ],
    },
  },
  muted: [],
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 12, high: 8, critical: 0 },
    dependencies: 438,
    devDependencies: 0,
    optionalDependencies: 0,
    totalDependencies: 438,
  },
};
const observedProjectionSha256 = '12d9d921122a2a46509a6fb15d2a8b68c4a4de804a97c65ce8b20ad494a132ad';

type ProcessResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
};

function response(data: unknown, status = 0): ProcessResult {
  return { status, signal: null, stdout: JSON.stringify(data), stderr: '' };
}
function summary(counts: Record<string, unknown> = cleanCounts): unknown {
  return { metadata: { vulnerabilities: counts } };
}
function absent(tool: string): ProcessResult {
  return {
    status: null,
    signal: null,
    stdout: '',
    stderr: '',
    error: Object.assign(new Error(`${tool}-missing-fixture`), { code: 'ENOENT' }),
  };
}
function processSeam(pnpm: ProcessResult, npm = absent('npm')): void {
  mocks.spawnSync.mockImplementation((tool: string) => {
    if (tool === 'pnpm') return pnpm;
    if (tool === 'npm') return npm;
    throw new Error(`undeclared process: ${tool}`);
  });
}
function expectUnobserved(reading: ReturnType<typeof senseSecurityScan>): void {
  expect(['unknown', 'error', 'killed']).toContain(reading.status);
  expect(reading.findings?.length).toBeGreaterThan(0);
  expect(reading.sensor).toMatchObject({ name: 'security-scan', kind: 'security_scan' });
  expect(reading.timestamp).toBe(now);
}

beforeEach(() => {
  mocks.spawnSync.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('CMP-0006 registered security_scan audit evidence', () => {
  it('binds the emitter to F2:T6 and checks the attributable audit projection', () => {
    const registry = JSON.parse(
      readFileSync(new URL('../../../../law/policy/sensor-registry.json', import.meta.url), 'utf8'),
    ) as {
      entries: {
        id: string;
        emitter_module: string;
        cells: { substrate: string; property: string }[];
      }[];
    };
    expect(registry.entries.find((entry) => entry.id === 'security_scan')).toMatchObject({
      emitter_module: 'packages/sensors/src/security-scan.ts',
      cells: [{ substrate: 'F2', property: 'T6' }],
    });
    expect(createHash('sha256').update(JSON.stringify(observedAudit)).digest('hex')).toBe(
      observedProjectionSha256,
    );
    const advisories = Object.values(observedAudit.advisories);
    expect(advisories.filter((entry) => entry.severity === 'high')).toHaveLength(8);
    expect(advisories.flatMap((entry) => entry.findings)).toHaveLength(20);
    expect(observedAudit.muted).toEqual([]);
  });

  it('emits FAIL for the observed high population even with normal audit exit 1', () => {
    processSeam(response(observedAudit, 1));
    const reading = senseSecurityScan({ repoRoot, now });
    expect(reading).toMatchObject({
      status: 'fail',
      command: 'pnpm audit --json',
      timestamp: now,
      sensor: { name: 'security-scan', kind: 'security_scan' },
      metrics: {
        tool: 'pnpm',
        critical: 0,
        high: 8,
        moderate: 12,
        low: 0,
        info: 0,
        total_vulnerabilities: 20,
        pass_max_high: 0,
        review_max_high: 5,
      },
    });
    expect(reading.findings?.[0]?.code).toBe('SECURITY_SCAN_HIGH_OVER_THRESHOLD');
    expect(reading.exit_code).toBe(1);
    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
  });

  it('admits a complete clean audit with the exact controlled process contract', () => {
    processSeam(response(summary()));
    const reading = senseSecurityScan({ repoRoot, now });
    expect(reading).toMatchObject({
      status: 'pass',
      command: 'pnpm audit --json',
      timestamp: now,
      metrics: {
        ...cleanCounts,
        tool: 'pnpm',
        total_vulnerabilities: 0,
        pass_max_high: 0,
        review_max_high: 5,
      },
    });
    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
    expect(mocks.spawnSync).toHaveBeenCalledWith(
      'pnpm',
      ['audit', '--json'],
      expect.objectContaining({
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 60_000,
        env: expect.objectContaining({ PATH: process.env.PATH }),
      }),
    );
  });

  it.each([1, 5, 6])('never passes an unwaived high population of %s', (high) => {
    processSeam(response(summary({ ...cleanCounts, high }), 1));
    const reading = senseSecurityScan({ repoRoot, now });
    expect(reading.status).toBe(high > 5 ? 'fail' : 'review');
    expect(reading.metrics?.high).toBe(high);
    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
  });

  it('fails on critical findings before the high threshold', () => {
    processSeam(response(summary({ ...cleanCounts, critical: 1 }), 1));
    const reading = senseSecurityScan({ repoRoot, now });
    expect(reading.status).toBe('fail');
    expect(reading.findings?.[0]?.code).toBe('SECURITY_SCAN_CRITICAL_VULN');
    expect(reading.metrics?.critical).toBe(1);
  });

  it.each([
    ['absent summary', {}],
    ['null root', null],
    ['primitive root', 0],
    ['array root', []],
    ['null metadata', { metadata: null }],
    ['array metadata', { metadata: [] }],
    ['empty summary', summary({})],
    ['null summary', { metadata: { vulnerabilities: null } }],
    ['array summary', { metadata: { vulnerabilities: [] } }],
    ['string summary', { metadata: { vulnerabilities: 'clean' } }],
    ['wrong nesting', { vulnerabilities: cleanCounts }],
    ['npm null map', { vulnerabilities: null }],
    ['npm array map', { vulnerabilities: [] }],
    ['audit error object', { error: { code: 'EAUDIT', summary: 'no completed audit' } }],
    ['error hidden behind clean counts', { ...(summary() as object), error: { code: 'EAUDIT' } }],
  ])('refuses %s instead of manufacturing zero counts', (_label, data) => {
    processSeam(response(data));
    expectUnobserved(senseSecurityScan({ repoRoot, now }));
  });

  it.each(severities)(
    'requires the %s count even when every other count is present',
    (severity) => {
      const partial = Object.fromEntries(
        Object.entries(cleanCounts).filter(([key]) => key !== severity),
      );
      processSeam(response(summary(partial)));
      expectUnobserved(senseSecurityScan({ repoRoot, now }));
    },
  );

  it.each(
    severities.flatMap((severity) =>
      [-1, 0.5, '0', null, true].map((value) => ({ severity, value })),
    ),
  )('rejects $severity=$value as an invalid count', ({ severity, value }) => {
    processSeam(response(summary({ ...cleanCounts, [severity]: value })));
    expectUnobserved(senseSecurityScan({ repoRoot, now }));
  });

  it.each(severities)('rejects JSON numeric overflow in the %s count', (severity) => {
    // 1e400 is valid JSON syntax but becomes Infinity in JavaScript; unlike
    // JSON.stringify(Infinity), these original process bytes retain the overflow.
    const stdout = JSON.stringify(summary()).replace(`"${severity}":0`, `"${severity}":1e400`);
    processSeam({ status: 0, signal: null, stdout, stderr: '' });
    expectUnobserved(senseSecurityScan({ repoRoot, now }));
  });

  it.each([{}, [], { high: '0' }, { high: -1 }].map((counts) => ({ counts })))(
    'does not let invalid metadata $counts hide a valid high npm population',
    ({ counts }) => {
      processSeam(
        response(
          {
            metadata: { vulnerabilities: counts },
            vulnerabilities: { dependency: { severity: 'high' } },
          },
          1,
        ),
      );
      const reading = senseSecurityScan({ repoRoot, now });
      expect(reading.status).not.toBe('pass');
      expect(reading.findings?.length).toBeGreaterThan(0);
      if (reading.status === 'fail' || reading.status === 'review')
        expect(reading.metrics?.high).toBeGreaterThan(0);
    },
  );

  it.each(
    [null, 'high', {}, [], { severity: 'other' }, { severity: 1 }].map((malformed) => ({
      malformed,
    })),
  )('rejects malformed npm member $malformed without discarding it', ({ malformed }) => {
    processSeam(absent('pnpm'), response({ vulnerabilities: { malformed } }));
    expectUnobserved(senseSecurityScan({ repoRoot, now }));
  });

  it.each([null, 'high', { severity: 'other' }])(
    'refuses mixed npm evidence with malformed member %j',
    (malformed) => {
      processSeam(
        absent('pnpm'),
        response({ vulnerabilities: { valid: { severity: 'high' }, malformed } }, 1),
      );
      expectUnobserved(senseSecurityScan({ repoRoot, now }));
    },
  );

  it('accepts the explicitly synthetic complete npm v2 alternate shape with process provenance', () => {
    // Constructed npm-audit-v2 compatibility fixture, not a captured live npm run.
    // Five supported severities; ENOENT on pnpm; completed npm audit exit 1.
    const vulnerabilities = Object.fromEntries(
      severities.map((severity) => [severity, { severity }]),
    );
    processSeam(absent('pnpm'), response({ auditReportVersion: 2, vulnerabilities }, 1));
    const reading = senseSecurityScan({ repoRoot, now });
    expect(reading).toMatchObject({
      status: 'fail',
      command: 'npm audit --json',
      timestamp: now,
      metrics: {
        tool: 'npm',
        critical: 1,
        high: 1,
        moderate: 1,
        low: 1,
        info: 1,
        total_vulnerabilities: 5,
      },
    });
    expect(mocks.spawnSync.mock.calls.map(([tool]) => tool)).toEqual(['pnpm', 'npm']);
    expect(reading.exit_code).toBe(1);
  });

  it('accepts an empty valid npm v2 map and retains the failed preferred-tool reason', () => {
    // Synthetic clean npm v2 control; explicit empty map differs from absent evidence.
    processSeam(absent('pnpm'), response({ auditReportVersion: 2, vulnerabilities: {} }));
    const reading = senseSecurityScan({ repoRoot, now });
    expect(reading).toMatchObject({
      status: 'pass',
      command: 'npm audit --json',
      timestamp: now,
      metrics: { tool: 'npm', total_vulnerabilities: 0 },
    });
    expect(mocks.spawnSync.mock.calls.map(([tool]) => tool)).toEqual(['pnpm', 'npm']);
    expect(JSON.stringify(reading.findings)).toContain('pnpm-missing-fixture');
  });

  it.each([
    [
      'exit 2',
      {
        status: 2,
        signal: null,
        stdout: JSON.stringify(summary()),
        stderr: 'audit-process-failed',
      },
    ],
    [
      'no completed status',
      { status: null, signal: null, stdout: JSON.stringify(summary()), stderr: 'audit-incomplete' },
    ],
    [
      'signal',
      {
        status: null,
        signal: 'SIGTERM',
        stdout: JSON.stringify(summary()),
        stderr: 'audit-signalled',
      },
    ],
    [
      'signal with status',
      {
        status: 0,
        signal: 'SIGTERM',
        stdout: JSON.stringify(summary()),
        stderr: 'audit-signalled',
      },
    ],
    [
      'timeout with partial JSON',
      {
        status: null,
        signal: 'SIGTERM',
        stdout: JSON.stringify(summary()),
        stderr: '',
        error: Object.assign(new Error('audit-timeout-fixture'), { code: 'ETIMEDOUT' }),
      },
    ],
    [
      'permission denied with partial JSON',
      {
        status: null,
        signal: null,
        stdout: JSON.stringify(summary()),
        stderr: '',
        error: Object.assign(new Error('audit-permission-fixture'), { code: 'EACCES' }),
      },
    ],
    [
      'exit 1 with zero findings',
      { status: 1, signal: null, stdout: JSON.stringify(summary()), stderr: 'audit-incoherent' },
    ],
    ['empty output', { status: 0, signal: null, stdout: '', stderr: 'audit-empty' }],
    ['whitespace output', { status: 0, signal: null, stdout: ' \n', stderr: 'audit-empty' }],
    ['invalid JSON', { status: 0, signal: null, stdout: '{', stderr: 'audit-invalid' }],
  ] as const)('refuses %s even when process stdout resembles clean evidence', (_label, result) => {
    processSeam(result);
    expectUnobserved(senseSecurityScan({ repoRoot, now }));
    expect(mocks.spawnSync.mock.calls.map(([tool]) => tool)).toEqual(['pnpm', 'npm']);
  });

  it('returns UNKNOWN with an attributable reason when both tools are missing', () => {
    processSeam(absent('pnpm'), absent('npm'));
    const reading = senseSecurityScan({ repoRoot, now });
    expectUnobserved(reading);
    expect(reading.metrics?.tools_tried).toBe(2);
    expect(reading.findings?.[0]?.message).toContain('npm-not-on-path');
  });

  it('retains the preferred timeout reason when the alternate tool is also absent', () => {
    processSeam({
      status: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('audit-timeout-fixture'), { code: 'ETIMEDOUT' }),
    });
    const reading = senseSecurityScan({ repoRoot, now });
    expectUnobserved(reading);
    expect(JSON.stringify(reading.findings)).toContain('audit-timeout-fixture');
    expect(mocks.spawnSync.mock.calls.map(([tool]) => tool)).toEqual(['pnpm', 'npm']);
  });
});
