import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { realpathSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { buildEvidenceRecord, canonicalJson } from '@devai-nyx/utils';
import { requireScope } from './host-operation.js';
import { readReconciliationHostBinding } from './reconciliation-host-operation.js';
import {
  readReconciliationObservationBinding,
  invalidateReconciliationObservation,
} from './reconciliation-observation.js';
import {
  readReconciliationHostApproval,
  readReconciliationHostApprovalUnderAdmission,
  readReconciliationObservedApproval,
} from './reconciliation-host-owner.js';
import {
  captureReconciliationHostContext,
  disposeReconciliationHostContext,
  readReconciliationHostPaths,
} from './reconciliation-host-context.js';
import {
  readNativePrivateFile,
  provisionBytesSha,
  provisionSha,
} from './reconciliation-host-namespace.js';
import { decodeReconciliationOwnerRecord } from '../runtime/reconciliation-owner-record.js';
import { readReconciliationDomainFile } from './reconciliation-phase-files.js';
import { parseReconciliationChain } from './reconciliation-plan.js';

import type { ReconciliationAdmissionAnchor } from './host-reconciliation-admission.js';

const CHAIN = 'record/proofs/chain.json';
function fail(): never {
  throw new Error('RECONCILIATION_CHECKPOINT_INVALID');
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail();
  return value as Record<string, unknown>;
}
function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}
function canonical(bytes: Uint8Array): unknown {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
    value: unknown = JSON.parse(text);
  if (`${canonicalJson(value)}\n` !== text) fail();
  return value;
}
function gitBlob(root: string, commit: string): Buffer {
  const result = spawnSync(
    '/usr/bin/git',
    [
      '--no-optional-locks',
      '--no-replace-objects',
      '--no-lazy-fetch',
      '-c',
      'core.fsmonitor=false',
      'cat-file',
      'blob',
      `${commit}:${CHAIN}`,
    ],
    {
      cwd: root,
      env: {
        PATH: '/usr/bin:/bin',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_ALLOW_PROTOCOL: '',
      },
      encoding: 'buffer',
      timeout: 10000,
      maxBuffer: 33554432,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    },
  );
  if (result.error || result.signal || result.status !== 0 || !Buffer.isBuffer(result.stdout))
    fail();
  return result.stdout;
}

/**
 * Only the exact local unresolved-merge replacement is recognized. No source
 * plan path, caller provider, admission lock, signer or portable trust claim.
 * Absence or any uncertainty leaves the historical guard fully in force.
 */
export function hasAuthenticatedReconciliationCheckpoint(root: string, chainPath: string): boolean {
  return checkpoint(root, chainPath);
}

