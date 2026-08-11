import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import './effects-check-cases.js';
import { subprocessCoverageEnvironment } from '../helpers/subprocess-coverage.js';

// Invariants: INV-DEVAI-020

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const DRIVER = resolve(REPO_ROOT, 'packages/cli/tests/fixtures/authorized-cli-test-driver.mjs');

describe('binding action-effect CLI', () => {
  it('binds every canonical kept handler to the canonical effect registry', () => {
    const result = spawnSync(
      'node',
      [DRIVER, 'check', '--only', 'action-effects', '--repo-root', REPO_ROOT, '--format', 'json'],
      { cwd: REPO_ROOT, encoding: 'utf8', env: subprocessCoverageEnvironment() },
    );
    expect(result.status, result.stderr).toBe(0);
    const envelope = JSON.parse(result.stdout) as {
      action_id: string;
      ok: boolean;
      result: { media_type: string; value: unknown };
    };
    expect(envelope).toMatchObject({
      action_id: 'check',
      ok: true,
      result: { media_type: 'application/json' },
    });
    const output = envelope.result.value as {
      reading: { status: string };
      report: {
        findings: unknown[];
        metrics: {
          catalog_actions: number;
          extracted_actions: number;
          unresolved_edges: number;
        };
      };
    };
    expect(output.reading.status).toBe('pass');
    expect(output.report.findings).toEqual([]);
    expect(output.report.metrics).toMatchObject({
      catalog_actions: 41,
      extracted_actions: 41,
      unresolved_edges: 0,
    });
  }, 30_000);
});
