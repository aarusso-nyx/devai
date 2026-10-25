// Independent Inspector shape assurance. Accepted strings are not approvals or operation handles.
import { describe, expect, it } from 'vitest';

const MODULE = '../../src/boundaries/reconciliation-resources.js';
interface Validators {
  isProofIndexResourceTarget(value: unknown): boolean;
  isReconciliationHostResourceTarget(value: unknown): boolean;
}
const validators = async (): Promise<Validators> => (await import(MODULE)) as Validators;
const DIGEST = 'a'.repeat(64);
const APPROVAL = 'b'.repeat(64);
const REPOSITORY = 'Repo_01';
const WORKTREE = 'Worktree-02';
const PROOF = 'record/proofs/chain.json';
const OPERATIONS = [
  'provision',
  'approve',
  'consume-phase',
  'renew',
  'revoke',
  'recover-owned-lease',
] as const;
type Operation = (typeof OPERATIONS)[number];
function proof(): Record<string, unknown> {
  return {
    kind: 'proof-index',
    id: `proof-index:${REPOSITORY}:${WORKTREE}:${PROOF}`,
    repository_id: REPOSITORY,
    worktree_id: WORKTREE,
    operation: 'chain-cas',
    proof_path: PROOF,
    approval_id: APPROVAL,
    plan_sha256: DIGEST,
    phase_sha256: DIGEST,
    before_index_sha256: DIGEST,
    other_entries_sha256: DIGEST,
    verified_chain_sha256: DIGEST,
  };
}
function host(operation: Operation = 'provision', phase = '01'): Record<string, unknown> {
  const base = {
    kind: 'reconciliation-host',
    id: `reconciliation-host:${REPOSITORY}:${WORKTREE}:${operation}`,
    repository_id: REPOSITORY,
    worktree_id: WORKTREE,
    operation,
    binding_sha256: DIGEST,
    plan_sha256: DIGEST,
  };
  if (operation === 'provision') return base;
  return {
    ...base,
    id: `${base.id}:${APPROVAL}${operation === 'consume-phase' ? `:${phase}` : ''}`,
    approval_id: APPROVAL,
    ...(operation === 'consume-phase' ? { phase } : {}),
  };
}
function expectUnchanged(
  value: object,
  check: (value: unknown) => boolean,
  expected: boolean,
): void {
  const before = Object.getOwnPropertyDescriptors(value);
  expect(check(value)).toBe(expected);
  expect(Object.getOwnPropertyDescriptors(value)).toEqual(before);
}
function clone(value: Record<string, unknown>): Record<string, unknown> {
  return { ...value };
}

describe('proof-index exact logical target shape only', () => {
  it('accepts ordinary, null-prototype and frozen exact data without mutation', async () => {
    const { isProofIndexResourceTarget: check } = await validators();
    for (const value of [
      proof(),
      Object.assign(Object.create(null), proof()),
      Object.freeze(JSON.parse(JSON.stringify(proof()))),
    ])
      expectUnchanged(value, check, true);
  });
  it.each(Object.keys(proof()))('requires own enumerable %s', async (key) => {
    const { isProofIndexResourceTarget: check } = await validators();
    const missing = proof();
    Reflect.deleteProperty(missing, key);
    expectUnchanged(missing, check, false);
    const hidden = proof();
    Object.defineProperty(hidden, key, { value: hidden[key], enumerable: false });
    expectUnchanged(hidden, check, false);
  });
  it.each([
    ['kind', 'Proof-Index'],
    ['operation', 'chain-CAS'],
    ['operation', '*'],
    ['proof_path', 'business/source.ts'],
    ['proof_path', '/record/proofs/chain.json'],
    ['proof_path', 'record/proofs/../proofs/chain.json'],
    ['proof_path', 'record/proofs/*'],
    ['id', `proof-index:${REPOSITORY}:foreign:${PROOF}`],
    ['id', `proof-index:${REPOSITORY}:${WORKTREE}:business/source.ts`],
    ['repository_id', 'foreign-repository'],
    ['worktree_id', 'foreign-worktree'],
  ] as const)('refuses substituted %s', async (key, value) => {
    const { isProofIndexResourceTarget: check } = await validators();
    const input = { ...proof(), [key]: value };
    expectUnchanged(input, check, false);
  });
  it.each([
    'approval_id',
    'plan_sha256',
    'phase_sha256',
    'before_index_sha256',
    'other_entries_sha256',
    'verified_chain_sha256',
  ])('requires exact lowerhex64 %s', async (key) => {
    const { isProofIndexResourceTarget: check } = await validators();
    for (const value of [
      '',
      'a'.repeat(63),
      'a'.repeat(65),
      'A'.repeat(64),
      'z'.repeat(64),
      'a'.repeat(64) + '\n',
      'a'.repeat(64) + '\r\n',
      null,
      undefined,
      64,
    ])
      expectUnchanged({ ...proof(), [key]: value }, check, false);
  });
  it('accepts any shape-valid caller digest without pretending to establish its origin', async () => {
    const { isProofIndexResourceTarget: check } = await validators();
    expect(check({ ...proof(), approval_id: '0'.repeat(64), plan_sha256: 'f'.repeat(64) })).toBe(
      true,
    );
    // A boolean shape result authenticates no issuer, caller, role, consent, current index or phase.
  });
});

