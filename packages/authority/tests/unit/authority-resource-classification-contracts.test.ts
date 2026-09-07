import { describe, expect, it } from 'vitest';
import {
  classifyAuthorityResource,
  protectedReleaseBoundaryAdapterId,
} from '../../src/boundaries/index.js';
import {
  dbTarget,
  expectBoundaryFailure,
  gitTarget,
  remoteTarget,
} from './authority-boundary-testkit.js';
import { fsTarget } from './authority-runtime-testkit.js';

// Boundary contract cases written against the retained authority mutation diagnostic
// (candidate 3dfdc316, report 414957d9). Each block names the surviving mutant IDs it
// pins. Every assertion is an observable refusal or acceptance at the public boundary;
// none restates an implementation constant.

const unprotectedRef = { ...gitTarget, protected: false } as const;

type Lane = Readonly<{
  system_id: string;
  operation_id: string;
  action_id: string;
  adapter: string;
}>;

const BOUND_LANES: readonly Lane[] = [
  {
    system_id: 'devai-protected-certification-provider-v3',
    operation_id: 'execute',
    action_id: 'release preflight',
    adapter: 'protected-certification-provider-v3',
  },
  {
    system_id: 'devai-protected-certification-provider-v3',
    operation_id: 'execute',
    action_id: 'release certify',
    adapter: 'protected-certification-provider-v3',
  },
  {
    system_id: 'trusted-certification-evidence-sink-v1',
    operation_id: 'write',
    action_id: 'release certify',
    adapter: 'trusted-certification-evidence-sink-v1',
  },
  {
    system_id: 'trusted-artifact-sink-v3',
    operation_id: 'write',
    action_id: 'release prepare',
    adapter: 'trusted-artifact-sink-v3',
  },
];

const PROTECTED_SYSTEMS = [
  ['devai-protected-certification-provider-v3', 'execute'],
  ['trusted-certification-evidence-sink-v1', 'write'],
  ['trusted-artifact-sink-v3', 'write'],
  ['trusted-export-artifact-sink-v1', 'write'],
  ['protected-export-signer-v1', 'sign'],
] as const;

