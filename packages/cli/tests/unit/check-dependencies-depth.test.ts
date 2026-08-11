// Invariants: INV-DEVAI-001, INV-DEVAI-017, INV-DEVAI-018
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawnSync: mocks.spawnSync,
}));

import { checkDependencies } from '../../src/commands/check/dependencies.js';

const NOW = '2026-07-27T12:00:00.000Z';
let root = '';

function write(path: string, value: string): void {
  const target = join(root, path);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, value);
}

function processResult(status: number, stdout = '', stderr = '') {
  return { status, signal: null, stdout, stderr, error: undefined };
}

function prepare(): void {
  write('package.json', JSON.stringify({ packageManager: 'pnpm@10.0.0' }));
  write('pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
  write('docs/site/package-lock.json', '{"lockfileVersion":3}\n');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-dependencies-depth-'));
  mocks.spawnSync.mockReset();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('dependency scanner adapter depth', () => {
  it('fails closed for missing, non-object, and incorrectly pinned project manifests', () => {
    expect(checkDependencies({ repoRoot: root, now: NOW, environment: {} }).status).toBe('unknown');
    write('package.json', '[]\n');
    expect(checkDependencies({ repoRoot: root, now: NOW, environment: {} }).status).toBe('unknown');
    write('package.json', '{\n');
    expect(checkDependencies({ repoRoot: root, now: NOW, environment: {} }).status).toBe('unknown');
    write('package.json', JSON.stringify({ packageManager: 'pnpm@latest' }));
    expect(checkDependencies({ repoRoot: root, now: NOW, environment: {} }).status).toBe('unknown');
  });

  it('fails malformed waiver documents before either dependency universe can pass', () => {
    prepare();
    for (const value of ['{', '{}', '{"waivers":{}}']) {
      write('.devai/config/dependency-waivers.json', value);
      const result = checkDependencies({ repoRoot: root, now: NOW, environment: {} });
      expect(result.status).toBe('fail');
      expect(
        'universes' in result && result.universes.every((item) => item.status === 'fail'),
      ).toBe(true);
    }
  });

  it('normalizes classic pnpm and modern npm advisories with stable ids, aliases, and fixes', () => {
    prepare();
    const classic = {
      advisories: {
        one: {
          id: 1,
          module_name: 'classic-package',
          severity: 'low',
          vulnerable_versions: '<1.0.0',
          patched_versions: '>=1.0.0',
          cves: ['CVE-1', ''],
          aliases: ['ALIAS-1'],
          cwe: ['CWE-1'],
          url: 'https://github.com/advisories/GHSA-abcd-1234-efgh',
        },
      },
      metadata: { vulnerabilities: { info: 0, low: 1, moderate: 0, high: 0, critical: 0 } },
    };
    const modern = {
      vulnerabilities: {
        modern: {
          name: 'modern-package',
          severity: 'moderate',
          range: '<2',
          fixAvailable: { version: '2.0.0' },
          via: [
            {
              source: 'ADV-2',
              dependency: 'modern-package',
              severity: 'moderate',
              range: '<2',
              aliases: ['CVE-2'],
            },
          ],
        },
      },
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0 } },
    };
    mocks.spawnSync.mockImplementation((executable?: string, args?: readonly string[]) => {
      if (args?.[0] === '--version') {
        return processResult(0, executable === 'pnpm' ? '10.0.0\n' : '11.14.1\n');
      }
      return processResult(1, JSON.stringify(executable === 'pnpm' ? classic : modern));
    });
    const result = checkDependencies({ repoRoot: root, now: NOW, environment: {} });
    expect(result).toMatchObject({
      status: 'review',
      counts: { low: 1, moderate: 1 },
      universes: [{ ecosystem: 'pnpm' }, { ecosystem: 'npm' }],
    });
    expect(result.advisories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'GHSA-ABCD-1234-EFGH', fixed_versions: ['>=1.0.0'] }),
        expect.objectContaining({ id: 'ADV-2', fixed_versions: ['2.0.0'] }),
      ]),
    );
  });

  it('keeps version, execution, malformed-output, and thrown scanner failures UNKNOWN', () => {
    prepare();
    const scenarios = [
      () => mocks.spawnSync.mockReturnValue(processResult(0, 'wrong\n')),
      () =>
        mocks.spawnSync.mockImplementation((_executable?: string, args?: readonly string[]) =>
          args?.[0] === '--version' ? processResult(0, '10.0.0\n') : processResult(2),
        ),
      () =>
        mocks.spawnSync.mockImplementation((executable?: string, args?: readonly string[]) =>
          args?.[0] === '--version'
            ? processResult(0, executable === 'pnpm' ? '10.0.0\n' : '11.14.1\n')
            : processResult(0, '{'),
        ),
      () =>
        mocks.spawnSync.mockImplementation(() => {
          throw new Error('not installed');
        }),
    ];
    for (const configure of scenarios) {
      mocks.spawnSync.mockReset();
      configure();
      expect(checkDependencies({ repoRoot: root, now: NOW, environment: {} }).status).toBe(
        'unknown',
      );
    }
  });

  it('handles malformed and conflicting scanner shapes without laundering them', () => {
    prepare();
    const malformed = [
      null,
      { advisories: { x: null }, metadata: { vulnerabilities: {} } },
      { vulnerabilities: { x: { via: 'bad' } }, metadata: { vulnerabilities: {} } },
      { vulnerabilities: { x: { via: ['missing-reference'] } }, metadata: { vulnerabilities: {} } },
      { vulnerabilities: { x: { via: [42] } }, metadata: { vulnerabilities: {} } },
      {
        vulnerabilities: {
          x: { name: 'x', severity: 'low', range: '<1', via: [{ source: 'A' }] },
        },
        metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } },
      },
    ];
    for (const raw of malformed) {
      mocks.spawnSync.mockImplementation((executable?: string, args?: readonly string[]) =>
        args?.[0] === '--version'
          ? processResult(0, executable === 'pnpm' ? '10.0.0\n' : '11.14.1\n')
          : processResult(0, JSON.stringify(raw)),
      );
      expect(checkDependencies({ repoRoot: root, now: NOW, environment: {} }).status).not.toBe(
        'pass',
      );
      mocks.spawnSync.mockReset();
    }
  });

  it('covers aggregate FAIL precedence and missing fixture universes under test mode', () => {
    prepare();
    const fixture = join(root, 'fixture.json');
    writeFileSync(fixture, '{');
    const malformed = checkDependencies({
      repoRoot: root,
      now: NOW,
      environment: {
        NODE_ENV: 'test',
        DEVAI_TEST_PNPM_DEPENDENCY_SCAN_FIXTURE: fixture,
      },
    });
    expect(malformed.status).toBe('unknown');

    const legacy = checkDependencies({
      repoRoot: root,
      now: NOW,
      environment: { VITEST: 'true', DEVAI_TEST_DEPENDENCY_SCAN_FIXTURE: fixture },
    });
    expect(legacy.status).toBe('unknown');
  });
});
