import { afterEach, describe, expect, it } from 'vitest';
import {
  createReconciliationHostInvocation,
  disposeReconciliationHostInvocation,
  readReconciliationInitialApprovalInput,
  readReconciliationExistingApprovalInput,
  type ReconciliationInvocationControls,
} from '../../src/boundaries/reconciliation-host-operation.js';
import { runWithAuthorityHostEffects } from '../../src/boundaries/host-scope.js';
import { createIssuer, runtimeApi } from './authority-runtime-testkit.js';

const streams = [process.stdin, process.stdout, process.stderr];
const descriptors = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, 'isTTY'));
afterEach(() =>
  streams.forEach((stream, i) => {
    const descriptor = descriptors[i];
    if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
    else Reflect.deleteProperty(stream, 'isTTY');
  }),
);
async function fixture() {
  for (const stream of streams)
    Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
  const issuer = createIssuer(await runtimeApi());
  const controls: ReconciliationInvocationControls = {
    action_id: 'evidence reconcile approve',
    invocation_id: 'invocation-1',
    receipt_store: issuer,
    repository_root: '/synthetic-input-only',
    repository_id: 'fixture-repository',
    original_argv_sha256: 'a'.repeat(64),
    initiator: 'owner',
    operation: 'approve',
    phases: [],
    write: true,
    require_tty: true,
    plan_path: '.devai/state/reconciliation/plans/exact.json',
    plan_sha256: 'b'.repeat(64),
    verifyActual: () => {},
    readCurrentBindings: () => {
      throw new Error('no host or B5 observation permitted in input-only test');
    },
  };
  return { issuer, controls };
}
function scope(
  f: Awaited<ReturnType<typeof fixture>>,
  invocation: object,
  effect: 'local-write' | 'read' = 'local-write',
) {
  return {
    action_id: f.controls.action_id,
    invocation_id: 'invocation-1',
    receipt_store: f.issuer,
    reconciliation_invocation: invocation,
    effect,
    apply_effect: () => {
      throw new Error('no effect permitted');
    },
  };
}
describe('existing approval inputs remain sealed data only', () => {
  it.each(['renew', 'revoke', 'recover-owned-lease'] as const)(
    'retains original expected CAS input for %s',
    async (operation) => {
      const f = await fixture();
      const field =
        operation === 'recover-owned-lease' ? 'expected_lease_sha256' : 'expected_grant_sha256';
      Object.assign(f.controls, {
        operation,
        approval_id: 'c'.repeat(64),
        [field]: 'd'.repeat(64),
      });
      const invocation = createReconciliationHostInvocation(f.controls);
      try {
        Reflect.set(f.controls, field, 'e'.repeat(64));
        runWithAuthorityHostEffects(scope(f, invocation), () => {
          expect(readReconciliationExistingApprovalInput()).toHaveProperty(field, 'd'.repeat(64));
        });
      } finally {
        disposeReconciliationHostInvocation(invocation);
        f.issuer.dispose();
      }
    },
  );

  it.each([
    ['approve', 'expected_grant_sha256', 'd'.repeat(64)],
    ['renew', 'expected_lease_sha256', 'd'.repeat(64)],
    ['recover-owned-lease', 'expected_grant_sha256', 'd'.repeat(64)],
    ['renew', 'expected_grant_sha256', undefined],
    ['renew', 'expected_grant_sha256', 'ABSENT'],
    ['renew', 'expected_grant_sha256', 'D'.repeat(64)],
    ['recover-owned-lease', 'expected_lease_sha256', undefined],
    ['recover-owned-lease', 'expected_lease_sha256', 'd'.repeat(63)],
  ])(
    'refuses malformed or foreign expected-CAS control %s/%s/%s',
    async (operation, field, value) => {
      const f = await fixture();
      try {
        expect(() =>
          createReconciliationHostInvocation({
            ...f.controls,
            operation,
            ...(operation !== 'approve' ? { approval_id: 'c'.repeat(64) } : {}),
            [field]: value,
          } as ReconciliationInvocationControls),
        ).toThrow('AUTHORITY_RECONCILIATION_INVOCATION_INVALID');
      } finally {
        f.issuer.dispose();
      }
    },
  );
  it.each([
    ['evidence reconcile approve', 'renew', 'owner', true, []],
    ['evidence reconcile approve', 'revoke', 'owner', true, []],
    ['evidence reconcile approve', 'recover-owned-lease', 'owner', true, []],
    ['evidence reconcile materialize', 'consume-phase', 'inspector', false, ['01', '02']],
    ['evidence reconcile stage-proof', 'consume-phase', 'inspector', false, ['03']],
    ['sense bootstrap-inventory', 'consume-phase', 'architect', false, ['04']],
  ] as const)(
    'reads only the sealed selectors for %s/%s',
    async (action, operation, initiator, tty, phases) => {
      const f = await fixture();
      Object.assign(f.controls, {
        action_id: action,
        operation,
        initiator,
        require_tty: tty,
        phases,
        approval_id: 'c'.repeat(64),
      });
      const invocation = createReconciliationHostInvocation(f.controls);
      try {
        runWithAuthorityHostEffects(scope(f, invocation), () => {
          const value = readReconciliationExistingApprovalInput();
          expect(value).toMatchObject({
            action_id: action,
            operation,
            plan_path: f.controls.plan_path,
            plan_sha256: f.controls.plan_sha256,
            approval_id: 'c'.repeat(64),
          });
          expect(value.invocation_sha256).toMatch(/^[a-f0-9]{64}$/u);
          expect(Object.isFrozen(value)).toBe(true);
          expect(() => readReconciliationInitialApprovalInput()).toThrow(
            'AUTHORITY_RECONCILIATION_INVOCATION_INVALID',
          );
        });
        runWithAuthorityHostEffects(scope(f, invocation, 'read'), () =>
          expect(() => readReconciliationExistingApprovalInput()).toThrow(
            'AUTHORITY_RECONCILIATION_INVOCATION_INVALID',
          ),
        );
        disposeReconciliationHostInvocation(invocation);
        runWithAuthorityHostEffects(scope(f, invocation), () =>
          expect(() => readReconciliationExistingApprovalInput()).toThrow(
            'AUTHORITY_RECONCILIATION_INVOCATION_INVALID',
          ),
        );
      } finally {
        disposeReconciliationHostInvocation(invocation);
        f.issuer.dispose();
      }
    },
  );

  it('refuses initial approval and legacy existing controls with no sealed path', async () => {
    const f = await fixture();
    let invocation = createReconciliationHostInvocation(f.controls);
    try {
      runWithAuthorityHostEffects(scope(f, invocation), () =>
        expect(() => readReconciliationExistingApprovalInput()).toThrow(
          'AUTHORITY_RECONCILIATION_INVOCATION_INVALID',
        ),
      );
      disposeReconciliationHostInvocation(invocation);
      Reflect.deleteProperty(f.controls, 'plan_path');
      Object.assign(f.controls, { operation: 'renew', approval_id: 'c'.repeat(64) });
      invocation = createReconciliationHostInvocation(f.controls);
      runWithAuthorityHostEffects(scope(f, invocation), () =>
        expect(() => readReconciliationExistingApprovalInput()).toThrow(
          'AUTHORITY_RECONCILIATION_INVOCATION_INVALID',
        ),
      );
    } finally {
      disposeReconciliationHostInvocation(invocation);
      f.issuer.dispose();
    }
  });
});
describe('initial Owner plan inputs are invocation-owned data only', () => {
  it('reads the frozen original path and exact file digest, without observing host or granting an effect', async () => {
    const f = await fixture();
    const invocation = createReconciliationHostInvocation(f.controls);
    try {
      const expected = { plan_path: f.controls.plan_path, plan_sha256: f.controls.plan_sha256 };
      Object.assign(f.controls, { plan_path: 'replacement.json', plan_sha256: 'c'.repeat(64) });
      runWithAuthorityHostEffects(scope(f, invocation), () => {
        const value = readReconciliationInitialApprovalInput();
        expect(value).toEqual(expected);
        expect(Object.isFrozen(value)).toBe(true);
      });
    } finally {
      disposeReconciliationHostInvocation(invocation);
      f.issuer.dispose();
    }
  });
  it.each([
    '',
    '/outside.json',
    '../foreign.json',
    'a/../foreign.json',
    'a//b.json',
    'a\\b.json',
    'a/./b.json',
    'a\u0000b.json',
  ])('refuses malformed sealed path %j', async (path) => {
    const f = await fixture();
    try {
      expect(() => createReconciliationHostInvocation({ ...f.controls, plan_path: path })).toThrow(
        'AUTHORITY_RECONCILIATION_INVOCATION_INVALID',
      );
    } finally {
      f.issuer.dispose();
    }
  });
  it('refuses an own undefined path', async () => {
    const f = await fixture();
    try {
      expect(() =>
        createReconciliationHostInvocation({ ...f.controls, plan_path: undefined }),
      ).toThrow('AUTHORITY_RECONCILIATION_INVOCATION_INVALID');
    } finally {
      f.issuer.dispose();
    }
  });
  it('keeps old synthetic controls valid but refuses native initial reads without a sealed path', async () => {
    const f = await fixture();
    const { plan_path: unused, ...old } = f.controls;
    void unused;
    const invocation = createReconciliationHostInvocation(old);
    try {
      runWithAuthorityHostEffects(scope(f, invocation), () =>
        expect(readReconciliationInitialApprovalInput).toThrow(
          'AUTHORITY_RECONCILIATION_INVOCATION_INVALID',
        ),
      );
    } finally {
      disposeReconciliationHostInvocation(invocation);
      f.issuer.dispose();
    }
  });
  it.each(['renew', 'revoke', 'recover-owned-lease'] as const)(
    'refuses %s as initial approval',
    async (operation) => {
      const f = await fixture();
      const invocation = createReconciliationHostInvocation({
        ...f.controls,
        operation,
        approval_id: 'd'.repeat(64),
      });
      try {
        runWithAuthorityHostEffects(scope(f, invocation), () =>
          expect(readReconciliationInitialApprovalInput).toThrow(
            'AUTHORITY_RECONCILIATION_INVOCATION_INVALID',
          ),
        );
      } finally {
        disposeReconciliationHostInvocation(invocation);
        f.issuer.dispose();
      }
    },
  );
  it('refuses an own undefined approval id rather than treating it as initial origin', async () => {
    const f = await fixture();
    const invocation = createReconciliationHostInvocation({
      ...f.controls,
      approval_id: undefined,
    });
    try {
      runWithAuthorityHostEffects(scope(f, invocation), () =>
        expect(readReconciliationInitialApprovalInput).toThrow(
          'AUTHORITY_RECONCILIATION_INVOCATION_INVALID',
        ),
      );
    } finally {
      disposeReconciliationHostInvocation(invocation);
      f.issuer.dispose();
    }
  });
  it('refuses read scopes, missing TTYs, disposed and forged invocations', async () => {
    const f = await fixture();
    const invocation = createReconciliationHostInvocation(f.controls);
    try {
      runWithAuthorityHostEffects(scope(f, invocation, 'read'), () =>
        expect(readReconciliationInitialApprovalInput).toThrow(
          'AUTHORITY_RECONCILIATION_INVOCATION_INVALID',
        ),
      );
      for (const stream of streams) {
        Object.defineProperty(stream, 'isTTY', { value: false, configurable: true });
        runWithAuthorityHostEffects(scope(f, invocation), () =>
          expect(readReconciliationInitialApprovalInput).toThrow(
            'AUTHORITY_RECONCILIATION_INVOCATION_INVALID',
          ),
        );
        Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
      }
      runWithAuthorityHostEffects(scope(f, {}), () =>
        expect(readReconciliationInitialApprovalInput).toThrow(
          'AUTHORITY_RECONCILIATION_INVOCATION_INVALID',
        ),
      );
      disposeReconciliationHostInvocation(invocation);
      runWithAuthorityHostEffects(scope(f, invocation), () =>
        expect(readReconciliationInitialApprovalInput).toThrow(
          'AUTHORITY_RECONCILIATION_INVOCATION_INVALID',
        ),
      );
    } finally {
      disposeReconciliationHostInvocation(invocation);
      f.issuer.dispose();
    }
  });
});
