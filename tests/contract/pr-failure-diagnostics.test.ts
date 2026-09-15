import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { prFailureDiagnostics } = await import(
  pathToFileURL(join(process.cwd(), 'scripts/pr-failure-diagnostics.mjs')).href
);
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-pr-diagnostics-')));
  roots.push(root);
  const dir = join(root, '.devai/state/check-cache/v1/diagnostics');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'task.json');
  const task = {
    nodeId: 'test:cli',
    taskKey: 'a'.repeat(64),
    outcome: 'FAIL',
    reason: 'process-exit-1',
    diagnosticPath: path,
  };
  writeFileSync(
    path,
    JSON.stringify({ ...task, stdoutTail: 'test summary', stderrTail: 'assertion failed' }),
  );
  return { root, path, task };
}
it('shows bounded, identity-bound failure details while leaving passes quiet', () => {
  const { root, path, task } = fixture();
  expect(prFailureDiagnostics(root, [task, { ...task, outcome: 'PASS' }])).toEqual([
    {
      nodeId: task.nodeId,
      outcome: task.outcome,
      reason: task.reason,
      stdoutTail: 'test summary',
      stderrTail: 'assertion failed',
    },
  ]);
  writeFileSync(path, JSON.stringify({ ...task, stdoutTail: 'x'.repeat(10000) }));
  expect(prFailureDiagnostics(root, [task])[0].stdoutTail).toHaveLength(8192);
});
it('does not disclose foreign, symlinked or wrong-task diagnostic files', () => {
  const { root, path, task } = fixture();
  const outside = join(root, 'private.json');
  writeFileSync(outside, JSON.stringify({ ...task, stdoutTail: 'private' }));
  expect(prFailureDiagnostics(root, [{ ...task, diagnosticPath: outside }])[0].diagnostic).toBe(
    'unavailable',
  );
  writeFileSync(path, JSON.stringify({ ...task, taskKey: 'b'.repeat(64), stdoutTail: 'foreign' }));
  expect(prFailureDiagnostics(root, [task])[0].diagnostic).toBe('unavailable');
  rmSync(path);
  symlinkSync(outside, path);
  expect(prFailureDiagnostics(root, [task])[0].diagnostic).toBe('unavailable');
});
