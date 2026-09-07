import { describe, expect, it } from 'vitest';
import { classifyAuthorityResource } from '../../src/boundaries/index.js';
import {
  boundaryApi,
  boundaryDependencies,
  expectBoundaryFailure,
  gitTarget,
} from './authority-boundary-testkit.js';
import {
  exactSubject,
  expectSuccess,
  fsTarget,
  type AuthorityDecisionIssuer,
} from './authority-runtime-testkit.js';

// Fail-closed regressions raised in Codex's review of d3b7586. The established contract:
//
// - `protected` on a git-ref target is a caller-declared classification hint, not an
//   authorization control: it is absent from GitRefResourceTarget (src/types.ts), never
//   validated by resourceValid (src/runtime/policy-resolver.ts) or decision.ts, consumed
//   only by classifyAuthorityResource (src/boundaries/index.ts), and the CLI broker emits
//   it as a boolean at every site (packages/cli/src/authority/broker.ts). Authorization of a
//   ref deletion is the policy selector plus the issuer's resolution binding. A marker that
//   is neither boolean is malformed input and must be refused, never downgraded to
//   unprotected.
// - Containment dependencies are supplied only by the trusted host runtime
//   (broker.ts createAuthorityBoundaryRuntime: `repository_root` is a realpathSync result
//   and `fs.realpath` returns an absolute path), never by the caller. Once a realpath is
//   supplied, containment must be established: the root must be an absolute path, the
//   result a non-empty path, and the result — absolute, or relative to the root as the
//   shared fixtures return it (authority-boundary-testkit.ts `realpath: (path) => path`) —
//   is resolved against the root and must land inside it. No shape of result is left
//   unchecked; a relative escape is refused like an absolute one.

const REAL_ISSUER_UNUSED = {
  consume: () => ({ ok: false, category: 'refused', code: 'FIXTURE_RECEIPT_REFUSED', reasons: [] }),
  dispose: () => ({ ok: true, value: true }),
};

async function registryRuntime(overrides: Record<string, unknown> = {}) {
  const api = await boundaryApi();
  const events: string[] = [];
  const runtime = api.createAuthorityBoundaryRuntime(
    boundaryDependencies(
      REAL_ISSUER_UNUSED as unknown as AuthorityDecisionIssuer,
      events,
      overrides,
    ),
  );
  const register = (subject: unknown) =>
    expectSuccess<object>(
      runtime.plannerRegistry.registerPlan({ subject, invocation_id: 'invocation-1' }),
    );
  return { runtime, events, register };
}

describe('malformed protected markers fail closed', () => {
  it.each(['true', 'false', 1, 0, {}, null, []])(
    'refuses classification of a git-ref carrying the non-boolean marker %s',
    (marker) => {
      expectBoundaryFailure(
        classifyAuthorityResource({ ...gitTarget, protected: marker, operation: 'delete' }),
        'refused',
        'AUTHORITY_GIT_REF_INVALID',
      );
      expectBoundaryFailure(
        classifyAuthorityResource({ ...gitTarget, protected: marker, operation: 'update' }),
        'refused',
        'AUTHORITY_GIT_REF_INVALID',
      );
    },
  );

  it('still admits an absent marker and a boolean marker', () => {
    const { protected: _marker, ...unmarked } = gitTarget;
    expect(classifyAuthorityResource(unmarked)).toMatchObject({
      ok: true,
      value: { protected: false },
    });
    expect(classifyAuthorityResource({ ...gitTarget, protected: false })).toMatchObject({
      ok: true,
      value: { protected: false },
    });
    expect(classifyAuthorityResource(gitTarget)).toMatchObject({
      ok: true,
      value: { protected: true },
    });
  });

  it('refuses the marker at the execution boundary before any receipt is consumed', async () => {
    const { runtime, register, events } = await registryRuntime();
    const target = { ...gitTarget, protected: 'true', operation: 'delete' };
    const subject = exactSubject([target]);
    const planHandle = register(subject);
    expectBoundaryFailure(
      runtime.prepare({
        plan_handle: planHandle,
        subject,
        target,
        adapter_id: 'git-ref-authority-boundary',
      }),
      'refused',
      'AUTHORITY_GIT_REF_INVALID',
    );
    expect(events).toEqual([]);
  });
});

