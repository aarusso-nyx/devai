import { describe, expect, it } from 'vitest';
import {
  createReconciliationHostInvocation,
  disposeReconciliationHostInvocation,
  invokeReconciliationHostOperation,
  readReconciliationPlanSelectors,
  type ReconciliationInvocationControls,
} from '../../src/boundaries/reconciliation-host-operation.js';
import { runWithAuthorityHostEffects } from '../../src/boundaries/host-scope.js';
import { createIssuer, runtimeApi } from './authority-runtime-testkit.js';

async function fixture() {
  const issuer = createIssuer(await runtimeApi());
  const bindings = {
    package_sha256: 'a'.repeat(64),
    module_sha256: 'b'.repeat(64),
    registry_sha256: 'c'.repeat(64),
    constitution_sha256: 'd'.repeat(64),
    policy_sha256: 'e'.repeat(64),
  };
  const controls: ReconciliationInvocationControls = {
    invocation_id: 'invocation-1',
    action_id: 'evidence reconcile plan',
    receipt_store: issuer,
    repository_root: '/fixture-only-no-host-access',
    repository_id: 'example-repository',
    original_argv_sha256: 'f'.repeat(64),
    initiator: 'architect',
    operation: 'plan',
    phases: [],
    write: false,
    require_tty: false,
    selected_parent: 'a'.repeat(40),
    published_ref: 'refs/heads/main',
    readCurrentBindings: () => bindings,
    verifyActual: () => {},
  };
  return { issuer, controls };
}

describe('sealed read-only plan invocation', () => {
  it('returns only its actual selectors in a read scope and cannot create mutation authority', async () => {
    const f = await fixture();
    const invocation = createReconciliationHostInvocation(f.controls);
    const scope = {
      action_id: f.controls.action_id,
      invocation_id: 'invocation-1',
      effect: 'read' as const,
      receipt_store: f.issuer,
      reconciliation_invocation: invocation,
      apply_effect: () => {
        throw new Error('no effect permitted');
      },
    };
    runWithAuthorityHostEffects(scope, () => {
      const selected = readReconciliationPlanSelectors();
      expect(selected).toEqual({
        selected_parent: 'a'.repeat(40),
        published_ref: 'refs/heads/main',
      });
      expect(Object.isFrozen(selected)).toBe(true);
      expect(() =>
        invokeReconciliationHostOperation({} as never, () => {
          throw new Error('must not run');
        }),
      ).toThrow('AUTHORITY_READ_ACTION_MUTATION_FORBIDDEN');
    });
    runWithAuthorityHostEffects({ ...scope, effect: 'local-write' }, () => {
      expect(() => readReconciliationPlanSelectors()).toThrow(
        'AUTHORITY_RECONCILIATION_INVOCATION_INVALID',
      );
      expect(() =>
        invokeReconciliationHostOperation({} as never, () => {
          throw new Error('must not run');
        }),
      ).toThrow('AUTHORITY_RECONCILIATION_OPERATION_INVALID');
    });
    disposeReconciliationHostInvocation(invocation);
    runWithAuthorityHostEffects(scope, () =>
      expect(() => readReconciliationPlanSelectors()).toThrow(
        'AUTHORITY_RECONCILIATION_INVOCATION_INVALID',
      ),
    );
  });

  it.each([
    { write: true },
    { require_tty: true },
    { initiator: 'owner' },
    { operation: 'provision' },
    { phases: ['01'] },
    { approval_id: 'a'.repeat(64) },
    { plan_sha256: 'a'.repeat(64) },
    { selected_parent: undefined },
    { published_ref: undefined },
    { published_ref: 'refs/tags/main' },
    { published_ref: 'refs/heads/a.lock/b' },
    { published_ref: 'refs/heads/a/.hidden' },
  ])('refuses incompatible plan controls %j', async (delta) => {
    const f = await fixture();
    expect(() =>
      createReconciliationHostInvocation({
        ...f.controls,
        ...delta,
      } as ReconciliationInvocationControls),
    ).toThrow('AUTHORITY_RECONCILIATION_INVOCATION_INVALID');
  });

  it.each(['selected_parent', 'published_ref'])(
    'forbids own %s even undefined on the historical provision action',
    async (field) => {
      const f = await fixture();
      const { selected_parent: _selected, published_ref: _published, ...base } = f.controls;
      const controls = {
        ...base,
        action_id: 'init bind',
        operation: 'provision',
        [field]: undefined,
      };
      expect(() =>
        createReconciliationHostInvocation(controls as ReconciliationInvocationControls),
      ).toThrow('AUTHORITY_RECONCILIATION_INVOCATION_INVALID');
    },
  );
});
