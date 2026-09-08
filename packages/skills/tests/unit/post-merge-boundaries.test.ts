// Invariants: INV-DEVAI-016, INV-DEVAI-018
//
// Boundary coverage for the post-merge auditor that the acceptance suite in
// post-merge-auditor.test.ts does not reach: the exact identity of a completed
// observation round, the reconciliation of interrupted or half-published
// effects, the refusal to promote readiness out of a failed round, and the
// archive/administration boundaries around the runtime state directory.
import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPostMergeHostScope,
  runAuditObservation,
  runPostMergeAuditor,
  verifyPostMergeHostReceipt,
} from '../../src/post-merge-auditor/index.js';
import { runWithAuthorityHostEffects, type AuthorityHostEffectRequest } from '@devai-nyx/authority';
import { withAuthorityHostTestScope } from './authority-host-test-scope.js';

const roots: string[] = [];
const NOW = '2026-07-24T12:00:00.000Z';
const VERSION = '1.0.0';
const SHA40 = 'a'.repeat(40);
const ARTIFACT_NAMES = ['inventory', 'scorecard', 'backlog', 'assessment'] as const;
const BUNDLE_NAMES = [...ARTIFACT_NAMES, 'status'] as const;

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function put(root: string, relativePath: string, contents: string | Buffer): string {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'DEVAI Test',
      GIT_AUTHOR_EMAIL: 'devai-test@example.invalid',
      GIT_COMMITTER_NAME: 'DEVAI Test',
      GIT_COMMITTER_EMAIL: 'devai-test@example.invalid',
    },
  }).trim();
}

function signed(value: Record<string, unknown>, key: Buffer): Record<string, unknown> {
  return {
    ...value,
    signature_hmac_sha256: createHmac('sha256', key).update(JSON.stringify(value)).digest('hex'),
  };
}

/**
 * Mirrors the production canonicalisation so a forged observation can be
 * re-sealed exactly the way the auditor seals a genuine one. Without it every
 * forgery below would stop at the seal comparison and could never reach the
 * per-field and per-artifact checks these tests are written to exercise.
 */
