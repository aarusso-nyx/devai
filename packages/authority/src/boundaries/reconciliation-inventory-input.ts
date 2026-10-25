import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { canonicalJson } from '@devai-nyx/utils';
import { decodeReconciliationOwnerRecord } from '../runtime/reconciliation-owner-record.js';
import { requireScope } from './host-operation.js';
import {
  captureReconciliationHostContext,
  disposeReconciliationHostContext,
  readReconciliationHostPaths,
} from './reconciliation-host-context.js';
import {
  readReconciliationExistingApprovalInput,
  withReconciliationHostBindingReader,
} from './reconciliation-host-operation.js';
import { readReconciliationHostApproval } from './reconciliation-host-owner.js';
import {
  provisionBytesSha,
  provisionSha,
  readNativePrivateFile,
} from './reconciliation-host-namespace.js';
import { hasAuthenticatedReconciliationCheckpoint } from './reconciliation-checkpoint.js';
import { readExistingReconciliationPlan } from './reconciliation-plan.js';
import { parseProofIndex } from './proof-index-codec.js';
import { readReconciliationDomainFile as readFile } from './reconciliation-phase-files.js';

const nativeInputs = new WeakMap<
  object,
  Readonly<{
    scope: ReturnType<typeof requireScope>;
    plan_file: ReturnType<typeof readFile>;
    invocation: string;
    plan: ReturnType<typeof readExistingReconciliationPlan>;
    index: ReturnType<typeof readFile>;
    chain: ReturnType<typeof readFile>;
    object: ReturnType<typeof readFile>;
    approval_namespace_sha256: string;
    binding_sha256: string;
    predecessor: string;
    clock: ReturnType<typeof readReconciliationHostApproval>['clock'];
  }>
>();

