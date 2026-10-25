import { randomBytes } from 'node:crypto';
import { canonicalJson } from '@devai-nyx/utils';
import { hostname } from 'node:os';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  readdirSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
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
  type readReconciliationHostBinding,
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
  parseReconciliationChain,
  readExistingReconciliationPlan,
  revalidateReconciliationSelectionSource,
} from './reconciliation-plan.js';
import { readReconciliationCustodyObjects } from './reconciliation-custody-input.js';
import { buildReconciliationSelection } from './reconciliation-selection.js';
import {
  readReconciliationDomainFile as readFile,
  reconciliationOwned,
  reconciliationPresent as present,
  reconciliationScratch,
  type ReconciliationPhaseOwned,
} from './reconciliation-phase-files.js';

export interface ReconciliationSelectionResult {
  readonly kind: 'reconciliation-selection-result';
  readonly phase: '02';
  readonly outcome: 'completed' | 'existing' | 'indeterminate';
  readonly approval_id: string;
  readonly plan_sha256: string;
  readonly intent_sha256: string | null;
  readonly completion_sha256: string | null;
  readonly outputs_manifest_sha256: string | null;
  readonly owned: readonly ReconciliationPhaseOwned[];
  readonly grants_authority: false;
}
function fail(): never {
  throw new Error('RECONCILIATION_PHASE_HELD');
}

