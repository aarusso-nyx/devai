import { runWithAuthorityHostEffects, type AuthorityHostEffectRequest } from '@devai-nyx/authority';
import { beforeAll } from 'vitest';
import { createAuthorityHostBroker } from '../../src/authority/broker.js';
import { getFullRegistry, type RegistryEntry } from '../../src/define-command.js';
import { resolveCliVersion } from '../../src/version.js';
import { createSelfContainedRepositoryFixture } from '../helpers/self-contained-repository-fixture.js';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { canonicalJson } from '@devai-nyx/utils';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('actual reconciliation host bridge module', () => {
  it('has the exact required product module before behavioral qualification', () => {
    expect(
      existsSync(
        resolve(
          import.meta.dirname,
          '../../../..',
          'packages/cli/src/authority/reconciliation-host-input.ts',
        ),
      ),
      'required actual module absent',
    ).toBe(true);
  });
});

const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'devai-reconciliation-input-inspector-')));
const sha = 'a'.repeat(64);
const approval = 'b'.repeat(64);
type Role = 'architect' | 'owner' | 'inspector' | 'engineer' | 'auditor';
type Parsed = {
  action_id: string;
  operation: string;
  phases: readonly string[];
  write: boolean;
  require_tty: boolean;
  original_argv_sha256: string;
  approval_id?: string;
  plan_sha256?: string;
};
async function parser() {
  return (await import('../../src/authority/reconciliation-host-input.js')) as {
    parseReconciliationHostInput: (
      action: string,
      argv: readonly string[],
      root: string,
      role: Role,
    ) => Parsed | undefined;
  };
}
function argv(action: string, flags: readonly string[]) {
  return [process.execPath, 'devai', ...action.split(' '), ...flags];
}
const common = [
  '--repo-root',
  root,
  '--plan',
  'record/reconciliation/plan.json',
  '--plan-sha256',
  sha,
];
const base = (role: Role) => [...common, '--as-role', role, '--format', 'json'];
const cases = [
  {
    action: 'init bind',
    role: 'architect' as const,
    flags: [
      '--reconciliation-host',
      '--target',
      root,
      '--as-role',
      'architect',
      '--format',
      'json',
    ],
    operation: 'provision',
    phases: [],
  },
  {
    action: 'evidence reconcile approve',
    role: 'owner' as const,
    flags: base('owner'),
    operation: 'approve',
    phases: [],
  },
  {
    action: 'evidence reconcile approve',
    role: 'owner' as const,
    flags: [...base('owner'), '--renew', '--approval', approval, '--expected-grant-sha256', sha],
    operation: 'renew',
    phases: [],
  },
  {
    action: 'evidence reconcile approve',
    role: 'owner' as const,
    flags: [...base('owner'), '--revoke', '--approval', approval, '--expected-grant-sha256', sha],
    operation: 'revoke',
    phases: [],
  },
  {
    action: 'evidence reconcile approve',
    role: 'owner' as const,
    flags: [
      ...base('owner'),
      '--recover-owned-lease',
      '--approval',
      approval,
      '--expected-lease-sha256',
      sha,
    ],
    operation: 'recover-owned-lease',
    phases: [],
  },
  {
    action: 'evidence reconcile approve',
    role: 'owner' as const,
    flags: [
      ...base('owner'),
      '--recover-owned-lease',
      '--approval',
      approval,
      '--expected-lease-sha256',
      'ABSENT',
    ],
    operation: 'recover-owned-lease',
    phases: [],
  },
  {
    action: 'evidence reconcile materialize',
    role: 'inspector' as const,
    flags: [...base('inspector'), '--approval', approval],
    operation: 'consume-phase',
    phases: ['01', '02'],
  },
  {
    action: 'evidence reconcile stage-proof',
    role: 'inspector' as const,
    flags: [...base('inspector'), '--approval', approval],
    operation: 'consume-phase',
    phases: ['03'],
  },
  {
    action: 'sense bootstrap-inventory',
    role: 'architect' as const,
    flags: [...base('architect'), '--approval', approval],
    operation: 'consume-phase',
    phases: ['04'],
  },
];
describe('closed original-argv reconciliation input grammar', () => {
  for (const c of cases)
    for (const write of [false, true]) {
      it(`${c.action}/${c.operation}/${c.flags.at(-1)} ${write ? 'write' : 'preview'} exact grammar`, async () => {
        const input = argv(c.action, [...c.flags, ...(write ? ['--write'] : [])]);
        const before = [...input];
        const result = (await parser()).parseReconciliationHostInput(c.action, input, root, c.role);
        expect(result).toMatchObject({
          action_id: c.action,
          operation: c.operation,
          phases: c.phases,
          write,
          require_tty:
            write && (c.action === 'init bind' || c.action === 'evidence reconcile approve'),
          original_argv_sha256: createHash('sha256').update(canonicalJson(input)).digest('hex'),
        });
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result?.phases)).toBe(true);
        expect(input).toEqual(before);
        if (c.flags.includes('--approval')) expect(result?.approval_id).toBe(approval);
        else expect(result).not.toHaveProperty('approval_id');
        if (c.action !== 'init bind') expect(result?.plan_sha256).toBe(sha);
        for (const [flag, field] of [
          ['--expected-grant-sha256', 'expected_grant_sha256'],
          ['--expected-lease-sha256', 'expected_lease_sha256'],
        ] as const) {
          const index = c.flags.indexOf(flag);
          if (index >= 0) expect(result).toHaveProperty(field, c.flags[index + 1]);
          else expect(result).not.toHaveProperty(field);
        }
      });
    }
  for (const c of [cases[0], cases[1], cases[6], cases[7], cases[8]]) {
    if (!c) throw new Error('missing fixed case');
    const changes: [string, (input: string[]) => string[]][] = [
      ['duplicate write', (input) => [...input, '--write', '--write']],
      [
        'equals format',
        (input) => {
          const i = input.indexOf('--format');
          return [...input.slice(0, i), '--format=json', ...input.slice(i + 2)];
        },
      ],
      ['duplicate role', (input) => [...input, '--as-role', c.role]],
      ['unknown flag', (input) => [...input, '--unknown']],
      ['session', (input) => [...input, '--authority-session', 'session']],
      ['machine actor', (input) => [...input, '--machine-actor', 'binding']],
      ['publish', (input) => [...input, '--publish']],
      ['experimental', (input) => [...input, '--experimental']],
      ['wrong format', (input) => input.map((x) => (x === 'json' ? 'text' : x))],
      ['role mismatch', (input) => input.map((x) => (x === c.role ? 'auditor' : x))],
      ['wrong root', (input) => input.map((x) => (x === root ? '/tmp' : x))],
      [
        'missing role',
        (input) => {
          const i = input.indexOf('--as-role');
          return [...input.slice(0, i), ...input.slice(i + 2)];
        },
      ],
      [
        'wrong command prefix',
        (input) => {
          input[2] = 'wrong';
          return input;
        },
      ],
      ['extra positional', (input) => [...input, 'extra']],
    ];
    for (const [name, change] of changes)
      it(`${c.action} refuses ${name}`, async () => {
        const parse = (await parser()).parseReconciliationHostInput;
        expect(() => parse(c.action, change(argv(c.action, c.flags)), root, c.role)).toThrow(
          'AUTHORITY_RECONCILIATION_INVOCATION_INVALID',
        );
      });
  }
  it.each([
    '--reconciliation-host=true',
    '--reconciliationHost',
    '--Reconciliation-Host',
    '--no-reconciliation-host',
  ])('refuses malformed init selector %s', async (flag) => {
    const c = cases[0];
    if (!c) throw new Error('missing case');
    const parse = (await parser()).parseReconciliationHostInput;
    expect(() =>
      parse(
        c.action,
        argv(
          c.action,
          c.flags.map((x) => (x === '--reconciliation-host' ? flag : x)),
        ),
        root,
        c.role,
      ),
    ).toThrow('AUTHORITY_RECONCILIATION_INVOCATION_INVALID');
  });
  it.each([
    '../plan.json',
    '/tmp/plan.json',
    './plan.json',
    'a/../plan.json',
    'a//plan.json',
    'a\\plan.json',
    'a\nplan.json',
  ])('refuses plan path %s', async (path) => {
    const c = cases[1];
    if (!c) throw new Error('missing case');
    const parse = (await parser()).parseReconciliationHostInput;
    expect(() =>
      parse(
        c.action,
        argv(
          c.action,
          c.flags.map((x) => (x === 'record/reconciliation/plan.json' ? path : x)),
        ),
        root,
        c.role,
      ),
    ).toThrow('AUTHORITY_RECONCILIATION_INVOCATION_INVALID');
  });
  it.each(['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'a'.repeat(63) + '\n'])(
    'refuses noncanonical digest %s',
    async (digest) => {
      const c = cases[1];
      if (!c) throw new Error('missing case');
      const parse = (await parser()).parseReconciliationHostInput;
      expect(() =>
        parse(
          c.action,
          argv(
            c.action,
            c.flags.map((x) => (x === sha ? digest : x)),
          ),
          root,
          c.role,
        ),
      ).toThrow('AUTHORITY_RECONCILIATION_INVOCATION_INVALID');
    },
  );
  it('keeps ordinary bind and doctor outside bridge; recognized plan refuses missing selectors', async () => {
    const parse = (await parser()).parseReconciliationHostInput;
    expect(
      parse(
        'init bind',
        argv('init bind', [
          '--full',
          '--target',
          root,
          '--as-role',
          'architect',
          '--format',
          'json',
        ]),
        root,
        'architect',
      ),
    ).toBeUndefined();
    expect(() =>
      parse('evidence reconcile plan', argv('evidence reconcile plan', []), root, 'architect'),
    ).toThrow('AUTHORITY_RECONCILIATION_INVOCATION_INVALID');
    expect(parse('doctor', argv('doctor', []), root, 'auditor')).toBeUndefined();
  });
});

