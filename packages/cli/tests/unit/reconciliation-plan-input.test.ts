import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseReconciliationHostInput } from '../../src/authority/reconciliation-host-input.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-plan-input-')));
const action = 'evidence reconcile plan';
const parent = 'a'.repeat(40);
const flags = [
  '--repo-root',
  root,
  '--selected-parent',
  parent,
  '--published-ref',
  'refs/heads/main',
  '--as-role',
  'architect',
  '--format',
  'json',
];
const argv = (options = flags) => [
  process.execPath,
  'devai',
  'evidence',
  'reconcile',
  'plan',
  ...options,
];
afterAll(() => rmSync(root, { recursive: true }));

describe('read-only reconciliation planning input', () => {
  it.each(['feature/topic', 'release/v2.8.0', 'a@b', 'a.locked', 'a./b', '@', 'ação'])(
    'admits supported Git branch %s',
    (branch) => {
      expect(
        parseReconciliationHostInput(
          action,
          argv(
            flags.map((value) => (value === 'refs/heads/main' ? `refs/heads/${branch}` : value)),
          ),
          root,
          'architect',
        ),
      ).toMatchObject({ published_ref: `refs/heads/${branch}`, operation: 'plan', write: false });
    },
  );
  it.each([40, 64])('admits exact %i-hex selectors without authority', (length) => {
    const parsed = parseReconciliationHostInput(
      action,
      argv(flags.map((v) => (v === parent ? 'a'.repeat(length) : v))),
      root,
      'architect',
    );
    expect(parsed).toMatchObject({
      action_id: action,
      initiator: 'architect',
      operation: 'plan',
      phases: [],
      write: false,
      require_tty: false,
    });
    expect(parsed).not.toHaveProperty('approval_id');
    expect(parsed).not.toHaveProperty('plan_sha256');
    expect(Object.isFrozen(parsed)).toBe(true);
  });
  it.each([
    ['--write'],
    ['--approval', 'b'.repeat(64)],
    ['--plan', 'plan.json'],
    ['--plan-sha256', 'b'.repeat(64)],
    ['--renew'],
    ['--reconciliation-host'],
    ['--selected-parent', parent],
    ['--published-ref', 'refs/heads/other'],
  ])('refuses mutation or duplicate selectors %j', (...extra) => {
    expect(() =>
      parseReconciliationHostInput(action, argv([...flags, ...extra]), root, 'architect'),
    ).toThrow('AUTHORITY_RECONCILIATION_INVOCATION_INVALID');
  });
  it.each([
    'main',
    'refs/tags/v1',
    'refs/heads/../main',
    'refs/heads/a..b',
    'refs/heads/a.lock',
    'refs/heads/a.lock/b',
    'refs/heads/a/.hidden',
    'refs/heads/a*',
    'refs/heads/a@{1}',
    'refs/heads/.hidden',
    'refs/heads/a//b',
    'refs/heads/-main',
    'refs/heads/a.',
    'refs/heads/a\\b',
    'refs/heads/a:b',
    'refs/heads/a b',
    'refs/heads/a\nb',
  ])('refuses unsafe or unsupported ref %s', (ref) => {
    expect(() =>
      parseReconciliationHostInput(
        action,
        argv(flags.map((v) => (v === 'refs/heads/main' ? ref : v))),
        root,
        'architect',
      ),
    ).toThrow('AUTHORITY_RECONCILIATION_INVOCATION_INVALID');
  });
  it.each(['HEAD', 'a'.repeat(39), 'A'.repeat(40), '--all', 'a'.repeat(41), 'a'.repeat(65)])(
    'refuses nonliteral parent %s',
    (oid) => {
      expect(() =>
        parseReconciliationHostInput(
          action,
          argv(flags.map((v) => (v === parent ? oid : v))),
          root,
          'architect',
        ),
      ).toThrow('AUTHORITY_RECONCILIATION_INVOCATION_INVALID');
    },
  );
  it('binds both selectors into the original argv digest', () => {
    const original = parseReconciliationHostInput(action, argv(), root, 'architect');
    const changed = parseReconciliationHostInput(
      action,
      argv(flags.map((v) => (v === parent ? 'b'.repeat(40) : v))),
      root,
      'architect',
    );
    expect(original?.original_argv_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(changed?.original_argv_sha256).not.toBe(original?.original_argv_sha256);
    expect(
      parseReconciliationHostInput(
        action,
        argv(flags.map((v) => (v === 'refs/heads/main' ? 'refs/heads/next' : v))),
        root,
        'architect',
      )?.original_argv_sha256,
    ).not.toBe(original?.original_argv_sha256);
  });
  it('refuses a different initiation role', () => {
    expect(() => parseReconciliationHostInput(action, argv(), root, 'owner')).toThrow(
      'AUTHORITY_RECONCILIATION_INVOCATION_INVALID',
    );
  });
});
