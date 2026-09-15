import {
  closeSync,
  constants,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createProtectedArtifactSinkAdapter,
  createProtectedReleaseHostAdapter,
  createProtectedReleaseSinkFilesystem,
  createProtectedReleaseSinkOwner,
  protectedArtifactSinkHostEffect,
  protectedReleaseHostEffect,
  runWithAuthorityHostEffects,
  spawnSync as guardedSpawnSync,
  writeFileSync as guardedWriteFileSync,
  type AuthorityHostEffectRequest,
  type AuthorityHostEffectScope,
} from '../../src/boundaries/host-effects.js';
import { createIssuer, runtimeApi } from './authority-runtime-testkit.js';
import { createReleaseRepositoryTestFixture } from './release-repository-test-fixture.js';

// Protected sink, adapter and scope contracts written against the retained authority
// mutation diagnostic (candidate 3dfdc316, report 414957d9); mutant ids are the report's.

let repository: ReturnType<typeof createReleaseRepositoryTestFixture>;
beforeAll(() => {
  repository = createReleaseRepositoryTestFixture();
});
afterAll(() => repository?.dispose());
const roots: string[] = [];
const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const READ = constants.O_RDONLY | constants.O_NOFOLLOW;
const WRITE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

async function scopeFor(
  invocationId: string,
  overrides: Partial<AuthorityHostEffectScope> = {},
): Promise<AuthorityHostEffectScope> {
  const issuer = createIssuer(await runtimeApi(), {
    issuer_id: `sink-contracts-${invocationId}`,
    invocation_id: invocationId,
  });
  disposers.push(() => {
    issuer.dispose();
  });
  return {
    action_id: 'release certify',
    invocation_id: invocationId,
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (_request, apply) => apply(),
    ...overrides,
  };
}

const certificationBinding = (repo = repository.repository) => ({
  action_id: 'release certify' as const,
  repository: { ...repo },
  plan_receipt_digest_sha256: 'a'.repeat(64),
  task_policy_digest_sha256: 'b'.repeat(64),
  helper_identity_sha256: 'c'.repeat(64),
});
const artifactBinding = (repo = repository.repository) => ({
  action_id: 'release prepare' as const,
  repository: { ...repo },
  plan_receipt_digest_sha256: 'a'.repeat(64),
  pack_spec_digest_sha256: 'b'.repeat(64),
  sink_id: 'expected-sink',
});

function store() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'sink contracts ç ')));
  roots.push(parent);
  const root = join(parent, 'store');
  mkdirSync(root, { mode: 0o700 });
  const owner = createProtectedReleaseSinkOwner('certification', 'contract-store');
  return { parent, root, owner, fs: createProtectedReleaseSinkFilesystem(root, owner) };
}

async function inSink<T>(
  f: ReturnType<typeof store>,
  callback: () => T,
  scope?: AuthorityHostEffectScope,
): Promise<T> {
  const adapter = createProtectedReleaseHostAdapter(certificationBinding());
  const selected = scope ?? (await scopeFor('invocation-1'));
  return await repository.run(() =>
    runWithAuthorityHostEffects(selected, () => adapter.invokeSink(callback, f.owner)),
  );
}

describe('sink owner identity', () => {
  // Mutants 747, 748, 755, 756: kind and sink id are each checked on their own, and the
  // sink id grammar is anchored on both sides.
  it.each([
    ['signer', 'store'],
    ['certification', ''],
    ['certification', '../store'],
    ['certification', 'store/x'],
    ['certification', '.store'],
    ['certification', 'a'.repeat(401)],
  ])('refuses owner kind %s with sink id %j', (kind, sinkId) => {
    expect(() => createProtectedReleaseSinkOwner(kind as 'certification', sinkId)).toThrow(
      'AUTHORITY_PROTECTED_SINK_OWNER_INVALID',
    );
  });

  it('admits one-character and 400-character sink ids', () => {
    for (const sinkId of ['a', 'a'.repeat(400)])
      expect(Object.isFrozen(createProtectedReleaseSinkOwner('export', sinkId))).toBe(true);
  });
});

