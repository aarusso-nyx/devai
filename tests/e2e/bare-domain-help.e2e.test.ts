import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { subprocessCoverageEnvironment } from '../helpers/subprocess-coverage.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', '..', 'packages', 'cli', 'dist', 'runtime', 'index', 'bin.js');

const skipIfNotBuilt = existsSync(BIN) ? it : it.skip;

function run(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('node', [BIN, ...args], {
    encoding: 'utf8',
    env: subprocessCoverageEnvironment(),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Typing a bare valid domain — the most
// natural exploration gesture — must render that node's help, exactly as
// `--help` would, not fall through to the unknown-command suggester.
// Table-driven over the live registry so new domains inherit the contract.

interface CatalogAction {
  readonly path: readonly string[];
}

function catalogPaths(): string[][] {
  const r = run(['catalog', 'actions']);
  expect(r.status).toBe(0);
  return (JSON.parse(r.stdout) as CatalogAction[]).map((a) => [...a.path]);
}

describe('bare domain/group paths render help instead of the suggester', () => {
  skipIfNotBuilt(
    'every non-leaf domain renders its help and exits 0',
    () => {
      const paths = catalogPaths();
      const domains = [...new Set(paths.filter((p) => p.length > 1).map((p) => p[0]))] as string[];
      expect(domains.length).toBeGreaterThan(5);
      for (const domain of domains) {
        const r = run([domain]);
        const combined = r.stdout + r.stderr;
        expect(combined, `devai ${domain}`).not.toMatch(/unknown or incomplete command/i);
        expect(r.status, `devai ${domain} should exit 0 with help`).toBe(0);
        expect(r.stdout, `devai ${domain} should render help`).toMatch(
          new RegExp(`devai ${domain}`),
        );
      }
    },
    90_000,
  );

  skipIfNotBuilt(
    'every depth-2 group with children renders its help and exits 0',
    () => {
      const paths = catalogPaths();
      // Hybrid nodes (e.g. `docs synthesize`, both a leaf action and the
      // parent of `docs synthesize all`) dispatch as commands, and a leaf
      // invoked with missing required args exits 2 per D-129 — so only
      // pure groups (not themselves registered actions) must render help.
      const exactActions = new Set(paths.map((p) => p.join(' ')));
      const groups = new Map<string, number>();
      for (const p of paths) {
        if (p.length > 2) {
          const key = `${p[0]} ${p[1]}`;
          if (exactActions.has(key)) continue;
          groups.set(key, (groups.get(key) ?? 0) + 1);
        }
      }
      expect(groups.size).toBe(3);
      for (const key of groups.keys()) {
        const parts = key.split(' ');
        const r = run(parts);
        const combined = r.stdout + r.stderr;
        expect(combined, `devai ${key}`).not.toMatch(/unknown or incomplete command/i);
        expect(r.status, `devai ${key} should exit 0 with help`).toBe(0);
      }
    },
    90_000,
  );

  skipIfNotBuilt('a genuinely unknown command still fails closed with exit 2', () => {
    const r = run(['frobnicate']);
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).toMatch(/unknown or incomplete command/i);
  });

  skipIfNotBuilt('the suggester never proposes an unrelated leaf for a valid domain', () => {
    const r = run(['work']);
    expect(r.stdout + r.stderr).not.toMatch(/did you mean 'devai init'/);
  });
});

// Invariants: INV-DEVAI-001