describe('reconciliation-host exact conditional logical shapes only', () => {
  it.each(OPERATIONS)('accepts exact %s ordinary/null/frozen own-data forms', async (operation) => {
    const { isReconciliationHostResourceTarget: check } = await validators();
    for (const phase of operation === 'consume-phase' ? ['01', '02', '03', '04'] : ['01']) {
      const input = host(operation, phase);
      for (const value of [
        input,
        Object.assign(Object.create(null), input),
        Object.freeze(JSON.parse(JSON.stringify(input))),
      ])
        expectUnchanged(value, check, true);
    }
  });
  it.each(Object.keys(host()))('requires base %s', async (key) => {
    const { isReconciliationHostResourceTarget: check } = await validators();
    const input = host();
    Reflect.deleteProperty(input, key);
    expectUnchanged(input, check, false);
    const hidden = host();
    Object.defineProperty(hidden, key, { value: hidden[key], enumerable: false });
    expectUnchanged(hidden, check, false);
  });
  it('forbids approval or phase on provision and phase on every non-consume operation', async () => {
    const { isReconciliationHostResourceTarget: check } = await validators();
    for (const extra of [
      { approval_id: APPROVAL },
      { phase: '01' },
      { approval_id: undefined },
      { phase: undefined },
    ])
      expectUnchanged({ ...host(), ...extra }, check, false);
    const absentPhase = host('consume-phase');
    Reflect.deleteProperty(absentPhase, 'phase');
    expectUnchanged(absentPhase, check, false);
    for (const [operation, key] of [
      ['approve', 'approval_id'],
      ['consume-phase', 'phase'],
    ] as const) {
      const hidden = host(operation);
      Object.defineProperty(hidden, key, { value: hidden[key], enumerable: false });
      expectUnchanged(hidden, check, false);
    }
    for (const operation of ['approve', 'renew', 'revoke', 'recover-owned-lease'] as const)
      expectUnchanged({ ...host(operation), phase: '01' }, check, false);
  });
  it.each(['approve', 'consume-phase', 'renew', 'revoke', 'recover-owned-lease'] as const)(
    'requires approval and exact operation-specific ID for %s',
    async (operation) => {
      const { isReconciliationHostResourceTarget: check } = await validators();
      const absent = host(operation);
      Reflect.deleteProperty(absent, 'approval_id');
      expectUnchanged(absent, check, false);
      for (const wrong of [
        '',
        'A'.repeat(64),
        'g'.repeat(64),
        'a'.repeat(63),
        'a'.repeat(65),
        null,
        3,
      ])
        expectUnchanged({ ...host(operation), approval_id: wrong }, check, false);
      expectUnchanged({ ...host(operation), id: `${host(operation).id}:extra` }, check, false);
      expectUnchanged({ ...host(operation), id: host().id }, check, false);
      expectUnchanged({ ...host(operation), approval_id: 'f'.repeat(64) }, check, false);
    },
  );
  it.each([undefined, null, '', '1', '00', '05', '01:02', '*', 1, true])(
    'refuses consume phase %s',
    async (phase) => {
      const { isReconciliationHostResourceTarget: check } = await validators();
      expectUnchanged({ ...host('consume-phase'), phase }, check, false);
    },
  );
  it.each(['binding_sha256', 'plan_sha256'])('requires lowerhex64 host %s', async (key) => {
    const { isReconciliationHostResourceTarget: check } = await validators();
    for (const value of [
      '',
      'A'.repeat(64),
      'a'.repeat(63),
      'g'.repeat(64),
      'a'.repeat(64) + '\n',
      null,
      undefined,
      7,
    ])
      expectUnchanged({ ...host(), [key]: value }, check, false);
  });
  it.each(['PROVISION', 'Approve', 'chain-cas', '*', '', 'recover-owned-lease-extra'])(
    'refuses host operation %s',
    async (operation) => {
      const { isReconciliationHostResourceTarget: check } = await validators();
      expectUnchanged({ ...host(), operation }, check, false);
    },
  );
  it('binds repository/worktree/operation/approval/phase exactly in the ID', async () => {
    const { isReconciliationHostResourceTarget: check } = await validators();
    for (const wrong of [
      { repository_id: 'foreign' },
      { worktree_id: 'foreign' },
      { operation: 'renew' },
      { id: `reconciliation-host:${REPOSITORY}:${WORKTREE}:approve:${APPROVAL}:01` },
    ])
      expectUnchanged({ ...host('approve'), ...wrong }, check, false);
    expectUnchanged({ ...host('consume-phase', '01'), phase: '02' }, check, false);
    expectUnchanged(
      { ...host(), id: 'reconciliation-host:Repo_01:Worktree-02:provision:' },
      check,
      false,
    );
  });
});

