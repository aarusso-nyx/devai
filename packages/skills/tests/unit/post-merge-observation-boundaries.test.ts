// Invariants: INV-DEVAI-016, INV-DEVAI-018
//
// Observation-side boundaries for the post-merge auditor that neither the
// acceptance suite (post-merge-auditor.test.ts) nor the round-identity suite
// (post-merge-boundaries.test.ts) reaches: which constitution the host binding
// is measured against, the diagnostics the auditor emits when a host effect it
// depends on is refused rather than merely unsuccessful, the scope of a round
// whose baseline is the merge itself, the identity of the audit commit, and the
// treatment of a stored predecessor whose backlog is not the shape it claims.
import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPostMergeHostScope,
  runAuditObservation,
  runPostMergeAuditor,
  verifyPostMergeHostReceipt,
} from '../../src/post-merge-auditor/index.js';
import { runWithAuthorityHostEffects } from '@devai-nyx/authority';
import { withAuthorityHostTestScope } from './authority-host-test-scope.js';

type JsonRecord = Record<string, unknown>;

const roots: string[] = [];
const NOW = '2026-07-24T12:00:00.000Z';
const VERSION = '1.0.0';
const ARTIFACT_NAMES = ['inventory', 'scorecard', 'backlog', 'assessment'] as const;

/**
 * The last constitution candidate the auditor consults is the one shipped
 * inside the installed package, which exists only in a built checkout. Both
 * states are asserted below rather than skipped, because the mutant this
 * distinguishes changes the *shape* of the failure in either state.
 */
const PACKAGED_CONSTITUTION = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../dist/law/constitution.md',
);

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

function signed(value: JsonRecord, key: Buffer): JsonRecord {
  return {
    ...value,
    signature_hmac_sha256: createHmac('sha256', key).update(JSON.stringify(value)).digest('hex'),
  };
}

