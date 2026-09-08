import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, aroundEach, expect, it } from 'vitest';
import { scanForbiddenActions } from '../../src/forbidden-actions/index.js';
import { withAuthorityHostTestScope } from './authority-host-test-scope.js';
const roots: string[] = [];
aroundEach((runTest) => withAuthorityHostTestScope(runTest));
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const patternMessage =
  'every forbidden action must have valid detection patterns and valid non-empty allowed change-line patterns when provided';
it.each([
  {
    label: 'missing registry',
    body: undefined,
    message: 'forbidden-action registry is missing',
    entries: 0,
  },
  {
    label: 'truncated JSON',
    body: '{"actions":',
    message: 'forbidden-action registry bytes are malformed',
    entries: 0,
  },
  {
    label: 'empty roster',
    body: '{"actions":[]}',
    message: 'forbidden-action registry has no actions',
    entries: 0,
  },
  {
    label: 'invalid pattern',
    body: JSON.stringify({ actions: [{ id: 'FORBID-TEST', detect_patterns: ['['] }] }),
    message: patternMessage,
    entries: 1,
  },
  ...[null, 'action', 42, true, []].map((entry) => ({
    label: `non-object entry ${JSON.stringify(entry)}`,
    body: JSON.stringify({ actions: [entry] }),
    message: 'forbidden-action registry bytes are malformed',
    entries: 0,
  })),
])(
  'reports $label precisely without fabricating a match or modifying registry bytes',
  ({ body, message, entries }) => {
    const root = mkdtempSync(join(tmpdir(), 'devai-forbidden-diagnostic-'));
    roots.push(root);
    const registryPath = join(root, 'registry.json');
    if (body !== undefined) writeFileSync(registryPath, body);
    let result: ReturnType<typeof scanForbiddenActions> | undefined;
    expect(() => {
      result = scanForbiddenActions({ repoRoot: root, registryPath });
    }).not.toThrow();
    expect(result).toEqual({
      registry_entries: entries,
      findings: [
        {
          forbidden_id: 'FORBIDDEN-REGISTRY-INVALID',
          source: 'commit-change',
          ref: registryPath,
          matched: '',
          message,
        },
      ],
    });
    if (body === undefined) expect(existsSync(registryPath)).toBe(false);
    else expect(readFileSync(registryPath, 'utf8')).toBe(body);
  },
);

it('distinguishes unavailable history from invalid policy and from a clean scan', () => {
  const root = mkdtempSync(join(tmpdir(), 'devai-forbidden-history-'));
  roots.push(root);
  const registryPath = join(root, 'registry.json');
  const body = JSON.stringify({
    actions: [{ id: 'FORBID-TEST', detect_patterns: ['forbidden command'] }],
  });
  writeFileSync(registryPath, body);
  expect(scanForbiddenActions({ repoRoot: root, registryPath })).toEqual({
    registry_entries: 1,
    findings: [
      {
        forbidden_id: 'FORBIDDEN-SCAN-UNAVAILABLE',
        source: 'commit-change',
        ref: 'git-log',
        matched: '',
        message: 'committed history could not be inspected',
      },
    ],
  });
  expect(readFileSync(registryPath, 'utf8')).toBe(body);
});
