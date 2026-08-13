import { appendVerbEvidence, loadChain } from '#runtime-core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from '@devai-nyx/authority';
import { classifyFailure } from '@devai-nyx/loop';
import { getValidator, validators } from '@devai-nyx/schemas';
import type { SensorReading } from '@devai-nyx/sensors';
import { EXIT_FAIL, EXIT_PASS, EXIT_USAGE } from '@devai-nyx/utils';
import type { CAC } from 'cac';
import { createHash } from 'node:crypto';
import { dirname, relative, resolve, sep } from 'node:path';
import { defineCommand } from '../../define-command.js';

interface TriageOptions {
  readonly input?: string;
  readonly repoRoot?: string;
  readonly task?: string;
  readonly human?: boolean;
}

export const triageClassify = defineCommand({
  name: 'triage classify',
  description:
    'Deterministically classify one SensorReading and record the verdict; inconclusive always escalates to a human.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    cli
      .command('triage-classify', 'Classify one schema-valid SensorReading')
      .option('--input <path>', 'SensorReading JSON path relative to the repository')
      .option('--repo-root <path>', 'Repository root (default: cwd)')
      .option('--task <task-id>', 'Optional TASK-N identity')
      .option('--human', 'Human-readable output')
      .action((options: TriageOptions) => {
        if (options.input === undefined) {
          process.stderr.write('devai triage classify: --input is required\n');
          process.exitCode = EXIT_USAGE;
          return;
        }
        if (options.task !== undefined && !/^TASK-[0-9]+$/u.test(options.task)) {
          process.stderr.write('devai triage classify: --task must match TASK-N\n');
          process.exitCode = EXIT_USAGE;
          return;
        }
        const repoRoot = resolve(options.repoRoot ?? process.cwd());
        const inputPath = resolve(repoRoot, options.input);
        const inputRelative = relative(repoRoot, inputPath);
        if (inputRelative === '..' || inputRelative.startsWith(`..${sep}`)) {
          process.stderr.write('devai triage classify: input path escapes repository\n');
          process.exitCode = EXIT_USAGE;
          return;
        }
        try {
          const reading = JSON.parse(readFileSync(inputPath, 'utf8')) as SensorReading;
          if (!validators.sensorReading(reading)) {
            throw new Error(
              `SENSOR_READING_INVALID:${JSON.stringify(validators.sensorReading.errors)}`,
            );
          }
          const classified = classifyFailure(reading, reading.timestamp);
          const verdict = {
            ...classified,
            ...(options.task === undefined ? {} : { subject_task_id: options.task }),
          };
          const validateTriage = getValidator('triage.schema.json');
          if (!validateTriage(verdict)) {
            throw new Error(`TRIAGE_VERDICT_INVALID:${JSON.stringify(validateTriage.errors)}`);
          }
          const outputPath = resolve(repoRoot, '.devai/state/triage', `${verdict.id}.json`);
          const bytes = `${JSON.stringify(verdict, null, 2)}\n`;
          if (existsSync(outputPath) && readFileSync(outputPath, 'utf8') !== bytes) {
            throw new Error('TRIAGE_REPLAY_DRIFT');
          }
          mkdirSync(dirname(outputPath), { recursive: true });
          writeFileSync(outputPath, bytes);
          const artifact = {
            path: relative(repoRoot, outputPath).split(sep).join('/'),
            sha256: createHash('sha256').update(bytes).digest('hex'),
            kind: 'triage',
          };
          let priorEvidence: string | undefined;
          try {
            priorEvidence = loadChain(resolve(repoRoot, 'record/proofs/chain.json')).records.find(
              (record) =>
                record.action === 'triage.classify' &&
                record.artifacts.some((item) => item.sha256 === artifact.sha256),
            )?.id;
          } catch {
            priorEvidence = undefined;
          }
          const evidence =
            priorEvidence === undefined
              ? appendVerbEvidence({
                  repoRoot,
                  action: 'triage.classify',
                  status: 'completed',
                  artifacts: [artifact],
                  notes: [
                    `classification=${verdict.classification}`,
                    `route=${verdict.recommended_route.action ?? 'none'}`,
                  ],
                })
              : { ok: true as const, id: priorEvidence };
          if (!evidence.ok) throw new Error(`TRIAGE_EVIDENCE_FAILED:${evidence.error ?? ''}`);
          const result = { verdict, artifact, evidence_ref: evidence.id };
          process.stdout.write(
            options.human === true
              ? `triage classify: ${verdict.classification} → ${verdict.recommended_route.action ?? verdict.recommended_route.discipline}\n`
              : `${JSON.stringify(result)}\n`,
          );
          process.exitCode = EXIT_PASS;
        } catch (error) {
          process.stderr.write(
            `devai triage classify: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          process.exitCode = EXIT_FAIL;
        }
      });
  },
});