function exactBinding(lane: Lane): Record<string, unknown> {
  return {
    action_id: lane.action_id,
    authority_repository_id: 'fixture-authority',
    expected_release_repository_id: 'owner/repository',
    origin_url: 'https://github.com/owner/repository.git',
    repository: { id: 'owner/repository', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    plan_receipt_digest_sha256: 'c'.repeat(64),
    ...(lane.action_id === 'release prepare'
      ? { pack_spec_digest_sha256: 'd'.repeat(64), sink_id: 'fixture-sink' }
      : { task_policy_digest_sha256: 'd'.repeat(64), helper_identity_sha256: 'e'.repeat(64) }),
  };
}

function boundTarget(lane: Lane, binding: unknown = exactBinding(lane)) {
  return {
    kind: 'remote',
    id: `remote:${lane.system_id}:${lane.operation_id}`,
    system_id: lane.system_id,
    endpoint_id: 'host',
    operation_id: lane.operation_id,
    publication: false,
    protected_operation_id: 'fixture-operation',
    protected_release_binding: binding,
  };
}

const providerLane = BOUND_LANES[1] as Lane;
const sinkLane = BOUND_LANES[2] as Lane;
const artifactLane = BOUND_LANES[3] as Lane;

describe('git-ref operation and protection contracts', () => {
  // Mutants 2429, 2431, 2432, 2433 (operation roster), 2439 (protected marker), 2397 (denial guard).
  it.each(['create', 'update', 'delete', 'merge', 'push'])(
    'admits %s on an unprotected ref and reports it as unprotected',
    (operation) => {
      const target = { ...unprotectedRef, operation };
      expect(classifyAuthorityResource(target)).toEqual({
        ok: true,
        value: { target, adapter_id: 'git-ref-authority-boundary', protected: false },
      });
    },
  );

  it('refuses force-push on an unprotected ref as an invalid operation, not a protected denial', () => {
    expectBoundaryFailure(
      classifyAuthorityResource({ ...unprotectedRef, operation: 'force-push' }),
      'refused',
      'AUTHORITY_GIT_OPERATION_INVALID',
    );
  });

  it.each(['rebase', 'squash', 'MERGE', '', undefined, 42])(
    'refuses unsupported git operation %s on an unprotected ref',
    (operation) => {
      expectBoundaryFailure(
        classifyAuthorityResource({ ...unprotectedRef, operation }),
        'refused',
        'AUTHORITY_GIT_OPERATION_INVALID',
      );
    },
  );

  // Mutant 2412: a non-string ref is refused, never dereferenced.
  it.each([undefined, null, 42, ['refs/heads/main'], { ref: 'refs/heads/main' }])(
    'refuses a non-string ref %s before inspecting it',
    (ref) => {
      expectBoundaryFailure(
        classifyAuthorityResource({ ...gitTarget, ref }),
        'refused',
        'AUTHORITY_GIT_REF_INVALID',
      );
    },
  );

  // The protected marker takes only a boolean; any other shape is malformed input and is
  // refused rather than read as unprotected (see authority-fail-closed-regressions.test.ts
  // for the contract references). An absent marker classifies as unprotected.
  it.each(['true', 1, {}, null])('refuses a non-boolean protected marker %s', (marker) => {
    expectBoundaryFailure(
      classifyAuthorityResource({ ...gitTarget, protected: marker, operation: 'delete' }),
      'refused',
      'AUTHORITY_GIT_REF_INVALID',
    );
  });

  it('classifies a ref without a protected marker as unprotected', () => {
    const { protected: _marker, ...target } = gitTarget;
    expect(classifyAuthorityResource({ ...target, operation: 'delete' })).toEqual({
      ok: true,
      value: {
        target: { ...target, operation: 'delete' },
        adapter_id: 'git-ref-authority-boundary',
        protected: false,
      },
    });
  });
});

describe('database operation contracts', () => {
  // Mutants 2469, 2470, 2471 (operation roster) and 2467 (the roster check itself).
  it.each(['insert', 'update', 'delete', 'ddl', 'execute'])(
    'admits the explicit %s operation',
    (operation) => {
      const target = { ...dbTarget, operation };
      expect(classifyAuthorityResource(target)).toEqual({
        ok: true,
        value: { target, adapter_id: 'db-authority-boundary' },
      });
    },
  );

  it.each(['select', 'drop', 'truncate', 'DDL', 'execute ', '', undefined, 42])(
    'refuses unsupported database operation %s',
    (operation) => {
      expectBoundaryFailure(
        classifyAuthorityResource({ ...dbTarget, operation }),
        'usage-error',
        'AUTHORITY_DB_TARGET_INVALID',
      );
    },
  );
});

describe('remote target shape contracts', () => {
  // Mutant 2497: publication is a boolean posture, never a truthy string or number.
  it.each(['true', 'false', 1, 0, null, undefined])(
    'refuses a non-boolean publication marker %s',
    (publication) => {
      expectBoundaryFailure(
        classifyAuthorityResource({ ...remoteTarget, publication }),
        'usage-error',
        'AUTHORITY_REMOTE_TARGET_INVALID',
      );
    },
  );

  // Mutants 2286 and 2479: input that is not a record, or whose kind is unknown, is refused
  // as an invalid target rather than falling through into any domain's validation.
  it.each([null, undefined, 'remote', 42, true])('refuses non-record input %s', (input) => {
    expectBoundaryFailure(
      classifyAuthorityResource(input),
      'usage-error',
      'AUTHORITY_RESOURCE_TARGET_INVALID',
    );
  });

  it.each(['http', 'REMOTE', 'remote ', 'fs-move', ''])(
    'refuses unknown resource kind %s without domain validation',
    (kind) => {
      expectBoundaryFailure(
        classifyAuthorityResource({ ...remoteTarget, kind }),
        'usage-error',
        'AUTHORITY_RESOURCE_TARGET_INVALID',
      );
    },
  );
});

describe('protected release system routing through classification', () => {
  // Mutants 2519 and 2522-2526: each frozen protected system id is refused without an
  // exact binding, including the export lanes.
  it.each(PROTECTED_SYSTEMS)(
    'refuses %s/%s without an exact protected binding',
    (system_id, operation_id) => {
      expectBoundaryFailure(
        classifyAuthorityResource({
          kind: 'remote',
          id: `remote:${system_id}:${operation_id}`,
          system_id,
          endpoint_id: 'host',
          operation_id,
          publication: false,
          protected_operation_id: 'fixture-operation',
        }),
        'refused',
        'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
      );
    },
  );

  it.each(PROTECTED_SYSTEMS)(
    'refuses %s/%s with a binding that is not an exact projection',
    (system_id, operation_id) => {
      expectBoundaryFailure(
        classifyAuthorityResource({
          kind: 'remote',
          id: `remote:${system_id}:${operation_id}`,
          system_id,
          endpoint_id: 'host',
          operation_id,
          publication: false,
          protected_operation_id: 'fixture-operation',
          protected_release_binding: { action_id: 'release certify' },
        }),
        'refused',
        'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
      );
    },
  );

  // Previously uncovered: an exact binding classifies to its frozen adapter, not to the
  // generic remote boundary.
  it.each(BOUND_LANES.map((lane) => [lane.system_id, lane.action_id, lane] as const))(
    'routes an exactly bound %s target for %s to its frozen adapter',
    (_system, _action, lane) => {
      const target = boundTarget(lane);
      expect(classifyAuthorityResource(target)).toEqual({
        ok: true,
        value: { target, adapter_id: lane.adapter },
      });
    },
  );
});

describe('filesystem containment dependency contracts', () => {
  const contained = (target: Record<string, unknown>) => ({
    ok: true,
    value: { target, atomicity: 'whole-plan', adapter_id: 'fs-authority-boundary' },
  });

  // A runtime that supplies a realpath must supply a string repository root; otherwise
  // containment cannot be established and the target is refused, never admitted unchecked
  // (see authority-fail-closed-regressions.test.ts for the contract references).
  it.each([undefined, 42, null, ['/workspace/devai']])(
    'refuses containment resolution when a realpath is supplied but the root is %s',
    (repository_root) => {
      expectBoundaryFailure(
        classifyAuthorityResource(fsTarget, {
          repository_root,
          realpath: () => '/private/outside/index.ts',
        }),
        'refused',
        'AUTHORITY_FS_SYMLINK_ESCAPE',
      );
    },
  );

  it('classifies without containment only when no realpath is supplied at all', () => {
    const target = { ...fsTarget };
    expect(classifyAuthorityResource(target, { repository_root: '/workspace/devai' })).toEqual(
      contained(target),
    );
  });

  // A non-string realpath result is likewise refused; a relative string result is resolved
  // against the root and must be contained, exactly like an absolute one.
  it.each([undefined, 42])('refuses a non-string realpath result %s', (resolved) => {
    expectBoundaryFailure(
      classifyAuthorityResource(fsTarget, {
        repository_root: '/workspace/devai',
        realpath: () => resolved,
      }),
      'refused',
      'AUTHORITY_FS_SYMLINK_ESCAPE',
    );
  });

  it.each(['packages/core/src/index.ts', 'elsewhere/../file'])(
    'contains the in-root relative realpath result %s',
    (resolved) => {
      const target = { ...fsTarget };
      expect(
        classifyAuthorityResource(target, {
          repository_root: '/workspace/devai',
          realpath: () => resolved,
        }),
      ).toEqual(contained(target));
    },
  );
});

describe('protected release binding identity contracts', () => {
  // Mutant 2219: the evidence sink is bound to release certify only.
  it('refuses an evidence sink binding for release preflight', () => {
    const binding = { ...exactBinding(sinkLane), action_id: 'release preflight' };
    expect(protectedReleaseBoundaryAdapterId(boundTarget(sinkLane, binding))).toBeUndefined();
  });

  it('routes the provider for both release preflight and release certify', () => {
    for (const lane of BOUND_LANES.slice(0, 2))
      expect(protectedReleaseBoundaryAdapterId(boundTarget(lane))).toBe(lane.adapter);
  });

  // Mutants 2224, 2227: the bound repository needs a non-empty string id.
  it.each(['', 42, undefined, null, ['owner/repository']])('refuses repository id %s', (id) => {
    const base = exactBinding(providerLane);
    const binding = { ...base, repository: { ...(base.repository as object), id } };
    expect(protectedReleaseBoundaryAdapterId(boundTarget(providerLane, binding))).toBeUndefined();
  });

  // Mutants 2230, 2231, 2233, 2235, 2236, 2239, 2240, 2243, 2244: commit and tree are each an
  // exact 40- or 64-hex object id, checked as strings, anchored at both ends, for every entry.
  const malformedObjectIds = [
    'a'.repeat(39),
    'a'.repeat(41),
    'a'.repeat(63),
    'a'.repeat(65),
    'G'.repeat(40),
    'g'.repeat(64),
    'a',
    '',
    42,
    new String('a'.repeat(40)),
  ];
  it.each(['commit', 'tree'])('refuses every malformed %s object id', (field) => {
    for (const value of malformedObjectIds) {
      const base = exactBinding(providerLane);
      const binding = { ...base, repository: { ...(base.repository as object), [field]: value } };
      expect(
        protectedReleaseBoundaryAdapterId(boundTarget(providerLane, binding)),
        String(value),
      ).toBeUndefined();
    }
  });

  // Mutants 2243 and 2244 tighten the object-id pattern so a 64-hex id no longer matches. The
  // identity capture upstream requires commit and tree to share a width, so both are 64-hex.
  it('accepts consistent 64-hex commit and tree object ids', () => {
    const base = exactBinding(providerLane);
    const binding = {
      ...base,
      repository: { ...(base.repository as object), commit: 'f'.repeat(64), tree: '0'.repeat(64) },
    };
    expect(protectedReleaseBoundaryAdapterId(boundTarget(providerLane, binding))).toBe(
      providerLane.adapter,
    );
  });

  it('refuses commit and tree object ids of differing widths', () => {
    const base = exactBinding(providerLane);
    const binding = {
      ...base,
      repository: { ...(base.repository as object), commit: 'f'.repeat(64), tree: '0'.repeat(40) },
    };
    expect(protectedReleaseBoundaryAdapterId(boundTarget(providerLane, binding))).toBeUndefined();
  });

  // Mutants 2253, 2260, 2263, 2264, 2268, 2269: the artifact sink id is a bounded token that
  // starts with an alphanumeric and is anchored at both ends.
  it.each(['', '.hidden', '-lead', ':lead', 'a/b', 'a b', 'a'.repeat(401), 42, null])(
    'refuses artifact sink id %s',
    (sink_id) => {
      const binding = { ...exactBinding(artifactLane), sink_id };
      expect(protectedReleaseBoundaryAdapterId(boundTarget(artifactLane, binding))).toBeUndefined();
    },
  );

  it.each(['a', 'A9._:-x', 'a'.repeat(400)])('accepts artifact sink id %s', (sink_id) => {
    const binding = { ...exactBinding(artifactLane), sink_id };
    expect(protectedReleaseBoundaryAdapterId(boundTarget(artifactLane, binding))).toBe(
      artifactLane.adapter,
    );
  });

  // Mutants 2140 and 2153: the binding is a plain or prototype-less object whose every own
  // member is a string-keyed enumerable data property.
  it('refuses a binding whose prototype is neither Object.prototype nor null', () => {
    const binding = Object.assign(Object.create({}) as object, exactBinding(providerLane));
    expect(protectedReleaseBoundaryAdapterId(boundTarget(providerLane, binding))).toBeUndefined();
  });

  it('accepts a prototype-less binding with the same own data', () => {
    const binding = Object.assign(Object.create(null) as object, exactBinding(providerLane));
    expect(protectedReleaseBoundaryAdapterId(boundTarget(providerLane, binding))).toBe(
      providerLane.adapter,
    );
  });

  it('refuses a binding carrying a symbol-keyed member', () => {
    const binding = { ...exactBinding(providerLane), [Symbol('extra')]: true };
    expect(protectedReleaseBoundaryAdapterId(boundTarget(providerLane, binding))).toBeUndefined();
  });

  it('refuses a binding carrying a non-enumerable member', () => {
    const binding = exactBinding(providerLane);
    Object.defineProperty(binding, 'extra', { value: true, enumerable: false });
    expect(protectedReleaseBoundaryAdapterId(boundTarget(providerLane, binding))).toBeUndefined();
  });
});