function fail(): never {
  throw new Error('RECONCILIATION_INVENTORY_SOURCE_INVALID');
}
/** Native read only. Returned bytes grant neither publication nor readiness authority. */
export function readReconciliationInventoryInput(repositoryRoot: string) {
  return withReconciliationHostBindingReader((readBinding) => {
    const input = readReconciliationExistingApprovalInput(),
      scope = requireScope('process');
    if (
      input.action_id !== 'sense bootstrap-inventory' ||
      scope.effect !== 'local-write' ||
      realpathSync(repositoryRoot) !== repositoryRoot
    )
      fail();
    const plan = readExistingReconciliationPlan(repositoryRoot),
      binding = readBinding(),
      planFile = readFile(join(repositoryRoot, input.plan_path), undefined, false, false);
    if (planFile.sha256 !== input.plan_sha256) fail();
    const approval = readReconciliationHostApproval(repositoryRoot, input.approval_id);
    if (
      !approval.binding_matches_approval ||
      approval.state.plan_sha256 !== input.plan_sha256 ||
      approval.state.source_manifest_sha256 !== plan.source_manifest_sha256 ||
      provisionSha(approval.identity) !== provisionSha(plan.identity)
    )
      fail();
    const third = approval.state.phases.find((p) => p.phase === '03');
    if (!third?.intent_sha256 || !third.completion_sha256 || approval.state.lease_sha256 !== null)
      fail();
    const context = captureReconciliationHostContext(
        repositoryRoot,
        binding.identity.repository_id,
      ),
      privateBuffers: Uint8Array[] = [];
    try {
      const paths = readReconciliationHostPaths(context),
        directory = join(paths.private_root, 'approvals', input.approval_id);
      const intentFile = readNativePrivateFile(join(directory, 'intent-03.json'));
      privateBuffers.push(intentFile.bytes);
      const completionFile = readNativePrivateFile(join(directory, 'phase-03.json'));
      privateBuffers.push(completionFile.bytes);
      const intent = decodeReconciliationOwnerRecord(intentFile.bytes),
        completion = decodeReconciliationOwnerRecord(completionFile.bytes);
      if (
        intentFile.sha256 !== third.intent_sha256 ||
        completionFile.sha256 !== third.completion_sha256 ||
        intent.kind !== 'phase-intent' ||
        completion.kind !== 'phase-completion'
      )
        fail();
      const indexPath = join(paths.git_dir, 'index'),
        chainPath = join(repositoryRoot, plan.effect_plan.proof_index.proof_path);
      if (!hasAuthenticatedReconciliationCheckpoint(repositoryRoot, chainPath)) fail();
      const index = readFile(indexPath, undefined, false, false),
        chain = readFile(chainPath, undefined, false, false),
        snapshot = parseProofIndex(index.bytes, plan.identity.object_format);
      const rawObject = Buffer.concat([
          Buffer.from(`blob ${String(chain.bytes.length)}\0`),
          chain.bytes,
        ]),
        oid = createHash(plan.identity.object_format).update(rawObject).digest('hex');
      const proof = snapshot.entries.filter(
        (entry) => entry.path === plan.effect_plan.proof_index.proof_path,
      );
      if (
        snapshot.other_entries_sha256 !==
          plan.effect_plan.proof_index.unchanged_other_entries_sha256 ||
        proof.length !== 1 ||
        proof[0]?.oid !== oid ||
        proof[0]?.stage !== 0 ||
        proof[0]?.mode !== '100644' ||
        proof[0]?.assume_valid !== false
      )
        fail();
      const objectPath = join(paths.common_dir, 'objects', oid.slice(0, 2), oid.slice(2)),
        loose = readFile(objectPath, undefined, false, false);
      if (!inflateSync(loose.bytes, { maxOutputLength: rawObject.length }).equals(rawObject))
        fail();
      const thirdOutputs = [
        {
          path: `trusted-common-dir/objects/${oid.slice(0, 2)}/${oid.slice(2)}`,
          sha256: loose.sha256,
          bytes: loose.bytes.length,
        },
        { path: 'trusted-worktree/index', sha256: index.sha256, bytes: index.bytes.length },
      ];
      const outputSha = provisionSha({
        schemaVersion: '1.0.0',
        kind: 'reconciliation-domain-outputs',
        phase: '03',
        outputs: thirdOutputs,
      });
      if (
        intent.output_plan_sha256 !== outputSha ||
        completion.outputs_manifest_sha256 !== outputSha
      )
        fail();
      const admitted = snapshot.entries.filter(
        (entry) =>
          entry.stage === 0 &&
          entry.path !== 'record/proofs/chain.json' &&
          entry.path !== 'law/security/authorization.json',
      );
      const projection = admitted.map((entry) => ({
        assume_valid: entry.assume_valid,
        mode: entry.mode,
        oid: entry.oid,
        path: entry.path,
        stage: entry.stage,
      }));
      if (
        provisionBytesSha(Buffer.from(JSON.stringify(projection))) !==
        plan.effect_plan.inventory.source_sha256
      )
        fail();
      const descriptors = new Map(
        plan.source_manifest.staged_files
          .filter((file) => file.stage === 0)
          .map((file) => [file.path, file]),
      );
      const objects = new Map<string, { sha256: string; bytes: number }>();
      let total = 0;
      for (const entry of admitted) {
        const file = descriptors.get(entry.path);
        if (
          !file ||
          file.blob_oid !== entry.oid ||
          file.mode !== entry.mode ||
          file.bytes > 33554432
        )
          fail();
        const prior = objects.get(entry.oid);
        if (prior && (prior.sha256 !== file.sha256 || prior.bytes !== file.bytes)) fail();
        if (!prior) {
          objects.set(entry.oid, file);
          total += file.bytes;
        }
      }
      if (objects.size > 100000 || total > 536870912) fail();
      const ids = [...objects.keys()];
      const result = spawnSync(
        '/usr/bin/git',
        [
          '--no-optional-locks',
          '--no-replace-objects',
          '--no-lazy-fetch',
          '-c',
          'core.fsmonitor=false',
          'cat-file',
          '--batch',
        ],
        {
          cwd: repositoryRoot,
          env: {
            PATH: '/usr/bin:/bin',
            LC_ALL: 'C',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_ALLOW_PROTOCOL: '',
          },
          input: Buffer.from(ids.length ? `${ids.join('\n')}\n` : ''),
          encoding: 'buffer',
          timeout: 30000,
          maxBuffer: total + ids.length * 128 + 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
        },
      );
      if (result.error || result.signal || result.status !== 0 || !Buffer.isBuffer(result.stdout))
        fail();
      const bytes = result.stdout,
        blobs = new Map<string, Uint8Array>();
      let offset = 0;
      for (const id of ids) {
        const expected = objects.get(id);
        if (!expected) fail();
        const end = bytes.indexOf(10, offset);
        if (
          end < offset ||
          bytes.subarray(offset, end).toString('ascii') !== `${id} blob ${String(expected.bytes)}`
        )
          fail();
        offset = end + 1;
        const body = bytes.subarray(offset, offset + expected.bytes);
        offset += expected.bytes;
        if (
          body.length !== expected.bytes ||
          bytes[offset++] !== 10 ||
          provisionBytesSha(body) !== expected.sha256 ||
          createHash(plan.identity.object_format)
            .update(`blob ${String(body.length)}\0`)
            .update(body)
            .digest('hex') !== id
        )
          fail();
        blobs.set(id, Buffer.from(body));
      }
      if (offset !== bytes.length) fail();
      let bodyClock = approval.clock;
      const fourth = approval.state.phases.find((phase) => phase.phase === '04');
      if (fourth?.intent_sha256) {
        const file = readNativePrivateFile(join(directory, 'intent-04.json'));
        privateBuffers.push(file.bytes);
        const record = decodeReconciliationOwnerRecord(file.bytes);
        if (
          file.sha256 !== fourth.intent_sha256 ||
          record.kind !== 'phase-intent' ||
          record.phase !== '04'
        )
          fail();
        bodyClock = record.clock;
      }
      const final = readBinding(),
        latest = readReconciliationHostApproval(repositoryRoot, input.approval_id);
      if (
        final.binding_sha256 !== binding.binding_sha256 ||
        provisionSha(final.identity) !== provisionSha(binding.identity) ||
        canonicalJson(
          readFile(
            join(repositoryRoot, input.plan_path),
            { sha256: planFile.sha256, bytes: planFile.bytes.length },
            false,
            false,
          ).witness,
        ) !== canonicalJson(planFile.witness) ||
        latest.namespace_sha256 !== approval.namespace_sha256 ||
        latest.approval_namespace_sha256 !== approval.approval_namespace_sha256 ||
        canonicalJson(readFile(indexPath, undefined, false, false).witness) !==
          canonicalJson(index.witness) ||
        canonicalJson(readFile(chainPath, undefined, false, false).witness) !==
          canonicalJson(chain.witness) ||
        canonicalJson(readFile(objectPath, undefined, false, false).witness) !==
          canonicalJson(loose.witness) ||
        !hasAuthenticatedReconciliationCheckpoint(repositoryRoot, chainPath)
      )
        fail();
      const nativeView = Object.freeze({
        kind: 'reconciliation-inventory-input',
        plan,
        blobs: blobs as ReadonlyMap<string, Uint8Array>,
        index_sha256: index.sha256,
        verified_chain_sha256: chain.sha256,
        predecessor_completion_sha256: third.completion_sha256,
        clock: bodyClock,
        grants_authority: false,
      });
      nativeInputs.set(
        nativeView,
        Object.freeze({
          plan_file: planFile,
          scope,
          invocation: input.invocation_sha256,
          plan,
          index,
          chain,
          object: loose,
          approval_namespace_sha256: approval.approval_namespace_sha256,
          binding_sha256: binding.binding_sha256,
          predecessor: third.completion_sha256,
          clock: bodyClock,
        }),
      );
      return nativeView;
    } finally {
      for (const bytes of privateBuffers) bytes.fill(0);
      disposeReconciliationHostContext(context);
    }
  });
}

/** Internal native identity lookup; caller fields cannot substitute for observed source custody. */
export function readNativeReconciliationInventoryInput(value: object) {
  const admitted = nativeInputs.get(value);
  const input = readReconciliationExistingApprovalInput();
  if (
    !admitted ||
    requireScope('process') !== admitted.scope ||
    input.action_id !== 'sense bootstrap-inventory' ||
    input.invocation_sha256 !== admitted.invocation
  )
    fail();
  return admitted;
}
