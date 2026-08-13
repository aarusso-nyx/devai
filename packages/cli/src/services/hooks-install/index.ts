import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  spawnSync,
  writeFileSync,
} from '@devai-nyx/authority';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Local feedback wiring installed by `devai init apply architect --include hooks`.
 * Repeated installation is idempotent, and existing hook content is preserved.
 */

export type HookName = 'pre-commit' | 'pre-push' | 'post-merge';

export const HOOK_NAMES: readonly HookName[] = ['pre-commit', 'pre-push', 'post-merge'];

const MARKER_START = '# >>> devai hooks install >>>';
const MARKER_END = '# <<< devai hooks install <<<';
const MARKER_BLOCK_RE = new RegExp(`${MARKER_START}[\\s\\S]*?${MARKER_END}`);

function gitAdminRoot(root: string): string {
  const dotGit = join(root, '.git');
  if (existsSync(dotGit) && lstatSync(dotGit).isDirectory()) return dotGit;
  if (existsSync(dotGit) && lstatSync(dotGit).isFile()) {
    const pointer = /^gitdir:\s*(.+)$/u.exec(readFileSync(dotGit, 'utf8').trim())?.[1];
    if (pointer !== undefined) {
      const resolved = resolve(root, pointer);
      if (existsSync(resolved) && lstatSync(resolved).isDirectory()) return resolved;
    }
  }
  throw new Error('HOOK_INSTALL_GIT_ADMIN_UNAVAILABLE');
}

function gitCommonRoot(root: string): string {
  const adminRoot = gitAdminRoot(root);
  const commonPointer = join(adminRoot, 'commondir');
  if (!existsSync(commonPointer)) return adminRoot;
  const common = readFileSync(commonPointer, 'utf8').trim();
  return common === '' ? adminRoot : resolve(adminRoot, common);
}

function gitHookPath(root: string, hook: HookName): string {
  try {
    return join(gitCommonRoot(root), 'hooks', hook);
  } catch {
    // Preserve dry bootstrap planning for repositories that have not yet run
    // `git init`. Post-merge installation remains strict because its input
    // validation requires a real repository and an exact HEAD binding.
    return join(root, '.git', 'hooks', hook);
  }
}

export interface HooksInstallOptions {
  readonly targetRoot: string;
  readonly hook?: HookName;
  readonly command?: string;
  readonly devaiVersion?: string;
}

export type HooksInstallAction = 'create' | 'update' | 'append';

export interface HooksInstallPlan {
  readonly targetRoot: string;
  readonly path: string;
  readonly manager: 'husky' | 'git';
  readonly action: HooksInstallAction;
  readonly hook: HookName;
  readonly command: string;
  readonly content: string;
  readonly devaiVersion?: string;
}

function resolveHookPath(
  targetRoot: string,
  hook: HookName,
): { path: string; manager: 'husky' | 'git' } {
  const huskyDir = join(targetRoot, '.husky');
  if (existsSync(huskyDir)) {
    return { path: join(huskyDir, hook), manager: 'husky' };
  }
  return { path: gitHookPath(targetRoot, hook), manager: 'git' };
}

