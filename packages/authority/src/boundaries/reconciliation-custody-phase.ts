import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readSync,
  fsyncSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
  readReconciliationHostIdentity,
  readReconciliationHostPaths,
} from './reconciliation-host-context.js';
import {
  invokeReconciliationHostOperation,
  readReconciliationExistingApprovalInput,
  readReconciliationHostBinding,
  withReconciliationHostBindingReader,
} from './reconciliation-host-operation.js';
import {
  readReconciliationHostApproval,
  readReconciliationHostApprovalUnderAdmission,
} from './reconciliation-host-owner.js';
import {
  provisionSha,
  provisionBytesSha,
  readNativeDirectory,
  readNativePrivateFile,
  readNativeReconciliationNamespace,
  syncNativeDirectory,
} from './reconciliation-host-namespace.js';
import {
  readExistingReconciliationPlan,
  revalidateReconciliationCustodySource,
} from './reconciliation-plan.js';
import { reconciliationCustodyManifest } from './reconciliation-effect-plan.js';
import { readReconciliationCustodyObjects } from './reconciliation-custody-input.js';

type Owned = Readonly<{ target: string; dev: string; ino: string; birthtime_ns: string }>;
type Output = Readonly<{ path: string; sha256: string; bytes: number }>;
export interface ReconciliationCustodyResult {
  readonly kind: 'reconciliation-custody-result';
  readonly phase: '01';
  readonly outcome: 'completed' | 'existing' | 'indeterminate';
  readonly approval_id: string;
  readonly plan_sha256: string;
  readonly outputs_manifest_sha256: string;
  readonly intent_sha256: string | null;
  readonly completion_sha256: string | null;
  readonly object_count: number;
  readonly owned: readonly Owned[];
  readonly grants_authority: false;
}
export class ReconciliationPhaseError extends Error {
  constructor(
    readonly code:
      'RECONCILIATION_PHASE_INVALID' | 'RECONCILIATION_PHASE_STALE' | 'RECONCILIATION_PHASE_HELD',
  ) {
    super(code);
    this.name = 'ReconciliationPhaseError';
  }
}
function fail(code: ReconciliationPhaseError['code'] = 'RECONCILIATION_PHASE_INVALID'): never {
  throw new ReconciliationPhaseError(code);
}
function identity(stat: BigIntStats, target: string): Owned {
  return Object.freeze({
    target,
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtime_ns: String(stat.birthtimeNs),
  });
}
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function regular(path: string, expected: Output, durable: boolean): Uint8Array {
  if (realpathSync(dirname(path)) !== dirname(path)) fail();
  const before = lstatSync(path, { bigint: true });
  if (
    !before.isFile() ||
    before.nlink !== 1n ||
    before.uid !== BigInt(process.geteuid?.() ?? -1) ||
    (before.mode & 0o7777n) !== 0o600n ||
    before.size !== BigInt(expected.bytes) ||
    before.size > 33554432n
  )
    fail();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.birthtimeNs !== before.birthtimeNs
    )
      fail('RECONCILIATION_PHASE_STALE');
    const bytes = Buffer.alloc(expected.bytes);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) fail();
      offset += count;
    }
    if (
      readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0 ||
      provisionBytesSha(bytes) !== expected.sha256
    )
      fail();
    if (durable) fsyncSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    for (const stat of [after, named])
      if (
        stat.dev !== before.dev ||
        stat.ino !== before.ino ||
        stat.birthtimeNs !== before.birthtimeNs ||
        stat.size !== before.size ||
        stat.mode !== before.mode ||
        stat.uid !== before.uid ||
        stat.nlink !== 1n ||
        stat.ctimeNs !== before.ctimeNs ||
        stat.mtimeNs !== before.mtimeNs
      )
        fail('RECONCILIATION_PHASE_STALE');
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function scratch(seed: Uint8Array, pid: number, target: string, settlement = false): string {
  if (pid !== process.pid) fail();
  const bytes = createHash('sha256')
    .update(
      canonicalJson({
        domain: settlement
          ? 'devai.reconciliation.settlement-scratch.v1'
          : 'devai.reconciliation.phase-scratch.v1',
        ...(settlement
          ? { completion_sha256: provisionBytesSha(seed) }
          : { lease_sha256: provisionBytesSha(seed) }),
        target,
        purpose: settlement ? 'private-completion-publication' : 'publication',
      }),
    )
    .digest()
    .subarray(0, 16);
  const six = bytes[6],
    eight = bytes[8];
  if (six === undefined || eight === undefined) fail();
  bytes[6] = (six & 15) | 64;
  bytes[8] = (eight & 63) | 128;
  const hex = bytes.toString('hex');
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return `.${basename(target)}.${String(pid)}-${uuid}.publish-staged`;
}

