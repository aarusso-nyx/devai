import { appendVerbEvidence, loadChain } from '#runtime-core';
import { runAuditObservation } from '@devai-nyx/skills';
import { EXIT_FAIL, EXIT_PASS, EXIT_USAGE } from '@devai-nyx/utils';
import type { CAC } from 'cac';
import { resolve } from 'node:path';
import { defineCommand } from '../../define-command.js';

interface AuditObserveOptions {
  readonly repoRoot?: string;
  readonly at?: string;
  readonly human?: boolean;
}

export const auditObserve = defineCommand({
  name: 'audit observe',
  description:
    'Regenerate inventory, scorecard, assessment, and backlog for one exact commit as non-promoting Auditor evidence.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    cli
      .command('audit-observe', 'Observe the exact current repository commit')
      .option('--repo-root <path>', 'Repository root (default: cwd)')
      .option('--at <full-sha>', 'Mandatory exact 40-character commit SHA')
      .option('--human', 'Human-readable output')
      .action(async (options: AuditObserveOptions) => {
        if (options.at === undefined || !/^[0-9a-f]{40}$/u.test(options.at)) {
          process.stderr.write('devai audit observe: --at requires a full 40-character SHA\n');
          process.exitCode = EXIT_USAGE;
          return;
        }
        const repoRoot = resolve(options.repoRoot ?? process.cwd());
        try {
          const observation = await runAuditObservation({ repoRoot, at: options.at });
          const observationArtifacts = observation.artifacts.map((artifact) => ({
            ...artifact,
            kind: 'audit',
          }));
          let priorEvidence: string | undefined;
          try {
            const expected = observationArtifacts.map((artifact) => artifact.sha256).sort();
            priorEvidence = loadChain(resolve(repoRoot, 'record/proofs/chain.json')).records.find(
              (record) =>
                record.action === 'audit.observe' &&
                JSON.stringify(record.artifacts.map((artifact) => artifact.sha256).sort()) ===
                  JSON.stringify(expected),
            )?.id;
          } catch {
            priorEvidence = undefined;
          }
          const evidence =
            priorEvidence === undefined
              ? appendVerbEvidence({
                  repoRoot,
                  action: 'audit.observe',
                  status: 'completed',
                  artifacts: observationArtifacts,
                  notes: [`exact_sha=${options.at}`, 'readiness_promoting=false'],
                })
              : { ok: true as const, id: priorEvidence };
          if (!evidence.ok)
            throw new Error(`AUDIT_OBSERVE_EVIDENCE_FAILED:${evidence.error ?? ''}`);
          const result = { ...observation, evidence_ref: evidence.id };
          process.stdout.write(
            options.human === true
              ? `audit observe: ${observation.status} ${options.at} (${evidence.id ?? 'no evidence'})\n`
              : `${JSON.stringify(result)}\n`,
          );
          process.exitCode = EXIT_PASS;
        } catch (error) {
          process.stderr.write(
            `devai audit observe: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          process.exitCode = EXIT_FAIL;
        }
      });
  },
});
