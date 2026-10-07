import { appendVerbEvidence, loadChain } from '#runtime-core';
import { execFileSync } from '@devai-nyx/authority';
import { runAuditObservation } from '@devai-nyx/skills';
import { trackGovernanceEvent } from '@devai-nyx/loop';
import { EXIT_FAIL, EXIT_PASS, EXIT_USAGE } from '@devai-nyx/utils';
import type { CAC } from 'cac';
import { resolve } from 'node:path';
import { declaredInvocationAuthority } from '../../authority/index.js';
import { defineCommand } from '../../define-command.js';
import {
  gateSelfDogfoodCommand,
  resolveSelfDogfoodDeclaration,
  selfDogfoodRefusal,
} from '../../services/self-dogfood.js';

/**
 * Exact tree of a commit. A commit SHA is not a tree SHA, so an unresolvable
 * tree yields no binding at all rather than a plausible-looking false one.
 */
function treeOf(repoRoot: string, commit: string): string | undefined {
  try {
    const tree = execFileSync('git', ['rev-parse', '--verify', `${commit}^{tree}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return /^[0-9a-f]{40}$/u.test(tree) ? tree : undefined;
  } catch {
    return undefined;
  }
}

interface AuditObserveOptions {
  readonly repoRoot?: string;
  readonly at?: string;
  readonly round?: string;
  readonly previous?: string;
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
      .option(
        '--round <round_id>',
        'Optional governed round to attribute this observation to for tracking',
      )
      .option(
        '--previous <sha-or-scorecard-id>',
        'Previous observation to link: a full commit SHA or a recorded SC- id (default: the nearest observed ancestor in the chain)',
      )
      .option('--human', 'Human-readable output')
      .action(async (options: AuditObserveOptions) => {
        if (options.at === undefined || !/^[0-9a-f]{40}$/u.test(options.at)) {
          process.stderr.write('devai audit observe: --at requires a full 40-character SHA\n');
          process.exitCode = EXIT_USAGE;
          return;
        }
        const repoRoot = resolve(options.repoRoot ?? process.cwd());
        // ADR-SCR-0001: on the framework repository an observation is a
        // harness-write the matrix admits for the inspector with write consent
        // only. Refused before any artifact or evidence is written.
        const selfDogfood = gateSelfDogfoodCommand({
          repoRoot,
          action_id: 'audit observe',
          declaration: resolveSelfDogfoodDeclaration(declaredInvocationAuthority()),
        });
        if (selfDogfood.applies && !selfDogfood.decision.ok) {
          process.stderr.write(selfDogfoodRefusal(selfDogfood));
          process.exitCode = EXIT_USAGE;
          return;
        }
        try {
          const observation = await runAuditObservation({
            repoRoot,
            at: options.at,
            ...(options.previous === undefined ? {} : { previous: options.previous }),
          });
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
          // An Auditor report may recommend, never ratify (Article 7), so this
          // is recorded as an observation and never as a verdict. A round is
          // never inferred; without --round nothing is attributed.
          if (options.round !== undefined) {
            const tree = treeOf(repoRoot, options.at);
            trackGovernanceEvent({
              repoRoot,
              round: options.round,
              role: 'auditor',
              kind: 'finding_emitted',
              status: 'not_applicable',
              summary: `Auditor observed commit ${options.at} with status ${observation.status}; non-promoting.`,
              payload: observation,
              evidenceRefs: evidence.id === undefined ? [] : [evidence.id],
              commitBinding:
                tree === undefined
                  ? null
                  : {
                      base_commit: options.at,
                      base_tree: tree,
                      candidate_commit: null,
                      candidate_tree: null,
                    },
            });
          }
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
