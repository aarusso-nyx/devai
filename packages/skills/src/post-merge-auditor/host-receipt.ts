import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createAuthorityDecisionIssuer } from '@devai-nyx/authority';
import type { AuthorityHostEffectRequest, AuthorityHostEffectScope } from '@devai-nyx/authority';
import {
  canonicalSha256,
  exactRepository,
  git,
  gitAdministrationRoot,
  gitText,
  installedConstitution,
  isRecord,
  readJson,
  sha256,
  type JsonRecord,
} from './support.js';

export interface PostMergeAuditorOptions {
  readonly repoRoot: string;
  readonly hostReceiptPath: string;
  readonly now?: string;
  readonly injectFailure?: boolean;
  readonly devaiVersion?: string;
}

export const FULL_SHA = /^[0-9a-f]{40}$/u;
const RECEIPT_MAX_AGE_MS = 5 * 60 * 1000;

function hmacValid(value: JsonRecord, key: Buffer): boolean {
  const signature = value['signature_hmac_sha256'];
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/u.test(signature)) return false;
  const { signature_hmac_sha256: _signature, ...unsigned } = value;
  const expected = createHmac('sha256', key).update(JSON.stringify(unsigned)).digest();
  return timingSafeEqual(Buffer.from(signature, 'hex'), expected);
}

/**
 * The canonical tracked post-merge declaration, field for field as `devai init bind
 * --host-adapter post-merge` writes it (postMergeDeclaration in the CLI hooks-install service).
 */
export const POST_MERGE_DECLARATION_PATH = '.devai/config/post-merge-host-adapter.json';
export const POST_MERGE_DECLARATION = Object.freeze({
  schemaVersion: '2.0.0',
  adapter_id: 'post-merge-host-adapter',
  adapter_kind: 'installed-checkout',
  required: true,
  local_state: 'git-dir',
  bind_command: 'devai init bind --target . --host-adapter post-merge --as-role architect --write',
});

/** Whether the checkout carries the canonical post-merge declaration, never throwing. */
function postMergeDeclared(root: string): boolean {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(root, POST_MERGE_DECLARATION_PATH), 'utf8'),
    );
    return JSON.stringify(parsed) === JSON.stringify(POST_MERGE_DECLARATION);
  } catch {
    return false;
  }
}

export interface VerifiedPostMergeHostReceipt {
  readonly mergeSha: string;
  readonly baselineSha: string;
}

export function verifyPostMergeHostReceipt(
  opts: PostMergeAuditorOptions,
): VerifiedPostMergeHostReceipt {
  const root = realpathSync(resolve(opts.repoRoot));
  if (!opts.hostReceiptPath) throw new Error('HOST_RECEIPT_MISSING');
  if (!existsSync(opts.hostReceiptPath)) throw new Error('HOST_RECEIPT_MISSING');
  const { value: receipt } = readJson(opts.hostReceiptPath, 'HOST_RECEIPT_INVALID');
  const gitAdminRoot = gitAdministrationRoot(root);
  const runtimeRoot = join(gitAdminRoot, 'devai');
  const keyPath = join(runtimeRoot, 'post-merge.key');
  // The checkout-bound attestation lives beside the key in this checkout's git directory; the
  // tracked .devai/config/post-merge-host-adapter.json declares the adapter, and a receipt is
  // accepted only while that declaration is present and canonical (#291).
  const attestationPath = join(runtimeRoot, 'post-merge-host-adapter.json');
  if (!existsSync(keyPath) || !existsSync(attestationPath) || !postMergeDeclared(root)) {
    throw new Error('HOST_RECEIPT_UNVERIFIED');
  }
  const key = readFileSync(keyPath);
  const { value: attestation, raw: attestationRaw } = readJson(
    attestationPath,
    'HOST_RECEIPT_UNVERIFIED',
  );
  if (!hmacValid(attestation, key) || !hmacValid(receipt, key)) {
    throw new Error('HOST_RECEIPT_UNVERIFIED');
  }
  if (
    !exactRepository(receipt['repository'], root) ||
    !exactRepository(attestation['repository'], root) ||
    receipt['repository_id'] !== attestation['repository_id'] ||
    receipt['adapter_id'] !== attestation['adapter_id']
  ) {
    throw new Error('HOST_RECEIPT_REPOSITORY_MISMATCH');
  }
  const mergeSha = receipt['merge_sha'];
  const baselineSha = attestation['installed_at_head'];
  if (
    typeof mergeSha !== 'string' ||
    !FULL_SHA.test(mergeSha) ||
    typeof baselineSha !== 'string' ||
    !FULL_SHA.test(baselineSha)
  ) {
    throw new Error('HOST_RECEIPT_INVALID');
  }
  const now = Date.parse(opts.now ?? new Date().toISOString());
  const issuedAt = Date.parse(String(receipt['issued_at']));
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(issuedAt) ||
    issuedAt > now + 30_000 ||
    now - issuedAt > RECEIPT_MAX_AGE_MS
  ) {
    throw new Error('HOST_RECEIPT_STALE');
  }
  const hookPath = attestation['hook_path'];
  if (
    typeof hookPath !== 'string' ||
    !existsSync(hookPath) ||
    sha256(readFileSync(hookPath)) !== attestation['hook_digest_sha256'] ||
    sha256(key) !== attestation['key_digest_sha256'] ||
    sha256(attestationRaw) !== receipt['attestation_digest_sha256'] ||
    receipt['hook_digest_sha256'] !== attestation['hook_digest_sha256']
  ) {
    throw new Error('HOST_RECEIPT_STALE');
  }
  const policyPath = join(root, '.devai/config/authority-policy.json');
  const expectedPolicy = existsSync(policyPath) ? sha256(readFileSync(policyPath)) : null;
  if (attestation['policy_digest_sha256'] !== expectedPolicy) {
    throw new Error('HOST_RECEIPT_STALE');
  }
  const packageBinding = attestation['package_binding'];
  if (
    !isRecord(packageBinding) ||
    packageBinding['name'] !== '@aarusso-nyx/devai' ||
    typeof opts.devaiVersion !== 'string' ||
    packageBinding['version'] !== opts.devaiVersion ||
    attestation['constitution_digest_sha256'] !== sha256(installedConstitution(root))
  ) {
    throw new Error('HOST_RECEIPT_STALE');
  }
  const head = gitText(root, ['rev-parse', 'HEAD'], 'HOST_RECEIPT_MERGE_MISMATCH');
  if (head !== mergeSha) throw new Error('HOST_RECEIPT_MERGE_MISMATCH');
  const parents = gitText(
    root,
    ['rev-list', '--parents', '-n', '1', mergeSha],
    'HOST_RECEIPT_INVALID',
  )
    .split(/\s+/u)
    .filter(Boolean);
  if (parents.length < 3) throw new Error('HOST_RECEIPT_NOT_A_MERGE');
  const baselineReachable = git(root, ['merge-base', '--is-ancestor', baselineSha, mergeSha]);
  if (baselineReachable.status !== 0) throw new Error('HOST_RECEIPT_MERGE_MISMATCH');
  return { mergeSha, baselineSha };
}

