// Invariants: INV-DEVAI-016, INV-DEVAI-018
import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPostMergeHostScope,
  runPostMergeAuditor,
  verifyPostMergeHostReceipt,
} from '../../src/post-merge-auditor/index.js';
import { runWithAuthorityHostEffects, type AuthorityHostEffectRequest } from '@devai-nyx/authority';
import { withAuthorityHostTestScope } from './authority-host-test-scope.js';

const roots: string[] = [];
const NOW = '2026-07-24T12:00:00.000Z';
const VERSION = '1.0.0';

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

interface HostFixture {
  readonly root: string;
  readonly key: Buffer;
  readonly keyPath: string;
  readonly hookPath: string;
  readonly policyPath: string;
  readonly constitutionPath: string;
  readonly attestationPath: string;
  readonly receiptPath: string;
  readonly baselineSha: string;
  readonly mergeSha: string;
  readonly attestation: Record<string, unknown>;
  readonly receipt: Record<string, unknown>;
}

function fixture(withMerge = true): HostFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-post-merge-host-')));
  roots.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  const constitutionPath = put(root, 'law/constitution.md', '# Constitution\n');
  const policyPath = put(root, '.devai/config/authority-policy.json', '{}\n');
  put(root, 'README.md', 'baseline\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'baseline']);
  const baselineSha = git(root, ['rev-parse', 'HEAD']);
  if (withMerge) {
    git(root, ['checkout', '-qb', 'feature']);
    put(root, 'feature.txt', 'feature\n');
    git(root, ['add', 'feature.txt']);
    git(root, ['commit', '-qm', 'feature']);
    git(root, ['checkout', '-q', 'main']);
    git(root, ['merge', '--no-ff', 'feature', '-qm', 'merge feature']);
  }
  const mergeSha = git(root, ['rev-parse', 'HEAD']);
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
    policyPath,
    constitutionPath,
    attestationPath,
    receiptPath,
    baselineSha,
    mergeSha,
    attestation,
    receipt,
  };
}

function rewrite(
  fx: HostFixture,
  changeAttestation: (value: Record<string, unknown>) => Record<string, unknown> = (v) => v,
  changeReceipt: (value: Record<string, unknown>) => Record<string, unknown> = (v) => v,
): void {
  const { signature_hmac_sha256: _as, ...attestationUnsigned } = fx.attestation;
  const attestation = signed(changeAttestation(attestationUnsigned), fx.key);
  writeFileSync(fx.attestationPath, `${JSON.stringify(attestation)}\n`);
  const { signature_hmac_sha256: _rs, ...receiptUnsigned } = fx.receipt;
  const receipt = signed(
    changeReceipt({
      ...receiptUnsigned,
      attestation_digest_sha256: sha256(readFileSync(fx.attestationPath)),
      hook_digest_sha256: attestation['hook_digest_sha256'],
    }),
    fx.key,
  );
  writeFileSync(fx.receiptPath, `${JSON.stringify(receipt)}\n`);
}