const checkout = resolve(import.meta.dirname, '../../../..');
let entries: readonly RegistryEntry[] = [];
beforeAll(async () => {
  const original = [...process.argv],
    stdout = process.stdout.write;
  try {
    process.argv = [process.execPath, 'devai', '--help'];
    process.stdout.write = (() => true) as typeof process.stdout.write;
    await import('../../src/bin.js');
    entries = getFullRegistry();
  } finally {
    process.argv = original;
    process.stdout.write = stdout;
  }
});
for (const kind of ['reconciliation-host', 'proof-index'] as const)
  it(`real default broker and record_init refuse forged ${kind} with zero handler effects`, () => {
    const fixture = createSelfContainedRepositoryFixture(checkout, {
      paths: ['.devai/config/project.json', '.devai/pin/constitution.md'],
    });
    const entry = entries.find((value) => value.name === 'init apply harness');
    if (!entry) throw new Error('missing canonical existing registry entry');
    const host = createAuthorityHostBroker({
      entry,
      entries,
      argv: [
        process.execPath,
        'devai',
        'init',
        'apply',
        'harness',
        '--as-role',
        'architect',
        '--write',
      ],
      role: 'architect',
      declaration: { as_role: 'architect' },
      repository_root: fixture.root,
      package_version: resolveCliVersion(),
      bootstrap_policy: true,
    });
    let effects = 0;
    const request = {
      kind,
      symbol: 'reconciliationHostOperation',
      arguments: [Object.freeze({})],
    } as unknown as AuthorityHostEffectRequest;
    try {
      expect(entry.authority_contract.capabilities).not.toContain(`${kind}:write`);
      expect(() =>
        runWithAuthorityHostEffects(host.scope, () =>
          host.scope.apply_effect(request, () => {
            effects++;
          }),
        ),
      ).toThrow('AUTHORITY_RECONCILIATION_OPERATION_INVALID');
      const internal = host.record_init('harness');
      expect(() =>
        runWithAuthorityHostEffects(internal.scope, () =>
          internal.scope.apply_effect(request, () => {
            effects++;
          }),
        ),
      ).toThrow();
      expect(effects).toBe(0);
    } finally {
      host.dispose();
      fixture.cleanup();
    }
  });

it('ordinary bind target pathname containing reconciliation-host never activates this bridge', async () => {
  const ordinary = resolve(root, 'reconciliation-host-adopter');
  mkdirSync(ordinary, { mode: 0o700 });
  const parse = (await parser()).parseReconciliationHostInput;
  for (const selector of [
    ['--constitution'],
    ['--review-authority-policy', '--after-constitution'],
  ])
    expect(
      parse(
        'init bind',
        argv('init bind', [
          '--target',
          ordinary,
          ...selector,
          '--as-role',
          'architect',
          '--write',
          '--format',
          'json',
        ]),
        ordinary,
        'architect',
      ),
    ).toBeUndefined();
});