/** Fixed phase01 only: original raw history bytes, never a caller-selected output or signer. */
export function materializeReconciliationCustody(
  repositoryRoot: string,
): ReconciliationCustodyResult {
  return withReconciliationHostBindingReader((readBinding) =>
    materializeCustody(repositoryRoot, readBinding),
  );
}

function materializeCustody(
  repositoryRoot: string,
  readBinding: () => ReturnType<typeof readReconciliationHostBinding>,
): ReconciliationCustodyResult {
  const buffers: Uint8Array[] = [];
  let context: ReturnType<typeof captureReconciliationHostContext> | undefined;
  const owned: Owned[] = [];
  let entered = false;
  let intentSha: string | null = null,
    completionSha: string | null = null;
  const input = readReconciliationExistingApprovalInput();
  if (
    input.action_id !== 'evidence reconcile materialize' ||
    realpathSync(repositoryRoot) !== repositoryRoot
  )
    fail();
  const scope = requireScope('process');
  const plan = readExistingReconciliationPlan(repositoryRoot);
  const initial = readReconciliationHostApproval(repositoryRoot, input.approval_id);
  if (
    !initial.binding_matches_approval ||
    initial.state.plan_sha256 !== input.plan_sha256 ||
    initial.state.source_manifest_sha256 !== plan.source_manifest_sha256 ||
    provisionSha(initial.identity) !== provisionSha(plan.identity)
  )
    fail('RECONCILIATION_PHASE_STALE');
  const outputs: readonly Output[] = [
    ...plan.effect_plan.custody.objects,
    plan.effect_plan.custody.manifest,
  ];
  const manifestSha = provisionSha({
    schemaVersion: '1.0.0',
    kind: 'reconciliation-domain-outputs',
    phase: '01',
    outputs,
  });
  const raw = readReconciliationCustodyObjects(repositoryRoot, plan);
  const custodyBytes = Buffer.from(reconciliationCustodyManifest(plan));
  const body = (output: Output): Uint8Array => {
    const bytes =
      output.path === plan.effect_plan.custody.manifest.path
        ? custodyBytes
        : raw.get(output.sha256);
    if (!bytes || bytes.length !== output.bytes || provisionBytesSha(bytes) !== output.sha256)
      fail();
    return bytes;
  };
  const result = (outcome: ReconciliationCustodyResult['outcome']): ReconciliationCustodyResult =>
    Object.freeze({
      kind: 'reconciliation-custody-result',
      phase: '01',
      outcome,
      approval_id: input.approval_id,
      plan_sha256: input.plan_sha256,
      outputs_manifest_sha256: manifestSha,
      intent_sha256: intentSha,
      completion_sha256: completionSha,
      object_count: plan.effect_plan.custody.objects.length,
      owned: Object.freeze([...owned]),
      grants_authority: false,
    });
  try {
    const binding = readBinding();
    context = captureReconciliationHostContext(repositoryRoot, binding.identity.repository_id);
    if (provisionSha(readReconciliationHostIdentity(context)) !== provisionSha(plan.identity))
      fail('RECONCILIATION_PHASE_STALE');
    const paths = readReconciliationHostPaths(context);
    const namespace = readNativeReconciliationNamespace(paths, binding.identity);
    if (namespace.issuer) buffers.push(namespace.issuer.bytes);
    const issuer = namespace.issuer,
      anchor = namespace.anchor;
    if (!issuer || !anchor || namespace.sha256 !== initial.namespace_sha256)
      fail('RECONCILIATION_PHASE_STALE');
    const directory = join(paths.private_root, 'approvals', input.approval_id);
    const privateDirectory = readNativeDirectory(directory);
    const privateRoot = namespace.root;
    if (!privateDirectory || !privateRoot) fail();
    const publicParents = new Map<string, string>();
    const directoryKey = (path: string): string => {
      if (realpathSync(path) !== path) fail();
      const stat = lstatSync(path, { bigint: true });
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.uid !== BigInt(process.geteuid?.() ?? -1)
      )
        fail();
      return [stat.dev, stat.ino, stat.birthtimeNs, stat.uid, stat.mode].join(':');
    };
    for (const path of [
      repositoryRoot,
      join(repositoryRoot, 'record'),
      join(repositoryRoot, 'record/proofs'),
    ])
      publicParents.set(path, directoryKey(path));
    const assertHost = () => {
      const current = readBinding();
      if (
        scopes.getStore() !== scope ||
        current.binding_sha256 !== plan.binding_sha256 ||
        provisionSha(current.identity) !== provisionSha(plan.identity) ||
        provisionSha(readNativeDirectory(directory)) !== provisionSha(privateDirectory) ||
        provisionSha(readNativeDirectory(paths.private_root)) !== provisionSha(privateRoot)
      )
        fail('RECONCILIATION_PHASE_STALE');
      for (const [path, witness] of publicParents)
        if (directoryKey(path) !== witness) fail('RECONCILIATION_PHASE_STALE');
      return current;
    };
    const dirs = plan.effect_plan.custody.directories;
    const inspect = (
      phaseTwoExists: boolean,
      durable = false,
    ): 'absent' | 'partial-known' | 'complete' => {
      const ns = join(repositoryRoot, plan.effect_plan.namespace),
        objects = join(ns, 'objects');
      if (present(ns)) {
        if (!readNativeDirectory(ns)) fail();
        const allowed = new Set([
          'objects',
          'custody.json',
          ...(phaseTwoExists ? ['selection.json'] : []),
        ]);
        if (readdirSync(ns).some((name) => !allowed.has(name))) fail('RECONCILIATION_PHASE_HELD');
      }
      if (present(objects)) {
        if (!readNativeDirectory(objects)) fail();
        const names = new Set(plan.effect_plan.custody.objects.map((item) => basename(item.path)));
        if (readdirSync(objects).some((name) => !names.has(name)))
          fail('RECONCILIATION_PHASE_HELD');
      }
      let count = 0;
      for (const output of outputs)
        if (present(join(repositoryRoot, output.path))) {
          regular(join(repositoryRoot, output.path), output, durable);
          count++;
        }
      return count === 0 ? 'absent' : count === outputs.length ? 'complete' : 'partial-known';
    };
    const publish = (
      absolute: string,
      target: string,
      bytes: Uint8Array,
      leaseBytes: Uint8Array,
      guard: () => unknown = assertHost,
      settlement = false,
    ): void => {
      guard();
      entered = true;
      try {
        const found = publishPrivateNoReplacePreparedSteps(
          absolute,
          scratch(leaseBytes, process.pid, target, settlement),
          bytes,
          {
            verifyPrepared: () => {
              guard();
            },
          },
        );
        owned.push(
          Object.freeze({
            target,
            dev: String(found.dev),
            ino: String(found.ino),
            birthtime_ns: String(found.birthtimeNs),
          }),
        );
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
    let outcome: 'completed' | 'existing' = 'completed';
    invokeReconciliationHostOperation(
      {
        kind: 'reconciliation-host',
        id: `reconciliation-host:${plan.identity.repository_id}:${plan.identity.worktree_id}:consume-phase:${input.approval_id}:01`,
        repository_id: plan.identity.repository_id,
        worktree_id: plan.identity.worktree_id,
        operation: 'consume-phase',
        binding_sha256: plan.binding_sha256,
        plan_sha256: input.plan_sha256,
        approval_id: input.approval_id,
        phase: '01',
      },
      (host) => {
        if (
          provisionSha(host.identity) !== provisionSha(plan.identity) ||
          provisionSha(host.bindings) !== plan.binding_sha256
        )
          fail('RECONCILIATION_PHASE_STALE');
        withReconciliationAdmissionSteps(host.paths.private_root, anchor, () => {
          const snapshot = readReconciliationHostApprovalUnderAdmission(
            repositoryRoot,
            input.approval_id,
            anchor,
          );
          if (snapshot.namespace_sha256 !== namespace.sha256) fail('RECONCILIATION_PHASE_STALE');
          const state = snapshot.state,
            selected = state.phases.find((item) => item.phase === '01');
          if (!selected || state.lease_sha256 !== null) fail('RECONCILIATION_PHASE_HELD');
          const phaseTwo = state.phases.some(
            (item) => item.phase === '02' && item.intent_sha256 !== null,
          );
          const outputState = inspect(phaseTwo);
          const assessment = assessReconciliationOwnerPhase(
            state,
            '01',
            snapshot.clock,
            outputState,
          );
          if (assessment.disposition === 'held') fail('RECONCILIATION_PHASE_HELD');
          if (selected.completion_sha256 !== null) {
            const old = readNativePrivateFile(join(directory, 'phase-01.json'));
            buffers.push(old.bytes);
            const record = decodeReconciliationOwnerRecord(old.bytes);
            if (
              record.kind !== 'phase-completion' ||
              record.outputs_manifest_sha256 !== manifestSha ||
              old.sha256 !== selected.completion_sha256
            )
              fail();
            intentSha = selected.intent_sha256;
            completionSha = selected.completion_sha256;
            outcome = 'existing';
            return;
          }
          revalidateReconciliationCustodySource(repositoryRoot, anchor);
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
          const assertDomain = (): void => {
            const current = assertHost();
            if (
              grant.kind === 'revocation' ||
              current.clock.boot_id !== grant.clock.boot_id ||
              current.clock.wall_ms >= grant.expires_wall_ms ||
              BigInt(current.clock.monotonic_ns) >= BigInt(grant.expires_monotonic_ns)
            )
              fail('RECONCILIATION_PHASE_HELD');
          };
          const linked = {
            repository_id: state.repository_id,
            worktree_id: state.worktree_id,
            approval_id: state.approval_id,
            issuer_sha256: state.issuer_sha256,
            approval_sha256: state.approval_sha256,
            scope_sha256: state.scope_sha256,
          };
          let intentBytes: Uint8Array;
          if (selected.intent_sha256 !== null) {
            const file = readNativePrivateFile(join(directory, 'intent-01.json'));
            buffers.push(file.bytes);
            const record = decodeReconciliationOwnerRecord(file.bytes);
            if (
              record.kind !== 'phase-intent' ||
              file.sha256 !== selected.intent_sha256 ||
              record.output_plan_sha256 !== manifestSha
            )
              fail();
            intentBytes = file.bytes;
            intentSha = file.sha256;
          } else {
            assertDomain();
            const record = signReconciliationOwnerRecord(
              {
                schemaVersion: '1.0.0',
                kind: 'phase-intent',
                domain: 'devai.reconciliation.owner.v1/phase-intent',
                ...linked,
                clock: readBinding().clock,
                grant_sha256: state.grant_sha256,
                before_witness_sha256: provisionSha({
                  namespace_sha256: snapshot.namespace_sha256,
                  identity: snapshot.identity,
                  source_manifest_sha256: plan.source_manifest_sha256,
                  index_sha256: plan.source_manifest.index.raw_sha256,
                }),
                output_plan_sha256: manifestSha,
                lease_nonce: randomBytes(32).toString('hex'),
                invocation_id: input.invocation_sha256,
                phase: '01',
                action_id: 'evidence reconcile materialize',
                initiator: 'inspector',
                predecessor_completion_sha256: null,
              },
              issuer.record.private_key_base64,
            );
            if (record.kind !== 'phase-intent') fail();
            intentBytes = encodeReconciliationOwnerRecord(record);
            buffers.push(intentBytes);
            intentSha = provisionBytesSha(intentBytes);
          }
          const settling = assessment.disposition === 'settle';
          let leaseBytes: Uint8Array = new Uint8Array();
          if (!settling) {
            assertDomain();
            const leaseRecord = signReconciliationOwnerRecord(
              {
                schemaVersion: '1.0.0',
                kind: 'lease',
                domain: 'devai.reconciliation.owner.v1/lease',
                ...linked,
                clock: readBinding().clock,
                grant_sha256: state.grant_sha256,
                original_intent_sha256: intentSha,
                invocation_id: input.invocation_sha256,
                nonce: randomBytes(32).toString('hex'),
                host_identity_sha256: state.host_identity_sha256,
                phase: '01',
                action_id: 'evidence reconcile materialize',
                initiator: 'inspector',
                pid: process.pid,
                hostname: hostname(),
              },
              issuer.record.private_key_base64,
            );
            leaseBytes = encodeReconciliationOwnerRecord(leaseRecord);
            buffers.push(leaseBytes);
          }
          if (selected.intent_sha256 === null)
            publish(
              join(directory, 'intent-01.json'),
              `worktree-host/devai/reconciliation/approvals/${state.approval_id}/intent-01.json`,
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
            for (const relative of dirs) {
              assertDomain();
              const absolute = join(repositoryRoot, relative);
              if (present(absolute)) {
                if (realpathSync(absolute) !== absolute || !lstatSync(absolute).isDirectory())
                  fail();
                if (relative !== dirs[0] && !readNativeDirectory(absolute)) fail();
                publicParents.set(absolute, directoryKey(absolute));
                continue;
              }
              if (realpathSync(dirname(absolute)) !== dirname(absolute)) fail();
              entered = true;
              mkdirSync(absolute, { mode: 0o700 });
              const created = lstatSync(absolute, { bigint: true });
              owned.push(identity(created, relative));
              if (!readNativeDirectory(absolute)) fail();
              publicParents.set(absolute, directoryKey(absolute));
              syncNativeDirectory(absolute);
              syncNativeDirectory(dirname(absolute));
            }
            for (const output of outputs) {
              assertDomain();
              const absolute = join(repositoryRoot, output.path);
              if (!present(absolute))
                publish(absolute, output.path, body(output), leaseBytes, assertDomain);
              const bytes = regular(absolute, output, true);
              if (!Buffer.from(bytes).equals(Buffer.from(body(output)))) fail();
            }
          }
          if (inspect(phaseTwo, true) !== 'complete') fail();
          revalidateReconciliationCustodySource(repositoryRoot, anchor);
          const current = readReconciliationHostApprovalUnderAdmission(
            repositoryRoot,
            state.approval_id,
            anchor,
          );
          const finalAssessment = assessReconciliationOwnerPhase(
            current.state,
            '01',
            current.clock,
            'complete',
          );
          if (finalAssessment.disposition !== 'settle') fail('RECONCILIATION_PHASE_HELD');
          const completion = signReconciliationOwnerRecord(
            {
              schemaVersion: '1.0.0',
              kind: 'phase-completion',
              domain: 'devai.reconciliation.owner.v1/phase-completion',
              ...linked,
              clock: current.clock,
              intent_sha256: intentSha,
              observed_grant_sha256: current.state.grant_sha256,
              final_witness_sha256: provisionSha({
                identity: current.identity,
                source_manifest_sha256: plan.source_manifest_sha256,
                outputs_manifest_sha256: manifestSha,
              }),
              outputs_manifest_sha256: manifestSha,
              phase: '01',
              predecessor_completion_sha256: null,
              durability: 'durable',
            },
            issuer.record.private_key_base64,
          );
          const completionBytes = encodeReconciliationOwnerRecord(completion);
          buffers.push(completionBytes);
          publish(
            join(directory, 'phase-01.json'),
            `worktree-host/devai/reconciliation/approvals/${state.approval_id}/phase-01.json`,
            completionBytes,
            settling ? completionBytes : leaseBytes,
            assertHost,
            settling,
          );
          completionSha = provisionBytesSha(completionBytes);
          if (!settling) {
            const leaseFile = readNativePrivateFile(join(directory, 'lease.json'));
            buffers.push(leaseFile.bytes);
            if (leaseFile.sha256 !== provisionBytesSha(leaseBytes)) fail();
            assertHost();
            entered = true;
            if (
              removeEntryIfIdentitySteps(join(directory, 'lease.json'), {
                dev: BigInt(leaseFile.identity.dev),
                ino: BigInt(leaseFile.identity.ino),
                birthtimeNs: BigInt(leaseFile.identity.birthtime_ns),
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
            finished.state.phases.find((item) => item.phase === '01')?.completion_sha256 !==
              completionSha
          )
            fail();
          assertHost();
        });
      },
    );
    assertHost();
    return result(outcome);
  } catch (error) {
    if (entered) return result('indeterminate');
    throw error;
  } finally {
    for (const bytes of buffers) bytes.fill(0);
    if (context) disposeReconciliationHostContext(context);
  }
}
