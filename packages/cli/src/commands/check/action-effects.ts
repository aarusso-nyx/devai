import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CAC } from 'cac';
import { ACTION_EFFECT_CONTRACTS, enforceEffectReport } from '@devai-nyx/effects-check';
import { senseActionEffectInference } from '@devai-nyx/sensors';
import { EXIT_FAIL, EXIT_PASS } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';

interface Options {
  readonly repoRoot?: string;
  readonly tsconfig?: string;
  readonly registry?: string;
  readonly human?: boolean;
}

export async function checkActionEffects(options: {
  readonly repoRoot: string;
  readonly tsconfig?: string;
  readonly registry?: string;
}) {
  const repoRoot = resolve(options.repoRoot);
  const registryPath = resolve(repoRoot, options.registry ?? 'law/policy/subprocess-effects.json');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as {
    templates: readonly {
      executable?: unknown;
      argv_shape?: unknown;
      capabilities?: unknown;
    }[];
  };
  const result = await senseActionEffectInference({
    tsconfigPath: resolve(repoRoot, options.tsconfig ?? 'tests/config/tsconfig.effects.json'),
    catalog: ACTION_EFFECT_CONTRACTS.map((entry) => entry.action_id),
    contracts: ACTION_EFFECT_CONTRACTS,
    subprocessRegistry: registry,
  });
  try {
    enforceEffectReport(result.report);
    return { ok: true, ...result };
  } catch (error) {
    return {
      ok: false,
      ...result,
      enforcement_error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const checkActionEffectsCmd = defineCommand({
  name: 'check action-effects',
  description:
    'Run the binding action-effect analyzer and emit its deterministic SensorReading (F5×T4).',
  authority: 'policy_firewall',
  lifecycle: 'supported',
  lifecycle_reason:
    'Binding analyzer; under-declaration, unresolved edges, and unregistered subprocesses fail closed.',
  promotion_criteria: [
    'Effect records require extractor equality, complete dispositions, subprocess classification, and the wall-clock gate.',
    'Static findings and runtime-seam enforcement must agree.',
  ],
  register(cli: CAC): void {
    cli
      .command('check-action-effects', 'Run the shadow action-effect analyzer')
      .option('--repo-root <path>', 'Repository root (default: .)')
      .option(
        '--tsconfig <path>',
        'Analyzer tsconfig (default: tests/config/tsconfig.effects.json)',
      )
      .option(
        '--registry <path>',
        'Subprocess-effects registry (default: law/policy/subprocess-effects.json)',
      )
      .option('--human', 'Human-readable summary')
      .action(async (options: Options) => {
        const result = await checkActionEffects({
          repoRoot: options.repoRoot ?? '.',
          ...(options.tsconfig !== undefined && { tsconfig: options.tsconfig }),
          ...(options.registry !== undefined && { registry: options.registry }),
        });

        if (options.human === true) {
          process.stdout.write(
            `policy check action effects: ${result.reading.status.toUpperCase()} ` +
              `(${String(result.report.metrics.catalog_actions)} actions, ` +
              `${String(result.report.findings.length)} findings, ` +
              `${String(result.report.metrics.duration_ms)}ms)\n`,
          );
          for (const finding of result.report.findings) {
            process.stdout.write(
              `  [${finding.code}] ${finding.action_id ?? '<program>'}: ${finding.message}\n`,
            );
          }
        } else {
          process.stdout.write(JSON.stringify(result) + '\n');
        }
        if (result.ok) {
          process.exitCode = EXIT_PASS;
        } else {
          if (options.human === true) {
            process.stderr.write(
              `policy check action effects: BINDING FAIL — ${'enforcement_error' in result ? result.enforcement_error : 'effect report enforcement failed'}\n`,
            );
          }
          process.exitCode = EXIT_FAIL;
        }
      });
  },
});
