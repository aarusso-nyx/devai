import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { types } from 'node:util';
import { getValidator } from '@devai-nyx/schemas';
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
  hasAuthenticatedReconciliationCheckpoint,
  hasReconciliationCheckpointUnderAdmission,
} from './reconciliation-checkpoint.js';
import { readNativeReconciliationInventoryInput } from './reconciliation-inventory-input.js';
import {
  readReconciliationDomainFile as readFile,
  reconciliationOwned,
  reconciliationPresent as present,
  reconciliationScratch,
  type ReconciliationPhaseOwned,
} from './reconciliation-phase-files.js';

export interface ReconciliationInventoryResult {
  readonly kind: 'reconciliation-inventory-result';
  readonly phase: '04';
  readonly outcome: 'completed' | 'existing' | 'indeterminate';
  readonly approval_id: string;
  readonly plan_sha256: string;
  readonly intent_sha256: string | null;
  readonly completion_sha256: string | null;
  readonly outputs_manifest_sha256: string;
  readonly outputs: readonly {
    readonly path: string;
    readonly schema: string;
    readonly sha256: string;
    readonly bytes: number;
  }[];
  readonly owned: readonly ReconciliationPhaseOwned[];
  readonly grants_authority: false;
  readonly publishes_readings: false;
  readonly grants_readiness: false;
}
function fail(): never {
  throw new Error('RECONCILIATION_PHASE_HELD');
}

