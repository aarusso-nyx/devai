import { createHash } from 'node:crypto';
import { getValidator } from '@devai-nyx/schemas';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, afterAll } from 'vitest';
import {
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
} from '../../src/boundaries/host-scope.js';
import type { AuthorityHostEffectRequest } from '../../src/boundaries/host-atomic-effects.js';
import { createAuthorityBoundaryRuntime } from '../../src/boundaries/boundary-runtime.js';
import { computeMutationEnvelopeDigest, type MutationEnvelope } from '../../src/index.js';
import {
  CONSENT,
  actionDocumentWithId,
  canonicalSha256,
  createIssuer,
  declarationDependencies,
  exactSubject,
  expectSuccess,
  makePolicyPlant,
  policyBindingFromPlant,
  runtimeApi,
  type AuthorityDecisionIssuer,
} from './authority-runtime-testkit.js';
import { boundaryDependencies } from './authority-boundary-testkit.js';
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
          'packages/authority/src/boundaries/reconciliation-host-operation.ts',
        ),
      ),
      'required actual module absent',
    ).toBe(true);
  });
});

type Data = Record<string, unknown>;
type View = Readonly<{
  target: Data;
  action_id: string;
  invocation_id: string;
  original_argv_sha256: string;
  initiator: unknown;
}>;
type Binding = Readonly<{
  identity: { repository_id: string; worktree_id: string };
  bindings: Data;
  binding_sha256: string;
  clock: unknown;
  grants_authority: false;
}>;
type Host = {
  paths: { repository_root: string; git_dir: string; common_dir: string; private_root: string };
  identity: unknown;
  bindings: Data;
};
interface OperationApi {
  createReconciliationHostInvocation(controls: Data): object;
  disposeReconciliationHostInvocation(invocation: object): void;
  readReconciliationHostBinding(): Binding;
  invokeReconciliationHostOperation<T>(target: Data, callback: (host: Host) => T): T;
  reconciliationHostOperation(
    request: AuthorityHostEffectRequest,
    expectedInvocation: object,
  ): View | undefined;
  reconciliationHostOperationSnapshot(
    view: unknown,
    expectedInvocation: object,
    target: Data,
  ): Readonly<Data>;
}
async function operationApi(): Promise<OperationApi> {
  return (await import('../../src/boundaries/reconciliation-host-operation.js')) as unknown as OperationApi;
}
const external = realpathSync(mkdtempSync(resolve(tmpdir(), 'devai-host-operation-inspector-')));
const cleanEnv = {
  PATH: '/usr/bin:/bin',
  LC_ALL: 'C',
  HOME: external,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_GLOBAL: '/dev/null',
};
const observations: unknown[] = [];
const originalArgv = [...process.argv];
const ttyDescriptors = [process.stdin, process.stdout, process.stderr].map(
  (stream) => [stream, Object.getOwnPropertyDescriptor(stream, 'isTTY')] as const,
);
afterEach(() => {
  process.argv = [...originalArgv];
  for (const [stream, descriptor] of ttyDescriptors) {
    if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
    else Reflect.deleteProperty(stream, 'isTTY');
  }
});
function git(root: string, args: string[]): string {
  return execFileSync('/usr/bin/git', ['-C', root, ...args], {
    env: cleanEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function repository(linked = false) {
  const base = realpathSync(mkdtempSync(resolve(external, 'fixture-')));
  const primary = resolve(base, 'repository');
  mkdirSync(primary, { mode: 0o700 });
  git(primary, ['init', '--initial-branch=main']);
  git(primary, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '--allow-empty',
    '-m',
    'fixture',
  ]);
  if (!linked) return { root: primary, primary };
  const root = resolve(base, 'linked');
  git(primary, ['worktree', 'add', '--detach', root, 'HEAD']);
  return { root: realpathSync(root), primary };
}
function inventory(root: string): unknown {
  const walk = (path: string): unknown => {
    const stat = lstatSync(path, { bigint: true });
    return stat.isDirectory()
      ? {
          mode: String(stat.mode),
          ino: String(stat.ino),
          entries: readdirSync(path)
            .sort()
            .map((name) => [name, walk(resolve(path, name))]),
        }
      : {
          mode: String(stat.mode),
          ino: String(stat.ino),
          bytes: readFileSync(path).toString('base64'),
        };
  };
  return walk(root);
}
async function genuineReceipt(
  target: Data,
  issuer: AuthorityDecisionIssuer,
  action: string,
  role: string,
) {
  const api = await runtimeApi();
  const rule = {
    rule_id: 'host-operation-fixture',
    origin: 'additive-extension',
    precedence: 500,
    action_ids: [action],
    selector: {
      kind: target.kind,
      repository_id: target.repository_id,
      operations: [target.operation],
    },
    effect: 'allow',
    subjects: [{ kind: 'human', roles: [role] }],
    required_consent: CONSENT,
    constitutional_anchors: [6],
    rationale: 'Owned deterministic operation fixture; no installed origin claim.',
  };
  const plant = makePolicyPlant({ additiveRules: [rule] });
  const context = expectSuccess<{ context_receipt: unknown }>(
    api.resolveAuthorityDeclaration(
      {
        action_id: action,
        invocation_id: 'invocation-1',
        dry_run: false,
        declaration: { as_role: role },
        consent: CONSENT,
      },
      declarationDependencies(
        issuer,
        actionDocumentWithId(action, 'local-write', { kind: 'human', allowed_roles: [role] }),
        undefined,
        policyBindingFromPlant(plant),
      ),
    ),
  );
  expect(getValidator('authority-policy.schema.json')(plant.document)).toBe(true);
  const policy = expectSuccess(api.loadAuthorityPolicy({ document: plant.document }, plant.deps));
  const resolution = api.resolveAuthorityPolicy(
    policy,
    {
      action_id: action,
      context_receipt: context.context_receipt,
      consent: CONSENT,
      resource: target,
      operation: target.operation,
    },
    { receiptStore: issuer, canonicalSha256 },
  );
  expect(resolution).toMatchObject({ outcome: 'allow' });
  const subject = exactSubject([target], plant) as { plan: { envelope: MutationEnvelope } };
  const envelope = {
    ...subject.plan.envelope,
    request: { ...subject.plan.envelope.request, action_id: action },
  } as MutationEnvelope;
  const exact = {
    plan: {
      ...subject.plan,
      envelope: {
        ...envelope,
        issued_by: {
          ...envelope.issued_by,
          envelope_digest_sha256: computeMutationEnvelopeDigest(envelope),
        },
      },
    },
  };
  const decision = issuer.issueAllow({
    resolutions: [resolution],
    subject: exact,
    context_receipt: context.context_receipt,
    invocation_id: 'invocation-1',
    boundary_adapter_id: `${String(target.kind)}-authority-boundary`,
  }) as { issued: boolean; receipt: unknown };
  expect(decision.issued).toBe(true);
  return { subject: exact, receipt: decision.receipt };
}

async function harness(
  options: {
    linked?: boolean;
    write?: boolean;
    action?: string;
    role?: string;
    operation?: string;
    phases?: string[];
    proof?: boolean;
    targetPhase?: string;
    scopeApply?: (
      request: AuthorityHostEffectRequest,
      apply: () => unknown,
      dispatch: () => unknown,
    ) => unknown;
  } = {},
) {
  const api = await operationApi();
  const repo = repository(options.linked);
  const issuer = createIssuer(await runtimeApi());
  const action = options.action ?? 'init bind',
    role = options.role ?? 'architect',
    write = options.write ?? true,
    operation = options.operation ?? 'provision',
    phases = options.phases ?? [];
  process.argv = [
    process.execPath,
    'devai',
    ...action.split(' '),
    ...(action === 'init bind'
      ? ['--reconciliation-host', '--target', repo.root]
      : [
          '--repo-root',
          repo.root,
          '--plan',
          'record/reconciliation/plan.json',
          '--plan-sha256',
          'f'.repeat(64),
          ...(operation === 'approve' ? [] : ['--approval', '1'.repeat(64)]),
          ...(operation === 'renew' || operation === 'revoke'
            ? [`--${operation}`, '--expected-grant-sha256', '6'.repeat(64)]
            : operation === 'recover-owned-lease'
              ? ['--recover-owned-lease', '--expected-lease-sha256', 'ABSENT']
              : []),
        ]),
    '--as-role',
    role,
    ...(write ? ['--write'] : []),
    '--format',
    'json',
  ];
  const argvHash = canonicalSha256(process.argv);
  // Owned deterministic B5 provider. These values do NOT attest installed package/module origin.
  const bindings: Data = {
    package_sha256: 'a'.repeat(64),
    module_sha256: 'b'.repeat(64),
    registry_sha256: 'c'.repeat(64),
    constitution_sha256: 'd'.repeat(64),
    policy_sha256: 'e'.repeat(64),
  };
  let currentBindings = bindings;
  let bindingFailure = false;
  let verified = 0;
  for (const stream of [process.stdin, process.stdout, process.stderr])
    Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
  const controls: Data = {
    invocation_id: 'invocation-1',
    action_id: action,
    receipt_store: issuer,
    repository_root: repo.root,
    repository_id: 'example-repository',
    original_argv_sha256: argvHash,
    initiator: role,
    operation,
    phases,
    write,
    require_tty: write && (action === 'init bind' || action === 'evidence reconcile approve'),
    readCurrentBindings: () => {
      if (bindingFailure) throw new Error('/private/SECRET/bindings');
      return currentBindings;
    },
    verifyActual: () => {
      verified++;
      if (canonicalSha256(process.argv) !== argvHash) throw new Error('actual argv drift');
    },
    ...(operation === 'provision'
      ? {}
      : {
          ...(operation === 'approve' ? {} : { approval_id: '1'.repeat(64) }),
          plan_sha256: 'f'.repeat(64),
        }),
  };
  const invocation = api.createReconciliationHostInvocation(controls);
  const requests: AuthorityHostEffectRequest[] = [];
  const views: View[] = [];
  const scope = {
    action_id: action,
    invocation_id: 'invocation-1',
    effect: 'local-write' as const,
    receipt_store: issuer,
    reconciliation_invocation: invocation,
    apply_effect: (request: AuthorityHostEffectRequest, apply: () => unknown) => {
      requests.push(request);
      const dispatch = () => {
        const view = api.reconciliationHostOperation(request, invocation);
        expect(view).toBeDefined();
        if (!view || !grant) throw new Error('missing genuine operation/decision');
        views.push(view);
        let appliedResult: unknown;
        const logicalAdapter = {
          admit: (value: Data) =>
            api.reconciliationHostOperation(request, invocation) === view &&
            canonicalSha256(value) === canonicalSha256(target),
          snapshot: (value: Data) =>
            api.reconciliationHostOperationSnapshot(view, invocation, value),
          apply: () => {
            appliedResult = apply();
            return appliedResult;
          },
        };
        const runtime = createAuthorityBoundaryRuntime(
          boundaryDependencies(issuer, [], {
            [target.kind === 'proof-index' ? 'proof_index' : 'reconciliation_host']: logicalAdapter,
          }),
        );
        const planHandle = expectSuccess(
          runtime.plannerRegistry.registerPlan({
            subject: grant.subject,
            invocation_id: 'invocation-1',
          }),
        );
        const prepared = expectSuccess(
          runtime.prepare({
            plan_handle: planHandle,
            subject: grant.subject,
            target,
            decision_receipt: grant.receipt,
            adapter_id: `${String(target.kind)}-authority-boundary`,
          }),
        );
        expectSuccess(runtime.apply({ prepared }));
        return appliedResult;
      };
      return options.scopeApply ? options.scopeApply(request, apply, dispatch) : dispatch();
    },
  };
  const run = <T>(callback: () => T) =>
    runWithAuthorityHostEffects(scope as AuthorityHostEffectScope, callback);
  const preview = run(() => api.readReconciliationHostBinding());
  const common = {
    repository_id: preview.identity.repository_id,
    worktree_id: preview.identity.worktree_id,
    plan_sha256: 'f'.repeat(64),
  };
  const approval = '1'.repeat(64);
  const target = options.proof
    ? {
        kind: 'proof-index',
        id: `proof-index:${common.repository_id}:${common.worktree_id}:record/proofs/chain.json`,
        ...common,
        operation: 'chain-cas',
        proof_path: 'record/proofs/chain.json',
        approval_id: approval,
        phase_sha256: '2'.repeat(64),
        before_index_sha256: '3'.repeat(64),
        other_entries_sha256: '4'.repeat(64),
        verified_chain_sha256: '5'.repeat(64),
      }
    : {
        kind: 'reconciliation-host',
        id: `reconciliation-host:${common.repository_id}:${common.worktree_id}:${operation}${operation === 'provision' ? '' : `:${approval}${operation === 'consume-phase' ? `:${options.targetPhase ?? phases[0]}` : ''}`}`,
        ...common,
        operation,
        binding_sha256: preview.binding_sha256,
        ...(operation === 'provision' ? {} : { approval_id: approval }),
        ...(operation === 'consume-phase' ? { phase: options.targetPhase ?? phases[0] } : {}),
      };
  const grant = await genuineReceipt(target, issuer, action, role);
  observations.push({
    fixture: repo,
    action,
    role,
    operation,
    phases,
    target,
    preview,
    original_argv_sha256: argvHash,
    installed_origin_attested: false,
    tty_flags_synthetic: true,
  });
  return {
    api,
    repo,
    issuer,
    scope,
    invocation,
    controls,
    target,
    preview,
    bindings,
    requests,
    views,
    run,
    failBindings: () => {
      bindingFailure = true;
    },
    replaceBindings: (value: Data) => {
      currentBindings = value;
    },
    verified: () => verified,
  };
}

describe('actual issuer-backed host invocation with synthetic B5 provider', () => {
  for (const linked of [false, true])
    it(`${linked ? 'registered linked' : 'direct'} read-only preview and genuine typed receipt dispatch preserve fixture bytes`, async () => {
      const f = await harness({ linked });
      const before = inventory(f.repo.primary);
      const observed: Host[] = [];
      expect(f.preview.grants_authority).toBe(false);
      expect(f.preview.binding_sha256).toBe(canonicalSha256(f.bindings));
      expect(Object.isFrozen(f.preview)).toBe(true);
      expect(f.preview).not.toHaveProperty('paths');
      const result = f.run(() =>
        f.api.invokeReconciliationHostOperation(f.target, (host) => {
          observed.push(host);
          return 'completed';
        }),
      );
      expect(result).toBe('completed');
      expect(observed).toHaveLength(1);
      expect(observed[0]?.paths.repository_root).toBe(f.repo.root);
      expect(observed[0]?.bindings).toEqual(f.bindings);
      expect(f.requests).toHaveLength(1);
      expect(inventory(f.repo.primary)).toEqual(before);
      expect(Object.keys(f.invocation)).toEqual([]);
      expect(Object.isFrozen(f.invocation)).toBe(true);
      expect(f.verified()).toBeGreaterThan(0);
      const view = f.views[0];
      expect(view).toBeDefined();
      expect(Object.keys(view ?? {}).sort()).toEqual([
        'action_id',
        'initiator',
        'invocation_id',
        'original_argv_sha256',
        'target',
      ]);
      expect(Object.isFrozen(view)).toBe(true);
      expect(
        f.api.reconciliationHostOperation(
          f.requests[0] as AuthorityHostEffectRequest,
          f.invocation,
        ),
      ).toBeUndefined();
      expect(() =>
        f.run(() => f.api.reconciliationHostOperationSnapshot(view, f.invocation, f.target)),
      ).toThrow('AUTHORITY_RECONCILIATION_OPERATION_INVALID');
      f.api.disposeReconciliationHostInvocation(f.invocation);
      f.issuer.dispose();
    });
  it('read-only invocation cannot reach a handler', async () => {
    const f = await harness({ write: false });
    let effects = 0;
    expect(() =>
      f.run(() =>
        f.api.invokeReconciliationHostOperation(f.target, () => {
          effects++;
        }),
      ),
    ).toThrow('AUTHORITY_RECONCILIATION_OPERATION_INVALID');
    expect(effects).toBe(0);
    expect(f.requests).toEqual([]);
  });
  it.each([
    'package_sha256',
    'module_sha256',
    'registry_sha256',
    'constitution_sha256',
    'policy_sha256',
  ])('fresh %s drift refuses before effects', async (field) => {
    const f = await harness();
    f.replaceBindings({ ...f.bindings, [field]: '9'.repeat(64) });
    let effects = 0;
    expect(() =>
      f.run(() =>
        f.api.invokeReconciliationHostOperation(f.target, () => {
          effects++;
        }),
      ),
    ).toThrow('AUTHORITY_RECONCILIATION_OPERATION_STALE');
    expect(effects).toBe(0);
  });
  it('preview is observation only: a later operation captures fresh actual HEAD', async () => {
    const f = await harness();
    const old = git(f.repo.root, ['rev-parse', 'HEAD']);
    git(f.repo.root, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--allow-empty',
      '-m',
      'changed',
    ]);
    const head = git(f.repo.root, ['rev-parse', 'HEAD']);
    expect(head).not.toBe(old);
    const result = f.run(() =>
      f.api.invokeReconciliationHostOperation(
        f.target,
        (host) => host.identity as { head: string },
      ),
    );
    expect(result.head).toBe(head);
    expect(f.preview.identity.worktree_id).toBe(f.target.worktree_id);
  });
  it('actual original argv drift refuses before a handler', async () => {
    const f = await harness();
    process.argv.push('--unknown');
    let effects = 0;
    expect(() =>
      f.run(() =>
        f.api.invokeReconciliationHostOperation(f.target, () => {
          effects++;
        }),
      ),
    ).toThrow();
    expect(effects).toBe(0);
  });
  it('disposing a cloned invocation cannot invalidate the exact owner', async () => {
    const f = await harness();
    f.api.disposeReconciliationHostInvocation({ ...f.invocation });
    expect(f.run(() => f.api.readReconciliationHostBinding())).toMatchObject({
      grants_authority: false,
    });
    f.api.disposeReconciliationHostInvocation(f.invocation);
    f.api.disposeReconciliationHostInvocation(f.invocation);
    expect(() => f.run(() => f.api.readReconciliationHostBinding())).toThrow(
      'AUTHORITY_RECONCILIATION_INVOCATION_INVALID',
    );
  });
  it('unknown request token and malformed request cannot expose an operation view', async () => {
    const f = await harness();
    expect(
      f.run(() =>
        f.api.reconciliationHostOperation(
          {
            kind: 'reconciliation-host',
            symbol: 'reconciliationHostOperation',
            arguments: [{}],
          } as unknown as AuthorityHostEffectRequest,
          f.invocation,
        ),
      ),
    ).toBeUndefined();
    expect(
      f.api.reconciliationHostOperation(
        { kind: 'filesystem', symbol: 'reconciliationHostOperation', arguments: [{}] },
        f.invocation,
      ),
    ).toBeUndefined();
  });
});

describe('opaque invocation custody and unsupported callback behavior', () => {
  it.each([
    'cloned-invocation',
    'foreign-receipt-store',
    'foreign-invocation-id',
    'foreign-action',
    'read-effect',
  ])('refuses %s in actual issuer-backed ALS before handler effects', async (form) => {
    const f = await harness();
    let effects = 0;
    const other = createIssuer(await runtimeApi(), {
      invocation_id: form === 'foreign-invocation-id' ? 'other-invocation' : 'invocation-1',
    });
    const scope = {
      ...f.scope,
      ...(form === 'cloned-invocation' ? { reconciliation_invocation: { ...f.invocation } } : {}),
      ...(form === 'foreign-receipt-store' ? { receipt_store: other } : {}),
      ...(form === 'foreign-invocation-id'
        ? { invocation_id: 'other-invocation', receipt_store: other }
        : {}),
      ...(form === 'foreign-action' ? { action_id: 'evidence reconcile approve' } : {}),
      ...(form === 'read-effect' ? { effect: 'read' as const } : {}),
    };
    expect(() =>
      runWithAuthorityHostEffects(scope, () =>
        f.api.invokeReconciliationHostOperation(f.target, () => {
          effects++;
        }),
      ),
    ).toThrow();
    expect(effects).toBe(0);
    expect(f.requests).toEqual([]);
    other.dispose();
  });
  it.each(['unknown', 'proxy', 'revoked'])(
    'unknown %s invocation cannot execute traps or dispose its actual owner',
    async (form) => {
      const f = await harness();
      let touches = 0;
      const trap = (): never => {
        touches++;
        throw new Error('untrusted invocation trap');
      };
      const owned = Proxy.revocable(
        {},
        { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap },
      );
      if (form === 'revoked') owned.revoke();
      const value = form === 'unknown' ? {} : owned.proxy;
      expect(() => f.api.disposeReconciliationHostInvocation(value)).not.toThrow();
      expect(() => f.api.reconciliationHostOperationSnapshot({}, value, f.target)).toThrow();
      expect(touches).toBe(0);
      expect(f.run(() => f.api.readReconciliationHostBinding())).toMatchObject({
        grants_authority: false,
      });
    },
  );
  it('deferred apply thunk cannot execute after its synchronous request ends', async () => {
    let deferred: (() => unknown) | undefined;
    const f = await harness({
      scopeApply: (_request, apply) => {
        deferred = apply;
        return undefined;
      },
    });
    let effects = 0;
    try {
      f.run(() =>
        f.api.invokeReconciliationHostOperation(f.target, () => {
          effects++;
        }),
      );
    } catch (error) {
      expect(String(error)).toContain('AUTHORITY_RECONCILIATION_OPERATION_INVALID');
    }
    expect(effects).toBe(0);
    expect(deferred).toBeTypeOf('function');
    expect(() => deferred?.()).toThrow('AUTHORITY_RECONCILIATION_OPERATION_INVALID');
    expect(effects).toBe(0);
  });
  it('nested operations cannot reuse the active invocation', async () => {
    const f = await harness();
    let nested = 0;
    f.run(() =>
      f.api.invokeReconciliationHostOperation(f.target, () => {
        expect(() =>
          f.api.invokeReconciliationHostOperation(f.target, () => {
            nested++;
          }),
        ).toThrow('AUTHORITY_RECONCILIATION_OPERATION_INVALID');
        return 'done';
      }),
    );
    expect(nested).toBe(0);
  });
  it('actual Promise callback return never claims completed synchronous operation', async () => {
    const f = await harness();
    expect(() =>
      f.run(() =>
        f.api.invokeReconciliationHostOperation(f.target, () => Promise.resolve('not synchronous')),
      ),
    ).toThrow('AUTHORITY_RECONCILIATION_OPERATION_INVALID');
  });
  it('late B5 drift inside apply_effect refuses before the fixed handler', async () => {
    const f: Awaited<ReturnType<typeof harness>> = await harness({
      scopeApply: (_request, apply) => {
        f.replaceBindings({ ...f.bindings, policy_sha256: '9'.repeat(64) });
        return apply();
      },
    });
    let effects = 0;
    expect(() =>
      f.run(() =>
        f.api.invokeReconciliationHostOperation(f.target, () => {
          effects++;
        }),
      ),
    ).toThrow('AUTHORITY_RECONCILIATION_OPERATION_STALE');
    expect(effects).toBe(0);
  });
  it('the callback is one-use even when a scope calls its thunk twice', async () => {
    const f = await harness({
      scopeApply: (_request, apply, dispatch) => {
        const result = dispatch();
        expect(() => apply()).toThrow('AUTHORITY_RECONCILIATION_OPERATION_INVALID');
        return result;
      },
    });
    let effects = 0;
    f.run(() =>
      f.api.invokeReconciliationHostOperation(f.target, () => {
        effects++;
        return 'done';
      }),
    );
    expect(effects).toBe(1);
  });
});

it('actual HEAD drift after request capture refuses the sealed callback before effects', async () => {
  const f: Awaited<ReturnType<typeof harness>> = await harness({
    scopeApply: (_request, apply) => {
      git(f.repo.root, [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '--allow-empty',
        '-m',
        'pending drift',
      ]);
      return apply();
    },
  });
  let effects = 0;
  expect(() =>
    f.run(() =>
      f.api.invokeReconciliationHostOperation(f.target, () => {
        effects++;
      }),
    ),
  ).toThrow('AUTHORITY_RECONCILIATION_OPERATION_STALE');
  expect(effects).toBe(0);
});
for (const c of [
  { action: 'evidence reconcile approve', role: 'owner', operation: 'approve', phases: [] },
  { action: 'evidence reconcile approve', role: 'owner', operation: 'renew', phases: [] },
  { action: 'evidence reconcile approve', role: 'owner', operation: 'revoke', phases: [] },
  {
    action: 'evidence reconcile approve',
    role: 'owner',
    operation: 'recover-owned-lease',
    phases: [],
  },
  {
    action: 'evidence reconcile materialize',
    role: 'inspector',
    operation: 'consume-phase',
    phases: ['01', '02'],
  },
  {
    action: 'evidence reconcile stage-proof',
    role: 'inspector',
    operation: 'consume-phase',
    phases: ['03'],
  },
  {
    action: 'evidence reconcile stage-proof',
    role: 'inspector',
    operation: 'consume-phase',
    phases: ['03'],
    proof: true,
  },
  {
    action: 'sense bootstrap-inventory',
    role: 'architect',
    operation: 'consume-phase',
    phases: ['04'],
  },
])
  it(`actual policy receipt dispatch ${c.action}/${c.operation}/${c.proof ? 'proof' : 'host'}`, async () => {
    const f = await harness(c);
    const before = inventory(f.repo.primary);
    let effects = 0;
    expect(
      f.run(() =>
        f.api.invokeReconciliationHostOperation(f.target, (host) => {
          expect(host.paths.repository_root).toBe(f.repo.root);
          effects++;
          return 'logical-only';
        }),
      ),
    ).toBe('logical-only');
    expect(effects).toBe(1);
    expect(f.requests).toHaveLength(1);
    expect(inventory(f.repo.primary)).toEqual(before);
  });

it('phase02 uses the same materialize custody without widening allowed phase set', async () => {
  const f = await harness({
    action: 'evidence reconcile materialize',
    role: 'inspector',
    operation: 'consume-phase',
    phases: ['01', '02'],
    targetPhase: '02',
  });
  let effects = 0;
  expect(
    f.run(() =>
      f.api.invokeReconciliationHostOperation(f.target, () => {
        effects++;
        return 'phase02';
      }),
    ),
  ).toBe('phase02');
  expect(effects).toBe(1);
});
it('printed/cloned/foreign token and view data cannot become operations', async () => {
  let touches = 0;
  const trap = (): never => {
    touches++;
    throw new Error('untrusted request trap');
  };
  const f: Awaited<ReturnType<typeof harness>> = await harness({
    scopeApply: (request, _apply, dispatch) => {
      const view = f.api.reconciliationHostOperation(request, f.invocation);
      expect(view).toBeDefined();
      const token = request.arguments[0];
      expect(
        f.api.reconciliationHostOperation(
          { ...request, arguments: [{ ...(token as object) }] },
          f.invocation,
        ),
      ).toBeUndefined();
      expect(
        f.api.reconciliationHostOperation(
          JSON.parse(JSON.stringify(request)) as AuthorityHostEffectRequest,
          f.invocation,
        ),
      ).toBeUndefined();
      expect(f.api.reconciliationHostOperation(request, {})).toBeUndefined();
      const bad = { ...request };
      Object.defineProperty(bad, 'arguments', { enumerable: true, get: trap });
      expect(f.api.reconciliationHostOperation(bad, f.invocation)).toBeUndefined();
      const proxy = new Proxy(request, {
        get: trap,
        ownKeys: trap,
        getPrototypeOf: trap,
        getOwnPropertyDescriptor: trap,
      });
      expect(f.api.reconciliationHostOperation(proxy, f.invocation)).toBeUndefined();
      expect(() =>
        f.api.reconciliationHostOperationSnapshot({ ...view }, f.invocation, f.target),
      ).toThrow('AUTHORITY_RECONCILIATION_OPERATION_INVALID');
      expect(() => f.api.reconciliationHostOperationSnapshot(view, {}, f.target)).toThrow(
        'AUTHORITY_RECONCILIATION_OPERATION_INVALID',
      );
      expect(touches).toBe(0);
      return dispatch();
    },
  });
  let effects = 0;
  f.run(() =>
    f.api.invokeReconciliationHostOperation(f.target, () => {
      effects++;
    }),
  );
  expect(effects).toBe(1);
  expect(touches).toBe(0);
});
it.each(['wrong-role', 'control-getter', 'control-proxy', 'control-revoked'])(
  'creation refuses %s without getters or host effects',
  async (form) => {
    const f = await harness();
    let touches = 0;
    const trap = (): never => {
      touches++;
      throw new Error('untrusted controls');
    };
    const controls = { ...f.controls };
    if (form === 'wrong-role') controls.initiator = 'owner';
    if (form === 'control-getter')
      Object.defineProperty(controls, 'repository_id', { enumerable: true, get: trap });
    const proxy = Proxy.revocable(controls, {
      get: trap,
      ownKeys: trap,
      getPrototypeOf: trap,
      getOwnPropertyDescriptor: trap,
    });
    if (form === 'control-revoked') proxy.revoke();
    expect(() =>
      f.api.createReconciliationHostInvocation(
        form === 'control-proxy' || form === 'control-revoked' ? proxy.proxy : controls,
      ),
    ).toThrow('AUTHORITY_RECONCILIATION_INVOCATION_INVALID');
    expect(touches).toBe(0);
    expect(f.requests).toEqual([]);
  },
);
it.each(['target-getter', 'target-proxy', 'target-revoked'])(
  'invoke refuses %s without header traps or effects',
  async (form) => {
    const f = await harness();
    let touches = 0,
      effects = 0;
    const trap = (): never => {
      touches++;
      throw new Error('untrusted target');
    };
    const target = { ...f.target };
    if (form === 'target-getter')
      Object.defineProperty(target, 'kind', { enumerable: true, get: trap });
    const proxy = Proxy.revocable(target, {
      get: trap,
      ownKeys: trap,
      getPrototypeOf: trap,
      getOwnPropertyDescriptor: trap,
    });
    if (form === 'target-revoked') proxy.revoke();
    expect(() =>
      f.run(() =>
        f.api.invokeReconciliationHostOperation(
          form === 'target-getter' ? target : proxy.proxy,
          () => {
            effects++;
          },
        ),
      ),
    ).toThrow('AUTHORITY_RECONCILIATION_OPERATION_INVALID');
    expect(touches).toBe(0);
    expect(effects).toBe(0);
    expect(f.requests).toEqual([]);
  },
);

it('observed pending binding staleness remains terminal after restoring the prior tuple', async () => {
  const f: Awaited<ReturnType<typeof harness>> = await harness({
    scopeApply: (request, apply) => {
      const view = f.api.reconciliationHostOperation(request, f.invocation);
      expect(view).toBeDefined();
      f.replaceBindings({ ...f.bindings, policy_sha256: '9'.repeat(64) });
      expect(() => f.api.reconciliationHostOperationSnapshot(view, f.invocation, f.target)).toThrow(
        'AUTHORITY_RECONCILIATION_OPERATION_STALE',
      );
      f.replaceBindings(f.bindings);
      expect(() => f.api.reconciliationHostOperationSnapshot(view, f.invocation, f.target)).toThrow(
        'AUTHORITY_RECONCILIATION_OPERATION_STALE',
      );
      return apply();
    },
  });
  let effects = 0;
  expect(() =>
    f.run(() =>
      f.api.invokeReconciliationHostOperation(f.target, () => {
        effects++;
      }),
    ),
  ).toThrow('AUTHORITY_RECONCILIATION_OPERATION_STALE');
  expect(effects).toBe(0);
});

it('snapshot target mismatch burns the pending operation rather than granting a retry', async () => {
  const f: Awaited<ReturnType<typeof harness>> = await harness({
    scopeApply: (request, apply) => {
      const view = f.api.reconciliationHostOperation(request, f.invocation);
      expect(view).toBeDefined();
      expect(() =>
        f.api.reconciliationHostOperationSnapshot(view, f.invocation, {
          ...f.target,
          plan_sha256: '9'.repeat(64),
        }),
      ).toThrow('AUTHORITY_RECONCILIATION_OPERATION_STALE');
      return apply();
    },
  });
  let effects = 0;
  expect(() =>
    f.run(() =>
      f.api.invokeReconciliationHostOperation(f.target, () => {
        effects++;
      }),
    ),
  ).toThrow('AUTHORITY_RECONCILIATION_OPERATION_STALE');
  expect(effects).toBe(0);
});
it('callback then accessor is unsupported and never executes a getter or reports completion', async () => {
  const f = await harness();
  let touches = 0;
  const result = {};
  Object.defineProperty(result, 'then', {
    enumerable: true,
    get() {
      touches++;
      throw new Error('/private/SECRET/then');
    },
  });
  expect(() =>
    f.run(() => f.api.invokeReconciliationHostOperation(f.target, () => result)),
  ).toThrow('AUTHORITY_RECONCILIATION_OPERATION_INVALID');
  expect(touches).toBe(0);
});
for (const mode of ['preview', 'invoke'])
  it(`binding provider failure at ${mode} is a closed diagnostic without sentinel`, async () => {
    const f = await harness();
    f.failBindings();
    let effects = 0;
    let failure: unknown;
    try {
      f.run(() =>
        mode === 'preview'
          ? f.api.readReconciliationHostBinding()
          : f.api.invokeReconciliationHostOperation(f.target, () => {
              effects++;
            }),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect([
      'AUTHORITY_RECONCILIATION_INVOCATION_INVALID',
      'AUTHORITY_RECONCILIATION_OPERATION_INVALID',
      'AUTHORITY_RECONCILIATION_OPERATION_STALE',
    ]).toContain(message);
    expect(message).not.toContain('SECRET');
    expect(effects).toBe(0);
    expect(f.requests).toEqual([]);
  });
it('same labels in a new actual ALS frame cannot execute the original pending callback', async () => {
  const f: Awaited<ReturnType<typeof harness>> = await harness({
    scopeApply: (request, apply) =>
      runWithAuthorityHostEffects(f.scope, () => {
        expect(f.api.reconciliationHostOperation(request, f.invocation)).toBeUndefined();
        return apply();
      }),
  });
  let effects = 0;
  expect(() =>
    f.run(() =>
      f.api.invokeReconciliationHostOperation(f.target, () => {
        effects++;
      }),
    ),
  ).toThrow();
  expect(effects).toBe(0);
});

afterAll(() => {
  const root = resolve(import.meta.dirname, '../../../..');
  const paths = [
    'packages/authority/src/boundaries/reconciliation-host-operation.ts',
    'packages/authority/src/boundaries/reconciliation-host-context.ts',
    'packages/authority/src/boundaries/host-scope.ts',
    'packages/authority/src/boundaries/host-atomic-effects.ts',
    'packages/authority/src/index.ts',
    'packages/cli/src/authority/reconciliation-host-input.ts',
    'packages/cli/src/authority/broker.ts',
  ];
  const hashes = Object.fromEntries(
    paths.map((path) => [
      path,
      createHash('sha256')
        .update(readFileSync(resolve(root, path)))
        .digest('hex'),
    ]),
  );
  writeFileSync(
    resolve(external, external.split('/').at(-1) + '.json'),
    JSON.stringify(
      {
        external_fixture: external,
        environment: {
          node: process.versions.node,
          uv: process.versions.uv,
          platform: process.platform,
        },
        source_sha256: hashes,
        synthetic_bindings_not_installed_origin: true,
        tty_flags_synthetic_not_actual_pty_qualification: true,
        observations,
      },
      null,
      2,
    ) + '\n',
  );
});