function verify(fx: HostFixture, overrides: Record<string, unknown> = {}) {
  return verifyPostMergeHostReceipt({
    repoRoot: fx.root,
    hostReceiptPath: fx.receiptPath,
    now: NOW,
    devaiVersion: VERSION,
    ...overrides,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('post-merge host receipt verification', () => {
  it('accepts an exact signed merge receipt bound to the installed host adapter', async () => {
    const fx = fixture();
    await withAuthorityHostTestScope(() => {
      expect(verify(fx)).toEqual({
        mergeSha: fx.mergeSha,
        baselineSha: fx.baselineSha,
      });
    });
  });

  it('accepts a receipt from a checkout whose .git entry points at an external admin directory', async () => {
    const original = fixture();
    const adminRoot = `${original.root}.git-admin`;
    renameSync(join(original.root, '.git'), adminRoot);
    roots.push(adminRoot);
    writeFileSync(join(original.root, '.git'), `gitdir: ${adminRoot}\n`);
    const linked = {
      ...original,
      keyPath: join(adminRoot, 'devai/post-merge.key'),
      hookPath: join(adminRoot, 'hooks/post-merge'),
      receiptPath: join(adminRoot, 'devai/post-merge-receipt.json'),
    };
    rewrite(linked, (value) => ({ ...value, hook_path: linked.hookPath }));
    await withAuthorityHostTestScope(() => {
      expect(verify(linked)).toEqual({
        mergeSha: linked.mergeSha,
        baselineSha: linked.baselineSha,
      });
    });
  });

  it('rejects missing, malformed, unsigned, and unprovisioned receipt inputs', async () => {
    const fx = fixture();
    expect(() =>
      verifyPostMergeHostReceipt({
        repoRoot: fx.root,
        hostReceiptPath: '',
        now: NOW,
        devaiVersion: VERSION,
      }),
    ).toThrow('HOST_RECEIPT_MISSING');
    expect(() =>
      verifyPostMergeHostReceipt({
        repoRoot: fx.root,
        hostReceiptPath: join(fx.root, 'absent.json'),
        now: NOW,
        devaiVersion: VERSION,
      }),
    ).toThrow('HOST_RECEIPT_MISSING');
    writeFileSync(fx.receiptPath, '[]');
    expect(() => verify(fx)).toThrow('HOST_RECEIPT_INVALID');
    writeFileSync(fx.receiptPath, JSON.stringify(fx.receipt));
    rmSync(fx.keyPath);
    expect(() => verify(fx)).toThrow('HOST_RECEIPT_UNVERIFIED');
    put(fx.root, '.git/devai/post-merge.key', fx.key);
    writeFileSync(fx.attestationPath, '{');
    expect(() => verify(fx)).toThrow('HOST_RECEIPT_UNVERIFIED');
    writeFileSync(
      fx.attestationPath,
      JSON.stringify({ ...fx.attestation, signature_hmac_sha256: 'x' }),
    );
    expect(() => verify(fx)).toThrow('HOST_RECEIPT_UNVERIFIED');
  });

  it('rejects signed repository identity and SHA shape mismatches', async () => {
    const cases: Array<{
      readonly attestation?: (value: Record<string, unknown>) => Record<string, unknown>;
      readonly receipt?: (value: Record<string, unknown>) => Record<string, unknown>;
      readonly code: string;
    }> = [
      {
        receipt: (v) => ({ ...v, repository: join(String(v['repository']), 'other') }),
        code: 'HOST_RECEIPT_REPOSITORY_MISMATCH',
      },
      {
        attestation: (v) => ({ ...v, repository_id: 'other' }),
        code: 'HOST_RECEIPT_REPOSITORY_MISMATCH',
      },
      { receipt: (v) => ({ ...v, adapter_id: 'other' }), code: 'HOST_RECEIPT_REPOSITORY_MISMATCH' },
      { receipt: (v) => ({ ...v, merge_sha: 'bad' }), code: 'HOST_RECEIPT_INVALID' },
      { attestation: (v) => ({ ...v, installed_at_head: 42 }), code: 'HOST_RECEIPT_INVALID' },
    ];
    for (const testCase of cases) {
      const fx = fixture();
      rewrite(fx, testCase.attestation, testCase.receipt);
      expect(() => verify(fx)).toThrow(testCase.code);
    }
  });

  it('rejects invalid, future, and stale receipt clocks', () => {
    for (const [now, issuedAt] of [
      ['invalid', NOW],
      [NOW, 'invalid'],
      [NOW, '2026-07-24T12:01:00.000Z'],
      [NOW, '2026-07-24T11:54:59.000Z'],
    ] as const) {
      const fx = fixture();
      rewrite(fx, undefined, (v) => ({ ...v, issued_at: issuedAt }));
      expect(() => verify(fx, { now })).toThrow('HOST_RECEIPT_STALE');
    }
  });

  it('rejects every stale host-file, package, policy, and constitution binding', () => {
    const cases: Array<(value: Record<string, unknown>) => Record<string, unknown>> = [
      (v) => ({ ...v, hook_path: 42 }),
      (v) => ({ ...v, hook_path: join(String(v['hook_path']), 'absent') }),
      (v) => ({ ...v, hook_digest_sha256: 'f'.repeat(64) }),
      (v) => ({ ...v, key_digest_sha256: 'f'.repeat(64) }),
      (v) => ({ ...v, policy_digest_sha256: 'f'.repeat(64) }),
      (v) => ({ ...v, package_binding: null }),
      (v) => ({ ...v, package_binding: { name: 'other', version: VERSION } }),
      (v) => ({ ...v, package_binding: { name: '@aarusso-nyx/devai', version: '9.9.9' } }),
      (v) => ({ ...v, constitution_digest_sha256: 'f'.repeat(64) }),
    ];
    for (const mutate of cases) {
      const fx = fixture();
      rewrite(fx, mutate);
      expect(() => verify(fx)).toThrow('HOST_RECEIPT_STALE');
    }
    const fx = fixture();
    rewrite(fx, undefined, (v) => ({ ...v, hook_digest_sha256: 'f'.repeat(64) }));
    expect(() => verify(fx)).toThrow('HOST_RECEIPT_STALE');
  }, 20_000);

  it('rejects head mismatch, non-merge heads, and unreachable baselines', async () => {
    const mismatched = fixture();
    rewrite(mismatched, undefined, (v) => ({ ...v, merge_sha: mismatched.baselineSha }));
    await withAuthorityHostTestScope(() => {
      expect(() => verify(mismatched)).toThrow('HOST_RECEIPT_MERGE_MISMATCH');
    });

    const nonMerge = fixture(false);
    await withAuthorityHostTestScope(() => {
      expect(() => verify(nonMerge)).toThrow('HOST_RECEIPT_NOT_A_MERGE');
    });

    const unreachable = fixture();
    rewrite(unreachable, (v) => ({ ...v, installed_at_head: 'f'.repeat(40) }));
    await withAuthorityHostTestScope(() => {
      expect(() => verify(unreachable)).toThrow('HOST_RECEIPT_MERGE_MISMATCH');
    });
  });
});

describe('post-merge authority host scope', () => {
  it('allows only bounded filesystem effects and the git command allowlist', () => {
    const fx = fixture();
    const host = createPostMergeHostScope(fx.root, fx.mergeSha);
    const apply = (request: AuthorityHostEffectRequest) =>
      host.scope.apply_effect(request, () => 'applied');
    expect(
      apply({
        kind: 'filesystem',
        symbol: 'writeFileSync',
        arguments: [join(fx.root, '.devai/worktrees/auditor-post-merge/status.json'), 'x'],
      }),
    ).toBe('applied');
    expect(
      apply({
        kind: 'filesystem',
        symbol: 'mkdirSync',
        arguments: [join(fx.root, '.git/devai/lock')],
      }),
    ).toBe('applied');
    expect(() =>
      apply({
        kind: 'filesystem',
        symbol: 'renameSync',
        arguments: [
          join(fx.root, '.devai/worktrees/auditor-post-merge/a'),
          join(fx.root, 'outside'),
        ],
      }),
    ).toThrow('POST_MERGE_EFFECT_OUT_OF_SCOPE');
    expect(() =>
      apply({ kind: 'filesystem', symbol: 'writeFileSync', arguments: [42, 'x'] }),
    ).toThrow('POST_MERGE_EFFECT_OUT_OF_SCOPE');
    expect(apply({ kind: 'process', symbol: 'spawnSync', arguments: ['git', ['status']] })).toBe(
      'applied',
    );
    expect(
      apply({
        kind: 'process',
        symbol: 'spawnSync',
        arguments: ['git', ['add', '--', `work/audit/post-merge/${fx.mergeSha}`]],
      }),
    ).toBe('applied');
    expect(
      apply({
        kind: 'process',
        symbol: 'spawnSync',
        arguments: ['git', ['commit', '-m', `audit(post-merge): observe ${fx.mergeSha}`]],
      }),
    ).toBe('applied');
    expect(() =>
      apply({
        kind: 'process',
        symbol: 'spawnSync',
        arguments: ['git', ['add', '--', 'work/audit/post-merge/not-a-sha']],
      }),
    ).toThrow('POST_MERGE_PROCESS_FORBIDDEN');
    expect(
      apply({
        kind: 'process',
        symbol: 'spawnSync',
        arguments: ['/usr/bin/git', ['worktree', 'add']],
      }),
    ).toBe('applied');
    expect(() =>
      apply({ kind: 'process', symbol: 'spawnSync', arguments: ['node', ['--version']] }),
    ).toThrow('POST_MERGE_PROCESS_FORBIDDEN');
    expect(() =>
      apply({ kind: 'process', symbol: 'spawnSync', arguments: ['git', 'status'] }),
    ).toThrow('POST_MERGE_PROCESS_FORBIDDEN');
    expect(() =>
      apply({ kind: 'process', symbol: 'spawnSync', arguments: ['git', ['reset']] }),
    ).toThrow('POST_MERGE_PROCESS_FORBIDDEN');
    expect(() =>
      apply({ kind: 'process', symbol: 'spawnSync', arguments: ['git', ['worktree', 'prune']] }),
    ).toThrow('POST_MERGE_PROCESS_FORBIDDEN');
    host.dispose();
  });

  it('processes, replays, archives failed observations, and reports repository locks', async () => {
    const fx = fixture();
    const execute = async (injectFailure = false) => {
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
    };

    await expect(execute(true)).rejects.toThrow('POST_MERGE_OBSERVATION_INJECTED_FAILURE');
    const stateRoot = join(fx.root, '.git/devai/post-merge-observations');
    expect(
      JSON.parse(readFileSync(join(stateRoot, fx.mergeSha, 'status.json'), 'utf8')),
    ).toMatchObject({ status: 'error', code: 'POST_MERGE_OBSERVATION_INJECTED_FAILURE' });

    await expect(execute()).resolves.toMatchObject({
      status: 'completed',
      processed: [fx.mergeSha],
    });
    expect(
      JSON.parse(readFileSync(join(stateRoot, fx.mergeSha, 'status.json'), 'utf8')),
    ).toMatchObject({ status: 'completed', readiness_promoting: false });
    expect(readFileSync(join(stateRoot, fx.mergeSha, 'status.json'), 'utf8')).toContain(
      'observation_digest_sha256',
    );
    const auditRef = `refs/devai/post-merge/${fx.mergeSha}`;
    expect(
      git(fx.root, ['show', `${auditRef}:work/audit/post-merge/${fx.mergeSha}/status.json`]),
    ).toContain('observation_digest_sha256');
    expect(git(fx.root, ['show', '-s', '--format=%an <%ae>', auditRef])).toBe(
      'DEVAI Auditor <aarusso@nyxk.com.br>',
    );
    expect(
      git(join(fx.root, '.devai/worktrees/auditor-post-merge'), ['status', '--porcelain']),
    ).toBe('');
    expect(readdirSync(join(stateRoot, 'attempt-history', fx.mergeSha)).length).toBeGreaterThan(0);

    await expect(execute()).resolves.toMatchObject({ status: 'replayed', processed: [] });
    mkdirSync(join(fx.root, '.devai/worktrees/auditor-post-merge/work'), { recursive: true });
    writeFileSync(
      join(fx.root, '.devai/worktrees/auditor-post-merge/work/untracked.txt'),
      'dirty\n',
    );
    await expect(execute()).rejects.toThrow('POST_MERGE_WORKTREE_DIRTY');
    mkdirSync(join(fx.root, '.git/devai/post-merge.lock'));
    await expect(execute()).resolves.toMatchObject({
      status: 'busy',
      merge_sha: fx.mergeSha,
      processed: [],
    });
  });
});
