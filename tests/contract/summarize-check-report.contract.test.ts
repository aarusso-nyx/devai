// #248: a failed gate names the failing node and its diagnostic tail in the log.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const SCRIPT = join(ROOT, 'scripts/process/summarize-check-report.mjs');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function summarize(report: string): { status: number | null; stdout: string } {
  const root = mkdtempSync(join(tmpdir(), 'devai-check-summary-'));
  roots.push(root);
  const path = join(root, 'report.json');
  writeFileSync(path, report.replaceAll('<root>', root));
  writeFileSync(
    join(root, 'diag.log'),
    `${Array.from({ length: 60 }, (_, index) => `line ${String(index + 1)}`).join('\n')}\n`,
  );
  const result = spawnSync(process.execPath, [SCRIPT, path], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout };
}

describe('check report summary (#248)', () => {
  it('names each failing node with its reason and the tail of its diagnostic', () => {
    const report = {
      schemaVersion: '1.0.0',
      ok: false,
      result: {
        value: {
          exitCode: 1,
          execution: [
            { nodeId: 'schemas', outcome: 'PASS', disposition: 'executed', reason: 'ok' },
            {
              nodeId: 'test:cli',
              outcome: 'FAIL',
              disposition: 'executed',
              reason: 'exit 1',
              exitCode: 1,
              diagnosticPath: '<root>/diag.log',
            },
          ],
          blocked: [{ nodeId: 'e2e', reason: 'no database', remediation: ['start postgres'] }],
        },
      },
    };
    const { status, stdout } = summarize(`npm notice noise\n${JSON.stringify(report)}\n`);
    expect(status).toBe(0);
    expect(stdout).toContain('1 node(s) not passing, 1 blocked');
    expect(stdout).toContain('::group::test:cli — FAIL (executed, exit 1)');
    expect(stdout).not.toContain('::group::schemas');
    expect(stdout).toContain('  line 60');
    expect(stdout).toContain('  line 21');
    expect(stdout).not.toContain('  line 20\n');
    expect(stdout).toContain('blocked: e2e — no database');
  });

  it('never fails the step when the report is absent or unreadable', () => {
    expect(summarize('not json').stdout).toContain('no runner report');
  });
});
