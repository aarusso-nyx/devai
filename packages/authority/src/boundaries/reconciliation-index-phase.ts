import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { canonicalJson } from '@devai-nyx/utils';
import { assessReconciliationOwnerPhase } from '../runtime/reconciliation-owner-state.js';
import {
  decodeReconciliationOwnerRecord,
  encodeReconciliationOwnerRecord,
  signReconciliationOwnerRecord,
} from '../runtime/reconciliation-owner-record.js';
import { withReconciliationAdmissionSteps } from './host-reconciliation-admission.js';
import { publishPrivateNoReplacePreparedSteps, PublishIndeterminateError } from './host-publish.js';
import { removeEntryIfIdentitySteps } from './host-remove.js';
import { requireScope } from './host-operation.js';
import { scopes } from './host-scope.js';
import {
  captureReconciliationHostContext,
  disposeReconciliationHostContext,
  readReconciliationHostPaths,
} from './reconciliation-host-context.js';
import {
  invokeReconciliationHostOperation,
  readReconciliationExistingApprovalInput,
  withReconciliationHostBindingReader,
} from './reconciliation-host-operation.js';
import {
  readReconciliationHostApproval,
  readReconciliationHostApprovalUnderAdmission,
} from './reconciliation-host-owner.js';
import {
  provisionSha,
  provisionBytesSha,
  readNativePrivateFile,
  readNativeReconciliationNamespace,
  syncNativeDirectory,
} from './reconciliation-host-namespace.js';
import {
  readExistingReconciliationPlan,
  revalidateReconciliationIndexSource,
  type ReconciliationPlan,
} from './reconciliation-plan.js';
import { buildReconciliationProofIndex } from './reconciliation-proof-index.js';
import { parseProofIndex } from './proof-index-codec.js';
import {
  hasAuthenticatedReconciliationCheckpoint,
  hasReconciliationCheckpointUnderAdmission,
} from './reconciliation-checkpoint.js';
import {
  readReconciliationDomainFile as readFile,
  reconciliationOwned,
  reconciliationPresent as present,
  reconciliationScratch,
  type ReconciliationPhaseOwned,
} from './reconciliation-phase-files.js';

function fail(): never {
  throw new Error('RECONCILIATION_PHASE_HELD');
}
export interface ReconciliationIndexResult {
  readonly kind: 'reconciliation-index-result';
  readonly phase: '03';
  readonly outcome: 'completed' | 'existing' | 'indeterminate';
  readonly approval_id: string;
  readonly plan_sha256: string;
  readonly intent_sha256: string | null;
  readonly completion_sha256: string | null;
  readonly outputs_manifest_sha256: string | null;
  readonly owned: readonly ReconciliationPhaseOwned[];
  readonly grants_authority: false;
}

/** Checks actual working files against the approved staged image; no Git refresh or effects. */
function verifySources(root: string, plan: ReconciliationPlan): void {
  for (const entry of plan.source_manifest.staged_files) {
    if (
      entry.stage !== 0 ||
      entry.path === 'record/proofs/chain.json' ||
      entry.path === 'law/security/authorization.json'
    )
      continue;
    const path = join(root, entry.path);
    if (realpathSync(dirname(path)) !== dirname(path)) fail();
    if (entry.mode === '120000') {
      const before = lstatSync(path, { bigint: true });
      if (!before.isSymbolicLink()) fail();
      const bytes = readlinkSync(path, { encoding: 'buffer' }),
        after = lstatSync(path, { bigint: true });
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.birthtimeNs !== after.birthtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        bytes.length !== entry.bytes ||
        provisionBytesSha(bytes) !== entry.sha256
      )
        fail();
    } else {
      const file = readFile(path, entry, false, false),
        mode = BigInt(file.witness.mode);
      if (((mode & 0o100n) !== 0n) !== (entry.mode === '100755')) fail();
    }
  }
}