function canonicalSha256(value: unknown): string {
  const canonical = (input: unknown): string => {
    if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
    if (input !== null && typeof input === 'object') {
      const record = input as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
        .join(',')}}`;
    }
    return JSON.stringify(input);
  };
  return sha256(canonical(value));
}

interface HostFixture {
  readonly root: string;
  readonly key: Buffer;
  readonly keyPath: string;
  readonly hookPath: string;
  readonly attestationPath: string;
  readonly receiptPath: string;
  readonly baselineSha: string;
  readonly mergeSha: string;
  readonly merges: readonly string[];
  readonly attestation: Record<string, unknown>;
  readonly receipt: Record<string, unknown>;
}

/**
 * A freshness reading in the shape the scorecard reads off disk. A failing
 * reading drives its scorecard cell to FAIL, which is what puts a backlog item
 * into the observed round.
 */
function reading(kind: string, status: string): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    id: `SR-${sha256(`${kind}:${status}`).slice(0, 16)}`,
    sensor: { name: kind, kind, version: '1.0.0' },
    timestamp: NOW,
    status,
    deterministic: true,
    command: `devai sense run ${kind}`,
    command_hash: sha256(kind),
    exit_code: status === 'pass' ? 0 : 1,
  };
}

function fixture(mergeCount = 1, readings: readonly (readonly unknown[])[] = []): HostFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-post-merge-boundary-')));
  roots.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  const constitutionPath = put(root, 'law/constitution.md', '# Constitution\n');
  const policyPath = put(root, '.devai/config/authority-policy.json', '{}\n');
  put(root, 'README.md', 'baseline\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'baseline']);
  const baselineSha = git(root, ['rev-parse', 'HEAD']);
  for (let index = 1; index <= mergeCount; index += 1) {
    git(root, ['checkout', '-qb', `feature-${String(index)}`]);
    put(root, `feature-${String(index)}.txt`, `feature ${String(index)}\n`);
    const round = readings[index - 1];
    if (round !== undefined) {
      put(
        root,
        'record/proofs/freshness/readings/sensors.json',
        `${JSON.stringify(round, null, 2)}\n`,
      );
    }
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', `feature ${String(index)}`]);
    git(root, ['checkout', '-q', 'main']);
    git(root, ['merge', '--no-ff', `feature-${String(index)}`, '-qm', `merge ${String(index)}`]);
  }
  const mergeSha = git(root, ['rev-parse', 'HEAD']);
  const merges = git(root, [
    'rev-list',
    '--first-parent',
    '--merges',
    '--reverse',
    `${baselineSha}..${mergeSha}`,
  ])
    .split('\n')
    .filter((sha) => sha.length === 40);
  const hookPath = put(root, '.git/hooks/post-merge', '#!/bin/sh\nexit 0\n');
  const key = Buffer.from('post-merge-test-key-32-bytes!!!');
  const keyPath = put(root, '.git/devai/post-merge.key', key);
  const attestationPath = join(root, '.devai/config/post-merge-host-adapter.json');
  const receiptPath = join(root, '.git/devai/post-merge-receipt.json');

  const attestation = signed(
    {
      schemaVersion: '1.0.0',
      adapter_id: 'post-merge-fixture',
      adapter_kind: 'installed-checkout',
      repository: root,
      repository_id: 'fixture',
      hook_path: hookPath,
      hook_digest_sha256: sha256(readFileSync(hookPath)),
      key_digest_sha256: sha256(key),
      policy_digest_sha256: sha256(readFileSync(policyPath)),
      constitution_digest_sha256: sha256(readFileSync(constitutionPath)),
      package_binding: { name: '@aarusso-nyx/devai', version: VERSION },
      installed_at_head: baselineSha,
      installed_at: NOW,
      cadence: { installed_checkout: 'persistent', remote_host: 'unknown' },
    },
    key,
  );
  put(root, '.devai/config/post-merge-host-adapter.json', `${JSON.stringify(attestation)}\n`);
  const receipt = signed(
    {
      schemaVersion: '1.0.0',
      repository: root,
      repository_id: 'fixture',
      adapter_id: 'post-merge-fixture',
      merge_sha: mergeSha,
      issued_at: NOW,
      hook_digest_sha256: attestation['hook_digest_sha256'],
      attestation_digest_sha256: sha256(readFileSync(attestationPath)),
      nonce: 'a'.repeat(32),
    },
    key,
  );
  put(root, '.git/devai/post-merge-receipt.json', `${JSON.stringify(receipt)}\n`);
  return {
    root,
    key,
    keyPath,
    hookPath,
    attestationPath,
    receiptPath,
    baselineSha,
    mergeSha,
    merges,
    attestation,
    receipt,
  };
}

function reseal(fx: HostFixture): void {
  const { signature_hmac_sha256: _attestationSignature, ...attestationUnsigned } = fx.attestation;
  const attestation = signed({ ...attestationUnsigned, hook_path: fx.hookPath }, fx.key);
  writeFileSync(fx.attestationPath, `${JSON.stringify(attestation)}\n`);
  const { signature_hmac_sha256: _receiptSignature, ...receiptUnsigned } = fx.receipt;
  writeFileSync(
    fx.receiptPath,
    `${JSON.stringify(
      signed(
        {
          ...receiptUnsigned,
          attestation_digest_sha256: sha256(readFileSync(fx.attestationPath)),
          hook_digest_sha256: attestation['hook_digest_sha256'],
        },
        fx.key,
      ),
    )}\n`,
  );
}

/**
 * Moves the fixture's Git administration directory beside the checkout and
 * installs `marker` in its place, so the `.git` pointer forms below are read
 * from a real linked checkout rather than a stubbed filesystem.
 */
function linkGitAdmin(fx: HostFixture, marker: (adminRoot: string) => string | null): HostFixture {
  const adminRoot = `${fx.root}.git-admin`;
  renameSync(join(fx.root, '.git'), adminRoot);
  roots.push(adminRoot);
  const contents = marker(adminRoot);
  if (contents === null) symlinkSync(adminRoot, join(fx.root, '.git'));
  else writeFileSync(join(fx.root, '.git'), contents);
  const linked: HostFixture = {
    ...fx,
    keyPath: join(adminRoot, 'devai/post-merge.key'),
    hookPath: join(adminRoot, 'hooks/post-merge'),
    receiptPath: join(adminRoot, 'devai/post-merge-receipt.json'),
  };
  reseal(linked);
  return linked;
}

function verify(fx: HostFixture) {
  return verifyPostMergeHostReceipt({
    repoRoot: fx.root,
    hostReceiptPath: fx.receiptPath,
    now: NOW,
    devaiVersion: VERSION,
  });
}

function adminRootOf(fx: HostFixture): string {
  return dirname(dirname(fx.receiptPath));
}

function stateRootOf(fx: HostFixture): string {
  return join(adminRootOf(fx), 'devai/post-merge-observations');
}

function worktreeOf(fx: HostFixture): string {
  return join(fx.root, '.devai/worktrees/auditor-post-merge');
}

async function runAuditor(fx: HostFixture, injectFailure = false) {
  const host = createPostMergeHostScope(fx.root, fx.mergeSha);
  try {
    return await runWithAuthorityHostEffects(host.scope, () =>
      runPostMergeAuditor({
        repoRoot: fx.root,
        hostReceiptPath: fx.receiptPath,
        now: NOW,
        devaiVersion: VERSION,
        injectFailure,
      }),
    );
  } finally {
    host.dispose();
  }
}

function bundleOf(fx: HostFixture, mergeSha = fx.mergeSha): string {
  return join(stateRootOf(fx), mergeSha);
}

function readBundle(fx: HostFixture, name: string, mergeSha = fx.mergeSha): string {
  return readFileSync(join(bundleOf(fx, mergeSha), `${name}.json`), 'utf8');
}

function readStatus(fx: HostFixture, mergeSha = fx.mergeSha): Record<string, unknown> {
  return JSON.parse(readBundle(fx, 'status', mergeSha)) as Record<string, unknown>;
}

/**
 * Republishes a bundle into both stores the auditor reconciles — the runtime
 * state directory and the committed audit ref — so a forgery is internally
 * consistent and must be rejected by the observation's own checks rather than
 * by the cross-store digest comparison.
 */
function publish(fx: HostFixture, contents: Readonly<Record<string, string>>): void {
  const worktree = worktreeOf(fx);
  const auditPath = `work/audit/post-merge/${fx.mergeSha}`;
  for (const [name, body] of Object.entries(contents)) {
    writeFileSync(join(bundleOf(fx), `${name}.json`), body);
    writeFileSync(join(worktree, auditPath, `${name}.json`), body);
  }
  git(worktree, ['add', '--', auditPath]);
  git(worktree, ['commit', '-qm', `forge ${Object.keys(contents).join('+')}`]);
  git(worktree, ['update-ref', `refs/devai/post-merge/${fx.mergeSha}`, 'HEAD']);
}

/** Re-seals a stored observation after `edit` so only the edited field is under test. */
function forgeStatus(
  fx: HostFixture,
  edit: (value: Record<string, unknown>) => Record<string, unknown>,
): void {
  const { observation_digest_sha256: _sealed, ...unsigned } = readStatus(fx);
  const body = edit(unsigned);
  publish(fx, {
    status: `${JSON.stringify({ ...body, observation_digest_sha256: canonicalSha256(body) }, null, 2)}\n`,
  });
}

/** Replaces one artifact and re-derives both digests, leaving the bundle self-consistent. */
function forgeArtifact(fx: HostFixture, name: (typeof ARTIFACT_NAMES)[number], value: unknown) {
  const artifacts = Object.fromEntries(
    ARTIFACT_NAMES.map((artifact) => [
      artifact,
      artifact === name ? value : (JSON.parse(readBundle(fx, artifact)) as unknown),
    ]),
  );
  const { observation_digest_sha256: _sealed, ...unsigned } = readStatus(fx);
  const body = { ...unsigned, artifact_digest_sha256: canonicalSha256(artifacts) };
  publish(fx, {
    ...Object.fromEntries(
      Object.entries(artifacts).map(([artifact, contents]) => [
        artifact,
        `${JSON.stringify(contents, null, 2)}\n`,
      ]),
    ),
    status: `${JSON.stringify({ ...body, observation_digest_sha256: canonicalSha256(body) }, null, 2)}\n`,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('post-merge completed round identity', () => {
  it('records every merge of the round in first-parent order with an exact digest chain', async () => {
    const fx = fixture(2);
    expect(fx.merges).toHaveLength(2);
    expect(fx.merges[1]).toBe(fx.mergeSha);

    expect(await runAuditor(fx)).toEqual({
      status: 'completed',
      merge_sha: fx.mergeSha,
      processed: fx.merges,
      worktree: worktreeOf(fx),
      cadence: { installed_checkout: 'persistent', remote_host: 'unknown' },
    });

    const [firstSha, secondSha] = fx.merges as readonly [string, string];
    const first = readStatus(fx, firstSha);
    const second = readStatus(fx, secondSha);
    expect(first['previous_observation_digest_sha256']).toBeNull();
    expect(first['merge_sha']).toBe(firstSha);
    expect(second).toEqual({
      schemaVersion: '1.0.0',
      merge_sha: secondSha,
      status: 'completed',
      generated_at: NOW,
      readiness_promoting: false,
      previous_observation_digest_sha256: first['observation_digest_sha256'],
      artifact_digest_sha256: canonicalSha256(
        Object.fromEntries(
          ARTIFACT_NAMES.map((name) => [
            name,
            JSON.parse(readBundle(fx, name, secondSha)) as unknown,
          ]),
        ),
      ),
      observation_digest_sha256: second['observation_digest_sha256'],
    });
    const { observation_digest_sha256: sealed, ...unsigned } = second;
    expect(sealed).toBe(canonicalSha256(unsigned));
    expect(first['observation_digest_sha256']).not.toBe(sealed);

    const replayed = await runAuditor(fx);
    expect(replayed).toEqual({
      status: 'replayed',
      merge_sha: fx.mergeSha,
      processed: [],
      worktree: worktreeOf(fx),
      cadence: { installed_checkout: 'persistent', remote_host: 'unknown' },
    });
    expect(readStatus(fx, secondSha)).toEqual(second);
  }, 60_000);

  it('carries the previous merge and its backlog forward into the round deltas', async () => {
    const fx = fixture(2, [
      [reading('type_check', 'fail'), reading('lint', 'fail')],
      [reading('type_check', 'pass'), reading('lint', 'fail'), reading('security_scan', 'fail')],
    ]);
    await runAuditor(fx);
    const [firstSha, secondSha] = fx.merges as readonly [string, string];
    const first = JSON.parse(readBundle(fx, 'backlog', firstSha)) as Record<string, unknown>;
    const second = JSON.parse(readBundle(fx, 'backlog', secondSha)) as Record<string, unknown>;
    const ids = (value: Record<string, unknown>, key: 'additions' | 'completions') =>
      ((value['deltas'] as Record<string, readonly Record<string, unknown>[]>)[key] ?? []).map(
        (item) => item['id'],
      );
    const currentIds = (value: Record<string, unknown>) =>
      (value['current'] as { readonly items: readonly Record<string, unknown>[] }).items.map(
        (item) => item['id'],
      );

    // The first round has no predecessor, so every open item is an addition.
    expect(currentIds(first)).toEqual(['BL-F2-T5', 'BL-F2-T8']);
    expect(first['previous_merge_sha']).toBeNull();
    expect(ids(first, 'additions')).toEqual(['BL-F2-T5', 'BL-F2-T8']);
    expect(ids(first, 'completions')).toEqual([]);

    // The second round retains F2×T5, opens F2×T6, and closes F2×T8.
    expect(currentIds(second)).toEqual(['BL-F2-T5', 'BL-F2-T6']);
    expect(second['previous_merge_sha']).toBe(firstSha);
    expect(second['merge_sha']).toBe(secondSha);
    expect(ids(second, 'additions')).toEqual(['BL-F2-T6']);
    expect(ids(second, 'completions')).toEqual(['BL-F2-T8']);
    expect(second['schemaVersion']).toBe('1.0.0');
  }, 60_000);
});

describe('post-merge readiness refusal', () => {
  it('seals a failed round as a non-promoting error and publishes no audit ref', async () => {
    const fx = fixture();
    await expect(runAuditor(fx, true)).rejects.toThrow('POST_MERGE_OBSERVATION_INJECTED_FAILURE');

    const status = readStatus(fx);
    const { observation_digest_sha256: sealed, ...unsigned } = status;
    expect(unsigned).toEqual({
      schemaVersion: '1.0.0',
      merge_sha: fx.mergeSha,
      status: 'error',
      generated_at: NOW,
      readiness_promoting: false,
      previous_observation_digest_sha256: null,
      code: 'POST_MERGE_OBSERVATION_INJECTED_FAILURE',
    });
    expect(sealed).toBe(canonicalSha256(unsigned));
    for (const name of ARTIFACT_NAMES) {
      expect(existsSync(join(bundleOf(fx), `${name}.json`))).toBe(false);
    }
    expect(() =>
      git(fx.root, ['rev-parse', '--verify', `refs/devai/post-merge/${fx.mergeSha}`]),
    ).toThrow();
    expect(existsSync(join(adminRootOf(fx), 'devai/post-merge.lock'))).toBe(false);
  }, 30_000);

  it('refuses a stored round whose artifacts no longer satisfy their schemas', async () => {
    const fx = fixture();
    await runAuditor(fx);
    const genuine = Object.fromEntries(BUNDLE_NAMES.map((name) => [name, readBundle(fx, name)]));

    for (const name of ARTIFACT_NAMES.filter((entry) => entry !== 'backlog')) {
      forgeArtifact(fx, name, {});
      expect(await runAuditor(fx), name).toMatchObject({
        status: 'completed',
        processed: [fx.mergeSha],
      });
      for (const restored of BUNDLE_NAMES) {
        expect(readBundle(fx, restored), `${name}/${restored}`).toBe(genuine[restored]);
      }
    }
  }, 60_000);

  it.each([
    ['a non-hex digest', 'z'.repeat(64)],
    ['a digest with a leading character', `z${'a'.repeat(64)}`],
    ['a digest with a trailing character', `${'a'.repeat(64)}z`],
    ['an upper-case digest', 'A'.repeat(64)],
    ['a numeric digest', 42],
  ])(
    'refuses a resealed round chained to %s',
    async (_label, previous) => {
      const fx = fixture();
      await runAuditor(fx);
      const genuine = readBundle(fx, 'status');
      forgeStatus(fx, (value) => ({ ...value, previous_observation_digest_sha256: previous }));
      expect(await runAuditor(fx)).toMatchObject({ status: 'completed', processed: [fx.mergeSha] });
      expect(readBundle(fx, 'status')).toBe(genuine);
    },
    30_000,
  );
});

describe('post-merge interrupted round reconciliation', () => {
  it('archives a bundle with no status under the digest of its sorted entries', async () => {
    const fx = fixture();
    await runAuditor(fx);
    const genuine = Object.fromEntries(BUNDLE_NAMES.map((name) => [name, readBundle(fx, name)]));
    rmSync(join(bundleOf(fx), 'status.json'));
    const entries = readdirSync(bundleOf(fx)).sort();
    expect(entries).toEqual(ARTIFACT_NAMES.map((name) => `${name}.json`).sort());

    expect(await runAuditor(fx)).toMatchObject({ status: 'completed', processed: [fx.mergeSha] });

    const historyRoot = join(stateRootOf(fx), 'attempt-history', fx.mergeSha);
    expect(readdirSync(historyRoot)).toEqual([sha256(entries.join('\n'))]);
    const archived = join(historyRoot, sha256(entries.join('\n')));
    expect(readdirSync(archived).sort()).toEqual(entries);
    for (const name of ARTIFACT_NAMES) {
      expect(readFileSync(join(archived, `${name}.json`), 'utf8'), name).toBe(genuine[name]);
      expect(readBundle(fx, name), name).toBe(genuine[name]);
    }
    expect(readBundle(fx, 'status')).toBe(genuine['status']);
  }, 30_000);

  it('re-observes a completed round whose audit ref was never published', async () => {
    const fx = fixture();
    await runAuditor(fx);
    const ref = `refs/devai/post-merge/${fx.mergeSha}`;
    const genuine = readBundle(fx, 'status');
    git(fx.root, ['update-ref', '-d', ref]);
    expect(() => git(fx.root, ['rev-parse', '--verify', ref])).toThrow();

    expect(await runAuditor(fx)).toMatchObject({ status: 'completed', processed: [fx.mergeSha] });
    expect(readBundle(fx, 'status')).toBe(genuine);
    expect(git(fx.root, ['show', `${ref}:work/audit/post-merge/${fx.mergeSha}/status.json`])).toBe(
      genuine.trimEnd(),
    );
    expect(readdirSync(join(stateRootOf(fx), 'attempt-history', fx.mergeSha))).toHaveLength(1);
  }, 30_000);

  it('refuses an observation worktree whose administration link is unusable', async () => {
    const fx = fixture();
    await runAuditor(fx);
    writeFileSync(join(worktreeOf(fx), '.git'), 'gitdir: /devai/absent-worktree-admin\n');

    const refusal: unknown = await runAuditor(fx).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toBe('POST_MERGE_WORKTREE_DIRTY');
    expect(existsSync(join(adminRootOf(fx), 'devai/post-merge.lock'))).toBe(false);
  }, 30_000);
});

describe('post-merge git administration boundaries', () => {
  it('refuses a checkout whose administration directory is absent', () => {
    const fx = linkGitAdmin(fixture(), (adminRoot) => `gitdir: ${adminRoot}\n`);
    rmSync(join(fx.root, '.git'));
    expect(() => verify(fx)).toThrow('HOST_RECEIPT_UNVERIFIED');
  });

  it('refuses a checkout whose administration entry is a symbolic link', () => {
    const fx = linkGitAdmin(fixture(), () => null);
    expect(() => verify(fx)).toThrow('HOST_RECEIPT_UNVERIFIED');
  });

  it.each([
    ['an unrelated body', () => 'not a gitdir pointer\n'],
    ['a prefixed pointer', (adminRoot: string) => `xgitdir: ${adminRoot}\n`],
    ['an empty pointer', () => 'gitdir:\n'],
  ])('refuses a checkout with %s in place of a gitdir pointer', (_label, marker) => {
    const fx = linkGitAdmin(fixture(), marker);
    expect(() => verify(fx)).toThrow('HOST_RECEIPT_UNVERIFIED');
  });

  // Git itself refuses both pointer spellings below, so verification cannot
  // succeed; what the auditor must not do is confuse them with an unreadable
  // pointer. Resolving the administration root and then failing on the head is
  // a materially different diagnostic from refusing the host outright.
  it.each([
    ['no separating space', (adminRoot: string) => `gitdir:${adminRoot}\n`],
    ['trailing whitespace', (adminRoot: string) => `gitdir: ${adminRoot}  \n`],
  ])(
    'resolves a gitdir pointer written with %s before reading the head',
    async (_label, marker) => {
      const fx = linkGitAdmin(fixture(), marker);
      expect(existsSync(fx.keyPath)).toBe(true);
      await withAuthorityHostTestScope(() => {
        expect(() => verify(fx)).toThrow('HOST_RECEIPT_MERGE_MISMATCH');
      });
    },
  );

  it('reports an unresolvable head as a merge mismatch rather than an opaque failure', async () => {
    const fx = fixture();
    writeFileSync(join(fx.root, '.git/HEAD'), 'ref: refs/heads/never-created\n');
    await withAuthorityHostTestScope(() => {
      expect(() => verify(fx)).toThrow('HOST_RECEIPT_MERGE_MISMATCH');
    });
  });
});

describe('post-merge host scope effect identity', () => {
  const scoped = (fx: HostFixture, request: AuthorityHostEffectRequest) => {
    const host = createPostMergeHostScope(fx.root, fx.mergeSha);
    let applied = false;
    try {
      const outcome = host.scope.apply_effect(request, () => {
        applied = true;
        return 'applied';
      });
      return { outcome, applied };
    } finally {
      host.dispose();
    }
  };

  it('admits the observation worktree root and the runtime root themselves', () => {
    const fx = fixture(0);
    for (const path of [worktreeOf(fx), join(fx.root, '.git/devai')]) {
      let observed: ReturnType<typeof scoped> | undefined;
      expect(() => {
        observed = scoped(fx, { kind: 'filesystem', symbol: 'mkdirSync', arguments: [path] });
      }).not.toThrow();
      expect(observed).toEqual({
        outcome: 'applied',
        applied: true,
      });
    }
  });

  it.each([
    ['the repository root', ''],
    ['a sibling of the runtime root', '.git/objects'],
    ['an unrelated directory', 'outside'],
  ])('refuses a directory created at %s', (_label, relativePath) => {
    const fx = fixture(0);
    expect(() =>
      scoped(fx, {
        kind: 'filesystem',
        symbol: 'mkdirSync',
        arguments: [join(fx.root, relativePath)],
      }),
    ).toThrow('POST_MERGE_EFFECT_OUT_OF_SCOPE');
  });

  it.each([
    ['node', ['status']],
    ['git-upload-pack', ['rev-parse', 'HEAD']],
    ['/usr/bin/gitk', ['worktree', 'add']],
    ['git.sh', ['add', '--', `work/audit/post-merge/${SHA40}`]],
  ])('refuses %s carrying an allowed git subcommand', (executable, args) => {
    const fx = fixture(0);
    expect(() =>
      scoped(fx, { kind: 'process', symbol: 'spawnSync', arguments: [executable, args] }),
    ).toThrow('POST_MERGE_PROCESS_FORBIDDEN');
  });

  it.each(
    [
      ['reset', '--', `work/audit/post-merge/${SHA40}`],
      ['clean', '--', `work/audit/post-merge/${SHA40}`],
      ['reset', '-m', `audit(post-merge): observe ${SHA40}`],
      ['tag', '-m', `audit(post-merge): observe ${SHA40}`],
      ['symbolic-ref', `refs/devai/post-merge/${SHA40}`, 'HEAD'],
      ['branch', `refs/devai/post-merge/${SHA40}`, 'HEAD'],
      ['cat-file', `refs/devai/post-merge/${SHA40}:work/audit/post-merge/${SHA40}/status.json`],
    ].map((args) => [JSON.stringify(args), args] as const),
  )('refuses %s wearing the shape of an audit command', (_label, args) => {
    const fx = fixture(0);
    expect(() =>
      scoped(fx, { kind: 'process', symbol: 'spawnSync', arguments: ['git', args] }),
    ).toThrow('POST_MERGE_PROCESS_FORBIDDEN');
  });

  it.each(
    [
      ['add', '--', [`work/audit/post-merge/${SHA40}`]],
      ['commit', '-m', [`audit(post-merge): observe ${SHA40}`]],
      ['update-ref', [`refs/devai/post-merge/${SHA40}`], 'HEAD'],
      ['show', [`refs/devai/post-merge/${SHA40}:work/audit/post-merge/${SHA40}/status.json`]],
    ].map((args) => [JSON.stringify(args), args] as const),
  )('refuses %s whose audit argument is not a string', (_label, args) => {
    const fx = fixture(0);
    expect(() =>
      scoped(fx, { kind: 'process', symbol: 'spawnSync', arguments: ['git', args] }),
    ).toThrow('POST_MERGE_PROCESS_FORBIDDEN');
  });
});

describe('post-merge audit observation facade', () => {
  function observationFixture(): { readonly root: string; readonly at: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-audit-boundary-')));
    roots.push(root);
    git(root, ['init', '-q', '-b', 'main']);
    put(root, 'README.md', '# Fixture\n');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '-qm', 'initial']);
    return { root, at: git(root, ['rev-parse', 'HEAD']) };
  }

  it('names the observation root and every artifact with repository-relative paths', async () => {
    const { root, at } = observationFixture();
    const observation = await withAuthorityHostTestScope(() =>
      runAuditObservation({ repoRoot: root, at }),
    );
    expect(observation.observation_root).toBe(`.devai/state/audit-observations/${at}`);
    expect(observation.artifacts.map((artifact) => artifact.path)).toEqual(
      BUNDLE_NAMES.map((name) => `.devai/state/audit-observations/${at}/${name}.json`),
    );
    for (const artifact of observation.artifacts) {
      expect(artifact.sha256, artifact.path).toBe(sha256(readFileSync(join(root, artifact.path))));
    }
    expect(
      readdirSync(join(root, '.devai/state/audit-observations')).filter((entry) =>
        entry.includes('.tmp-'),
      ),
    ).toEqual([]);
  }, 30_000);

  it.each([
    ['an abbreviated head', (at: string) => at.slice(0, 7)],
    ['an upper-case head', (at: string) => at.toUpperCase()],
    ['a forty-one character head', (at: string) => `${at}a`],
  ])('refuses %s before reading the repository', async (_label, mutate) => {
    const { root, at } = observationFixture();
    await expect(
      withAuthorityHostTestScope(() => runAuditObservation({ repoRoot: root, at: mutate(at) })),
    ).rejects.toThrow('AUDIT_OBSERVE_FULL_SHA_REQUIRED');
    expect(existsSync(join(root, '.devai/state'))).toBe(false);
  });

  it('reports an unreadable head distinctly from a mismatched head', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-audit-boundary-bare-')));
    roots.push(root);
    await expect(
      withAuthorityHostTestScope(() => runAuditObservation({ repoRoot: root, at: SHA40 })),
    ).rejects.toThrow('AUDIT_OBSERVE_HEAD_UNAVAILABLE');
  });

  it('refuses to replay an observation that no longer matches a fresh one', async () => {
    const { root, at } = observationFixture();
    await withAuthorityHostTestScope(() => runAuditObservation({ repoRoot: root, at }));
    const stored = join(root, '.devai/state/audit-observations', at);
    const backlog = join(stored, 'backlog.json');
    const genuine = readFileSync(backlog, 'utf8');
    writeFileSync(
      backlog,
      `${JSON.stringify({ ...(JSON.parse(genuine) as object), drifted: true }, null, 2)}\n`,
    );

    await expect(
      withAuthorityHostTestScope(() => runAuditObservation({ repoRoot: root, at })),
    ).rejects.toThrow('AUDIT_OBSERVE_REPLAY_DRIFT');
    expect(readdirSync(join(root, '.devai/state/audit-observations')).sort()).toEqual([at]);
  }, 30_000);
});
