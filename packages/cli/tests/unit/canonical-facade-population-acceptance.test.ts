// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
// Inspector acceptance: the 41 current actions have a one-to-one executable
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
  releaseCheck,
  releaseDrift,
  releaseStatus,
  releaseVerify,
} from '../../src/commands/release/facade.js';
import { roundWorkflowCommands } from '../../src/commands/round/workflow.js';
import { senseInventoryCmd } from '../../src/commands/sense/inventory.js';
import { senseMigrateCmd } from '../../src/commands/sense/migrate.js';
import { senseRecordCmd } from '../../src/commands/sense/record.js';
import { senseRunSetCmd } from '../../src/commands/sense/run-set.js';
import { taskCommands } from '../../src/commands/task/index.js';
import { ACTION_REGISTRY } from '../../src/generated/action-registry.js';

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};

interface FacadeDefinition {
  readonly name: string;
  register(cli: CAC): void;
}

const FACADES: readonly FacadeDefinition[] = [
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
  releaseCheck,
  releaseDrift,
  releaseStatus,
  releaseVerify,
  ...roundWorkflowCommands,
  senseInventoryCmd,
  senseMigrateCmd,
  senseRecordCmd,
  senseRunSetCmd,
  ...taskCommands,
] as const;

const REFUSAL_ARGS: Readonly<Record<string, readonly string[]>> = {
  'catalog actions': ['--authority', 'invalid-authority'],
  check: ['--only', 'not-a-check-service'],
  doctor: ['--probe', 'not-a-probe'],
  'evidence collect': ['--source', 'not-a-source'],
  'evidence record': ['--kind', 'not-a-kind'],
  'evidence redact': ['1'],
  'evidence render': ['--kind', 'not-a-kind'],
  'evidence verify': ['--scope', 'not-a-scope'],
  'init apply architect': ['--tier', 'not-a-tier'],
  'init apply harness': ['--tier', 'not-a-tier'],
  'init apply owner': ['--tier', 'not-a-tier'],
  'init plan': ['--tier', 'not-a-tier'],
  'init bind': ['--unknown-option'],
  'release check': ['--environment', 'not-an-environment'],
  'release drift': ['--environment', 'not-an-environment'],
  'release status': ['--kind', 'not-a-kind'],
  'release verify': [],
  'round assess': [],
  'round close': [],
  'round gap create': [],
  'round gap list': [],
  'round gap resolve': ['missing-gap'],
  'round gap show': ['missing-gap'],
  'round plan': [],
  'round run': [],
  'round seal': [],
  'round status': [],
  'sense inventory': [],
  'sense migrate': [],
  'sense record': [],
  'sense run': [],
  'task escalate': [],
  'task finish': [],
  'task pause': [],
  'task queue add': [],
  'task queue complete': [],
  'task queue list': [],
  'task queue next': [],
  'task resume': [],
  'task start': [],
  'task status': [],
};

describe('canonical facade population acceptance', () => {
  it('binds exactly one executable facade to every current action', () => {
    const facadeNames = FACADES.map((definition) => definition.name).sort();
    const currentBindings = ACTION_REGISTRY.map((entry) => entry.handler).sort();

    expect(FACADES).toHaveLength(41);
    expect(ACTION_REGISTRY).toHaveLength(41);
    expect(new Set(facadeNames).size).toBe(41);
    expect(facadeNames).toEqual(currentBindings);
    expect(Object.keys(REFUSAL_ARGS).sort()).toEqual(currentBindings);

    const cli = cac('devai-canonical-facade-population');
    for (const definition of FACADES) definition.register(cli);
  });

  it('executes a bounded refusal probe for all 41 current facades without external effects', async () => {
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
        const args = REFUSAL_ARGS[definition.name];
        if (args === undefined) throw new Error(`missing refusal fixture for ${definition.name}`);
        process.argv = ['node', 'devai', definition.name.replaceAll(' ', '-'), ...args];
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
        ).toBe(2);
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
