import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { canonicalJson } from '@devai-nyx/utils';
import { requireScope } from './host-operation.js';
import { scopes } from './host-scope.js';
import {
  captureReconciliationHostContext,
  disposeReconciliationHostContext,
  readReconciliationHostIdentity,
} from './reconciliation-host-context.js';
import { readReconciliationHostBinding } from './reconciliation-host-operation.js';
import type { ReconciliationPlan } from './reconciliation-plan.js';

const MAX_BLOB = 32 * 1024 * 1024;
const MAX_TOTAL = 512 * 1024 * 1024;
const MAX_OBJECTS = 100000;
const ENV = Object.freeze({
  PATH: '/usr/bin:/bin',
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ALLOW_PROTOCOL: '',
});
const sha = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
function fail(): never {
  throw new Error('RECONCILIATION_CUSTODY_SOURCE_INVALID');
}

/** Native raw-object input only. A returned map grants no custody publication authority. */
export function readReconciliationCustodyObjects(
  repositoryRoot: string,
  plan: ReconciliationPlan,
): ReadonlyMap<string, Uint8Array> {
  const scope = requireScope('process');
  if (
    scope.action_id !== 'evidence reconcile materialize' ||
    scope.effect !== 'local-write' ||
    realpathSync(repositoryRoot) !== repositoryRoot
  )
    fail();
  const binding = readReconciliationHostBinding();
  const context = captureReconciliationHostContext(repositoryRoot, binding.identity.repository_id);
  try {
    if (
      canonicalJson(binding.identity) !== canonicalJson(readReconciliationHostIdentity(context)) ||
      canonicalJson(binding.identity) !== canonicalJson(plan.identity) ||
      binding.binding_sha256 !== plan.binding_sha256 ||
      sha(canonicalJson(plan.source_manifest)) !== plan.source_manifest_sha256
    )
      fail();
    const format = plan.source_manifest.index.object_format;
    const pattern = format === 'sha1' ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u;
    const objects = new Map<string, { type: 'blob' | 'commit'; sha256: string; bytes: number }>();
    let total = 0;
    for (const file of plan.source_manifest.files) {
      const type = file.kind === 'ancestry' ? ('commit' as const) : ('blob' as const);
      if (
        !pattern.test(file.blob_oid) ||
        !/^[a-f0-9]{64}$/u.test(file.sha256) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0 ||
        file.bytes > MAX_BLOB
      )
        fail();
      const previous = objects.get(file.blob_oid);
      if (
        previous &&
        (previous.type !== type || previous.sha256 !== file.sha256 || previous.bytes !== file.bytes)
      )
        fail();
      if (!previous) {
        objects.set(file.blob_oid, { type, sha256: file.sha256, bytes: file.bytes });
        total += file.bytes;
      }
    }
    if (objects.size === 0 || objects.size > MAX_OBJECTS || total > MAX_TOTAL) fail();
    const ids = [...objects.keys()];
    const result = spawnSync(
      '/usr/bin/git',
      [
        '--no-optional-locks',
        '--no-replace-objects',
        '--no-lazy-fetch',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'credential.helper=',
        'cat-file',
        '--batch',
      ],
      {
        cwd: repositoryRoot,
        env: ENV,
        input: Buffer.from(`${ids.join('\n')}\n`),
        encoding: 'buffer',
        timeout: 30000,
        maxBuffer: total + ids.length * 128,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    if (result.status !== 0 || result.signal || result.error || !Buffer.isBuffer(result.stdout))
      fail();
    const output = result.stdout;
    let offset = 0;
    const captured = new Map<string, Uint8Array>();
    for (const id of ids) {
      const expected = objects.get(id);
      if (!expected) fail();
      const end = output.indexOf(10, offset);
      if (
        end < 0 ||
        output.subarray(offset, end).toString('ascii') !==
          `${id} ${expected.type} ${expected.bytes}`
      )
        fail();
      offset = end + 1;
      const bytes = output.subarray(offset, offset + expected.bytes);
      offset += expected.bytes;
      if (
        bytes.length !== expected.bytes ||
        output[offset++] !== 10 ||
        sha(bytes) !== expected.sha256 ||
        createHash(format)
          .update(`${expected.type} ${expected.bytes}\0`)
          .update(bytes)
          .digest('hex') !== id
      )
        fail();
      const previous = captured.get(expected.sha256);
      if (previous && !Buffer.from(previous).equals(bytes)) fail();
      captured.set(expected.sha256, bytes);
    }
    if (offset !== output.length) fail();
    const current = readReconciliationHostBinding();
    if (
      scopes.getStore() !== scope ||
      canonicalJson(current.identity) !== canonicalJson(binding.identity) ||
      canonicalJson(readReconciliationHostIdentity(context)) !== canonicalJson(binding.identity) ||
      current.binding_sha256 !== binding.binding_sha256
    )
      fail();
    return captured;
  } finally {
    disposeReconciliationHostContext(context);
  }
}