/** Internal native publisher. Only the fixed bundled composer supplies data; data grants no effects. */
export function materializeReconciliationInventory(
  repositoryRoot: string,
  admittedInput: object,
  proposed: readonly { readonly path: string; readonly text: string }[],
): ReconciliationInventoryResult {
  return withReconciliationHostBindingReader((readBinding) => {
    const admitted = readNativeReconciliationInventoryInput(admittedInput),
      input = readReconciliationExistingApprovalInput(),
      scope = requireScope('process'),
      plan = admitted.plan,
      recipe = plan.effect_plan.inventory;
    if (
      input.action_id !== 'sense bootstrap-inventory' ||
      realpathSync(repositoryRoot) !== repositoryRoot ||
      !Array.isArray(proposed) ||
      types.isProxy(proposed) ||
      proposed.length !== 7
    )
      fail();
    const bodies = new Map<string, Buffer>();
    let plannedBytes = 0;
    const outputs = recipe.outputs.map((descriptor, index) => {
      const entryDescriptor = Object.getOwnPropertyDescriptor(proposed, String(index));
      if (!entryDescriptor || !Object.hasOwn(entryDescriptor, 'value')) fail();
      const value: unknown = entryDescriptor.value;
      if (!value || typeof value !== 'object' || types.isProxy(value)) fail();
      const path = Object.getOwnPropertyDescriptor(value, 'path'),
        text = Object.getOwnPropertyDescriptor(value, 'text');
      if (
        !path ||
        !text ||
        !Object.hasOwn(path, 'value') ||
        !Object.hasOwn(text, 'value') ||
        path.value !== descriptor.path ||
        typeof text.value !== 'string'
      )
        fail();
      const byteLength = Buffer.byteLength(text.value);
      plannedBytes += byteLength;
      if (byteLength > recipe.body_bytes_limit || plannedBytes > recipe.aggregate_bytes_limit)
        fail();
      const bytes = Buffer.from(text.value),
        parsed: unknown = JSON.parse(
          new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
        );
      if (
        bytes.length > recipe.body_bytes_limit ||
        !getValidator(descriptor.schema)(parsed) ||
        `${canonicalJson(parsed)}\n` !== text.value
      )
        fail();
      bodies.set(descriptor.path, bytes);
      return Object.freeze({
        path: descriptor.path,
        schema: descriptor.schema,
        sha256: provisionBytesSha(bytes),
        bytes: bytes.length,
      });
    });
    if (
      outputs.length !== 7 ||
      outputs.reduce((sum, file) => sum + file.bytes, 0) > recipe.aggregate_bytes_limit
    )
      fail();
    const manifestSha = provisionSha({
      schemaVersion: '1.0.0',
      kind: 'reconciliation-domain-outputs',
      phase: '04',
      outputs: outputs.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })),
    });
    const initial = readReconciliationHostApproval(repositoryRoot, input.approval_id);
    if (
      !initial.binding_matches_approval ||
      initial.state.plan_sha256 !== input.plan_sha256 ||
      initial.approval_namespace_sha256 !== admitted.approval_namespace_sha256 ||
      provisionSha(initial.identity) !== provisionSha(plan.identity) ||
      !hasAuthenticatedReconciliationCheckpoint(
        repositoryRoot,
        join(repositoryRoot, 'record/proofs/chain.json'),
      )
    )
      fail();
    const binding = readBinding(),
      context = captureReconciliationHostContext(repositoryRoot, binding.identity.repository_id),
      buffers: Uint8Array[] = [],
      owned: ReconciliationPhaseOwned[] = [];
    let entered = false,
      intentSha: string | null = null,
      completionSha: string | null = null;
    const result = (
      outcome: ReconciliationInventoryResult['outcome'],
    ): ReconciliationInventoryResult =>
      Object.freeze({
        kind: 'reconciliation-inventory-result',
        phase: '04',
        outcome,
        approval_id: input.approval_id,
        plan_sha256: input.plan_sha256,
        intent_sha256: intentSha,
        completion_sha256: completionSha,
        outputs_manifest_sha256: manifestSha,
        outputs: Object.freeze(outputs),
        owned: Object.freeze([...owned]),
        grants_authority: false,
        publishes_readings: false,
        grants_readiness: false,
      });
    try {
      const paths = readReconciliationHostPaths(context),
        namespace = readNativeReconciliationNamespace(paths, binding.identity);
      if (namespace.issuer) buffers.push(namespace.issuer.bytes);
      const issuer = namespace.issuer,
        anchor = namespace.anchor;
      if (
        !issuer ||
        !anchor ||
        namespace.sha256 !== initial.namespace_sha256 ||
        binding.binding_sha256 !== admitted.binding_sha256
      )
        fail();
      const directory = join(paths.private_root, 'approvals', input.approval_id);
      const directoryKey = (path: string): string => {
        if (realpathSync(path) !== path) fail();
        const stat = lstatSync(path, { bigint: true });
        if (
          !stat.isDirectory() ||
          stat.uid !== BigInt(process.geteuid?.() ?? -1) ||
          (stat.mode & 0o022n) !== 0n
        )
          fail();
        return [stat.dev, stat.ino, stat.birthtimeNs, stat.uid, stat.mode].join(':');
      };
      const parents = new Map(
        [
          repositoryRoot,
          join(repositoryRoot, '.devai'),
          paths.git_dir,
          paths.common_dir,
          paths.private_root,
          directory,
        ].map((path) => [path, directoryKey(path)]),
      );
      const indexPath = join(paths.git_dir, 'index'),
        chainPath = join(repositoryRoot, 'record/proofs/chain.json');
      // The native input authenticated the exact loose-object/index pair against03.
      const assertHost = () => {
        const now = readBinding();
        if (
          scopes.getStore() !== scope ||
          now.binding_sha256 !== admitted.binding_sha256 ||
          provisionSha(now.identity) !== provisionSha(plan.identity)
        )
          fail();
        for (const [path, witness] of parents) if (directoryKey(path) !== witness) fail();
        if (
          canonicalJson(
            readFile(
              join(repositoryRoot, input.plan_path),
              { sha256: admitted.plan_file.sha256, bytes: admitted.plan_file.bytes.length },
              false,
              false,
            ).witness,
          ) !== canonicalJson(admitted.plan_file.witness) ||
          canonicalJson(
            readFile(
              indexPath,
              { sha256: admitted.index.sha256, bytes: admitted.index.bytes.length },
              false,
              false,
            ).witness,
          ) !== canonicalJson(admitted.index.witness) ||
          canonicalJson(
            readFile(
              chainPath,
              { sha256: admitted.chain.sha256, bytes: admitted.chain.bytes.length },
              false,
              false,
            ).witness,
          ) !== canonicalJson(admitted.chain.witness) ||
          canonicalJson(
            readFile(
              admitted.object.identity.target,
              { sha256: admitted.object.sha256, bytes: admitted.object.bytes.length },
              false,
              false,
            ).witness,
          ) !== canonicalJson(admitted.object.witness)
        )
          fail();
        return now;
      };
      const knownOutputWitnesses = new Map<string, ReturnType<typeof readFile>['witness']>();
      const inventoryRoot = join(
        repositoryRoot,
        '.devai/state/reconciliation',
        plan.source_manifest_sha256,
        'inventory',
      );
      const inspect = (durable = false): 'absent' | 'partial-known' | 'complete' => {
        let count = 0;
        for (const relative of recipe.directories) {
          const absolute = join(repositoryRoot, relative);
          if (present(absolute)) {
            const witness = directoryKey(absolute),
              prior = parents.get(absolute);
            if (prior !== undefined && prior !== witness) fail();
            parents.set(absolute, witness);
          }
        }
        const scopedRoot = dirname(inventoryRoot);
        if (present(scopedRoot) && readdirSync(scopedRoot).some((name) => name !== 'inventory'))
          fail();
        const allowed = new Map<string, Set<string>>();
        for (const output of outputs) {
          const absolute = join(repositoryRoot, output.path),
            parent = dirname(absolute);
          if (!allowed.has(parent)) allowed.set(parent, new Set());
          allowed.get(parent)?.add(absolute.slice(parent.length + 1));
          if (present(parent)) {
            if (!parents.has(parent)) parents.set(parent, directoryKey(parent));
            else if (directoryKey(parent) !== parents.get(parent)) fail();
          }
          if (present(absolute)) {
            const file = readFile(absolute, output, durable);
            const prior = knownOutputWitnesses.get(output.path);
            if (prior && canonicalJson(file.witness) !== canonicalJson(prior)) fail();
            const owner = owned.findLast((entry) => entry.target === output.path);
            if (
              owner &&
              (file.identity.dev !== owner.dev ||
                file.identity.ino !== owner.ino ||
                file.identity.birthtime_ns !== owner.birthtime_ns)
            )
              fail();
            knownOutputWitnesses.set(output.path, file.witness);
            count++;
          }
        }
        if (present(inventoryRoot)) {
          const expected = new Set(
            [...allowed.keys()].map((path) => path.slice(inventoryRoot.length + 1)),
          );
          if (readdirSync(inventoryRoot).some((name) => !expected.has(name))) fail();
        }
        for (const [path, names] of allowed)
          if (present(path) && readdirSync(path).some((name) => !names.has(name))) fail();
        return count === 0 ? 'absent' : count === 7 ? 'complete' : 'partial-known';
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
          const own = publishPrivateNoReplacePreparedSteps(
            path,
            reconciliationScratch(seed, target, settlement),
            bytes,
            { verifyPrepared: guard },
          );
          owned.push(
            Object.freeze({
              target,
              dev: String(own.dev),
              ino: String(own.ino),
              birthtime_ns: String(own.birthtimeNs),
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
          id: `reconciliation-host:${plan.identity.repository_id}:${plan.identity.worktree_id}:consume-phase:${input.approval_id}:04`,
          repository_id: plan.identity.repository_id,
          worktree_id: plan.identity.worktree_id,
          operation: 'consume-phase',
          binding_sha256: admitted.binding_sha256,
          plan_sha256: input.plan_sha256,
          approval_id: input.approval_id,
          phase: '04',
        },
        (host) => {
          if (
            provisionSha(host.identity) !== provisionSha(plan.identity) ||
            provisionSha(host.bindings) !== admitted.binding_sha256
          )
            fail();
          withReconciliationAdmissionSteps(host.paths.private_root, anchor, () => {
            const snapshot = readReconciliationHostApprovalUnderAdmission(
                repositoryRoot,
                input.approval_id,
                anchor,
              ),
              state = snapshot.state;
            if (
              snapshot.approval_namespace_sha256 !== admitted.approval_namespace_sha256 ||
              state.lease_sha256 !== null ||
              state.phases.find((p) => p.phase === '03')?.completion_sha256 !== admitted.predecessor
            )
              fail();
            const phase = state.phases.find((p) => p.phase === '04');
            if (!phase) fail();
            assertHost();
            if (!hasReconciliationCheckpointUnderAdmission(repositoryRoot, chainPath, anchor))
              fail();
            const outputState = inspect(),
              assessment = assessReconciliationOwnerPhase(state, '04', snapshot.clock, outputState);
            if (assessment.disposition === 'held') fail();
            const oldIntent = phase.intent_sha256
              ? readNativePrivateFile(join(directory, 'intent-04.json'))
              : undefined;
            if (oldIntent) buffers.push(oldIntent.bytes);
            const oldRecord = oldIntent
              ? decodeReconciliationOwnerRecord(oldIntent.bytes)
              : undefined;
            if (
              oldRecord &&
              (oldRecord.kind !== 'phase-intent' ||
                oldRecord.phase !== '04' ||
                oldIntent?.sha256 !== phase.intent_sha256 ||
                oldRecord.output_plan_sha256 !== manifestSha ||
                canonicalJson(oldRecord.clock) !== canonicalJson(admitted.clock))
            )
              fail();
            if (oldRecord && oldRecord.kind !== 'phase-intent') fail();
            const assertOutputs = () => {
              assertHost();
              if (inspect(true) !== 'complete') fail();
            };
            if (phase.completion_sha256) {
              const file = readNativePrivateFile(join(directory, 'phase-04.json'));
              buffers.push(file.bytes);
              const record = decodeReconciliationOwnerRecord(file.bytes);
              if (
                record.kind !== 'phase-completion' ||
                file.sha256 !== phase.completion_sha256 ||
                record.outputs_manifest_sha256 !== manifestSha
              )
                fail();
              assertOutputs();
              intentSha = phase.intent_sha256;
              completionSha = file.sha256;
              outcome = 'existing';
              return;
            }
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
            const linked = {
              repository_id: state.repository_id,
              worktree_id: state.worktree_id,
              approval_id: state.approval_id,
              issuer_sha256: state.issuer_sha256,
              approval_sha256: state.approval_sha256,
              scope_sha256: state.scope_sha256,
            };
            const beforeWitness = provisionSha({
              identity: plan.identity,
              index: admitted.index.witness,
              chain: admitted.chain.witness,
              source_sha256: recipe.source_sha256,
            });
            if (oldRecord && oldRecord.before_witness_sha256 !== beforeWitness) fail();
            const intentBytes =
              oldIntent?.bytes ??
              encodeReconciliationOwnerRecord(
                signReconciliationOwnerRecord(
                  {
                    schemaVersion: '1.0.0',
                    kind: 'phase-intent',
                    domain: 'devai.reconciliation.owner.v1/phase-intent',
                    ...linked,
                    clock: admitted.clock,
                    grant_sha256: state.grant_sha256,
                    before_witness_sha256: beforeWitness,
                    output_plan_sha256: manifestSha,
                    lease_nonce: randomBytes(32).toString('hex'),
                    invocation_id: input.invocation_sha256,
                    phase: '04',
                    action_id: 'sense bootstrap-inventory',
                    initiator: 'architect',
                    predecessor_completion_sha256: admitted.predecessor,
                  },
                  issuer.record.private_key_base64,
                ),
              );
            if (!oldIntent) buffers.push(intentBytes);
            intentSha = provisionBytesSha(intentBytes);
            const settling = assessment.disposition === 'settle';
            const lease = settling
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
                      phase: '04',
                      action_id: 'sense bootstrap-inventory',
                      initiator: 'architect',
                      pid: process.pid,
                      hostname: hostname(),
                    },
                    issuer.record.private_key_base64,
                  ),
                );
            buffers.push(lease);
            if (!oldIntent)
              publish(
                join(directory, 'intent-04.json'),
                `worktree-host/devai/reconciliation/approvals/${state.approval_id}/intent-04.json`,
                intentBytes,
                lease,
                assertDomain,
              );
            if (!settling) {
              publish(
                join(directory, 'lease.json'),
                `worktree-host/devai/reconciliation/approvals/${state.approval_id}/lease.json`,
                lease,
                lease,
                assertDomain,
              );
              for (const relative of recipe.directories) {
                assertDomain();
                const absolute = join(repositoryRoot, relative);
                if (present(absolute)) {
                  const witness = directoryKey(absolute),
                    prior = parents.get(absolute);
                  if (prior !== undefined && prior !== witness) fail();
                  parents.set(absolute, witness);
                  continue;
                }
                if (realpathSync(dirname(absolute)) !== dirname(absolute)) fail();
                entered = true;
                mkdirSync(absolute, { mode: 0o700 });
                const stat = lstatSync(absolute, { bigint: true });
                owned.push(reconciliationOwned(stat, relative));
                if ((stat.mode & 0o7777n) !== 0o700n) fail();
                const witness = directoryKey(absolute);
                if (
                  witness !== [stat.dev, stat.ino, stat.birthtimeNs, stat.uid, stat.mode].join(':')
                )
                  fail();
                parents.set(absolute, witness);
                syncNativeDirectory(absolute);
                syncNativeDirectory(dirname(absolute));
              }
              for (const output of outputs) {
                assertDomain();
                const absolute = join(repositoryRoot, output.path),
                  body = bodies.get(output.path);
                if (!body) fail();
                if (!present(absolute)) publish(absolute, output.path, body, lease, assertDomain);
                readFile(absolute, output, true);
              }
            }
            assertOutputs();
            if (!hasReconciliationCheckpointUnderAdmission(repositoryRoot, chainPath, anchor))
              fail();
            const current = readReconciliationHostApprovalUnderAdmission(
              repositoryRoot,
              input.approval_id,
              anchor,
            );
            if (
              assessReconciliationOwnerPhase(current.state, '04', current.clock, 'complete')
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
                  clock: current.clock,
                  intent_sha256: intentSha,
                  observed_grant_sha256: current.state.grant_sha256,
                  final_witness_sha256: provisionSha({
                    identity: plan.identity,
                    source_sha256: recipe.source_sha256,
                    outputs_manifest_sha256: manifestSha,
                  }),
                  outputs_manifest_sha256: manifestSha,
                  phase: '04',
                  predecessor_completion_sha256: admitted.predecessor,
                  durability: 'durable',
                },
                issuer.record.private_key_base64,
              ),
            );
            buffers.push(completion);
            // During own completion publication, pin every authenticated private record
            // and admit only the fixed scratch; the full Owner census runs before/after.
            const target = `worktree-host/devai/reconciliation/approvals/${state.approval_id}/phase-04.json`,
              seed = settling ? completion : lease,
              scratch = reconciliationScratch(seed, target, settling);
            const privateImage = new Map(
              readdirSync(directory).map((name) => {
                const file = readNativePrivateFile(join(directory, name)),
                  witness = { sha256: file.sha256, identity: file.identity };
                file.bytes.fill(0);
                return [name, witness] as const;
              }),
            );
            let scratchIdentity: ReconciliationPhaseOwned | undefined;
            const completionGuard = () => {
              assertOutputs();
              const names = readdirSync(directory);
              if (
                names.some((name) => !privateImage.has(name) && name !== scratch) ||
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
              if (names.includes(scratch)) {
                const file = readFile(join(directory, scratch));
                try {
                  if (
                    scratchIdentity &&
                    canonicalJson(file.identity) !== canonicalJson(scratchIdentity)
                  )
                    fail();
                  scratchIdentity ??= file.identity;
                  if (file.bytes.length !== 0 && !file.bytes.equals(Buffer.from(completion)))
                    fail();
                } finally {
                  file.bytes.fill(0);
                }
              } else if (scratchIdentity) fail();
            };
            publish(
              join(directory, 'phase-04.json'),
              target,
              completion,
              seed,
              completionGuard,
              settling,
            );
            completionSha = provisionBytesSha(completion);
            assertOutputs();
            if (!hasReconciliationCheckpointUnderAdmission(repositoryRoot, chainPath, anchor))
              fail();
            if (!settling) {
              const file = readNativePrivateFile(join(directory, 'lease.json'));
              buffers.push(file.bytes);
              if (file.sha256 !== provisionBytesSha(lease)) fail();
              assertOutputs();
              if (
                removeEntryIfIdentitySteps(join(directory, 'lease.json'), {
                  dev: BigInt(file.identity.dev),
                  ino: BigInt(file.identity.ino),
                  birthtimeNs: BigInt(file.identity.birthtime_ns),
                }) !== 'removed'
              )
                fail();
              syncNativeDirectory(directory);
            }
            const finished = readReconciliationHostApprovalUnderAdmission(
              repositoryRoot,
              input.approval_id,
              anchor,
            );
            if (
              finished.state.lease_sha256 !== null ||
              finished.state.phases.find((p) => p.phase === '04')?.completion_sha256 !==
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
