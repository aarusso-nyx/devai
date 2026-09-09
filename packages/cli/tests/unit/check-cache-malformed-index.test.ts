import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CheckCache } from '../../src/services/check-runner/cache.js';
import type { PlannedTask } from '../../src/services/check-runner/types.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const task: PlannedTask = {
  nodeId: 'test:unit',
  taskKey: 'a'.repeat(64),
  dependencies: [],
  outputContract: {},
  argv: [],
  executable: { path: '/unused', sha256: 'b'.repeat(64) },
  cwd: '.',
  inputDigest: 'c'.repeat(64),
  inputPaths: [],
  matchedChangedPaths: [],
  cacheState: 'execute',
  reason: 'fixture',
};
function inspect(index: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'devai-cache-index-'));
  roots.push(root);
  const cacheRoot = join(root, 'cache');
  mkdirSync(join(cacheRoot, 'nodes'), { recursive: true });
  writeFileSync(
    join(cacheRoot, 'nodes', `${Buffer.from(task.nodeId).toString('base64url')}.json`),
    JSON.stringify(index),
  );
  return new CheckCache(root, cacheRoot).inspect(task, {});
}
const valid = {
  schemaVersion: '1.0.0',
  nodeId: task.nodeId,
  taskKey: task.taskKey,
  updatedAt: '2026-09-09T00:00:00.000Z',
};
describe('cache index structural corruption', () => {
  it.each(
    [
      null,
      [],
      true,
      42,
      'index',
      { ...valid },
      { ...valid, outcome: null },
      { ...valid, outcome: 5 },
      { ...valid, outcome: 'UNKNOWN' },
    ].map((index) => ({ index })),
  )('classifies malformed index $index as stale', ({ index }) => {
    expect(inspect(index)).toEqual({ cacheState: 'stale', reason: 'cache-index-malformed' });
  });
  it.each(['FAIL', 'TIMEOUT', 'KILLED', 'ABORTED'] as const)(
    'executes after previous %s',
    (outcome) => {
      expect(inspect({ ...valid, outcome })).toEqual({
        cacheState: 'execute',
        reason: `previous-${outcome.toLowerCase()}`,
      });
    },
  );
});