/** Fixed native selection under real Owner admission and normal append serialization. */
export function materializeReconciliationSelection(
  repositoryRoot: string,
): ReconciliationSelectionResult {
  return withReconciliationHostBindingReader((read) => materialize(repositoryRoot, read));
}
function materialize(
  repositoryRoot: string,
  readBinding: () => ReturnType<typeof readReconciliationHostBinding>,
): ReconciliationSelectionResult {
  const input = readReconciliationExistingApprovalInput(),
    scope = requireScope('process');
  if (
    input.action_id !== 'evidence reconcile materialize' ||
    realpathSync(repositoryRoot) !== repositoryRoot
  )
    fail();
  const plan = readExistingReconciliationPlan(repositoryRoot),
    recipe = plan.effect_plan.selection;
  const initial = readReconciliationHostApproval(repositoryRoot, input.approval_id);
  if (
    !initial.binding_matches_approval ||
    initial.state.plan_sha256 !== input.plan_sha256 ||
    provisionSha(initial.identity) !== provisionSha(plan.identity)
  )
    fail();
  const originals = readReconciliationCustodyObjects(repositoryRoot, plan),
    selected = originals.get(recipe.selected_chain_sha256);
  if (!selected) fail();
  // A signed completion is not a substitute for rereading complete public custody.
  const verifyCustody = (allowSelection: boolean): void => {
    const namespace = join(repositoryRoot, plan.effect_plan.namespace);
    const objects = join(namespace, 'objects');
    if (!readNativeDirectory(namespace) || !readNativeDirectory(objects)) fail();
    const names = new Set([
      'objects',
      'custody.json',
      ...(allowSelection ? ['selection.json'] : []),
    ]);
    if (readdirSync(namespace).some((name) => !names.has(name))) fail();
    const expected = new Set(
      plan.effect_plan.custody.objects.map((output) => output.path.split('/').at(-1)),
    );
    if (readdirSync(objects).some((name) => !expected.has(name))) fail();
    for (const output of [...plan.effect_plan.custody.objects, plan.effect_plan.custody.manifest])
      readFile(join(repositoryRoot, output.path), output);
  };
  verifyCustody(
    initial.state.phases.some((phase) => phase.phase === '02' && phase.intent_sha256 !== null),
  );
  const binding = readBinding(),
    context = captureReconciliationHostContext(repositoryRoot, binding.identity.repository_id);
  const buffers: Uint8Array[] = [],
    owned: ReconciliationPhaseOwned[] = [];
  let entered = false,
    intentSha: string | null = null,
    completionSha: string | null = null,
    outputsSha: string | null = null;
  let lockOwned: ReconciliationPhaseOwned | undefined,
    candidateOwned: ReconciliationPhaseOwned | undefined;
  const activePath = join(repositoryRoot, recipe.active_path),
    lockPath = join(repositoryRoot, recipe.append_lock_path),
    candidatePath = join(repositoryRoot, recipe.candidate_path);
  const result = (
    outcome: ReconciliationSelectionResult['outcome'],
  ): ReconciliationSelectionResult =>
    Object.freeze({
      kind: 'reconciliation-selection-result',
      phase: '02',
      outcome,
      approval_id: input.approval_id,
      plan_sha256: input.plan_sha256,
      intent_sha256: intentSha,
      completion_sha256: completionSha,
      outputs_manifest_sha256: outputsSha,
      owned: Object.freeze([...owned]),
      grants_authority: false,
    });
  const removeOwned = (path: string, identity: ReconciliationPhaseOwned): void => {
    if (
      removeEntryIfIdentitySteps(path, {
        dev: BigInt(identity.dev),
        ino: BigInt(identity.ino),
        birthtimeNs: BigInt(identity.birthtime_ns),
      }) !== 'removed'
    )
      fail();
    syncNativeDirectory(dirname(path));
  };
  try {
    const paths = readReconciliationHostPaths(context),
      namespace = readNativeReconciliationNamespace(paths, binding.identity);
    if (namespace.issuer) buffers.push(namespace.issuer.bytes);
    const issuer = namespace.issuer,
      anchor = namespace.anchor;
    if (!issuer || !anchor || namespace.sha256 !== initial.namespace_sha256) fail();
    const directory = join(paths.private_root, 'approvals', input.approval_id);
    const parentPaths = [
      repositoryRoot,
      join(repositoryRoot, 'record'),
      join(repositoryRoot, 'record/proofs'),
      join(repositoryRoot, 'record/proofs/reconciliation'),
      join(repositoryRoot, plan.effect_plan.namespace),
      paths.private_root,
      directory,
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
    const parents = new Map(parentPaths.map((path) => [path, directoryWitness(path)]));
    const assertHost = () => {
      const now = readBinding();
      if (
        scopes.getStore() !== scope ||
        now.binding_sha256 !== plan.binding_sha256 ||
        provisionSha(now.identity) !== provisionSha(plan.identity)
      )
        fail();
      for (const [path, witness] of parents) if (directoryWitness(path) !== witness) fail();
      const index = readFile(join(paths.git_dir, 'index'), undefined, false, false);
      if (index.sha256 !== plan.source_manifest.index.raw_sha256) fail();
      return now;
    };
    const publish = (
      path: string,
      target: string,
      bytes: Uint8Array,
      seed: Uint8Array,
      guard: () => unknown,
      settlement = false,
    ): ReconciliationPhaseOwned => {
      guard();
      entered = true;
      try {
        const identity = publishPrivateNoReplacePreparedSteps(
          path,
          reconciliationScratch(seed, target, settlement),
          bytes,
          {
            verifyPrepared: () => {
              guard();
            },
          },
        );
        const value = Object.freeze({
          target,
          dev: String(identity.dev),
          ino: String(identity.ino),
          birthtime_ns: String(identity.birthtimeNs),
        });
        owned.push(value);
        return value;
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
        id: `reconciliation-host:${plan.identity.repository_id}:${plan.identity.worktree_id}:consume-phase:${input.approval_id}:02`,
        repository_id: plan.identity.repository_id,
        worktree_id: plan.identity.worktree_id,
        operation: 'consume-phase',
        binding_sha256: plan.binding_sha256,
        plan_sha256: input.plan_sha256,
        approval_id: input.approval_id,
        phase: '02',
      },
      (host) => {
        if (
          provisionSha(host.identity) !== provisionSha(plan.identity) ||
          provisionSha(host.bindings) !== plan.binding_sha256
        )
          fail();
        withReconciliationAdmissionSteps(host.paths.private_root, anchor, () => {
          try {
            const snapshot = readReconciliationHostApprovalUnderAdmission(
                repositoryRoot,
                input.approval_id,
                anchor,
              ),
              state = snapshot.state;
            if (snapshot.namespace_sha256 !== namespace.sha256 || state.lease_sha256 !== null)
              fail();
            const first = state.phases.find((p) => p.phase === '01'),
              second = state.phases.find((p) => p.phase === '02');
            if (!first?.completion_sha256 || !second) fail();
            const oldIntent =
              second.intent_sha256 === null
                ? undefined
                : readNativePrivateFile(join(directory, 'intent-02.json'));
            if (oldIntent) buffers.push(oldIntent.bytes);
            const oldRecord = oldIntent
              ? decodeReconciliationOwnerRecord(oldIntent.bytes)
              : undefined;
            if (
              oldIntent &&
              (oldIntent.sha256 !== second.intent_sha256 ||
                oldRecord?.kind !== 'phase-intent' ||
                oldRecord.phase !== '02')
            )
              fail();
            if (oldRecord && oldRecord.kind !== 'phase-intent') fail();
            const clock = oldRecord?.clock ?? assertHost().clock,
              nonce = oldRecord?.lease_nonce ?? randomBytes(32).toString('hex');
            const built = buildReconciliationSelection(
              plan,
              state,
              clock,
              nonce,
              repositoryRoot,
              selected,
            );
            outputsSha = built.outputs_manifest_sha256;
            if (oldRecord && oldRecord.output_plan_sha256 !== outputsSha) fail();
            const receiptOutput = built.outputs[0],
              chainOutput = built.outputs[1];
            if (!receiptOutput || !chainOutput) fail();
            const receiptPath = join(repositoryRoot, receiptOutput.path);
            const current = readFile(activePath, undefined, false, false);
            const witnessFor = (chain: ReturnType<typeof readFile>) =>
              provisionSha({
                identity: plan.identity,
                source_manifest_sha256: plan.source_manifest_sha256,
                index_sha256: plan.source_manifest.index.raw_sha256,
                chain: chain.witness,
                chain_sha256: chain.sha256,
              });
            const initialBefore = witnessFor(current);
            const beforeWitness = () => witnessFor(readFile(activePath, undefined, false, false));
            const receiptExists = present(receiptPath);
            if (receiptExists) readFile(receiptPath, receiptOutput);
            let outputState: 'absent' | 'partial-known' | 'complete' = 'absent';
            if (oldRecord) {
              if (
                receiptExists &&
                current.sha256 === chainOutput.sha256 &&
                current.bytes.length === chainOutput.bytes
              )
                outputState = 'complete';
              else if (beforeWitness() === oldRecord.before_witness_sha256)
                outputState = receiptExists ? 'partial-known' : 'absent';
              else if (second.completion_sha256 !== null && receiptExists) {
                const chain = parseReconciliationChain(current.bytes),
                  base = parseReconciliationChain(Buffer.from(built.candidate_text));
                const prefix = {
                  ...chain,
                  records: chain.records.slice(0, base.records.length),
                  head: base.head,
                };
                if (`${JSON.stringify(prefix, null, 2)}\n` !== built.candidate_text) fail();
                outputState = 'complete';
              } else fail();
            } else {
              if (receiptExists) fail();
              const originalHead = plan.source_manifest.files.find(
                (file) =>
                  file.commit === plan.identity.head &&
                  file.kind === 'chain' &&
                  file.path === recipe.active_path,
              );
              if (
                !originalHead ||
                current.sha256 !== originalHead.sha256 ||
                current.bytes.length !== originalHead.bytes
              )
                fail();
            }
            const assessment = assessReconciliationOwnerPhase(
              state,
              '02',
              snapshot.clock,
              outputState,
            );
            if (assessment.disposition === 'held') fail();
            intentSha = second.intent_sha256;
            if (second.completion_sha256 !== null) {
              const file = readNativePrivateFile(join(directory, 'phase-02.json'));
              buffers.push(file.bytes);
              const record = decodeReconciliationOwnerRecord(file.bytes);
              if (
                record.kind !== 'phase-completion' ||
                file.sha256 !== second.completion_sha256 ||
                record.outputs_manifest_sha256 !== outputsSha
              )
                fail();
              completionSha = file.sha256;
              outcome = 'existing';
              assertHost();
              return;
            }
            if (present(lockPath) || present(candidatePath)) fail();
            revalidateReconciliationSelectionSource(repositoryRoot, anchor);
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
              return now;
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
            if (oldIntent) intentBytes = oldIntent.bytes;
            else {
              assertDomain();
              if (beforeWitness() !== initialBefore) fail();
              intentBytes = encodeReconciliationOwnerRecord(
                signReconciliationOwnerRecord(
                  {
                    schemaVersion: '1.0.0',
                    kind: 'phase-intent',
                    domain: 'devai.reconciliation.owner.v1/phase-intent',
                    ...linked,
                    clock,
                    grant_sha256: state.grant_sha256,
                    before_witness_sha256: initialBefore,
                    output_plan_sha256: outputsSha,
                    lease_nonce: nonce,
                    invocation_id: input.invocation_sha256,
                    phase: '02',
                    action_id: 'evidence reconcile materialize',
                    initiator: 'inspector',
                    predecessor_completion_sha256: first.completion_sha256,
                  },
                  issuer.record.private_key_base64,
                ),
              );
              buffers.push(intentBytes);
              intentSha = provisionBytesSha(intentBytes);
            }
            if (intentSha === null) fail();
            const settling = assessment.disposition === 'settle';
            let leaseBytes: Uint8Array = new Uint8Array();
            let leaseNonce = '';
            if (!settling) {
              const now = assertDomain();
              leaseNonce = randomBytes(32).toString('hex');
              leaseBytes = encodeReconciliationOwnerRecord(
                signReconciliationOwnerRecord(
                  {
                    schemaVersion: '1.0.0',
                    kind: 'lease',
                    domain: 'devai.reconciliation.owner.v1/lease',
                    ...linked,
                    clock: now.clock,
                    grant_sha256: state.grant_sha256,
                    original_intent_sha256: intentSha,
                    invocation_id: input.invocation_sha256,
                    nonce: leaseNonce,
                    host_identity_sha256: state.host_identity_sha256,
                    phase: '02',
                    action_id: 'evidence reconcile materialize',
                    initiator: 'inspector',
                    pid: process.pid,
                    hostname: hostname(),
                  },
                  issuer.record.private_key_base64,
                ),
              );
              buffers.push(leaseBytes);
            }
            if (!oldIntent)
              publish(
                join(directory, 'intent-02.json'),
                `worktree-host/devai/reconciliation/approvals/${state.approval_id}/intent-02.json`,
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
              const lockBytes = Buffer.from(
                JSON.stringify({
                  operation: 'evidence-chain-append',
                  chain_path: activePath,
                  pid: process.pid,
                  nonce: leaseNonce,
                }) + '\n',
              );
              lockOwned = publish(
                lockPath,
                recipe.append_lock_path,
                lockBytes,
                leaseBytes,
                assertDomain,
              );
              if (beforeWitness() !== decodeIntentBefore(intentBytes)) fail();
              if (!receiptExists)
                publish(
                  receiptPath,
                  receiptOutput.path,
                  Buffer.from(built.receipt_text),
                  leaseBytes,
                  assertDomain,
                );
              assertDomain();
              const fd = openSync(
                candidatePath,
                constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
                0o600,
              );
              entered = true;
              try {
                const stat = fstatSync(fd, { bigint: true });
                candidateOwned = reconciliationOwned(stat, recipe.candidate_path);
                owned.push(candidateOwned);
                if ((stat.mode & 0o7777n) !== 0o600n || stat.nlink !== 1n) fail();
                const bytes = Buffer.from(built.candidate_text);
                let offset = 0;
                while (offset < bytes.length) {
                  const count = writeSync(fd, bytes, offset, bytes.length - offset);
                  if (count <= 0) fail();
                  offset += count;
                }
                fsyncSync(fd);
                const preparedCandidate = readFile(candidatePath, chainOutput);
                revalidateReconciliationSelectionSource(repositoryRoot, anchor);
                assertDomain();
                if (beforeWitness() !== decodeIntentBefore(intentBytes)) fail();
                const checkedCandidate = readFile(candidatePath, chainOutput);
                if (
                  canonicalJson(checkedCandidate.witness) !==
                  canonicalJson(preparedCandidate.witness)
                )
                  fail();
                const named = lstatSync(candidatePath, { bigint: true });
                if (
                  named.dev !== stat.dev ||
                  named.ino !== stat.ino ||
                  named.birthtimeNs !== stat.birthtimeNs ||
                  named.nlink !== 1n
                )
                  fail();
                renameSync(candidatePath, activePath);
                owned.push(Object.freeze({ ...candidateOwned, target: recipe.active_path }));
                candidateOwned = undefined;
                syncNativeDirectory(dirname(activePath));
              } finally {
                closeSync(fd);
              }
            }
            readFile(receiptPath, receiptOutput, true);
            readFile(activePath, chainOutput, true);
            revalidateReconciliationSelectionSource(repositoryRoot, anchor);
            const final = readReconciliationHostApprovalUnderAdmission(
              repositoryRoot,
              state.approval_id,
              anchor,
            );
            if (
              assessReconciliationOwnerPhase(final.state, '02', final.clock, 'complete')
                .disposition !== 'settle'
            )
              fail();
            const assertCompletion = () => {
              assertHost();
              verifyCustody(true);
              readFile(receiptPath, receiptOutput);
              readFile(activePath, chainOutput);
            };
            const completionBytes = encodeReconciliationOwnerRecord(
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
                  phase: '02',
                  predecessor_completion_sha256: first.completion_sha256,
                  durability: 'durable',
                },
                issuer.record.private_key_base64,
              ),
            );
            buffers.push(completionBytes);
            publish(
              join(directory, 'phase-02.json'),
              `worktree-host/devai/reconciliation/approvals/${state.approval_id}/phase-02.json`,
              completionBytes,
              settling ? completionBytes : leaseBytes,
              assertCompletion,
              settling,
            );
            completionSha = provisionBytesSha(completionBytes);
            if (lockOwned) {
              assertHost();
              removeOwned(lockPath, lockOwned);
              lockOwned = undefined;
            }
            if (!settling) {
              const lease = readNativePrivateFile(join(directory, 'lease.json'));
              buffers.push(lease.bytes);
              if (lease.sha256 !== provisionBytesSha(leaseBytes)) fail();
              assertHost();
              removeOwned(join(directory, 'lease.json'), {
                target: 'lease.json',
                ...lease.identity,
              });
            }
            const finished = readReconciliationHostApprovalUnderAdmission(
              repositoryRoot,
              state.approval_id,
              anchor,
            );
            if (
              finished.state.lease_sha256 !== null ||
              finished.state.phases.find((p) => p.phase === '02')?.completion_sha256 !==
                completionSha
            )
              fail();
            assertHost();
          } catch (error) {
            // Only current-process ephemeral entries have ownership witnesses. Immutable
            // intent, receipt and completion are never rolled back or rewritten.
            // Candidate removal is outside the frozen removal target bound.
            // Preserve it, with its owned identity, for explicit inspection.
            if (lockOwned) {
              try {
                removeOwned(lockPath, lockOwned);
              } catch {
                /* preserve uncertain ownership */
              }
            }
            throw error;
          }
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
}
function decodeIntentBefore(bytes: Uint8Array): string {
  const value = decodeReconciliationOwnerRecord(bytes);
  if (value.kind !== 'phase-intent') fail();
  return value.before_witness_sha256;
}