describe('protected adapter operations', () => {
  // Mutant 769: an artifact or certification sink unit may run without an owner.
  it.each(['artifact', 'certification'] as const)(
    'runs an ownerless %s sink unit',
    async (kind) => {
      const scope = await scopeFor('invocation-1', {
        action_id: kind === 'artifact' ? 'release prepare' : 'release certify',
      });
      const adapter =
        kind === 'artifact'
          ? createProtectedArtifactSinkAdapter(artifactBinding())
          : createProtectedReleaseHostAdapter(certificationBinding());
      expect(
        await repository.run(() =>
          runWithAuthorityHostEffects(scope, () => adapter.invokeSink(() => 'ownerless')),
        ),
      ).toBe('ownerless');
    },
  );

  // Mutants 791-799: the adapter binding must name the live repository identity field by
  // field; a mismatch is refused before the broker sees any request.
  it.each([
    ['id', { id: 'other/repository' }],
    ['commit', { commit: 'd'.repeat(40) }],
    ['tree', { tree: 'e'.repeat(40) }],
  ])('refuses a binding whose repository %s differs from the live identity', async (_f, change) => {
    const requests: AuthorityHostEffectRequest[] = [];
    const scope = await scopeFor('invocation-1', {
      apply_effect: (request, apply) => {
        requests.push(request);
        return apply();
      },
    });
    const adapter = createProtectedReleaseHostAdapter(
      certificationBinding({ ...repository.repository, ...change }),
    );
    const callback = vi.fn();
    await expect(
      repository.run(() => runWithAuthorityHostEffects(scope, () => adapter.invokeSink(callback))),
    ).rejects.toThrow('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
    expect(callback).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  // Mutants 897, 1065: every operation carries its own non-empty id bound to the
  // invocation; two operations never share one.
  it.each(['artifact', 'certification'] as const)(
    'gives each %s operation a distinct id bound to the invocation',
    async (kind) => {
      const ids: string[] = [];
      const inspect =
        kind === 'artifact' ? protectedArtifactSinkHostEffect : protectedReleaseHostEffect;
      const scope = await scopeFor('invocation-7', {
        action_id: kind === 'artifact' ? 'release prepare' : 'release certify',
        apply_effect: (request, apply) => {
          const operation = inspect(request);
          if (!operation) throw new Error('operation missing');
          ids.push(operation.operation_id);
          return apply();
        },
      });
      const adapter =
        kind === 'artifact'
          ? createProtectedArtifactSinkAdapter(artifactBinding())
          : createProtectedReleaseHostAdapter(certificationBinding());
      await repository.run(() =>
        runWithAuthorityHostEffects(scope, () => {
          adapter.invokeSink(() => 1);
          adapter.invokeSink(() => 2);
        }),
      );
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
      for (const id of ids) expect(id).toContain('invocation-7');
    },
  );

  // Mutants 820, 987, 991: a live token is recognized only from the scope that issued it.
  it.each(['artifact', 'certification'] as const)(
    'hides a live %s operation from another scope',
    async (kind) => {
      const inspect =
        kind === 'artifact' ? protectedArtifactSinkHostEffect : protectedReleaseHostEffect;
      const other = await scopeFor('invocation-2');
      let seen = 0;
      const scope = await scopeFor('invocation-1', {
        action_id: kind === 'artifact' ? 'release prepare' : 'release certify',
        apply_effect: (request, apply) => {
          expect(inspect(request)).toBeDefined();
          expect(runWithAuthorityHostEffects(other, () => inspect(request))).toBeUndefined();
          seen += 1;
          return apply();
        },
      });
      const adapter =
        kind === 'artifact'
          ? createProtectedArtifactSinkAdapter(artifactBinding())
          : createProtectedReleaseHostAdapter(certificationBinding());
      await repository.run(() =>
        runWithAuthorityHostEffects(scope, () => adapter.invokeSink(() => 'done')),
      );
      expect(seen).toBe(1);
    },
  );

  // Mutants 899, 1067: a token the broker abandoned is retired as soon as the operation
  // returns, even inside the same scope.
  it.each(['artifact', 'certification'] as const)(
    'retires an abandoned %s token within the issuing scope',
    async (kind) => {
      const inspect =
        kind === 'artifact' ? protectedArtifactSinkHostEffect : protectedReleaseHostEffect;
      let abandoned: AuthorityHostEffectRequest | undefined;
      const scope = await scopeFor('invocation-1', {
        action_id: kind === 'artifact' ? 'release prepare' : 'release certify',
        apply_effect: (request) => {
          abandoned = request;
          throw new Error('broker refusal');
        },
      });
      const adapter =
        kind === 'artifact'
          ? createProtectedArtifactSinkAdapter(artifactBinding())
          : createProtectedReleaseHostAdapter(certificationBinding());
      await repository.run(() =>
        runWithAuthorityHostEffects(scope, () => {
          expect(() => adapter.invokeSink(() => 'unreachable')).toThrow('broker refusal');
          if (!abandoned) throw new Error('request missing');
          expect(inspect(abandoned)).toBeUndefined();
        }),
      );
    },
  );

  // Mutants 1054, 1056, 1057: a preflight binding may run provider operations but never a
  // certification sink; a certify binding runs both.
  it('routes provider and sink operations by the bound release phase', async () => {
    const preflight = createProtectedReleaseHostAdapter({
      ...certificationBinding(),
      action_id: 'release preflight',
    });
    const certify = createProtectedReleaseHostAdapter(certificationBinding());
    const preflightScope = await scopeFor('invocation-1', { action_id: 'release preflight' });
    const callback = vi.fn(() => 'sink');
    await repository.run(() =>
      runWithAuthorityHostEffects(preflightScope, () => {
        expect(preflight.spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).status).toBe(
          0,
        );
        expect(() => preflight.invokeSink(callback)).toThrow(
          'AUTHORITY_PROTECTED_RELEASE_ACTION_MISMATCH',
        );
      }),
    );
    expect(callback).not.toHaveBeenCalled();
    const certifyScope = await scopeFor('invocation-3');
    await repository.run(() =>
      runWithAuthorityHostEffects(certifyScope, () => {
        expect(certify.spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).status).toBe(0);
        expect(certify.invokeSink(callback)).toBe('sink');
      }),
    );
    expect(callback).toHaveBeenCalledOnce();
  });
});

describe('guarded seam under a read scope', () => {
  // Mutant 1083: a read-only action may still run process seams; only mutations are refused.
  it('admits process effects and refuses filesystem mutations', async () => {
    const requests: AuthorityHostEffectRequest[] = [];
    const scope = await scopeFor('invocation-1', {
      action_id: 'release preflight',
      effect: 'read',
      apply_effect: (request, apply) => {
        requests.push(request);
        return apply();
      },
    });
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'read scope ç ')));
    roots.push(parent);
    runWithAuthorityHostEffects(scope, () => {
      expect(guardedSpawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).status).toBe(0);
      expect(() => guardedWriteFileSync(join(parent, 'file'), 'bytes')).toThrow(
        'AUTHORITY_READ_ACTION_MUTATION_FORBIDDEN',
      );
    });
    expect(requests.map((request) => request.kind)).toEqual(['process']);
  });
});

