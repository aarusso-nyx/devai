// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
// Inspector acceptance: the 57 current actions have a one-to-one executable
// facade population, and every facade has a bounded, non-silent refusal probe.
import { createRequire } from 'node:module';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import type { CAC } from '../../node_modules/cac/dist/index.d.ts';
import { describe, expect, it } from 'vitest';
import { actionsList } from '../../src/commands/actions-list.js';
import { auditObserve } from '../../src/commands/audit/observe.js';
import { auditScorecard } from '../../src/commands/audit/scorecard.js';
import { checkCmd } from '../../src/commands/check/facade.js';
import { doctor } from '../../src/commands/doctor.js';
import {
  evidenceCollect,
  evidenceRecord,
  evidenceRedact,
  evidenceRender,
  evidenceVerify,
} from '../../src/commands/evidence/facade.js';
import {
  initApplyArchitect,
  initApplyHarness,
  initApplyOwner,
  initBind,
  initPlan,
} from '../../src/commands/init/index.js';
import {
  releaseCertify,
  releaseCheck,
  releaseDrift,
  releaseEvidencePublish,
  releaseExport,
  releaseOfflineVerify,
  releasePlan,
  releasePreflight,
  releasePrepare,
  releasePublish,
  releaseResume,
  releaseStatus,
  releaseVerify,
} from '../../src/commands/release/facade.js';
import { roundWorkflowCommands } from '../../src/commands/round/workflow.js';
import { roundTrackingCommands } from '../../src/commands/round/tracking.js';
import { senseInventoryCmd } from '../../src/commands/sense/inventory.js';
import { senseMigrateCmd } from '../../src/commands/sense/migrate.js';
import { senseRecordCmd } from '../../src/commands/sense/record.js';
import { senseRunSetCmd } from '../../src/commands/sense/run-set.js';
import { taskCommands } from '../../src/commands/task/index.js';
import { triageClassify } from '../../src/commands/triage/classify.js';
import { ACTION_REGISTRY } from '../../src/generated/action-registry.js';

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};

interface FacadeDefinition {
  readonly name: string;
  register(cli: CAC): void;
}

interface RefusalProbe {
  readonly args: readonly string[];
  readonly exit: 1 | 2;
}

const FACADES: readonly FacadeDefinition[] = [
  auditObserve,
  auditScorecard,
  actionsList,
  checkCmd,
  doctor,
  evidenceCollect,
  evidenceRecord,
  evidenceRedact,
  evidenceRender,
  evidenceVerify,
  initApplyArchitect,
  initApplyHarness,
  initApplyOwner,
  initBind,
  initPlan,
  releaseCertify,
  releaseCheck,
  releaseDrift,
  releaseEvidencePublish,
  releaseExport,
  releaseOfflineVerify,
  releasePlan,
  releasePreflight,
  releasePrepare,
  releasePublish,
  releaseResume,
  releaseStatus,
  releaseVerify,
  ...roundWorkflowCommands,
  ...roundTrackingCommands,
  senseInventoryCmd,
  senseMigrateCmd,
  senseRecordCmd,
  senseRunSetCmd,
  ...taskCommands,
  triageClassify,
] as const;

const usage = (args: readonly string[]): RefusalProbe => ({ args, exit: 2 });
const failed = (args: readonly string[]): RefusalProbe => ({ args, exit: 1 });

const REFUSAL_PROBES: Readonly<Record<string, RefusalProbe>> = {
  'audit observe': usage([]),
  'audit scorecard': usage([]),
  'catalog actions': usage(['--authority', 'invalid-authority']),
  check: usage(['--only', 'not-a-check-service']),
  doctor: usage(['--probe', 'not-a-probe']),
  'evidence collect': usage(['--source', 'not-a-source']),
  'evidence record': usage(['--kind', 'not-a-kind']),
  'evidence redact': usage(['1']),
  'evidence render': usage(['--kind', 'not-a-kind']),
  'evidence verify': usage(['--scope', 'not-a-scope']),
  'init apply architect': usage(['--tier', 'not-a-tier']),
  'init apply harness': usage(['--tier', 'not-a-tier']),
  'init apply owner': usage(['--tier', 'not-a-tier']),
  'init plan': usage(['--tier', 'not-a-tier']),
  'init bind': usage(['--unknown-option']),
  'release certify': failed(['--request', 'missing-release-request.json']),
  'release check': usage(['--environment', 'not-an-environment']),
  'release drift': usage(['--environment', 'not-an-environment']),
  'release evidence-publish': failed(['--request', 'missing-release-request.json']),
  'release export': failed(['--request', 'missing-release-request.json']),
  'release offline-verify': failed(['--exported-state', 'missing-exported-state.json']),
  'release plan': failed([
    '--intent',
    'missing-release-intent.json',
    '--repository',
    'aarusso-nyx/devai',
  ]),
  'release preflight': failed(['--request', 'missing-release-request.json']),
  'release prepare': failed(['--request', 'missing-release-request.json']),
  'release publish': failed(['--request', 'missing-release-request.json']),
  'release resume': failed(['--state-chain', 'missing-release-state-chain.json']),
  'release status': usage(['--kind', 'not-a-kind']),
  'release verify': usage([]),
  'round assess': usage([]),
  'round close': usage([]),
  'round gap create': usage([]),
  'round gap list': usage([]),
  'round gap resolve': usage(['missing-gap']),
  'round gap show': usage(['missing-gap']),
  'round plan': usage([]),
  'round run': usage([]),
  'round seal': usage([]),
  'round status': usage([]),
  'round tracking disable': usage([]),
  'round tracking enable': usage([]),
  'round tracking status': usage([]),
  'round tracking sync': usage([]),
  'sense inventory': usage([]),
  'sense migrate': usage([]),
  'sense record': usage([]),
  'sense run': usage([]),
  'task escalate': usage([]),
  'task finish': usage([]),
  'task pause': usage([]),
  'task queue add': usage([]),
  'task queue complete': usage([]),
  'task queue list': usage([]),
  'task queue next': usage([]),
  'task resume': usage([]),
  'task start': usage([]),
  'task status': usage([]),
  'triage classify': usage([]),
};

