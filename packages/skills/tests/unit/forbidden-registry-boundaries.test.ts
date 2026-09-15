import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  CANONICAL_FORBIDDEN_ACTIONS,
  checkForbiddenRegistryCoverage,
  loadForbiddenWaivers,
} from '../../src/forbidden-actions/index.js';
let root = '';
let path = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-registry-boundaries-'));
  path = join(root, 'registry.json');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const valid = { id: 'FORBID-RM-RF', reason: '12345678' };

it.each([
  { label: 'null', value: null },
  { label: 'array', value: [] },
  { label: 'text', value: 'waiver' },
  { label: 'number', value: 1 },
  { label: 'boolean', value: true },
  ...['xFORBID-RM-RF', 'FORBID-RM-RF!', 'FORBID-rm', 'FORBID-1', '', 1].map((id) => ({
    label: `id ${id}`,
    value: { ...valid, id },
  })),
  ...['1234567', '😀'.repeat(7), '', null, 123].map((reason) => ({
    label: `reason ${JSON.stringify(reason)}`,
    value: { ...valid, reason },
  })),
  { label: 'unknown key', value: { ...valid, granted: true } },
])('isolates invalid waiver $label without discarding an adjacent valid waiver', ({ value }) => {
  for (const waivers of [
    [value, valid],
    [valid, value],
  ]) {
    const bytes = JSON.stringify({ actions: [], waivers });
    writeFileSync(path, bytes);
    expect(loadForbiddenWaivers(path)).toEqual([valid]);
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  }
});

it('accepts eight Unicode code points and all declared identifier characters', () => {
  const waiver = { id: 'FORBID-A0_B-C', reason: '😀'.repeat(8) };
  writeFileSync(path, JSON.stringify({ waivers: [waiver] }));
  expect(loadForbiddenWaivers(path)).toEqual([waiver]);
});

it.each([
  { label: 'absent', value: undefined },
  { label: 'empty', value: [] },
  { label: 'scalar', value: 'git' },
  { label: 'non-string member', value: ['git', 42] },
  { label: 'invalid regex member', value: ['git', '['] },
])('does not count a canonical action with $label detection patterns', ({ value }) => {
  const actions = CANONICAL_FORBIDDEN_ACTIONS.map((entry) =>
    entry.id === valid.id ? { ...entry, detect_patterns: value } : entry,
  );
  writeFileSync(path, JSON.stringify({ actions }));
  const result = checkForbiddenRegistryCoverage(path);
  expect(result.ok).toBe(false);
  expect(result.unwaived_missing).toEqual([valid.id]);
  expect(result.present).not.toContain(valid.id);
});

it.each([
  { label: 'empty', value: [] },
  { label: 'scalar', value: 'git' },
  { label: 'non-string member', value: ['git', 42] },
  { label: 'invalid regex member', value: ['git', '['] },
])('does not count an action with $label allowed-line patterns', ({ value }) => {
  const actions = CANONICAL_FORBIDDEN_ACTIONS.map((entry) =>
    entry.id === valid.id ? { ...entry, allowed_change_line_patterns: value } : entry,
  );
  writeFileSync(path, JSON.stringify({ actions }));
  expect(checkForbiddenRegistryCoverage(path)).toMatchObject({
    ok: false,
    unwaived_missing: [valid.id],
  });
});

it('counts actions with valid detection patterns and absent or valid optional patterns', () => {
  for (const allowed_change_line_patterns of [undefined, ['^safe$', 'devai_task_']]) {
    const actions = CANONICAL_FORBIDDEN_ACTIONS.map((entry) =>
      entry.id === valid.id ? { ...entry, allowed_change_line_patterns } : entry,
    );
    writeFileSync(path, JSON.stringify({ actions }));
    expect(checkForbiddenRegistryCoverage(path)).toMatchObject({
      ok: true,
      unwaived_missing: [],
      present: CANONICAL_FORBIDDEN_ACTIONS.map((entry) => entry.id),
    });
  }
});
