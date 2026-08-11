import type { CAC } from 'cac';
import { detectRelabeledSensors, loadReadingsFromDir, type RelabelGroup } from '#runtime-core';
import { EXIT_PASS, EXIT_REVIEW } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';

/**
 * Sensor-integrity validation behind the canonical `check` facade: flag readings that
 * share a `command_hash` across distinct `sensor.kind` values — one
 * command's exit code relabeled as several independent measurements.
 * The audit that motivated this check found a scorecard where 12 of
 * 45 cells resolved to one shared npm-script exit code under 12
 * different sensor names, overstating the scorecard's evidentiary
 * value (Article 32 expects polymorphic, independently-measured
 * sensor composition, not relabeling).
 *
 * Judgment, not a hard gate: a shared command CAN legitimately back
 * more than one cell (e.g. one aggregate command whose exit code
 * really does certify two properties) — the check surfaces the
 * pattern for review rather than assuming bad faith. Exit REVIEW
 * when findings exist, PASS otherwise; never FAILs on its own.
 */
const DEFAULT_REPO_ROOT = '.';
const DEFAULT_READINGS_DIR = '.devai/state/sensor-readings';

export interface SensorIntegrityReport {
  readonly verdict: 'pass' | 'review';
  readonly readings_scanned: number;
  readonly groups: readonly RelabelGroup[];
}

export interface CheckSensorIntegrityOptions {
  readonly repoRoot: string;
  readonly readingsDir?: string;
}

export function checkSensorIntegrity(options: CheckSensorIntegrityOptions): SensorIntegrityReport {
  const dir = options.readingsDir ?? `${options.repoRoot}/${DEFAULT_READINGS_DIR}`;
  const readings = loadReadingsFromDir(dir);
  const groups = detectRelabeledSensors(readings);
  return {
    verdict: groups.length > 0 ? 'review' : 'pass',
    readings_scanned: readings.length,
    groups,
  };
}

export const checkSensorIntegrityCmd = defineCommand({
  name: 'check sensor-integrity',
  description:
    'Flag SensorReadings that share a command_hash across distinct sensor.kind values (relabeled, not independently measured). Advisory: exits REVIEW on findings, never FAIL.',
  authority: 'policy_firewall',
  register(cli: CAC): void {
    cli
      .command(
        'check-sensor-integrity',
        'Flag relabeled SensorReadings (shared command_hash, distinct kinds)',
      )
      .option('--repo-root <path>', `Repo root (default: ${DEFAULT_REPO_ROOT})`)
      .option(
        '--readings-dir <path>',
        `SensorReadings directory (default: <repo-root>/${DEFAULT_READINGS_DIR})`,
      )
      .option('--human', 'Human-readable output')
      .action((options: { repoRoot?: string; readingsDir?: string; human?: boolean }) => {
        const report = checkSensorIntegrity({
          repoRoot: options.repoRoot ?? DEFAULT_REPO_ROOT,
          ...(options.readingsDir !== undefined && { readingsDir: options.readingsDir }),
        });

        if (options.human === true) {
          const lines: string[] = [
            `check sensor-integrity: ${report.verdict === 'pass' ? 'PASS' : 'REVIEW'} (${String(report.readings_scanned)} reading(s) scanned, ${String(report.groups.length)} relabeled group(s))`,
          ];
          for (const g of report.groups) {
            lines.push(
              `  [!] command_hash ${g.command_hash.slice(0, 12)}… shared by kinds: ${g.kinds.join(', ')}`,
            );
            lines.push(`      readings: ${g.reading_ids.join(', ')}`);
          }
          process.stdout.write(lines.join('\n') + '\n');
        } else {
          process.stdout.write(JSON.stringify(report) + '\n');
        }

        process.exitCode = report.verdict === 'review' ? EXIT_REVIEW : EXIT_PASS;
      });
  },
});