describe('closed inert property boundary shared by both predicates', () => {
  it.each([
    'git_dir',
    'index_path',
    'physical_path',
    'output_path',
    'key_path',
    'argv',
    'scope',
    'selector',
    'sql',
    'receipt',
    'owner_label',
    'write_consent',
    'actor',
  ])('refuses unknown %s including hidden data without mutation', async (key) => {
    const api = await validators();
    for (const [seed, check] of [
      [proof(), api.isProofIndexResourceTarget],
      [host(), api.isReconciliationHostResourceTarget],
    ] as const) {
      expectUnchanged({ ...seed, [key]: '/physical/.git/index' }, check, false);
      const hidden = clone(seed);
      Object.defineProperty(hidden, key, { value: '/physical/.git/index', enumerable: false });
      expectUnchanged(hidden, check, false);
    }
  });
  it.each(['repository_id', 'worktree_id'])(
    'enforces logical identifier shape and exact recomputed IDs for %s',
    async (key) => {
      const api = await validators();
      for (const value of [
        '',
        '_leading',
        '-leading',
        '../escape',
        '/physical',
        'a:b',
        'white space',
        'Repo\n',
        'Repo\r',
        'á',
        'a'.repeat(129),
      ]) {
        const p = { ...proof(), [key]: value };
        p.id = `proof-index:${p.repository_id}:${p.worktree_id}:${PROOF}`;
        const h = { ...host(), [key]: value };
        h.id = `reconciliation-host:${h.repository_id}:${h.worktree_id}:provision`;
        expectUnchanged(p, api.isProofIndexResourceTarget, false);
        expectUnchanged(h, api.isReconciliationHostResourceTarget, false);
      }
      const maximal = 'A'.repeat(128);
      const p = { ...proof(), [key]: maximal };
      p.id = `proof-index:${p.repository_id}:${p.worktree_id}:${PROOF}`;
      const h = { ...host(), [key]: maximal };
      h.id = `reconciliation-host:${h.repository_id}:${h.worktree_id}:provision`;
      expectUnchanged(p, api.isProofIndexResourceTarget, true);
      expectUnchanged(h, api.isReconciliationHostResourceTarget, true);
    },
  );
  it('refuses symbols, getters and hidden required data without invoking getters', async () => {
    const api = await validators();
    for (const [seed, check] of [
      [proof(), api.isProofIndexResourceTarget],
      [host(), api.isReconciliationHostResourceTarget],
    ] as const) {
      for (const key of ['kind', 'id', 'repository_id', 'unknown']) {
        let called = 0;
        const input = clone(seed);
        Object.defineProperty(input, key, {
          enumerable: true,
          configurable: true,
          get: () => {
            called += 1;
            throw new Error('getter must never execute');
          },
        });
        expectUnchanged(input, check, false);
        expect(called).toBe(0);
      }
      const symbol = clone(seed);
      Object.defineProperty(symbol, Symbol('physical path'), {
        enumerable: true,
        value: '/private/.git',
      });
      expectUnchanged(symbol, check, false);
      const hiddenSymbol = clone(seed);
      Object.defineProperty(hiddenSymbol, Symbol.toStringTag, {
        get: () => {
          throw new Error('symbol getter must not execute');
        },
      });
      expectUnchanged(hiddenSymbol, check, false);
    }
  });
  it('refuses inherited, exotic and proxy records without running property getters or traps', async () => {
    const api = await validators();
    for (const [seed, check] of [
      [proof(), api.isProofIndexResourceTarget],
      [host(), api.isReconciliationHostResourceTarget],
    ] as const) {
      for (const prototype of [seed, Object.create(null)])
        expect(check(Object.assign(Object.create(prototype), seed))).toBe(false);
      class Exotic {
        valueOf(): number {
          return 0;
        }
      }
      for (const object of [
        new Exotic(),
        new Date(),
        new Map(),
        new Set(),
        /pattern/u,
        [],
        new String('boxed'),
        new Number(1),
        new Uint8Array(0),
      ])
        expect(check(Object.assign(object, seed))).toBe(false);
      let called = 0;
      const proxy = new Proxy(seed, {
        get: () => {
          called += 1;
          throw new Error('proxy getter must not execute');
        },
        ownKeys: () => {
          called += 1;
          throw new Error('proxy reflection must not execute');
        },
        getPrototypeOf: () => {
          called += 1;
          throw new Error('proxy prototype trap must not execute');
        },
      });
      expect(check(proxy)).toBe(false);
      expect(called).toBe(0);
      const revocable = Proxy.revocable(seed, {});
      revocable.revoke();
      expect(check(revocable.proxy)).toBe(false);
    }
  });
  it.each([
    null,
    undefined,
    false,
    true,
    0,
    1,
    '',
    'proof-index',
    Symbol('target'),
    1n,
    () => undefined,
  ])('refuses non-record %s', async (input) => {
    const api = await validators();
    expect(api.isProofIndexResourceTarget(input)).toBe(false);
    expect(api.isReconciliationHostResourceTarget(input)).toBe(false);
  });
  it('never consults an inherited Object.prototype getter for a missing host field', async () => {
    const { isReconciliationHostResourceTarget: check } = await validators();
    const input = host();
    Reflect.deleteProperty(input, 'binding_sha256');
    const before = Object.getOwnPropertyDescriptors(input);
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'binding_sha256');
    let called = 0;
    let result: boolean | undefined;
    try {
      Object.defineProperty(Object.prototype, 'binding_sha256', {
        configurable: true,
        get: () => {
          called += 1;
          throw new Error('inherited getter must not execute');
        },
      });
      result = check(input);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(Object.prototype, 'binding_sha256');
      else Object.defineProperty(Object.prototype, 'binding_sha256', previous);
    }
    expect(result).toBe(false);
    expect(called).toBe(0);
    expect(Object.getOwnPropertyDescriptors(input)).toEqual(before);
  });
  it('keeps the two resource kinds distinct and returns only boolean shape decisions', async () => {
    const api = await validators();
    expect(api.isProofIndexResourceTarget(host())).toBe(false);
    expect(api.isReconciliationHostResourceTarget(proof())).toBe(false);
    const forged = host('approve');
    expect(api.isReconciliationHostResourceTarget(forged)).toBe(true);
    expect(typeof api.isReconciliationHostResourceTarget(forged)).toBe('boolean');
    // No host-origin, role, consent, exact-plan selection, binding or opaque handle is proved here.
  });
});