describe('canonical facade population acceptance', () => {
  it('binds exactly one executable facade to every current action', () => {
    const facadeNames = FACADES.map((definition) => definition.name).sort();
    const currentBindings = ACTION_REGISTRY.map((entry) => entry.handler).sort();

    expect(FACADES).toHaveLength(57);
    expect(ACTION_REGISTRY).toHaveLength(57);
    expect(new Set(facadeNames).size).toBe(57);
    expect(facadeNames).toEqual(currentBindings);
    expect(Object.keys(REFUSAL_PROBES).sort()).toEqual(currentBindings);

    const cli = cac('devai-canonical-facade-population');
    for (const definition of FACADES) definition.register(cli);
  });

  it('executes a bounded refusal probe for all 57 current facades without external effects', async () => {
    const cli = cac('devai-canonical-facade-refusals');
    for (const definition of FACADES) definition.register(cli);

    let ordinal = 0;
    const issuer = createAuthorityDecisionIssuer({
      issuer_id: 'canonical-facade-refusal-contract',
      issuer_version: '1.0.0',
      invocation_id: 'canonical-facade-refusal-invocation',
      canonicalSha256: () => 'b'.repeat(64),
      randomId: () => `canonical-facade-refusal-${String(++ordinal)}`,
      now: () => '2026-08-08T00:00:00.000Z',
      receipt_ttl_ms: 30_000,
    });
    const scope: AuthorityHostEffectScope = {
      action_id: 'canonical facade refusal contract',
      invocation_id: 'canonical-facade-refusal-invocation',
      effect: 'read',
      receipt_store: issuer,
      apply_effect: (_request, apply) => apply(),
    };

    const originalArgv = process.argv;
    const originalExit = process.exit;
    const originalExitCode = process.exitCode;
    const originalStdout = process.stdout.write;
    const originalStderr = process.stderr.write;
    try {
      for (const definition of FACADES) {
        let stdout = '';
        let stderr = '';
        const probe = REFUSAL_PROBES[definition.name];
        if (probe === undefined) throw new Error(`missing refusal fixture for ${definition.name}`);
        process.argv = ['node', 'devai', definition.name.replaceAll(' ', '-'), ...probe.args];
        process.exitCode = undefined;
        process.stdout.write = ((chunk: unknown) => {
          stdout += String(chunk);
          return true;
        }) as typeof process.stdout.write;
        process.stderr.write = ((chunk: unknown) => {
          stderr += String(chunk);
          return true;
        }) as typeof process.stderr.write;
        process.exit = ((code?: string | number | null) => {
          process.exitCode = typeof code === 'number' ? code : 0;
          throw new Error(`TEST_PROCESS_EXIT:${String(process.exitCode)}`);
        }) as typeof process.exit;

        cli.parse(process.argv, { run: false });
        try {
          await runWithAuthorityHostEffects(scope, () => cli.runMatchedCommand());
        } catch (error) {
          if (error instanceof Error && error.name === 'CACError') {
            process.exitCode = 2;
            stderr = error.message;
          } else if (!(error instanceof Error) || !error.message.startsWith('TEST_PROCESS_EXIT:')) {
            throw error;
          }
        }
        await new Promise<void>((done) => setImmediate(done));
        const exit = typeof process.exitCode === 'number' ? process.exitCode : 0;
        expect(
          exit,
          `${definition.name}: exit=${String(exit)} stdout=${stdout} stderr=${stderr}`,
        ).toBe(probe.exit);
        expect(
          stdout.length + stderr.length,
          `${definition.name}: refusal was silent`,
        ).toBeGreaterThan(0);
      }
    } finally {
      process.argv = originalArgv;
      process.exit = originalExit;
      process.exitCode = originalExitCode;
      process.stdout.write = originalStdout;
      process.stderr.write = originalStderr;
      issuer.dispose();
    }
  }, 120_000);
});
