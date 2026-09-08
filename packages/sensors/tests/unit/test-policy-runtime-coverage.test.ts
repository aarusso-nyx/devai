import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SensorReading } from '../../src/sensor-reading.js';
import { senseSpecSecurityCoverage } from '../../src/spec-security-coverage.js';
import { senseTestIdiomaticity } from '../../src/test-idiomaticity.js';

const NOW = '2026-09-08T12:00:00.000Z';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** Write `rel` under `root`; refuses any path that escapes the fixture root. */
function write(root: string, rel: string, contents: string): string {
  const path = resolve(root, rel);
  if (path !== root && !path.startsWith(root + sep)) {
    throw new Error(`fixture write outside root: ${rel}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

function writeJson(root: string, rel: string, value: unknown): string {
  return write(root, rel, `${JSON.stringify(value, null, 2)}\n`);
}

function codes(reading: SensorReading): readonly string[] {
  return (reading.findings ?? []).map((finding) => finding.code);
}

/**
 * Builds the shared idiomaticity fixture: two packages under the default globs,
 * one collected file outside them, and the excluded directory names.
 */
function idiomaticityFixture(): string {
  const root = fixtureRoot('devai-test-idiomaticity-');
  write(
    root,
    'packages/alpha/test/plain.test.ts',
    [
      'beforeEach(() => seed());',
      'afterEach(() => reset());',
      'const stub = vi.fn();',
      "it('renders', () => expect(render()).toMatchSnapshot());",
    ].join('\n'),
  );
  write(
    root,
    'packages/alpha/test/heavy.test.ts',
    ['beforeAll(() => boot());', "vi.mock('./dep');", 'stub.mockReturnValue(1);'].join('\n'),
  );
  // Not collected: the extension check is anchored at the end of the name.
  write(root, 'packages/alpha/test/notes.test.ts.md', '# not a test file\nvi.fn()\n');
  for (const excluded of ['node_modules', '.git', 'dist', 'build']) {
    write(root, `packages/alpha/test/${excluded}/ignored.test.ts`, 'vi.mock("x");\nvi.fn();\n');
  }
  write(
    root,
    'packages/alpha/src/unit.spec.tsx',
    "it('inlines', () => expect(1).toMatchInlineSnapshot('1'));\n",
  );
  write(
    root,
    'packages/beta/test/flow.integration.test.ts',
    ["vi.mock('./api');", 'client.mockImplementation(() => 1);'].join('\n'),
  );
  write(root, 'packages/beta/test/clean.e2e.test.ts', "it('drives the real stack', () => {});\n");
  // Collected, and only matches the integration pattern if the end anchor is dropped.
  write(root, 'packages/beta/test/weird.integration.test.js.test.ts', 'vi.fn();\n');
  write(root, 'tools/outside.test.ts', 'vi.mock("a");\nvi.mock("b");\n');
  return root;
}

describe('senseTestIdiomaticity mock accounting, globs and thresholds', () => {
  it('reviews mocked integration tests and reports the full metric block', () => {
    const root = idiomaticityFixture();

    const reading = senseTestIdiomaticity({ repoRoot: root, now: NOW });

    expect(reading.schemaVersion).toBe('1.0.0');
    expect(reading.sensor).toEqual({ name: 'test-idiomaticity', kind: 'test_idiomaticity' });
    expect(reading.command).toBe('devai sense-test-idiomaticity');
    expect(reading.tier).toBe('L0');
    expect(reading.deterministic).toBe(true);
    expect(reading.timestamp).toBe(NOW);
    expect(reading.status).toBe('review');
    expect(reading.findings).toEqual([
      {
        severity: 'warning',
        code: 'TEST_IDIOMATICITY_MOCK_IN_INTEGRATION',
        message: 'Integration/e2e file uses mocks: packages/beta/test/flow.integration.test.ts',
        file: 'packages/beta/test/flow.integration.test.ts',
      },
    ]);
    expect(reading.metrics).toEqual({
      test_files: 6,
      mock_calls: 6,
      fixture_calls: 3,
      snapshot_calls: 2,
      mock_heavy_files: 2,
      mock_heavy_ratio: 0.333,
      mocks_in_integration_files: 1,
    });
  });

  it('reviews an empty repository with a no-tests finding', () => {
    const root = fixtureRoot('devai-test-idiomaticity-empty-');

    const reading = senseTestIdiomaticity({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('review');
    expect(reading.findings).toEqual([
      { severity: 'info', code: 'TEST_IDIOMATICITY_NO_TESTS', message: 'No test files found.' },
    ]);
    expect(reading.metrics).toEqual({
      test_files: 0,
      mock_calls: 0,
      fixture_calls: 0,
      snapshot_calls: 0,
      mock_heavy_files: 0,
      mock_heavy_ratio: 0,
      mocks_in_integration_files: 0,
    });
  });

  it('fails when the mock-heavy ratio reaches the fail threshold exactly', () => {
    const root = idiomaticityFixture();

    const reading = senseTestIdiomaticity({
      repoRoot: root,
      testGlobs: ['packages/alpha/test'],
      thresholds: { review: 0.25, fail: 0.5 },
      now: NOW,
    });

    expect(reading.status).toBe('fail');
    expect(reading.findings).toEqual([
      {
        severity: 'error',
        code: 'TEST_IDIOMATICITY_MOCK_DOMINANT',
        message: '50.0% of test files are mock-heavy (≥ 50%).',
      },
    ]);
    expect(reading.metrics?.mock_heavy_ratio).toBe(0.5);
  });

  it('reviews when the ratio reaches the review threshold exactly', () => {
    const root = idiomaticityFixture();

    const reading = senseTestIdiomaticity({
      repoRoot: root,
      testGlobs: ['packages/alpha/test'],
      now: NOW,
    });

    expect(reading.status).toBe('review');
    expect(reading.findings).toEqual([
      {
        severity: 'warning',
        code: 'TEST_IDIOMATICITY_MOCK_HEAVY',
        message: '50.0% of test files are mock-heavy.',
      },
    ]);
    expect(reading.metrics).toEqual({
      test_files: 2,
      mock_calls: 3,
      fixture_calls: 3,
      snapshot_calls: 1,
      mock_heavy_files: 1,
      mock_heavy_ratio: 0.5,
      mocks_in_integration_files: 0,
    });
  });

  it('passes for a single non-mock-heavy file addressed directly by glob', () => {
    const root = idiomaticityFixture();

    const reading = senseTestIdiomaticity({
      repoRoot: root,
      testGlobs: ['packages/alpha/test/plain.test.ts'],
      now: NOW,
    });

    expect(reading.status).toBe('pass');
    expect(reading.findings).toEqual([]);
    expect(reading.metrics).toEqual({
      test_files: 1,
      mock_calls: 1,
      fixture_calls: 2,
      snapshot_calls: 1,
      mock_heavy_files: 0,
      mock_heavy_ratio: 0,
      mocks_in_integration_files: 0,
    });
  });

  it('expands a leading wildcard across the whole repository root', () => {
    const root = idiomaticityFixture();

    const reading = senseTestIdiomaticity({ repoRoot: root, testGlobs: ['*'], now: NOW });

    expect(reading.metrics?.test_files).toBe(7);
    expect(reading.metrics?.mock_calls).toBe(8);
  });

  it('normalises a trailing /** to a single wildcard segment', () => {
    const root = idiomaticityFixture();

    const reading = senseTestIdiomaticity({ repoRoot: root, testGlobs: ['packages/**'], now: NOW });

    expect(reading.metrics?.test_files).toBe(6);
    expect(reading.metrics?.mocks_in_integration_files).toBe(1);
  });

  it('treats an interior ** as one wildcard segment and keeps the trailing literal', () => {
    const root = idiomaticityFixture();

    const reading = senseTestIdiomaticity({
      repoRoot: root,
      testGlobs: ['packages/**/test'],
      now: NOW,
    });

    expect(reading.status).toBe('review');
    expect(codes(reading)).toEqual(['TEST_IDIOMATICITY_MOCK_IN_INTEGRATION']);
    expect(reading.metrics?.test_files).toBe(5);
  });

  it('timestamps with the current instant when no clock is supplied', () => {
    const root = fixtureRoot('devai-test-idiomaticity-clock-');

    const reading = senseTestIdiomaticity({ repoRoot: root });

    expect(reading.timestamp).not.toBe(NOW);
    expect(reading.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe('senseSpecSecurityCoverage presence checks', () => {
  it('passes when the threat model, PII registry row and RBAC invariant all exist', () => {
    const root = fixtureRoot('devai-spec-security-');
    write(root, 'docs/meta/security/threat-model.md', '# Threat model\n');
    write(root, 'migrations/sub/001_pii.sql', "INSERT INTO core.pii_map (col) VALUES ('email');\n");
    write(root, 'migrations/node_modules/ignored.sql', 'SELECT 1;\n');
    writeJson(root, 'law/invariants/INV-RBAC.json', { id: 'INV-RBAC', domain: 'RBAC' });
    writeJson(root, 'law/invariants/INV-DATA.json', { id: 'INV-DATA', domain: 'DATA' });
    write(root, 'law/invariants/broken.json', '{ not json\n');
    write(root, 'law/invariants/notes.txt', 'domain RBAC in prose only\n');

    const reading = senseSpecSecurityCoverage({ repoRoot: root, now: NOW });

    expect(reading.schemaVersion).toBe('1.0.0');
    expect(reading.sensor).toEqual({
      name: 'spec-security-coverage',
      kind: 'spec_security_coverage',
    });
    expect(reading.command).toBe('devai sense-spec-security-coverage');
    expect(reading.tier).toBe('L0');
    expect(reading.deterministic).toBe(true);
    expect(reading.timestamp).toBe(NOW);
    expect(reading.status).toBe('pass');
    expect(reading.findings).toEqual([]);
    expect(reading.metrics).toEqual({
      threat_model_present: 1,
      pii_registry_present: 1,
      rbac_invariant_present: 1,
      signals_present: 3,
    });
  });

  it('fails with one warning per missing signal, ignoring near-miss files', () => {
    const root = fixtureRoot('devai-spec-security-absent-');
    // Neither decoy is a threat model: the name is anchored at both ends.
    write(root, 'docs/meta/security/xthreat-model.md', '# not it\n');
    write(root, 'docs/meta/security/threat-model.md.bak', '# not it either\n');
    write(root, 'migrations/002_other.sql', 'INSERT INTO core.other (a) VALUES (1);\n');
    // Only `.sql` files are scanned, and excluded directories stay excluded.
    write(root, 'migrations/notes.txt', "INSERT INTO core.pii_map (col) VALUES ('ssn');\n");
    for (const excluded of ['node_modules', 'dist', '.git']) {
      write(root, `migrations/${excluded}/003_pii.sql`, 'INSERT INTO core.pii_map (col) VALUES;\n');
    }
    writeJson(root, 'law/invariants/lower.json', { id: 'INV-L', domain: 'rbac' });
    write(root, 'law/invariants/invalid.json', '{\n');
    write(root, 'law/invariants/rbac.json.txt', '{ "domain": "RBAC" }\n');

    const reading = senseSpecSecurityCoverage({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('fail');
    expect(reading.findings).toEqual([
      {
        severity: 'warning',
        code: 'SPEC_SECURITY_NO_THREAT_MODEL',
        message: 'No threat-model document found under: docs/meta/security',
      },
      {
        severity: 'warning',
        code: 'SPEC_SECURITY_NO_PII_REGISTRY',
        message:
          'No `INSERT INTO core.pii_map` row found across migration dirs: migrations, apps/api/migrations, reference/api/migrations',
      },
      {
        severity: 'warning',
        code: 'SPEC_SECURITY_NO_RBAC_INVARIANT',
        message: 'No invariant with domain="RBAC" found.',
      },
    ]);
    expect(reading.metrics).toEqual({
      threat_model_present: 0,
      pii_registry_present: 0,
      rbac_invariant_present: 0,
      signals_present: 0,
    });
  });

  it('reviews a partial signal set through custom dirs, globs and table name', () => {
    const root = fixtureRoot('devai-spec-security-custom-');
    write(root, 'docs/sec/threatmodel.md', '# Threat model\n');
    write(root, 'db/2026/x.SQL', "insert into APP.PII_COLUMNS (col) values ('email');\n");
    writeJson(root, 'custom/inv/INV-DATA.json', { id: 'INV-DATA', domain: 'DATA' });

    const reading = senseSpecSecurityCoverage({
      repoRoot: root,
      invariantsDir: 'custom/inv',
      threatModelGlobs: ['docs/missing', 'docs/sec/threatmodel.md', 'docs/sec'],
      piiMigrationsGlobs: ['db/**/*.sql'],
      piiRegistryTable: 'app.pii_columns',
      now: NOW,
    });

    expect(reading.status).toBe('review');
    expect(reading.findings).toEqual([
      {
        severity: 'warning',
        code: 'SPEC_SECURITY_NO_RBAC_INVARIANT',
        message: 'No invariant with domain="RBAC" found.',
      },
    ]);
    expect(reading.metrics).toEqual({
      threat_model_present: 1,
      pii_registry_present: 1,
      rbac_invariant_present: 0,
      signals_present: 2,
    });
  });

  it('does not look for PII migrations outside the configured migration dirs', () => {
    const root = fixtureRoot('devai-spec-security-decoy-');
    write(root, 'docs/samples/decoy.sql', "INSERT INTO core.pii_map (col) VALUES ('email');\n");
    writeJson(root, 'law/invariants/INV-RBAC.json', { id: 'INV-RBAC', domain: 'RBAC' });

    const reading = senseSpecSecurityCoverage({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('review');
    expect(codes(reading)).toEqual([
      'SPEC_SECURITY_NO_THREAT_MODEL',
      'SPEC_SECURITY_NO_PII_REGISTRY',
    ]);
    expect(reading.metrics).toEqual({
      threat_model_present: 0,
      pii_registry_present: 0,
      rbac_invariant_present: 1,
      signals_present: 1,
    });
  });

  it('timestamps with the current instant when no clock is supplied', () => {
    const root = fixtureRoot('devai-spec-security-clock-');

    const reading = senseSpecSecurityCoverage({ repoRoot: root });

    expect(reading.timestamp).not.toBe(NOW);
    expect(reading.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