function contained(path: string, root: string): boolean {
  const absolute = resolve(path);
  return absolute === root || absolute.startsWith(`${root}${sep}`);
}

export function createPostMergeHostScope(
  repoRoot: string,
  mergeSha: string,
): { readonly scope: AuthorityHostEffectScope; readonly dispose: () => void } {
  const invocationId = `post-merge-${mergeSha}-${randomUUID()}`;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'devai-post-merge-host-adapter',
    issuer_version: '1.0.0',
    invocation_id: invocationId,
    canonicalSha256,
    randomId: randomUUID,
    now: () => new Date().toISOString(),
    receipt_ttl_ms: 30_000,
  });
  const worktreeRoot = join(repoRoot, '.devai/worktrees/auditor-post-merge');
  const worktreesRoot = dirname(worktreeRoot);
  const runtimeRoot = join(gitAdministrationRoot(repoRoot), 'devai');
  const applyEffect = (request: AuthorityHostEffectRequest, apply: () => unknown): unknown => {
    if (request.kind === 'filesystem') {
      const candidates =
        request.symbol === 'renameSync'
          ? [request.arguments[0], request.arguments[1]]
          : [request.arguments[0]];
      if (
        candidates.some(
          (candidate) =>
            typeof candidate !== 'string' ||
            (!contained(candidate, worktreeRoot) &&
              !(request.symbol === 'mkdirSync' && resolve(candidate) === worktreesRoot) &&
              !contained(candidate, runtimeRoot)),
        )
      ) {
        throw new Error('POST_MERGE_EFFECT_OUT_OF_SCOPE');
      }
      return apply();
    }
    const executable = request.arguments[0];
    const args = request.arguments[1];
    if (basename(String(executable)) !== 'git' || !Array.isArray(args)) {
      throw new Error('POST_MERGE_PROCESS_FORBIDDEN');
    }
    const command = String(args[0]);
    const auditPathPattern = /^work\/audit\/post-merge\/[0-9a-f]{40}$/u;
    const exactAuditMutation =
      (command === 'add' &&
        args.length === 3 &&
        args[1] === '--' &&
        typeof args[2] === 'string' &&
        auditPathPattern.test(args[2])) ||
      (command === 'commit' &&
        args.length === 3 &&
        args[1] === '-m' &&
        typeof args[2] === 'string' &&
        /^audit\(post-merge\): observe [0-9a-f]{40}$/u.test(args[2])) ||
      (command === 'update-ref' &&
        args.length === 3 &&
        typeof args[1] === 'string' &&
        /^refs\/devai\/post-merge\/[0-9a-f]{40}$/u.test(args[1]) &&
        args[2] === 'HEAD');
    const exactAuditRead =
      command === 'show' &&
      args.length === 2 &&
      typeof args[1] === 'string' &&
      new RegExp(
        `^refs/devai/post-merge/([0-9a-f]{40}):work/audit/post-merge/\\1/(?:inventory|scorecard|backlog|assessment|status)\\.json$`,
        'u',
      ).test(args[1]);
    if (
      !['worktree', 'checkout', 'rev-list', 'rev-parse', 'merge-base', 'status'].includes(
        command,
      ) &&
      !exactAuditMutation &&
      !exactAuditRead
    ) {
      throw new Error('POST_MERGE_PROCESS_FORBIDDEN');
    }
    if (command === 'worktree' && args[1] !== 'add') {
      throw new Error('POST_MERGE_PROCESS_FORBIDDEN');
    }
    return apply();
  };
  return {
    scope: Object.freeze({
      action_id: 'round close',
      invocation_id: invocationId,
      effect: 'harness-write',
      receipt_store: issuer,
      apply_effect: applyEffect,
    }),
    dispose: () => {
      issuer.dispose();
    },
  };
}