describe('unverifiable containment fails closed', () => {
  const escaping = () => '/private/outside/index.ts';

  it.each([undefined, 42, null, ['/workspace/devai']])(
    'refuses classification when a realpath is supplied but the repository root is %s',
    (repository_root) => {
      expectBoundaryFailure(
        classifyAuthorityResource(fsTarget, { repository_root, realpath: escaping }),
        'refused',
        'AUTHORITY_FS_SYMLINK_ESCAPE',
      );
    },
  );

  it.each([undefined, 42, null, ['/workspace/devai/x']])(
    'refuses classification when realpath yields the non-string result %s',
    (resolved) => {
      expectBoundaryFailure(
        classifyAuthorityResource(fsTarget, {
          repository_root: '/workspace/devai',
          realpath: () => resolved,
        }),
        'refused',
        'AUTHORITY_FS_SYMLINK_ESCAPE',
      );
    },
  );

  // A realpath result is a canonical path, absolute or relative to the repository root. It is
  // resolved against the validated root and checked for containment either way; a relative
  // result is never a bypass.
  it.each([
    'packages/core/src/index.ts',
    'packages/core/src/../src/index.ts',
    '/workspace/devai/packages/core/src/index.ts',
  ])('contains the in-root realpath result %s', (resolved) => {
    const target = { ...fsTarget };
    expect(
      classifyAuthorityResource(target, {
        repository_root: '/workspace/devai',
        realpath: () => resolved,
      }),
    ).toEqual({
      ok: true,
      value: { target, atomicity: 'whole-plan', adapter_id: 'fs-authority-boundary' },
    });
  });

  it.each([
    '../outside/index.ts',
    '../../outside/index.ts',
    'packages/../../outside/index.ts',
    '..',
  ])('refuses the relative escape %s', (resolved) => {
    expectBoundaryFailure(
      classifyAuthorityResource(fsTarget, {
        repository_root: '/workspace/devai',
        realpath: () => resolved,
      }),
      'refused',
      'AUTHORITY_FS_SYMLINK_ESCAPE',
    );
  });

  it.each(['', 'index\0.ts', '/workspace/devai/\0'])(
    'refuses the empty or malformed realpath result %j',
    (resolved) => {
      expectBoundaryFailure(
        classifyAuthorityResource(fsTarget, {
          repository_root: '/workspace/devai',
          realpath: () => resolved,
        }),
        'refused',
        'AUTHORITY_FS_SYMLINK_ESCAPE',
      );
    },
  );

  it.each(['', 'workspace/devai', './workspace/devai', '/workspace/\0devai'])(
    'refuses a repository root that is not an absolute path: %j',
    (repository_root) => {
      expectBoundaryFailure(
        classifyAuthorityResource(fsTarget, { repository_root, realpath: (path: string) => path }),
        'refused',
        'AUTHORITY_FS_SYMLINK_ESCAPE',
      );
    },
  );

  it('refuses a relative escape at the execution boundary', async () => {
    const { runtime, register, events } = await registryRuntime({
      fs: {
        realpath: () => '../outside/index.ts',
        lstat: () => ({ kind: 'file', inode: 1, mtime_ms: 1 }),
        writeAtomic: (path: string) => events.push(`fs:write:${path}`),
        renameAtomic: () => undefined,
      },
    });
    const subject = exactSubject([fsTarget]);
    const planHandle = register(subject);
    expectBoundaryFailure(
      runtime.prepare({
        plan_handle: planHandle,
        subject,
        target: fsTarget,
        adapter_id: 'fs-authority-boundary',
      }),
      'refused',
      'AUTHORITY_FS_SYMLINK_ESCAPE',
    );
    expect(events).toEqual([]);
  });

  it('classifies without containment only when no realpath is supplied at all', () => {
    const target = { ...fsTarget };
    expect(classifyAuthorityResource(target, { repository_root: '/workspace/devai' })).toEqual({
      ok: true,
      value: { target, atomicity: 'whole-plan', adapter_id: 'fs-authority-boundary' },
    });
  });

  it('refuses at the execution boundary when the runtime lost its repository root', async () => {
    const { runtime, register, events } = await registryRuntime({
      repository_root: undefined,
      fs: {
        realpath: escaping,
        lstat: () => ({ kind: 'file', inode: 1, mtime_ms: 1 }),
        writeAtomic: (path: string) => events.push(`fs:write:${path}`),
        renameAtomic: () => undefined,
      },
    });
    const subject = exactSubject([fsTarget]);
    const planHandle = register(subject);
    expectBoundaryFailure(
      runtime.prepare({
        plan_handle: planHandle,
        subject,
        target: fsTarget,
        adapter_id: 'fs-authority-boundary',
      }),
      'refused',
      'AUTHORITY_FS_SYMLINK_ESCAPE',
    );
    expect(events).toEqual([]);
  });
});