/** Internal only: the actual native admission anchor is still verified by the Owner reader. */
export function hasReconciliationCheckpointUnderAdmission(
  root: string,
  chainPath: string,
  anchor: ReconciliationAdmissionAnchor,
): boolean {
  return checkpoint(root, chainPath, anchor);
}
function checkpoint(
  root: string,
  chainPath: string,
  anchor?: ReconciliationAdmissionAnchor,
): boolean {
  let context: ReturnType<typeof captureReconciliationHostContext> | undefined;
  const privateBuffers: Uint8Array[] = [];
  try {
    if (realpathSync(root) !== root || chainPath !== join(root, CHAIN)) fail();
    const scope = requireScope('process'),
      observed = scope.reconciliation_observation !== undefined;
    const readBinding = () =>
      observed ? readReconciliationObservationBinding(root) : readReconciliationHostBinding();
    const readApproval = (id: string) =>
      observed
        ? readReconciliationObservedApproval(root, id)
        : anchor === undefined
          ? readReconciliationHostApproval(root, id)
          : readReconciliationHostApprovalUnderAdmission(root, id, anchor);
    const first = readBinding();
    if (first.identity.merge_heads.length === 0) fail();
    const active = readReconciliationDomainFile(chainPath, undefined, false, false),
      chain = parseReconciliationChain(active.bytes);
    const event = chain.records.findLast(
      (record) => record.action === 'evidence.reconcile.canonical-selection',
    );
    if (!event) fail();
    const pointer = event.artifacts.find((item) => item.kind === 'reconciliation-selection');
    const match =
      pointer &&
      /^record\/proofs\/reconciliation\/([a-f0-9]{64})\/selection\.json$/u.exec(pointer.path);
    if (!match || !digest(pointer?.sha256)) fail();
    const sourceSha = match[1];
    if (!sourceSha) fail();
    const namespace = `record/proofs/reconciliation/${sourceSha}`;
    const publicPaths = [
      root,
      join(root, 'record'),
      join(root, 'record/proofs'),
      join(root, 'record/proofs/reconciliation'),
      join(root, namespace),
      join(root, namespace, 'objects'),
    ];
    const directoryWitness = (path: string): string => {
      if (realpathSync(path) !== path) fail();
      const stat = lstatSync(path, { bigint: true });
      if (
        !stat.isDirectory() ||
        stat.uid !== BigInt(process.geteuid?.() ?? -1) ||
        (stat.mode & 0o022n) !== 0n
      )
        fail();
      return [stat.dev, stat.ino, stat.birthtimeNs, stat.mode, stat.uid].join(':');
    };
    const publicWitnesses = new Map(publicPaths.map((path) => [path, directoryWitness(path)]));
    const receiptFile = readReconciliationDomainFile(join(root, `${namespace}/selection.json`));
    if (receiptFile.bytes.length > 1048576 || receiptFile.sha256 !== pointer.sha256) fail();
    const receipt = object(canonical(receiptFile.bytes), [
      'schemaVersion',
      'kind',
      'plan_sha256',
      'source_manifest_sha256',
      'effect_plan_sha256',
      'binding_sha256',
      'approval_id',
      'approval_sha256',
      'scope_sha256',
      'identity',
      'selected_parent',
      'selected_chain_sha256',
      'selected_chain_records',
      'selected_chain_head',
      'custody_manifest',
      'clock',
      'nonce',
      'grants_authority',
    ]);
    if (
      receipt.schemaVersion !== '1.0.0' ||
      receipt.kind !== 'reconciliation-selection' ||
      receipt.grants_authority !== false ||
      receipt.source_manifest_sha256 !== sourceSha ||
      !digest(receipt.approval_id) ||
      !digest(receipt.plan_sha256) ||
      !digest(receipt.effect_plan_sha256) ||
      !digest(receipt.selected_chain_sha256) ||
      !digest(receipt.nonce) ||
      provisionSha(receipt.identity) !== provisionSha(first.identity) ||
      receipt.binding_sha256 !== first.binding_sha256 ||
      typeof receipt.selected_parent !== 'string' ||
      ![first.identity.head, ...first.identity.merge_heads].includes(receipt.selected_parent)
    )
      fail();
    const approval = readApproval(receipt.approval_id),
      state = approval.state;
    if (
      !approval.binding_matches_approval ||
      state.plan_sha256 !== receipt.plan_sha256 ||
      state.source_manifest_sha256 !== sourceSha ||
      state.approval_sha256 !== receipt.approval_sha256 ||
      state.scope_sha256 !== receipt.scope_sha256 ||
      provisionSha(approval.identity) !== provisionSha(first.identity)
    )
      fail();
    context = captureReconciliationHostContext(root, first.identity.repository_id);
    const paths = readReconciliationHostPaths(context),
      directory = join(paths.private_root, 'approvals', state.approval_id);
    const phase01 = state.phases.find((p) => p.phase === '01'),
      phase02 = state.phases.find((p) => p.phase === '02');
    if (
      !phase01?.intent_sha256 ||
      !phase01.completion_sha256 ||
      !phase02?.intent_sha256 ||
      !phase02.completion_sha256
    )
      fail();
    const privateRecord = (name: string, sha: string) => {
      const file = readNativePrivateFile(join(directory, name));
      privateBuffers.push(file.bytes);
      if (file.sha256 !== sha) fail();
      return decodeReconciliationOwnerRecord(file.bytes);
    };
    const intent01 = privateRecord('intent-01.json', phase01.intent_sha256),
      completion01 = privateRecord('phase-01.json', phase01.completion_sha256);
    const intent02 = privateRecord('intent-02.json', phase02.intent_sha256),
      completion02 = privateRecord('phase-02.json', phase02.completion_sha256);
    if (
      intent01.kind !== 'phase-intent' ||
      completion01.kind !== 'phase-completion' ||
      intent02.kind !== 'phase-intent' ||
      completion02.kind !== 'phase-completion' ||
      intent02.predecessor_completion_sha256 !== phase01.completion_sha256 ||
      completion02.predecessor_completion_sha256 !== phase01.completion_sha256 ||
      canonicalJson(intent02.clock) !== canonicalJson(receipt.clock) ||
      intent02.lease_nonce !== receipt.nonce
    )
      fail();
    const manifestDescriptor = object(receipt.custody_manifest, ['path', 'sha256', 'bytes']);
    if (
      manifestDescriptor.path !== `${namespace}/custody.json` ||
      !digest(manifestDescriptor.sha256) ||
      typeof manifestDescriptor.bytes !== 'number' ||
      !Number.isSafeInteger(manifestDescriptor.bytes) ||
      manifestDescriptor.bytes < 1 ||
      manifestDescriptor.bytes > 33554432
    )
      fail();
    const manifestFile = readReconciliationDomainFile(join(root, `${namespace}/custody.json`), {
      sha256: manifestDescriptor.sha256,
      bytes: manifestDescriptor.bytes,
    });
    const custody = object(canonical(manifestFile.bytes), [
      'schemaVersion',
      'kind',
      'source_manifest_sha256',
      'files',
    ]);
    if (
      custody.schemaVersion !== '1.0.0' ||
      custody.kind !== 'reconciliation-custody' ||
      custody.source_manifest_sha256 !== sourceSha ||
      !Array.isArray(custody.files) ||
      custody.files.length < 1 ||
      custody.files.length > 100000
    )
      fail();
    const originals = new Map<string, ReturnType<typeof readReconciliationDomainFile>>();
    let charged = 0;
    const oidPattern =
      first.identity.object_format === 'sha1' ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u;
    const files = custody.files.map((value) => {
      const file = object(value, [
        'commit',
        'path',
        'mode',
        'blob_oid',
        'sha256',
        'bytes',
        'kind',
        'object_path',
      ]);
      if (
        typeof file.commit !== 'string' ||
        (file.commit !== '@staged' && !oidPattern.test(file.commit)) ||
        typeof file.path !== 'string' ||
        !['chain', 'epoch', 'ancestry', 'baseline'].includes(String(file.kind)) ||
        !digest(file.sha256) ||
        typeof file.blob_oid !== 'string' ||
        !oidPattern.test(file.blob_oid) ||
        typeof file.bytes !== 'number' ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0 ||
        file.bytes > 33554432 ||
        file.object_path !== `${namespace}/objects/${file.sha256}`
      )
        fail();
      let source = originals.get(file.sha256);
      if (!source) {
        charged += file.bytes;
        if (charged > 536870912) fail();
        source = readReconciliationDomainFile(join(root, file.object_path as string), {
          sha256: file.sha256,
          bytes: file.bytes,
        });
        originals.set(file.sha256, source);
      }
      if (
        source.bytes.length !== file.bytes ||
        createHash(first.identity.object_format)
          .update(`${file.kind === 'ancestry' ? 'commit' : 'blob'} ${String(file.bytes)}\0`)
          .update(source.bytes)
          .digest('hex') !== file.blob_oid
      )
        fail();
      return file;
    });
    const census = (): void => {
      const names = new Set(['objects', 'custody.json', 'selection.json']);
      if (readdirSync(join(root, namespace)).some((name) => !names.has(name))) fail();
      if (readdirSync(join(root, namespace, 'objects')).some((name) => !originals.has(name)))
        fail();
      for (const [path, witness] of publicWitnesses) if (directoryWitness(path) !== witness) fail();
    };
    census();
    const custodyOutputs = [
      ...[...originals]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([sha, file]) => ({
          path: `${namespace}/objects/${sha}`,
          sha256: sha,
          bytes: file.bytes.length,
        })),
      {
        path: `${namespace}/custody.json`,
        sha256: manifestFile.sha256,
        bytes: manifestFile.bytes.length,
      },
    ];
    const custodyOutputsSha = provisionSha({
      schemaVersion: '1.0.0',
      kind: 'reconciliation-domain-outputs',
      phase: '01',
      outputs: custodyOutputs,
    });
    if (
      custodyOutputsSha !== intent01.output_plan_sha256 ||
      custodyOutputsSha !== completion01.outputs_manifest_sha256
    )
      fail();
    const selectedSource = files.find(
        (file) =>
          file.kind === 'chain' && file.commit === receipt.selected_parent && file.path === CHAIN,
      ),
      headSource = files.find(
        (file) =>
          file.kind === 'chain' && file.commit === first.identity.head && file.path === CHAIN,
      );
    if (
      !selectedSource ||
      !headSource ||
      selectedSource.sha256 !== receipt.selected_chain_sha256 ||
      provisionBytesSha(gitBlob(root, receipt.selected_parent)) !== selectedSource.sha256 ||
      provisionBytesSha(gitBlob(root, first.identity.head)) !== headSource.sha256
    )
      fail();
    const selected = originals.get(receipt.selected_chain_sha256);
    if (!selected) fail();
    const parent = parseReconciliationChain(selected.bytes);
    if (
      parent.records.length !== receipt.selected_chain_records ||
      parent.head !== receipt.selected_chain_head ||
      chain.records.length < parent.records.length + 1 ||
      JSON.stringify(chain.records.slice(0, parent.records.length)) !==
        JSON.stringify(parent.records)
    )
      fail();
    const expectedEvent = buildEvidenceRecord(
      {
        id: `EV-${receiptFile.sha256.slice(0, 16)}`,
        timestamp: new Date(intent02.clock.wall_ms).toISOString(),
        actor: 'devai.evidence-reconciliation',
        actor_role: 'human:inspector',
        action: 'evidence.reconcile.canonical-selection',
        status: 'completed',
        context: { repo_root: root, git: { head_sha: first.identity.head, dirty_files: [CHAIN] } },
        artifacts: [
          {
            path: `${namespace}/custody.json`,
            sha256: manifestFile.sha256,
            kind: 'reconciliation-custody',
          },
          {
            path: `${namespace}/objects/${receipt.selected_chain_sha256}`,
            sha256: receipt.selected_chain_sha256,
            kind: 'selected-original-chain',
          },
          {
            path: `${namespace}/selection.json`,
            sha256: receiptFile.sha256,
            kind: 'reconciliation-selection',
          },
        ],
      },
      parent.head,
      parent.records.length + 1,
    );
    if (
      canonicalJson(event) !== canonicalJson(expectedEvent) ||
      chain.records[parent.records.length] !== event
    )
      fail();
    const base = {
        ...chain,
        records: chain.records.slice(0, parent.records.length + 1),
        head: event.manifest_hash,
      },
      baseBytes = Buffer.from(`${JSON.stringify(base, null, 2)}\n`);
    const outputs = [
      {
        path: `${namespace}/selection.json`,
        sha256: receiptFile.sha256,
        bytes: receiptFile.bytes.length,
      },
      { path: CHAIN, sha256: provisionBytesSha(baseBytes), bytes: baseBytes.length },
    ];
    const outputSha = provisionSha({
      schemaVersion: '1.0.0',
      kind: 'reconciliation-domain-outputs',
      phase: '02',
      outputs,
    });
    if (
      outputSha !== intent02.output_plan_sha256 ||
      outputSha !== completion02.outputs_manifest_sha256
    )
      fail();
    // Recheck all public witnesses, then the entire authenticated private graph
    // and current native B5/HEAD/merge observation before granting the exception.
    for (const [sha, file] of originals) {
      const latest = readReconciliationDomainFile(join(root, `${namespace}/objects/${sha}`), {
        sha256: sha,
        bytes: file.bytes.length,
      });
      if (canonicalJson(latest.witness) !== canonicalJson(file.witness)) fail();
    }
    for (const [path, file] of [
      [`${namespace}/selection.json`, receiptFile],
      [`${namespace}/custody.json`, manifestFile],
    ] as const) {
      const latest = readReconciliationDomainFile(join(root, path), {
        sha256: file.sha256,
        bytes: file.bytes.length,
      });
      if (canonicalJson(latest.witness) !== canonicalJson(file.witness)) fail();
    }
    census();
    const finalApproval = readApproval(state.approval_id),
      final = readBinding(),
      finalChain = readReconciliationDomainFile(chainPath, undefined, false, false);
    if (
      finalApproval.namespace_sha256 !== approval.namespace_sha256 ||
      final.binding_sha256 !== first.binding_sha256 ||
      provisionSha(final.identity) !== provisionSha(first.identity) ||
      canonicalJson(finalChain.witness) !== canonicalJson(active.witness) ||
      finalChain.sha256 !== active.sha256
    )
      fail();
    return true;
  } catch {
    invalidateReconciliationObservation();
    return false;
  } finally {
    for (const bytes of privateBuffers) bytes.fill(0);
    if (context) disposeReconciliationHostContext(context);
  }
}