describe('protected sink filesystem', () => {
  // Mutant 1111: an owner may be bound again to the very same root.
  it('rebinds an owner to its own root', () => {
    const f = store();
    expect(createProtectedReleaseSinkFilesystem(f.root, f.owner).root).toBe(f.root);
  });

  // Mutants 1117-1122: the root must be given as its own absolute canonical path.
  it('refuses a relative root and a symlinked root', () => {
    const f = store();
    expect(() =>
      createProtectedReleaseSinkFilesystem(relative(process.cwd(), f.root), f.owner),
    ).toThrow('AUTHORITY_PROTECTED_SINK_ROOT_INVALID');
    const link = join(f.parent, 'link');
    symlinkSync(f.root, link);
    expect(() => createProtectedReleaseSinkFilesystem(link, f.owner)).toThrow(
      'AUTHORITY_PROTECTED_SINK_ROOT_INVALID',
    );
  });

  // Mutant 1141: the parent of the root itself is outside the store.
  it('refuses the parent directory of the root', () => {
    const f = store();
    expect(() => f.fs.lstatSync(f.parent)).toThrow('AUTHORITY_PROTECTED_SINK_PATH_INVALID');
  });

  // Mutants 1152, 1153: a root that became a symlink is refused even when it points at a
  // private directory with the expected mode.
  it('refuses a root replaced by a symlink to a private directory', () => {
    const f = store();
    renameSync(f.root, join(f.parent, 'moved'));
    symlinkSync(join(f.parent, 'moved'), f.root);
    expect(() => f.fs.readdirSync(f.root)).toThrow('AUTHORITY_PROTECTED_SINK_ROOT_INVALID');
  });

  // Mutants 1192, 1193, 1196: a descriptor number reused by unrelated code no longer
  // names the store's file.
  it('refuses a registered descriptor number after it was reused elsewhere', () => {
    const f = store();
    const path = join(f.root, 'report');
    writeFileSync(path, 'store bytes', { mode: 0o600 });
    const other = join(f.parent, 'other');
    writeFileSync(other, 'other bytes');
    const fd = f.fs.openSync(path, READ);
    closeSync(fd);
    const reused = openSync(other, 'r');
    try {
      expect(reused).toBe(fd);
      expect(() => f.fs.fstatSync(fd)).toThrow('AUTHORITY_PROTECTED_SINK_DESCRIPTOR_INVALID');
      expect(() => f.fs.readFileSync(fd)).toThrow('AUTHORITY_PROTECTED_SINK_DESCRIPTOR_INVALID');
    } finally {
      closeSync(reused);
    }
  });

  // Mutant 1229: a path read closes the descriptor it opened.
  it('leaves no descriptor behind after a path read', () => {
    const f = store();
    const path = join(f.root, 'report');
    writeFileSync(path, 'store bytes', { mode: 0o600 });
    const probe = openSync(path, 'r');
    closeSync(probe);
    expect(f.fs.readFileSync(path).toString()).toBe('store bytes');
    const next = openSync(path, 'r');
    try {
      expect(next).toBe(probe);
    } finally {
      closeSync(next);
    }
  });

  // Mutants 1242, 1263: read descriptors open and close outside any sink unit; a write
  // descriptor closes only inside one.
  it('closes read descriptors freely and write descriptors only inside a sink unit', async () => {
    const f = store();
    const existing = join(f.root, 'existing');
    writeFileSync(existing, 'store bytes', { mode: 0o600 });
    const readFd = f.fs.openSync(existing, READ);
    f.fs.closeSync(readFd);
    let writeFd = -1;
    await inSink(f, () => {
      writeFd = f.fs.openSync(join(f.root, 'created'), WRITE);
      expect(f.fs.writeSync(writeFd, Buffer.from('new'), 0, 3, null)).toBe(3);
    });
    expect(() => f.fs.closeSync(writeFd)).toThrow('AUTHORITY_PROTECTED_SINK_OPERATION_FORBIDDEN');
    await inSink(f, () => f.fs.closeSync(writeFd));
    expect(() => f.fs.fstatSync(writeFd)).toThrow('AUTHORITY_PROTECTED_SINK_DESCRIPTOR_INVALID');
    expect(readFileSync(join(f.root, 'created'), 'utf8')).toBe('new');
  });

  // Mutants 1258, 1259: fsync needs both a sink unit and a registered descriptor.
  it('refuses fsync outside a sink unit and on a foreign descriptor inside one', async () => {
    const f = store();
    const other = join(f.parent, 'other');
    writeFileSync(other, 'other bytes');
    const foreign = openSync(other, 'r');
    try {
      expect(() => f.fs.fsyncSync(foreign)).toThrow('AUTHORITY_PROTECTED_SINK_OPERATION_FORBIDDEN');
      await inSink(f, () => {
        expect(() => f.fs.fsyncSync(foreign)).toThrow(
          'AUTHORITY_PROTECTED_SINK_DESCRIPTOR_INVALID',
        );
      });
    } finally {
      closeSync(foreign);
    }
  });

  // Mutant 1209: a sink effect from a different scope nested inside the unit is refused.
  it('refuses a sink effect issued from a nested foreign scope', async () => {
    const f = store();
    const other = await scopeFor('invocation-2');
    await inSink(f, () => {
      f.fs.assertWriteAuthority();
      expect(() => runWithAuthorityHostEffects(other, () => f.fs.assertWriteAuthority())).toThrow(
        'AUTHORITY_PROTECTED_SINK_OPERATION_FORBIDDEN',
      );
    });
  });

  // Mutant 1274: an explicit private mode is the one mode a sink directory may request.
  it('creates a directory with an explicit private mode', async () => {
    const f = store();
    const directory = join(f.root, 'objects');
    await inSink(f, () => {
      f.fs.mkdirSync(directory, { mode: 0o700 });
    });
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  });
});
