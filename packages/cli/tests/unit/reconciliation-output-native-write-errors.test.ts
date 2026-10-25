import { Writable } from 'node:stream';
import { setImmediate as immediate } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import type { RegistryEntry } from '../../src/define-command.js';
// Output-only fixtures: native authority and filesystem effects are not exercised.
vi.mock('@devai-nyx/authority', () => ({ readReconciliationHostBinding: () => Object.freeze({}) }));
import {
  runReconciliationPhaseOutput,
  requireReconciliationPhaseOutput,
} from '../../src/reconciliation-phase-output.js';
import {
  runReconciliationOwnerOutput,
  requireReconciliationOwnerOutput,
} from '../../src/reconciliation-owner-output.js';
import {
  runReconciliationProvisionOutput,
  requireReconciliationProvisionOutput,
} from '../../src/reconciliation-provision-output.js';
const phase = {
  kind: 'reconciliation-index-result',
  phase: '03',
  outcome: 'completed',
  approval_id: '24b3953e410a7654b1ecdbad8c03a512439a904d9ed90349b116d6685a761caf',
  plan_sha256: '5d55b291ae2e31c578ec2c064bd83c8471cda1afbd197734c946f7fd87f61141',
  intent_sha256: '6d9e291a346b5562c8a10be1fcf361f5a9c478b6d67a88263e9bee9416e840e5',
  completion_sha256: '662c54e2ef6088877e5300d9951691c6299c93615d08e08825638ae22b111bab',
  outputs_manifest_sha256: '8ccbae0f77c1b28edbce79598b5efb07422e0d9c3abeb19363477cc3f3d1ee32',
  owned: [
    {
      target:
        'worktree-host/devai/reconciliation/approvals/24b3953e410a7654b1ecdbad8c03a512439a904d9ed90349b116d6685a761caf/phase-03.json',
      dev: '16777233',
      ino: '1124982548',
      birthtime_ns: '1792904590748238914',
    },
  ],
  grants_authority: false,
};
const owner = {
  preview: {
    kind: 'reconciliation-grant-review',
    operation: 'revoke',
    approval_id: '24b3953e410a7654b1ecdbad8c03a512439a904d9ed90349b116d6685a761caf',
    plan_sha256: '5d55b291ae2e31c578ec2c064bd83c8471cda1afbd197734c946f7fd87f61141',
    prior_grant_sha256: '348fb37362e821841e0b29ebc32059e811758719ce9b5c59c15ba5129f8cbe52',
    record_sha256: 'b03d60968ec6988a4951176596d2eee488c41e4cb3e55b4cbc3e29a5ae0b7e3a',
    record_bytes: 879,
    sequence: 5,
    namespace_sha256: 'adf0aa7c27af677efca409c555aa3a8e5abea930f0055e1bb14639909e0b1e6a',
    effects: [
      {
        target:
          'worktree-host/devai/reconciliation/approvals/24b3953e410a7654b1ecdbad8c03a512439a904d9ed90349b116d6685a761caf/.grant-000005.json.27055-ec09587f-8eed-4ebb-ae79-2aeccd11847f.publish-staged',
        operation: 'publish-private-scratch-and-owned-cleanup',
        mode: '0600',
      },
      {
        target:
          'worktree-host/devai/reconciliation/approvals/24b3953e410a7654b1ecdbad8c03a512439a904d9ed90349b116d6685a761caf/grant-000005.json',
        operation: 'publish-grant-no-replace',
        mode: '0600',
      },
    ],
    confirmation:
      'REVOKE RECONCILIATION 24b3953e410a7654b1ecdbad8c03a512439a904d9ed90349b116d6685a761caf b03d60968ec6988a4951176596d2eee488c41e4cb3e55b4cbc3e29a5ae0b7e3a',
    lifetime_ms: 300000,
    grants_authority: false,
  },
  result: {
    kind: 'reconciliation-grant-result',
    operation: 'revoke',
    outcome: 'cancelled',
    approval_id: '24b3953e410a7654b1ecdbad8c03a512439a904d9ed90349b116d6685a761caf',
    plan_sha256: '5d55b291ae2e31c578ec2c064bd83c8471cda1afbd197734c946f7fd87f61141',
    record_sha256: 'b03d60968ec6988a4951176596d2eee488c41e4cb3e55b4cbc3e29a5ae0b7e3a',
    sequence: 5,
    owned: [],
    grants_authority: false,
  },
};
const provision = {
  kind: 'reconciliation-provision-result',
  action_id: 'init bind',
  outcome: 'existing',
  stage: null,
  repository_id: 'output-test',
  worktree_id: 'output-test',
  issuer_sha256: 'a'.repeat(64),
  owned: [],
  grants_authority: false,
};
type Kind = 'phase' | 'owner' | 'provision';
type Mode = 'native-order' | 'callback-only' | 'success' | 'sync-throw' | 'both-channels';
const cases: [Kind, Mode][] = (['phase', 'owner', 'provision'] as const).flatMap((kind) =>
  (['native-order', 'success', 'sync-throw', 'both-channels'] as const).map(
    (mode) => [kind, mode] as [Kind, Mode],
  ),
);
cases.push(['phase', 'callback-only'], ['owner', 'callback-only']);
it.each(cases)(
  '%s output handles %s without unhandled events or listener leaks',
  async (kind, mode) => {
    const savedArgv = process.argv,
      savedExit = process.exitCode;
    const streams = [process.stdin, process.stdout, process.stderr];
    const descriptors = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, 'isTTY'));
    for (const stream of streams)
      Object.defineProperty(stream, 'isTTY', { configurable: true, value: true });
    const stdoutListeners = process.stdout.listenerCount('error'),
      stderrListeners = process.stderr.listenerCount('error');
    let writes = 0,
      diagnostic = '',
      terminalAttempt = false;
    const events: string[] = [],
      wires: Writable[] = [];
    function failedWrite(
      stream: NodeJS.WriteStream,
      callback: ((error?: Error | null) => void) | undefined,
    ) {
      const cause = Object.assign(new Error('closed output'), { code: 'EPIPE' });
      if (mode === 'sync-throw') throw cause;
      if (mode === 'callback-only') {
        callback?.(cause);
        return false;
      }
      // Use Node's actual Writable sequencing, forwarding its native error event to
      // the transport stream. No extra error listener on that stream masks a bug.
      const wire = new Writable({
        write(_chunk, _encoding, done) {
          done(cause);
        },
      });
      wires.push(wire);
      wire.on('error', (error) => {
        events.push('error');
        stream.emit('error', error);
      });
      return wire.write('terminal', 'utf8', (error) => {
        events.push('callback');
        callback?.(error);
      });
    }
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: unknown,
      _encoding: unknown,
      callback?: (error?: Error | null) => void,
    ) => {
      writes++;
      const terminal = kind !== 'owner' || writes > 1;
      if (terminal && mode !== 'success') {
        terminalAttempt = true;
        return failedWrite(process.stdout, callback);
      }
      callback?.();
      return true;
    }) as typeof process.stdout.write);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(((
      chunk: unknown,
      _encoding: unknown,
      callback?: (error?: Error | null) => void,
    ) => {
      if (terminalAttempt && mode === 'both-channels') return failedWrite(process.stderr, callback);
      diagnostic += String(chunk);
      callback?.();
      return true;
    }) as typeof process.stderr.write);
    try {
      process.argv = ['node', 'devai', 'output-only-test'];
      const entry = {
        name:
          kind === 'phase'
            ? 'evidence reconcile stage-proof'
            : kind === 'owner'
              ? 'evidence reconcile approve'
              : 'init bind',
      } as RegistryEntry;
      const success = (_entry: RegistryEntry, text: string) => text + '\n',
        failure = (_entry: RegistryEntry, text: string) => text + '\n';
      if (kind === 'phase')
        await runReconciliationPhaseOutput(
          entry,
          () => requireReconciliationPhaseOutput().finishReconciliationPhase(phase),
          success,
          failure,
        );
      else if (kind === 'owner')
        await runReconciliationOwnerOutput(
          entry,
          async () => {
            const output = requireReconciliationOwnerOutput();
            await output.ready(owner.preview as never);
            diagnostic = '';
            output.finishOwnerReconciliation(owner.result as never);
          },
          success,
          failure,
        );
      else
        await runReconciliationProvisionOutput(
          entry,
          () => requireReconciliationProvisionOutput().complete(provision as never),
          success,
          failure,
        );
      // Callback-only cleanup intentionally waits one check phase; native Writable
      // emits error on nextTick, before the deferred fallback cleanup.
      await immediate();
      expect(process.stdout.listenerCount('error')).toBe(stdoutListeners);
      expect(process.stderr.listenerCount('error')).toBe(stderrListeners);
      expect(process.exitCode).toBe(mode === 'success' ? 0 : 6);
      if (mode === 'native-order') expect(events).toEqual(['callback', 'error']);
      if (mode === 'both-channels')
        expect(events).toEqual(['callback', 'error', 'callback', 'error']);
      if (mode !== 'success' && mode !== 'both-channels') {
        const error = JSON.parse(diagnostic.trim());
        const custody =
          kind === 'provision' ? error.context.provisioning : error.context.reconciliation;
        expect(custody.outcome).toBe('indeterminate');
        if (kind === 'phase') expect(custody.completion_sha256).toBe(phase.completion_sha256);
        if (kind === 'owner') expect(custody.record_sha256).toBe(owner.result.record_sha256);
      }
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      for (const wire of wires) wire.destroy();
      streams.forEach((stream, index) => {
        const descriptor = descriptors[index];
        if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
        else Reflect.deleteProperty(stream, 'isTTY');
      });
      process.argv = savedArgv;
      process.exitCode = savedExit;
    }
  },
);