/** Exact native phase03 only: one proof-index operation, real Owner admission, fixed Git CAS. */
export function stageReconciliationProof(repositoryRoot: string): ReconciliationIndexResult {
  return withReconciliationHostBindingReader((readBinding) => {
    const input = readReconciliationExistingApprovalInput(),
      scope = requireScope('process');
    if (
      input.action_id !== 'evidence reconcile stage-proof' ||
      realpathSync(repositoryRoot) !== repositoryRoot
    )
      fail();
    const plan = readExistingReconciliationPlan(repositoryRoot),
      recipe = plan.effect_plan.proof_index;
    const initial = readReconciliationHostApproval(repositoryRoot, input.approval_id);
    if (
      !initial.binding_matches_approval ||
      initial.state.plan_sha256 !== input.plan_sha256 ||
      provisionSha(initial.identity) !== provisionSha(plan.identity)
    )
      fail();
    const chainPath = join(repositoryRoot, recipe.proof_path);
    if (!hasAuthenticatedReconciliationCheckpoint(repositoryRoot, chainPath)) fail();
    const binding = readBinding(),
      context = captureReconciliationHostContext(repositoryRoot, binding.identity.repository_id);
    const buffers: Uint8Array[] = [],
      owned: ReconciliationPhaseOwned[] = [];
    let entered = false,
      intentSha: string | null = null,
      completionSha: string | null = null,
      outputsSha: string | null = null;
    const result = (outcome: ReconciliationIndexResult['outcome']): ReconciliationIndexResult =>
      Object.freeze({
        kind: 'reconciliation-index-result',
        phase: '03',
        outcome,
        approval_id: input.approval_id,
        plan_sha256: input.plan_sha256,
        intent_sha256: intentSha,
        completion_sha256: completionSha,
        outputs_manifest_sha256: outputsSha,
        owned: Object.freeze([...owned]),
        grants_authority: false,
      });
    try {
      const paths = readReconciliationHostPaths(context),
        namespace = readNativeReconciliationNamespace(paths, binding.identity);
      if (namespace.issuer) buffers.push(namespace.issuer.bytes);
      const issuer = namespace.issuer,
        anchor = namespace.anchor;
      if (!issuer || !anchor || namespace.sha256 !== initial.namespace_sha256) fail();
      const directory = join(paths.private_root, 'approvals', input.approval_id),
        indexPath = join(paths.git_dir, 'index'),
        lockPath = join(paths.git_dir, 'index.lock');
      const chain = readFile(chainPath, undefined, false, false),
        before = readFile(indexPath, undefined, false, false);
      const rawObject = Buffer.concat([
        Buffer.from(`blob ${String(chain.bytes.length)}\0`),
        chain.bytes,
      ]);
      const oid = createHash(recipe.object_format).update(rawObject).digest('hex');
      const objects = join(paths.common_dir, 'objects'),
        shard = join(objects, oid.slice(0, 2)),
        objectPath = join(shard, oid.slice(2)),
        scratch = join(shard, `.${oid.slice(2)}.reconciliation.tmp`);
      const dirWitness = (path: string): string => {
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
      const parents = new Map(
        [
          repositoryRoot,
          dirname(chainPath),
          paths.git_dir,
          paths.common_dir,
          objects,
          paths.private_root,
          directory,
        ].map((p) => [p, dirWitness(p)]),
      );
      if (present(shard)) parents.set(shard, dirWitness(shard));
      const assertHost = () => {
        const now = readBinding();
        if (
          scopes.getStore() !== scope ||
          now.binding_sha256 !== plan.binding_sha256 ||
          provisionSha(now.identity) !== provisionSha(plan.identity)
        )
          fail();
        for (const [path, witness] of parents) if (dirWitness(path) !== witness) fail();
        const active = readFile(chainPath, undefined, false, false);
        if (
          active.sha256 !== chain.sha256 ||
          canonicalJson(active.witness) !== canonicalJson(chain.witness)
        )
          fail();
        return now;
      };
      const oldPhase = initial.state.phases.find((p) => p.phase === '03');
      if (!oldPhase || !initial.state.phases.find((p) => p.phase === '02')?.completion_sha256)
        fail();
      const oldIntent = oldPhase.intent_sha256
        ? readNativePrivateFile(join(directory, 'intent-03.json'))
        : undefined;
      if (oldIntent) buffers.push(oldIntent.bytes);
      const oldRecord = oldIntent ? decodeReconciliationOwnerRecord(oldIntent.bytes) : undefined;
      if (
        oldRecord &&
        (oldRecord.kind !== 'phase-intent' ||
          oldRecord.phase !== '03' ||
          oldIntent?.sha256 !== oldPhase.intent_sha256)
      )
        fail();
      if (oldRecord && oldRecord.kind !== 'phase-intent') fail();
      const sourceMap = new Map<string, Uint8Array>();
      for (const obligation of plan.source_manifest.recovery_obligations)
        if (obligation.mode === 'divergent') {
          const descriptor = plan.source_manifest.files.find(
            (f) =>
              f.kind === 'chain' &&
              f.commit === obligation.source_commit &&
              f.sha256 === obligation.source_chain_sha256,
          );
          if (!descriptor) fail();
          sourceMap.set(
            descriptor.sha256,
            readFile(
              join(repositoryRoot, plan.effect_plan.namespace, 'objects', descriptor.sha256),
              descriptor,
            ).bytes,
          );
        }
      const existingObject = present(objectPath)
        ? readFile(objectPath, undefined, false, false)
        : undefined;
      const existing = existingObject?.bytes;
      let indexBytes: Buffer,
        looseBytes: Buffer,
        outputs: readonly { path: string; sha256: string; bytes: number }[];
      if (before.sha256 === recipe.before_index_sha256) {
        const built = buildReconciliationProofIndex(
          plan,
          before.bytes,
          chain.bytes,
          existing,
          sourceMap,
        );
        indexBytes = Buffer.from(built.index_bytes_base64, 'base64');
        looseBytes = Buffer.from(built.loose_object_base64, 'base64');
        outputs = built.outputs;
        outputsSha = built.outputs_manifest_sha256;
      } else {
        // Settlement/retry reconstructs only already-published output bytes, pinned
        // by the original authenticated intent; it cannot authorize another CAS.
        if (!oldRecord || !existing) fail();
        const snapshot = parseProofIndex(before.bytes, recipe.object_format),
          proof = snapshot.entries.filter((e) => e.path === recipe.proof_path);
        if (
          snapshot.other_entries_sha256 !== recipe.unchanged_other_entries_sha256 ||
          proof.length !== 1 ||
          proof[0]?.stage !== 0 ||
          proof[0]?.mode !== '100644' ||
          proof[0]?.oid !== oid ||
          proof[0]?.assume_valid !== false ||
          !inflateSync(existing, { maxOutputLength: rawObject.length }).equals(rawObject)
        )
          fail();
        indexBytes = before.bytes;
        looseBytes = Buffer.from(existing);
        outputs = [
          {
            path: `trusted-common-dir/objects/${oid.slice(0, 2)}/${oid.slice(2)}`,
            sha256: provisionBytesSha(looseBytes),
            bytes: looseBytes.length,
          },
          { path: 'trusted-worktree/index', sha256: before.sha256, bytes: before.bytes.length },
        ];
        outputsSha = provisionSha({
          schemaVersion: '1.0.0',
          kind: 'reconciliation-domain-outputs',
          phase: '03',
          outputs,
        });
        if (outputsSha !== oldRecord.output_plan_sha256) fail();
      }
      if (oldRecord && oldRecord.output_plan_sha256 !== outputsSha) fail();
      const beforeWitness = provisionSha({
        identity: plan.identity,
        source_manifest_sha256: plan.source_manifest_sha256,
        index: before.witness,
        index_sha256: before.sha256,
        chain: chain.witness,
        chain_sha256: chain.sha256,
      });
      if (
        oldRecord &&
        before.sha256 === recipe.before_index_sha256 &&
        oldRecord.before_witness_sha256 !== beforeWitness
      )
        fail();
      const state = initial.state,
        predecessor = state.phases.find((p) => p.phase === '02')?.completion_sha256;
      if (!predecessor) fail();
      const linked = {
        repository_id: state.repository_id,
        worktree_id: state.worktree_id,
        approval_id: state.approval_id,
        issuer_sha256: state.issuer_sha256,
        approval_sha256: state.approval_sha256,
        scope_sha256: state.scope_sha256,
      };
      const intentBytes =
        oldIntent?.bytes ??
        encodeReconciliationOwnerRecord(
          signReconciliationOwnerRecord(
            {
              schemaVersion: '1.0.0',
              kind: 'phase-intent',
              domain: 'devai.reconciliation.owner.v1/phase-intent',
              ...linked,
              clock: initial.clock,
              grant_sha256: state.grant_sha256,
              before_witness_sha256: beforeWitness,
              output_plan_sha256: outputsSha,
              lease_nonce: randomBytes(32).toString('hex'),
              invocation_id: input.invocation_sha256,
              phase: '03',
              action_id: 'evidence reconcile stage-proof',
              initiator: 'inspector',
              predecessor_completion_sha256: predecessor,
            },
            issuer.record.private_key_base64,
          ),
        );
      if (!oldIntent) buffers.push(intentBytes);
      intentSha = provisionBytesSha(intentBytes);
      let outcome: 'completed' | 'existing' = 'completed';
      invokeReconciliationHostOperation(
        {
          kind: 'proof-index',
          id: `proof-index:${plan.identity.repository_id}:${plan.identity.worktree_id}:record/proofs/chain.json`,
          repository_id: plan.identity.repository_id,
          worktree_id: plan.identity.worktree_id,
          operation: 'chain-cas',
          proof_path: 'record/proofs/chain.json',
          approval_id: input.approval_id,
          plan_sha256: input.plan_sha256,
          phase_sha256: intentSha,
          before_index_sha256: recipe.before_index_sha256,
          other_entries_sha256: recipe.unchanged_other_entries_sha256,
          verified_chain_sha256: chain.sha256,
        },
        (host) => {
          if (
            provisionSha(host.identity) !== provisionSha(plan.identity) ||
            provisionSha(host.bindings) !== plan.binding_sha256
          )
            fail();
          withReconciliationAdmissionSteps(host.paths.private_root, anchor, () => {
            const snapshot = readReconciliationHostApprovalUnderAdmission(
              repositoryRoot,
              input.approval_id,
              anchor,
            );
            if (
              snapshot.namespace_sha256 !== namespace.sha256 ||
              snapshot.state.lease_sha256 !== null ||
              snapshot.state.grant_sha256 !== state.grant_sha256
            )
              fail();
            const phase = snapshot.state.phases.find((p) => p.phase === '03');
            if (
              !phase ||
              phase.intent_sha256 !== oldPhase.intent_sha256 ||
              phase.completion_sha256 !== oldPhase.completion_sha256
            )
              fail();
            assertHost();
            if (
              canonicalJson(readFile(indexPath, undefined, false, false).witness) !==
              canonicalJson(before.witness)
            )
              fail();
            if (!hasReconciliationCheckpointUnderAdmission(repositoryRoot, chainPath, anchor))
              fail();
            if (before.sha256 === recipe.before_index_sha256)
              revalidateReconciliationIndexSource(repositoryRoot, anchor);
            else verifySources(repositoryRoot, plan);
            const complete = before.sha256 === provisionBytesSha(indexBytes) && present(objectPath);
            const assessment = assessReconciliationOwnerPhase(
              snapshot.state,
              '03',
              snapshot.clock,
              complete ? 'complete' : oldRecord && existing ? 'partial-known' : 'absent',
            );
            if (assessment.disposition === 'held') fail();
            let finalIndexWitness =
              before.sha256 === provisionBytesSha(indexBytes) ? before.witness : undefined;
            let finalObjectWitness = existingObject?.witness;
            const assertOutputBytes = () => {
              assertHost();
              const currentIndex = readFile(
                indexPath,
                { sha256: provisionBytesSha(indexBytes), bytes: indexBytes.length },
                true,
                false,
              );
              const currentObject = readFile(
                objectPath,
                { sha256: provisionBytesSha(looseBytes), bytes: looseBytes.length },
                true,
                false,
              );
              const indexOwner = owned.findLast(
                (entry) => entry.target === 'trusted-worktree/index',
              );
              const objectOwner = owned.findLast((entry) => entry.target === outputs[0]?.path);
              for (const [file, owner] of [
                [currentIndex, indexOwner],
                [currentObject, objectOwner],
              ] as const) {
                if (
                  owner &&
                  (file.identity.dev !== owner.dev ||
                    file.identity.ino !== owner.ino ||
                    file.identity.birthtime_ns !== owner.birthtime_ns)
                )
                  fail();
              }
              if (
                (BigInt(currentIndex.witness.mode) & 0o7777n) !==
                  (BigInt(before.witness.mode) & 0o7777n) ||
                (BigInt(currentObject.witness.mode) & 0o7777n) !==
                  (existingObject ? BigInt(existingObject.witness.mode) & 0o7777n : 0o444n) ||
                (finalIndexWitness &&
                  canonicalJson(currentIndex.witness) !== canonicalJson(finalIndexWitness)) ||
                (finalObjectWitness &&
                  canonicalJson(currentObject.witness) !== canonicalJson(finalObjectWitness))
              )
                fail();
              finalIndexWitness ??= currentIndex.witness;
              finalObjectWitness ??= currentObject.witness;
              verifySources(repositoryRoot, plan);
              assertHost();
              if (
                canonicalJson(readFile(indexPath, undefined, false, false).witness) !==
                  canonicalJson(finalIndexWitness) ||
                canonicalJson(readFile(objectPath, undefined, false, false).witness) !==
                  canonicalJson(finalObjectWitness)
              )
                fail();
            };

            if (phase.completion_sha256) {
              const file = readNativePrivateFile(join(directory, 'phase-03.json'));
              buffers.push(file.bytes);
              const record = decodeReconciliationOwnerRecord(file.bytes);
              if (
                record.kind !== 'phase-completion' ||
                file.sha256 !== phase.completion_sha256 ||
                record.outputs_manifest_sha256 !== outputsSha ||
                !complete
              )
                fail();
              assertOutputBytes();
              completionSha = file.sha256;
              outcome = 'existing';
              return;
            }
            if (present(lockPath) || present(scratch)) fail();
            const grantFile = readNativePrivateFile(
              join(
                directory,
                state.grant_sequence === 1
                  ? 'approval.json'
                  : `grant-${String(state.grant_sequence).padStart(6, '0')}.json`,
              ),
            );
            buffers.push(grantFile.bytes);
            const grant = decodeReconciliationOwnerRecord(grantFile.bytes);
            if (
              grantFile.sha256 !== state.grant_sha256 ||
              (grant.kind !== 'approval' && grant.kind !== 'renewal' && grant.kind !== 'revocation')
            )
              fail();
            const assertDomain = () => {
              const now = assertHost();
              if (
                grant.kind === 'revocation' ||
                now.clock.boot_id !== grant.clock.boot_id ||
                now.clock.wall_ms >= grant.expires_wall_ms ||
                BigInt(now.clock.monotonic_ns) >= BigInt(grant.expires_monotonic_ns)
              )
                fail();
            };
            const publish = (
              path: string,
              target: string,
              bytes: Uint8Array,
              seed: Uint8Array,
              guard: () => unknown,
              settlement = false,
            ) => {
              guard();
              entered = true;
              try {
                const identity = publishPrivateNoReplacePreparedSteps(
                  path,
                  reconciliationScratch(seed, target, settlement),
                  bytes,
                  { verifyPrepared: guard },
                );
                const own = {
                  target,
                  dev: String(identity.dev),
                  ino: String(identity.ino),
                  birthtime_ns: String(identity.birthtimeNs),
                };
                owned.push(Object.freeze(own));
                return own;
              } catch (error) {
                if (error instanceof PublishIndeterminateError)
                  owned.push(
                    Object.freeze({
                      target,
                      dev: String(error.identity.dev),
                      ino: String(error.identity.ino),
                      birthtime_ns: String(error.identity.birthtimeNs),
                    }),
                  );
                throw error;
              }
            };
            const settling = assessment.disposition === 'settle';
            const leaseBytes = settling
              ? new Uint8Array()
              : encodeReconciliationOwnerRecord(
                  signReconciliationOwnerRecord(
                    {
                      schemaVersion: '1.0.0',
                      kind: 'lease',
                      domain: 'devai.reconciliation.owner.v1/lease',
                      ...linked,
                      clock: assertHost().clock,
                      grant_sha256: state.grant_sha256,
                      original_intent_sha256: intentSha,
                      invocation_id: input.invocation_sha256,
                      nonce: randomBytes(32).toString('hex'),
                      host_identity_sha256: state.host_identity_sha256,
                      phase: '03',
                      action_id: 'evidence reconcile stage-proof',
                      initiator: 'inspector',
                      pid: process.pid,
                      hostname: hostname(),
                    },
                    issuer.record.private_key_base64,
                  ),
                );
            buffers.push(leaseBytes);
            if (!oldIntent)
              publish(
                join(directory, 'intent-03.json'),
                `worktree-host/devai/reconciliation/approvals/${state.approval_id}/intent-03.json`,
                intentBytes,
                leaseBytes,
                assertDomain,
              );
            if (!settling) {
              publish(
                join(directory, 'lease.json'),
                `worktree-host/devai/reconciliation/approvals/${state.approval_id}/lease.json`,
                leaseBytes,
                leaseBytes,
                assertDomain,
              );
              if (!present(shard)) {
                assertDomain();
                entered = true;
                mkdirSync(shard, { mode: 0o700 });
                owned.push(
                  reconciliationOwned(
                    lstatSync(shard, { bigint: true }),
                    `trusted-common-dir/objects/${oid.slice(0, 2)}`,
                  ),
                );
                if ((lstatSync(shard).mode & 0o7777) !== 0o700) fail();
                parents.set(shard, dirWitness(shard));
                syncNativeDirectory(shard);
                syncNativeDirectory(objects);
              }
              if (!present(objectPath)) {
                assertDomain();
                const fd = openSync(
                  scratch,
                  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
                  0o600,
                );
                entered = true;
                try {
                  const stat = fstatSync(fd, { bigint: true }),
                    identity = reconciliationOwned(
                      stat,
                      `trusted-common-dir/objects/${oid.slice(0, 2)}/.${oid.slice(2)}.reconciliation.tmp`,
                    );
                  owned.push(identity);
                  if ((stat.mode & 0o7777n) !== 0o600n || stat.nlink !== 1n) fail();
                  writeAll(fd, looseBytes);
                  fsyncSync(fd);
                  const prepared = readFile(scratch, {
                    sha256: provisionBytesSha(looseBytes),
                    bytes: looseBytes.length,
                  });
                  if (
                    !inflateSync(prepared.bytes, { maxOutputLength: rawObject.length }).equals(
                      rawObject,
                    )
                  )
                    fail();
                  fchmodSync(fd, 0o444);
                  fsyncSync(fd);
                  assertDomain();
                  const checked = readFile(
                    scratch,
                    { sha256: provisionBytesSha(looseBytes), bytes: looseBytes.length },
                    false,
                    false,
                  );
                  if (
                    (BigInt(checked.witness.mode) & 0o7777n) !== 0o444n ||
                    checked.identity.dev !== identity.dev ||
                    checked.identity.ino !== identity.ino ||
                    checked.identity.birthtime_ns !== identity.birthtime_ns
                  )
                    fail();
                  const named = lstatSync(scratch, { bigint: true });
                  if (
                    (named.mode & 0o7777n) !== 0o444n ||
                    named.dev !== stat.dev ||
                    named.ino !== stat.ino ||
                    named.birthtimeNs !== stat.birthtimeNs ||
                    named.nlink !== 1n
                  )
                    fail();
                  linkSync(scratch, objectPath);
                  owned.push(Object.freeze({ ...identity, target: outputs[0]?.path ?? '' }));
                  const after = lstatSync(scratch, { bigint: true }),
                    published = lstatSync(objectPath, { bigint: true });
                  if (
                    after.dev !== stat.dev ||
                    after.ino !== stat.ino ||
                    after.birthtimeNs !== stat.birthtimeNs ||
                    after.nlink !== 2n ||
                    published.dev !== stat.dev ||
                    published.ino !== stat.ino
                  )
                    fail();
                  unlinkSync(scratch);
                  syncNativeDirectory(shard);
                } finally {
                  closeSync(fd);
                }
              }
              readFile(
                objectPath,
                { sha256: provisionBytesSha(looseBytes), bytes: looseBytes.length },
                true,
                false,
              );
              assertDomain();
              const fd = openSync(
                lockPath,
                constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
                0o600,
              );
              entered = true;
              try {
                const stat = fstatSync(fd, { bigint: true }),
                  identity = reconciliationOwned(stat, 'trusted-worktree/index.lock');
                owned.push(identity);
                if (stat.nlink !== 1n || (stat.mode & 0o7777n) !== 0o600n) fail();
                writeAll(fd, indexBytes);
                fchmodSync(fd, Number(BigInt(before.witness.mode) & 0o7777n));
                fsyncSync(fd);
                const prepared = readFile(
                  lockPath,
                  { sha256: provisionBytesSha(indexBytes), bytes: indexBytes.length },
                  false,
                  false,
                );
                revalidateReconciliationIndexSource(repositoryRoot, anchor);
                if (!hasReconciliationCheckpointUnderAdmission(repositoryRoot, chainPath, anchor))
                  fail();
                assertDomain();
                if (
                  canonicalJson(readFile(indexPath, undefined, false, false).witness) !==
                  canonicalJson(before.witness)
                )
                  fail();
                const checked = readFile(
                  lockPath,
                  { sha256: provisionBytesSha(indexBytes), bytes: indexBytes.length },
                  false,
                  false,
                );
                if (
                  canonicalJson(checked.witness) !== canonicalJson(prepared.witness) ||
                  checked.identity.dev !== identity.dev ||
                  checked.identity.ino !== identity.ino ||
                  checked.identity.birthtime_ns !== identity.birthtime_ns
                )
                  fail();
                renameSync(lockPath, indexPath);
                owned.push(Object.freeze({ ...identity, target: 'trusted-worktree/index' }));
                syncNativeDirectory(paths.git_dir);
              } finally {
                closeSync(fd);
              }
            }
            const assertOutputs = () => {
              assertOutputBytes();
              if (!hasReconciliationCheckpointUnderAdmission(repositoryRoot, chainPath, anchor))
                fail();
            };
            assertOutputs();
            const final = readReconciliationHostApprovalUnderAdmission(
              repositoryRoot,
              state.approval_id,
              anchor,
            );
            if (
              assessReconciliationOwnerPhase(final.state, '03', final.clock, 'complete')
                .disposition !== 'settle'
            )
              fail();
            const completion = encodeReconciliationOwnerRecord(
              signReconciliationOwnerRecord(
                {
                  schemaVersion: '1.0.0',
                  kind: 'phase-completion',
                  domain: 'devai.reconciliation.owner.v1/phase-completion',
                  ...linked,
                  clock: final.clock,
                  intent_sha256: intentSha,
                  observed_grant_sha256: final.state.grant_sha256,
                  final_witness_sha256: provisionSha({
                    identity: plan.identity,
                    source_manifest_sha256: plan.source_manifest_sha256,
                    outputs_manifest_sha256: outputsSha,
                  }),
                  outputs_manifest_sha256: outputsSha,
                  phase: '03',
                  predecessor_completion_sha256: predecessor,
                  durability: 'durable',
                },
                issuer.record.private_key_base64,
              ),
            );
            buffers.push(completion);
            // A full Owner census cannot run while its own exclusive publication
            // scratch exists. Pin the authenticated private image immediately before
            // publication, admit only that exact scratch during its guarded lifecycle,
            // and run the full census again after the publisher removes it.
            const completionTarget = `worktree-host/devai/reconciliation/approvals/${state.approval_id}/phase-03.json`;
            const completionSeed = settling ? completion : leaseBytes;
            const completionScratch = reconciliationScratch(
              completionSeed,
              completionTarget,
              settling,
            );
            const privateImage = new Map(
              readdirSync(directory).map((name) => {
                const file = readNativePrivateFile(join(directory, name));
                const witness = { sha256: file.sha256, identity: file.identity };
                file.bytes.fill(0);
                return [name, witness] as const;
              }),
            );
            let scratchIdentity: ReconciliationPhaseOwned | undefined;
            const assertCompletionPublication = () => {
              assertOutputBytes();
              const names = readdirSync(directory);
              if (
                names.some((name) => !privateImage.has(name) && name !== completionScratch) ||
                [...privateImage.keys()].some((name) => !names.includes(name))
              )
                fail();
              for (const [name, witness] of privateImage) {
                const file = readNativePrivateFile(join(directory, name));
                try {
                  if (
                    file.sha256 !== witness.sha256 ||
                    canonicalJson(file.identity) !== canonicalJson(witness.identity)
                  )
                    fail();
                } finally {
                  file.bytes.fill(0);
                }
              }
              if (names.includes(completionScratch)) {
                const file = readFile(join(directory, completionScratch));
                if (
                  scratchIdentity &&
                  canonicalJson(file.identity) !== canonicalJson(scratchIdentity)
                )
                  fail();
                scratchIdentity ??= file.identity;
                if (file.bytes.length !== 0 && !file.bytes.equals(Buffer.from(completion))) fail();
                file.bytes.fill(0);
              } else if (scratchIdentity) fail();
            };
            publish(
              join(directory, 'phase-03.json'),
              `worktree-host/devai/reconciliation/approvals/${state.approval_id}/phase-03.json`,
              completion,
              completionSeed,
              assertCompletionPublication,
              settling,
            );
            assertOutputs();
            completionSha = provisionBytesSha(completion);
            if (!settling) {
              const lease = readNativePrivateFile(join(directory, 'lease.json'));
              buffers.push(lease.bytes);
              if (lease.sha256 !== provisionBytesSha(leaseBytes)) fail();
              assertOutputs();
              if (
                removeEntryIfIdentitySteps(join(directory, 'lease.json'), {
                  dev: BigInt(lease.identity.dev),
                  ino: BigInt(lease.identity.ino),
                  birthtimeNs: BigInt(lease.identity.birthtime_ns),
                }) !== 'removed'
              )
                fail();
              syncNativeDirectory(directory);
            }
            const finished = readReconciliationHostApprovalUnderAdmission(
              repositoryRoot,
              state.approval_id,
              anchor,
            );
            if (
              finished.state.lease_sha256 !== null ||
              finished.state.phases.find((p) => p.phase === '03')?.completion_sha256 !==
                completionSha
            )
              fail();
            assertOutputs();
          });
        },
      );
      return result(outcome);
    } catch (error) {
      if (entered) return result('indeterminate');
      throw error;
    } finally {
      for (const bytes of buffers) bytes.fill(0);
      disposeReconciliationHostContext(context);
    }
  });
}
function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset);
    if (count <= 0) fail();
    offset += count;
  }
}