/** Mirrors the production canonicalisation so a forged bundle can be re-sealed exactly. */
function canonicalSha256(value: unknown): string {
  const canonical = (input: unknown): string => {
    if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
    if (input !== null && typeof input === 'object') {
      const record = input as JsonRecord;
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
  readonly attestationPath: string;
  readonly receiptPath: string;
  readonly baselineSha: string;
  readonly mergeSha: string;
  readonly merges: readonly string[];
}

interface FixtureOptions {
  /** Number of `--no-ff` merges made on top of the baseline commit. */
  readonly merges?: number;
  /** Where the checkout keeps its constitution; `null` installs none at all. */
  readonly constitution?: string | null;
  /** Extra files committed with the baseline, visible in every observed worktree. */
  readonly files?: Readonly<Record<string, string>>;
  /** Freshness readings committed with each merge, one entry per round. */
  readonly readings?: readonly (readonly unknown[])[];
  /** Binds the adapter to the merge itself rather than to the pre-merge baseline. */
  readonly installedAtHead?: boolean;
}

/**
 * A freshness reading in the shape the scorecard reads off disk; a failing
 * reading is what puts a backlog item into the observed round.
 */
function reading(kind: string, status: string): JsonRecord {
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

function fixture(options: FixtureOptions = {}): HostFixture {
  const mergeCount = options.merges ?? 1;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-post-merge-observation-')));
  roots.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  const constitutionRelative =
    options.constitution === undefined ? 'law/constitution.md' : options.constitution;
  const constitutionPath =
    constitutionRelative === null ? null : put(root, constitutionRelative, '# Constitution\n');
  const policyPath = put(root, '.devai/config/authority-policy.json', '{}\n');
  put(root, 'README.md', 'baseline\n');
  for (const [path, contents] of Object.entries(options.files ?? {})) put(root, path, contents);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'baseline']);
  const baselineSha = git(root, ['rev-parse', 'HEAD']);
  for (let index = 1; index <= mergeCount; index += 1) {
    git(root, ['checkout', '-qb', `feature-${String(index)}`]);
    put(root, `feature-${String(index)}.txt`, `feature ${String(index)}\n`);
    const round = options.readings?.[index - 1];
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
  const key = Buffer.from('post-merge-observation-key-32b!');
  put(root, '.git/devai/post-merge.key', key);
  const attestationPath = join(root, '.devai/config/post-merge-host-adapter.json');
  const receiptPath = join(root, '.git/devai/post-merge-receipt.json');
  const constitutionDigest =
    constitutionPath !== null
      ? sha256(readFileSync(constitutionPath))
      : existsSync(PACKAGED_CONSTITUTION)
        ? sha256(readFileSync(PACKAGED_CONSTITUTION))
        : 'absent';
  const attestation = signed(
    {
      schemaVersion: '1.0.0',
      adapter_id: 'post-merge-observation-fixture',
      adapter_kind: 'installed-checkout',
      repository: root,
      repository_id: 'fixture',
      hook_path: hookPath,
      hook_digest_sha256: sha256(readFileSync(hookPath)),
      key_digest_sha256: sha256(key),
      policy_digest_sha256: sha256(readFileSync(policyPath)),
      constitution_digest_sha256: constitutionDigest,
      package_binding: { name: '@aarusso-nyx/devai', version: VERSION },
      installed_at_head: options.installedAtHead === true ? mergeSha : baselineSha,
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
      adapter_id: 'post-merge-observation-fixture',
      merge_sha: mergeSha,
      issued_at: NOW,
      hook_digest_sha256: attestation['hook_digest_sha256'],
      attestation_digest_sha256: sha256(readFileSync(attestationPath)),
      nonce: 'b'.repeat(32),
    },
    key,
  );
  put(root, '.git/devai/post-merge-receipt.json', `${JSON.stringify(receipt)}\n`);
  return { root, key, attestationPath, receiptPath, baselineSha, mergeSha, merges };
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
  return join(fx.root, '.git');
}

function stateRootOf(fx: HostFixture): string {
  return join(adminRootOf(fx), 'devai/post-merge-observations');
}

function worktreeOf(fx: HostFixture): string {
  return join(fx.root, '.devai/worktrees/auditor-post-merge');
}

function lockOf(fx: HostFixture): string {
  return join(adminRootOf(fx), 'devai/post-merge.lock');
}

async function runAuditor(fx: HostFixture) {
  const host = createPostMergeHostScope(fx.root, fx.mergeSha);
  try {
    return await runWithAuthorityHostEffects(host.scope, () =>
      runPostMergeAuditor({
        repoRoot: fx.root,
        hostReceiptPath: fx.receiptPath,
        now: NOW,
        devaiVersion: VERSION,
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

function readJsonBundle(fx: HostFixture, name: string, mergeSha = fx.mergeSha): JsonRecord {
  return JSON.parse(readBundle(fx, name, mergeSha)) as JsonRecord;
}

function auditRef(fx: HostFixture, mergeSha = fx.mergeSha): string {
  return `refs/devai/post-merge/${mergeSha}`;
}

function refExists(fx: HostFixture, mergeSha = fx.mergeSha): boolean {
  try {
    git(fx.root, ['rev-parse', '--verify', auditRef(fx, mergeSha)]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Republishes a bundle into both stores the auditor reconciles — the runtime
 * state directory and the committed audit ref — and re-derives both digests, so
 * the forgery is internally consistent and is accepted as a completed round.
 */
function forgeArtifact(
  fx: HostFixture,
  mergeSha: string,
  name: (typeof ARTIFACT_NAMES)[number],
  value: unknown,
): void {
  const artifacts = Object.fromEntries(
    ARTIFACT_NAMES.map((artifact) => [
      artifact,
      artifact === name ? value : (JSON.parse(readBundle(fx, artifact, mergeSha)) as unknown),
    ]),
  );
  const { observation_digest_sha256: _sealed, ...unsigned } = readJsonBundle(
    fx,
    'status',
    mergeSha,
  );
  const body = { ...unsigned, artifact_digest_sha256: canonicalSha256(artifacts) };
  const contents: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(artifacts).map(([artifact, artifactBody]) => [
        artifact,
        `${JSON.stringify(artifactBody, null, 2)}\n`,
      ]),
    ),
    status: `${JSON.stringify({ ...body, observation_digest_sha256: canonicalSha256(body) }, null, 2)}\n`,
  };
  const worktree = worktreeOf(fx);
  const auditPath = `work/audit/post-merge/${mergeSha}`;
  // The observation worktree stands at the round's last merge, so an earlier
  // round's committed bundle is not in the working tree and has to be restored
  // before it can be republished.
  mkdirSync(join(worktree, auditPath), { recursive: true });
  for (const [entry, contentsBody] of Object.entries(contents)) {
    writeFileSync(join(bundleOf(fx, mergeSha), `${entry}.json`), contentsBody);
    writeFileSync(join(worktree, auditPath, `${entry}.json`), contentsBody);
  }
  git(worktree, ['add', '--', auditPath]);
  git(worktree, ['commit', '-qm', `forge ${name}`]);
  git(worktree, ['update-ref', auditRef(fx, mergeSha), 'HEAD']);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      chmodSync(join(root, '.git/devai'), 0o700);
    } catch {
      // The runtime directory only exists in fixtures that provisioned one.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe('post-merge constitution binding', () => {
  it('measures the binding against a constitution kept under .devai', async () => {
    const fx = fixture({ constitution: '.devai/constitution.md' });
    await withAuthorityHostTestScope(() => {
      expect(verify(fx)).toEqual({ mergeSha: fx.mergeSha, baselineSha: fx.baselineSha });
    });
  });

  it('reaches the packaged constitution only after every checkout copy is absent', async () => {
    const fx = fixture({ constitution: null });
    await withAuthorityHostTestScope(() => {
      if (existsSync(PACKAGED_CONSTITUTION)) {
        // A built checkout: the packaged copy is the last candidate and the
        // binding is measured against its bytes.
        expect(verify(fx)).toEqual({ mergeSha: fx.mergeSha, baselineSha: fx.baselineSha });
      } else {
        // An unbuilt checkout: there is no constitution to measure at all, and
        // that is reported as such rather than as a stale binding.
        expect(() => verify(fx)).toThrow('HOST_RECEIPT_CONSTITUTION_UNAVAILABLE');
      }
    });
  });
});

describe('post-merge receipt input validity', () => {
  it('refuses a receipt path that was never supplied', () => {
    const fx = fixture({ merges: 0 });
    expect(() =>
      verifyPostMergeHostReceipt({
        repoRoot: fx.root,
        hostReceiptPath: undefined as unknown as string,
        now: NOW,
        devaiVersion: VERSION,
      }),
    ).toThrow('HOST_RECEIPT_MISSING');
  });

  it('refuses a gitdir pointer that carries more than the pointer line', async () => {
    const fx = fixture();
    const adminRoot = `${fx.root}.git-admin`;
    roots.push(adminRoot);
    renameSync(join(fx.root, '.git'), adminRoot);
    writeFileSync(join(fx.root, '.git'), `gitdir: ${adminRoot}\nrepositoryformatversion = 0\n`);
    const linked: HostFixture = {
      ...fx,
      receiptPath: join(adminRoot, 'devai/post-merge-receipt.json'),
    };
    await withAuthorityHostTestScope(() => {
      expect(() => verify(linked)).toThrow('HOST_RECEIPT_UNVERIFIED');
    });
  });

  it('reports an unreadable merge commit as an invalid receipt, not a mismatch', async () => {
    const fx = fixture();
    rmSync(join(adminRootOf(fx), 'objects', fx.mergeSha.slice(0, 2), fx.mergeSha.slice(2)));
    await withAuthorityHostTestScope(() => {
      expect(() => verify(fx)).toThrow('HOST_RECEIPT_INVALID');
    });
  });
});

describe('post-merge observation refusal diagnostics', () => {
  it.each([
    [
      'a readings path that is not a directory',
      { 'record/proofs/freshness/readings': 'not a directory\n' },
      /ENOTDIR/u,
    ],
    [
      'a scorecard carve-out file that is not valid JSON',
      { '.devai/config/scorecard-na.json': '{"cells": }\n' },
      /not valid JSON/u,
    ],
  ])('seals %s under the generic observation code', async (_label, files, raw) => {
    const fx = fixture({ files });
    await expect(runAuditor(fx)).rejects.toThrow(raw);

    const status = readJsonBundle(fx, 'status');
    const { observation_digest_sha256: sealed, ...unsigned } = status;
    expect(unsigned).toEqual({
      schemaVersion: '1.0.0',
      merge_sha: fx.mergeSha,
      status: 'error',
      generated_at: NOW,
      readiness_promoting: false,
      previous_observation_digest_sha256: null,
      code: 'POST_MERGE_OBSERVATION_FAILED',
    });
    expect(sealed).toBe(canonicalSha256(unsigned));
    expect(refExists(fx)).toBe(false);
    expect(existsSync(lockOf(fx))).toBe(false);
  });
});

describe('post-merge round scope', () => {
  it('observes nothing when the adapter was installed at the merge itself', async () => {
    const fx = fixture({ installedAtHead: true });
    expect(await runAuditor(fx)).toEqual({
      status: 'replayed',
      merge_sha: fx.mergeSha,
      processed: [],
      worktree: worktreeOf(fx),
      cadence: { installed_checkout: 'persistent', remote_host: 'unknown' },
    });
    expect(existsSync(bundleOf(fx))).toBe(false);
    expect(refExists(fx)).toBe(false);
  });

  it('creates its observation worktree beside checkouts that already exist', async () => {
    const fx = fixture();
    put(fx.root, '.devai/worktrees/adopter-checkout/owner.txt', 'preserve owner bytes\n');

    expect(await runAuditor(fx)).toMatchObject({ status: 'completed', processed: [fx.mergeSha] });
    expect(readFileSync(join(fx.root, '.devai/worktrees/adopter-checkout/owner.txt'), 'utf8')).toBe(
      'preserve owner bytes\n',
    );
    expect(readdirSync(join(fx.root, '.devai/worktrees')).sort()).toEqual([
      'adopter-checkout',
      'auditor-post-merge',
    ]);
  });

  it('refuses a worktree path that is still registered but no longer present', async () => {
    const fx = fixture();
    mkdirSync(join(fx.root, '.devai/worktrees'), { recursive: true });
    git(fx.root, ['worktree', 'add', '--detach', worktreeOf(fx), fx.mergeSha]);
    rmSync(worktreeOf(fx), { recursive: true, force: true });

    await expect(runAuditor(fx)).rejects.toThrow('POST_MERGE_WORKTREE_CREATE_FAILED');
    expect(existsSync(bundleOf(fx))).toBe(false);
    expect(existsSync(lockOf(fx))).toBe(false);
  });

  it('refuses to advance an observation worktree whose index is locked', async () => {
    const fx = fixture();
    mkdirSync(join(fx.root, '.devai/worktrees'), { recursive: true });
    git(fx.root, ['worktree', 'add', '--detach', worktreeOf(fx), fx.mergeSha]);
    writeFileSync(join(adminRootOf(fx), 'worktrees/auditor-post-merge/index.lock'), '');

    await expect(runAuditor(fx)).rejects.toThrow('POST_MERGE_WORKTREE_ADVANCE_FAILED');
    expect(existsSync(bundleOf(fx))).toBe(false);
    expect(refExists(fx)).toBe(false);
    expect(existsSync(lockOf(fx))).toBe(false);
  });

  it('surfaces a host failure creating the round lock instead of reporting contention', async () => {
    const fx = fixture();
    const failure = Object.assign(new Error('EACCES: fixture host refused the round lock'), {
      code: 'EACCES',
    });
    const host = createPostMergeHostScope(fx.root, fx.mergeSha);
    let refused = false;
    try {
      await expect(
        runWithAuthorityHostEffects(
          {
            ...host.scope,
            apply_effect(request, apply) {
              return host.scope.apply_effect(request, () => {
                if (
                  request.kind === 'filesystem' &&
                  request.symbol === 'mkdirSync' &&
                  request.arguments[0] === lockOf(fx)
                ) {
                  refused = true;
                  throw failure;
                }
                return apply();
              });
            },
          },
          () =>
            runPostMergeAuditor({
              repoRoot: fx.root,
              hostReceiptPath: fx.receiptPath,
              now: NOW,
              devaiVersion: VERSION,
            }),
        ),
      ).rejects.toBe(failure);
    } finally {
      host.dispose();
    }
    expect(refused).toBe(true);
    expect(existsSync(lockOf(fx))).toBe(false);
    expect(existsSync(stateRootOf(fx))).toBe(false);
  });
});

describe('post-merge audit publication', () => {
  it('commits the audit bundle under the auditor identity', async () => {
    const fx = fixture();
    await runAuditor(fx);
    const worktree = worktreeOf(fx);
    expect(git(worktree, ['log', '-1', '--format=%an%n%ae%n%cn%n%ce'])).toBe(
      ['DEVAI Auditor', 'aarusso@nyxk.com.br', 'DEVAI Auditor', 'aarusso@nyxk.com.br'].join('\n'),
    );
    expect(git(worktree, ['log', '-1', '--format=%s'])).toBe(
      `audit(post-merge): observe ${fx.mergeSha}`,
    );
    expect(git(fx.root, ['rev-parse', auditRef(fx)])).toBe(git(worktree, ['rev-parse', 'HEAD']));
  });

  it('refuses an audit bundle the checkout would silently ignore', async () => {
    const fx = fixture({ files: { '.gitignore': 'work/audit/\n' } });

    await expect(runAuditor(fx)).rejects.toThrow('POST_MERGE_AUDIT_STAGE_FAILED');
    expect(readJsonBundle(fx, 'status')['status']).toBe('completed');
    expect(refExists(fx)).toBe(false);
    expect(existsSync(lockOf(fx))).toBe(false);
  });

  it('refuses an audit commit the host declines', async () => {
    const fx = fixture();
    const hooks = join(fx.root, '.devai/refusing-hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(hooks, 'pre-commit'), 0o755);
    git(fx.root, ['config', 'core.hooksPath', hooks]);

    await expect(runAuditor(fx)).rejects.toThrow('POST_MERGE_AUDIT_COMMIT_FAILED');
    expect(readJsonBundle(fx, 'status')['status']).toBe('completed');
    expect(refExists(fx)).toBe(false);
    expect(existsSync(lockOf(fx))).toBe(false);
  });

  it('refuses an audit ref blocked by an occupied namespace', async () => {
    const fx = fixture();
    git(fx.root, ['update-ref', 'refs/devai/post-merge', fx.baselineSha]);

    await expect(runAuditor(fx)).rejects.toThrow('POST_MERGE_AUDIT_REF_FAILED');
    expect(refExists(fx)).toBe(false);
    expect(existsSync(lockOf(fx))).toBe(false);
  });
});

describe('post-merge backlog deltas', () => {
  it('ignores entries of a stored predecessor backlog that are not items', async () => {
    const fx = fixture({
      merges: 2,
      readings: [
        [reading('type_check', 'fail'), reading('lint', 'fail')],
        [reading('type_check', 'pass'), reading('lint', 'fail'), reading('security_scan', 'fail')],
      ],
    });
    await runAuditor(fx);
    const [firstSha, secondSha] = fx.merges as readonly [string, string];

    const stored = readJsonBundle(fx, 'backlog', firstSha);
    const current = stored['current'] as { readonly items: readonly JsonRecord[] };
    expect(current.items.map((item) => item['id'])).toEqual(['BL-F2-T5', 'BL-F2-T8']);
    forgeArtifact(fx, firstSha, 'backlog', {
      ...stored,
      current: { ...current, items: [...current.items, 'BL-F2-T8'] },
    });
    git(fx.root, ['update-ref', '-d', auditRef(fx, secondSha)]);

    expect(await runAuditor(fx)).toMatchObject({ status: 'completed', processed: [secondSha] });
    const deltas = readJsonBundle(fx, 'backlog', secondSha)['deltas'] as Record<
      'additions' | 'completions',
      readonly JsonRecord[]
    >;
    expect(deltas.completions.map((item) => item['id'])).toEqual(['BL-F2-T8']);
    expect(deltas.additions.map((item) => item['id'])).toEqual(['BL-F2-T6']);
  });
});

describe('post-merge audit observation facade', () => {
  function observationFixture(): { readonly root: string; readonly at: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-audit-observation-')));
    roots.push(root);
    git(root, ['init', '-q', '-b', 'main']);
    put(root, 'README.md', '# Fixture\n');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '-qm', 'initial']);
    return { root, at: git(root, ['rev-parse', 'HEAD']) };
  }

  it('clears a staging bundle an interrupted observation left behind', async () => {
    const { root, at } = observationFixture();
    const stateRoot = join(root, '.devai/state/audit-observations');
    const staging = join(stateRoot, `${at}.tmp-${process.pid.toString()}`);
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, 'status.json'), '{"status":"interrupted"}\n');

    const observation = await withAuthorityHostTestScope(() =>
      runAuditObservation({ repoRoot: root, at }),
    );
    expect(observation.status).toBe('completed');
    expect(readdirSync(stateRoot).sort()).toEqual([at]);
    expect(
      (JSON.parse(readFileSync(join(stateRoot, at, 'status.json'), 'utf8')) as JsonRecord)[
        'status'
      ],
    ).toBe('completed');
  });

  it('reports a head whose commit object is unreadable as a missing timestamp', async () => {
    const { root, at } = observationFixture();
    rmSync(join(root, '.git/objects', at.slice(0, 2), at.slice(2)));

    await expect(
      withAuthorityHostTestScope(() => runAuditObservation({ repoRoot: root, at })),
    ).rejects.toThrow('AUDIT_OBSERVE_TIMESTAMP_UNAVAILABLE');
    expect(existsSync(join(root, '.devai/state'))).toBe(false);
  });
});

describe('post-merge host scope authority', () => {
  it('issues effects under the post-merge adapter identity and closes it on disposal', () => {
    const fx = fixture({ merges: 0 });
    const host = createPostMergeHostScope(fx.root, fx.mergeSha);
    const issuer = host.scope.receipt_store as {
      readonly issuer_id: unknown;
      readonly issuer_version: unknown;
      readonly issueAllow: (input: unknown) => { readonly code?: unknown };
    };
    try {
      expect(issuer.issuer_id).toBe('devai-post-merge-host-adapter');
      expect(issuer.issuer_version).toBe('1.0.0');
      expect(host.scope.invocation_id).toMatch(
        new RegExp(`^post-merge-${fx.mergeSha}-[0-9a-f-]{36}$`, 'u'),
      );
      expect(issuer.issueAllow({}).code).toBe('AUTHORITY_DECISION_INPUT_INVALID');
    } finally {
      host.dispose();
    }
    expect(issuer.issueAllow({}).code).toBe('AUTHORITY_DECISION_ISSUER_CLOSED');
  });
});