function block(command: string): string {
  return `${MARKER_START}\n${command}\n${MARKER_END}`;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function installedConstitution(root: string): string {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const candidates = [
    join(root, '.devai/pin/constitution.md'),
    join(root, 'law/constitution.md'),
    join(root, '.devai/constitution.md'),
    join(packageRoot, 'dist/law/constitution.md'),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path === undefined) throw new Error('POST_MERGE_ADAPTER_CONSTITUTION_MISSING');
  return readFileSync(path, 'utf8');
}

export interface PostMergeAdapterVerification {
  readonly ok: boolean;
  readonly facts: Readonly<Record<string, boolean>>;
  readonly errors: readonly string[];
}

export function verifyInstalledPostMergeAdapter(
  targetRoot: string,
  devaiVersion: string,
): PostMergeAdapterVerification {
  const root = realpathSync(resolve(targetRoot));
  const hookPath = resolveHookPath(root, 'post-merge').path;
  const keyPath = join(gitAdminRoot(root), 'devai/post-merge.key');
  const attestationPath = join(root, '.devai/config/post-merge-host-adapter.json');
  const policyPath = join(root, '.devai/config/authority-policy.json');
  const errors: string[] = [];
  const facts: Record<string, boolean> = {};
  try {
    facts['hook_present'] = existsSync(hookPath);
    facts['key_present'] = existsSync(keyPath);
    facts['attestation_present'] = existsSync(attestationPath);
    facts['policy_present'] = existsSync(policyPath);
    if (Object.values(facts).some((value) => !value)) {
      errors.push('POST_MERGE_ADAPTER_BINDING_MISSING');
      return { ok: false, facts, errors };
    }
    const hook = readFileSync(hookPath, 'utf8');
    const key = readFileSync(keyPath);
    const attestation = JSON.parse(readFileSync(attestationPath, 'utf8')) as Record<
      string,
      unknown
    >;
    const { signature_hmac_sha256: signature, ...unsigned } = attestation;
    const localBinary = join(root, 'node_modules/.bin/devai');
    facts['hook_local_binary'] = hook.includes('./node_modules/.bin/devai round close');
    facts['local_binary_present'] = existsSync(localBinary);
    const localVersion = facts['local_binary_present']
      ? spawnSync(localBinary, ['--version'], { cwd: root, encoding: 'utf8' })
      : null;
    facts['local_binary_version'] =
      localVersion?.status === 0 && localVersion.stdout.trim().startsWith(`devai/${devaiVersion}`);
    facts['key_private'] = (statSync(keyPath).mode & 0o077) === 0;
    facts['signature_valid'] =
      typeof signature === 'string' &&
      createHmac('sha256', key).update(JSON.stringify(unsigned)).digest('hex') === signature;
    facts['repository_bound'] =
      typeof attestation['repository'] === 'string' &&
      realpathSync(resolve(String(attestation['repository']))) === root;
    facts['hook_bound'] = attestation['hook_digest_sha256'] === sha256(hook);
    facts['key_bound'] = attestation['key_digest_sha256'] === sha256(key);
    facts['policy_bound'] =
      attestation['policy_digest_sha256'] === sha256(readFileSync(policyPath));
    facts['constitution_bound'] =
      attestation['constitution_digest_sha256'] === sha256(installedConstitution(root));
    const packageBinding = attestation['package_binding'] as Record<string, unknown> | undefined;
    facts['package_bound'] =
      packageBinding?.['name'] === '@aarusso-nyx/devai' &&
      packageBinding['version'] === devaiVersion;
    const installedHead = attestation['installed_at_head'];
    const headCheck =
      typeof installedHead === 'string'
        ? spawnSync('git', ['cat-file', '-e', `${installedHead}^{commit}`], {
            cwd: root,
            encoding: 'utf8',
          })
        : null;
    facts['installed_head_bound'] = headCheck?.status === 0;
    for (const [name, value] of Object.entries(facts)) {
      if (!value) errors.push(`POST_MERGE_ADAPTER_${name.toUpperCase()}_INVALID`);
    }
    return { ok: errors.length === 0, facts, errors };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return { ok: false, facts, errors };
  }
}

function validatePostMergeAdapterInputs(plan: HooksInstallPlan): void {
  const root = resolve(plan.targetRoot);
  if (!existsSync(join(root, '.devai/config/authority-policy.json'))) {
    throw new Error('POST_MERGE_ADAPTER_AUTHORITY_POLICY_MISSING');
  }
  installedConstitution(root);
  if (
    plan.devaiVersion === undefined ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(plan.devaiVersion)
  ) {
    throw new Error('POST_MERGE_ADAPTER_PACKAGE_VERSION_MISSING');
  }
}

function postMergeCommand(): string {
  return `devai_git_dir="$(git rev-parse --absolute-git-dir)" || exit $?\nnode "$devai_git_dir/devai/issue-post-merge-receipt.cjs"\n./node_modules/.bin/devai round close --post-merge-receipt --host-receipt "$devai_git_dir/devai/post-merge-receipt.json"`;
}

function prePushCommand(): string {
  return `devai_zero_sha=0000000000000000000000000000000000000000
devai_seen_ref=0
while read -r devai_local_ref devai_local_sha devai_remote_ref devai_remote_sha; do
  devai_seen_ref=1
  if [ "$devai_local_sha" = "$devai_zero_sha" ]; then
    echo "DEVAI_PRE_PUSH_REF_DELETION_REFUSED:$devai_remote_ref" >&2
    exit 1
  fi
  if [ "$devai_remote_sha" = "$devai_zero_sha" ]; then
    devai_first_outgoing="$(git rev-list --reverse "$devai_local_sha" --not --remotes | sed -n '1p')"
    if [ -n "$devai_first_outgoing" ] && devai_since_ref="$(git rev-parse "$devai_first_outgoing^" 2>/dev/null)"; then
      ./node_modules/.bin/devai check --only forbidden-actions --strict --since-ref "$devai_since_ref" || exit $?
    else
      ./node_modules/.bin/devai check --only forbidden-actions --strict --max-commits 50 || exit $?
    fi
  else
    ./node_modules/.bin/devai check --only forbidden-actions --strict --since-ref "$devai_remote_sha" || exit $?
  fi
done
if [ "$devai_seen_ref" -eq 0 ]; then
  ./node_modules/.bin/devai check --only forbidden-actions --strict --max-commits 50
fi`;
}

function headAt(root: string): string {
  const resolved = spawnSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (resolved.status === 0 && /^[0-9a-f]{40}$/u.test(resolved.stdout.trim())) {
    return resolved.stdout.trim();
  }
  const adminRoot = gitAdminRoot(root);
  const head = readFileSync(join(adminRoot, 'HEAD'), 'utf8').trim();
  if (/^[0-9a-f]{40}$/u.test(head)) return head;
  const ref = /^ref:\s+(.+)$/u.exec(head)?.[1];
  if (ref !== undefined) {
    const loose = join(adminRoot, ref);
    if (existsSync(loose)) return readFileSync(loose, 'utf8').trim();
    const packed = join(gitCommonRoot(root), 'packed-refs');
    if (existsSync(packed)) {
      const match = readFileSync(packed, 'utf8')
        .split(/\r?\n/u)
        .find((line) => line.endsWith(` ${ref}`));
      if (match !== undefined) return match.slice(0, 40);
    }
  }
  throw new Error('POST_MERGE_ADAPTER_HEAD_UNAVAILABLE');
}

function receiptIssuerSource(): string {
  return `'use strict';
const { createHash, createHmac, randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readFileSync, realpathSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const repository = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
const key = readFileSync(join(__dirname, 'post-merge.key'));
const attestationPath = join(repository, '.devai/config/post-merge-host-adapter.json');
const attestationBytes = readFileSync(attestationPath);
const attestation = JSON.parse(attestationBytes.toString('utf8'));
const mergeSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
const unsigned = {
  schemaVersion: '1.0.0',
  repository,
  repository_id: attestation.repository_id,
  adapter_id: attestation.adapter_id,
  merge_sha: mergeSha,
  issued_at: new Date().toISOString(),
  hook_digest_sha256: attestation.hook_digest_sha256,
  attestation_digest_sha256: createHash('sha256').update(attestationBytes).digest('hex'),
  nonce: randomBytes(16).toString('hex'),
};
const signature = createHmac('sha256', key).update(JSON.stringify(unsigned)).digest('hex');
writeFileSync(join(__dirname, 'post-merge-receipt.json'), JSON.stringify({ ...unsigned, signature_hmac_sha256: signature }, null, 2) + '\\n', { mode: 0o600 });
`;
}

function executePostMergeAdapter(plan: HooksInstallPlan): void {
  const root = realpathSync(resolve(plan.targetRoot));
  const runtimeRoot = join(gitAdminRoot(root), 'devai');
  const configRoot = join(root, '.devai/config');
  const keyPath = join(runtimeRoot, 'post-merge.key');
  const issuerPath = join(runtimeRoot, 'issue-post-merge-receipt.cjs');
  const attestationPath = join(configRoot, 'post-merge-host-adapter.json');
  const policyPath = join(root, '.devai/config/authority-policy.json');
  mkdirSync(runtimeRoot, { recursive: true });
  mkdirSync(configRoot, { recursive: true });
  const key = existsSync(keyPath) ? readFileSync(keyPath) : randomBytes(32);
  if (!existsSync(keyPath)) {
    writeFileSync(keyPath, key, { mode: 0o600 });
    chmodSync(keyPath, 0o600);
  }
  writeFileSync(issuerPath, receiptIssuerSource(), 'utf8');
  chmodSync(issuerPath, 0o700);

  const constitution = installedConstitution(root);
  const policyDigest = sha256(readFileSync(policyPath));
  const stableBindings = {
    repository: root,
    repository_id: root.split('/').at(-1) ?? 'repository',
    hook_path: plan.path,
    hook_digest_sha256: sha256(plan.content),
    key_digest_sha256: sha256(key),
    policy_digest_sha256: policyDigest,
    constitution_digest_sha256: sha256(constitution),
    package_binding: { name: '@aarusso-nyx/devai', version: plan.devaiVersion },
  };
  if (existsSync(attestationPath)) {
    try {
      const existing = JSON.parse(readFileSync(attestationPath, 'utf8')) as Record<string, unknown>;
      const { signature_hmac_sha256: existingSignature, ...existingUnsigned } = existing;
      const validSignature =
        typeof existingSignature === 'string' &&
        createHmac('sha256', key).update(JSON.stringify(existingUnsigned)).digest('hex') ===
          existingSignature;
      const stable = Object.entries(stableBindings).every(
        ([field, value]) => JSON.stringify(existing[field]) === JSON.stringify(value),
      );
      if (validSignature && stable) return;
    } catch {
      // A stale or malformed attestation is replaced by a newly bound one.
    }
  }
  const unsigned = {
    schemaVersion: '1.0.0',
    adapter_id: `post-merge-${sha256(root).slice(0, 16)}`,
    adapter_kind: 'installed-checkout',
    ...stableBindings,
    installed_at_head: headAt(root),
    installed_at: new Date().toISOString(),
    cadence: {
      installed_checkout: 'persistent',
      remote_host: 'unknown',
    },
  };
  const signature = createHmac('sha256', key).update(JSON.stringify(unsigned)).digest('hex');
  writeFileSync(
    attestationPath,
    `${JSON.stringify({ ...unsigned, signature_hmac_sha256: signature }, null, 2)}\n`,
    'utf8',
  );
}

export function buildHooksInstallPlan(opts: HooksInstallOptions): HooksInstallPlan {
  const hook = opts.hook ?? 'pre-push';
  const command =
    opts.command ??
    (hook === 'post-merge'
      ? postMergeCommand()
      : hook === 'pre-push'
        ? prePushCommand()
        : './node_modules/.bin/devai check --only forbidden-actions --strict');
  const { path, manager } = resolveHookPath(opts.targetRoot, hook);
  const newBlock = block(command);

  if (!existsSync(path)) {
    // Plain git hooks require a shebang; husky v9 hook files are
    // invoked directly as shell scripts and conventionally omit one.
    const shebang = manager === 'git' ? '#!/usr/bin/env sh\n' : '';
    return {
      targetRoot: resolve(opts.targetRoot),
      path,
      manager,
      action: 'create',
      hook,
      command,
      content: `${shebang}${newBlock}\n`,
      ...(opts.devaiVersion !== undefined && { devaiVersion: opts.devaiVersion }),
    };
  }

  const existing = readFileSync(path, 'utf8');
  if (MARKER_BLOCK_RE.test(existing)) {
    return {
      targetRoot: resolve(opts.targetRoot),
      path,
      manager,
      action: 'update',
      hook,
      command,
      content: existing.replace(MARKER_BLOCK_RE, newBlock),
      ...(opts.devaiVersion !== undefined && { devaiVersion: opts.devaiVersion }),
    };
  }
  const sep = existing.endsWith('\n') ? '' : '\n';
  return {
    targetRoot: resolve(opts.targetRoot),
    path,
    manager,
    action: 'append',
    hook,
    command,
    content: `${existing}${sep}\n${newBlock}\n`,
    ...(opts.devaiVersion !== undefined && { devaiVersion: opts.devaiVersion }),
  };
}

export function executeHooksInstallPlan(plan: HooksInstallPlan): void {
  preflightHooksInstallPlan(plan);
  mkdirSync(dirname(plan.path), { recursive: true });
  writeFileSync(plan.path, plan.content);
  chmodSync(plan.path, 0o755);
  if (plan.hook === 'post-merge') executePostMergeAdapter(plan);
}

export function preflightHooksInstallPlan(plan: HooksInstallPlan): readonly string[] {
  const root = resolve(plan.targetRoot);
  const targets = [plan.path];
  if (plan.hook === 'post-merge') {
    validatePostMergeAdapterInputs(plan);
    const runtimeRoot = join(gitAdminRoot(root), 'devai');
    targets.push(
      join(runtimeRoot, 'post-merge.key'),
      join(runtimeRoot, 'issue-post-merge-receipt.cjs'),
      join(root, '.devai/config/post-merge-host-adapter.json'),
    );
  }
  const trustedRoots = [root];
  try {
    trustedRoots.push(gitAdminRoot(root), gitCommonRoot(root));
  } catch {
    if (plan.hook === 'post-merge') throw new Error('HOOK_INSTALL_GIT_ADMIN_UNAVAILABLE');
  }
  for (const target of targets) {
    const absoluteTarget = resolve(target);
    const trustedRoot = trustedRoots
      .filter((candidate) => {
        const path = relative(candidate, absoluteTarget);
        return path !== '' && path !== '..' && !path.startsWith(`..${sep}`);
      })
      .sort((left, right) => right.length - left.length)[0];
    if (trustedRoot === undefined) {
      throw new Error(`HOOK_INSTALL_PATH_ESCAPE:${target}`);
    }
    const fromTrustedRoot = relative(trustedRoot, absoluteTarget);
    let cursor = trustedRoot;
    for (const segment of fromTrustedRoot.split(sep).slice(0, -1)) {
      cursor = join(cursor, segment);
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
        throw new Error(`HOOK_INSTALL_SYMLINK_REFUSED:${target}`);
      }
    }
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
      throw new Error(`HOOK_INSTALL_SYMLINK_REFUSED:${target}`);
    }
  }
  return targets;
}
