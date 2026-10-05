import type { CAC } from 'cac';
import { EXIT_PASS, EXIT_USAGE } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';
import { executeAuthorityPolicyMaterialization } from '../../authority/command-capabilities.js';
import { DEFAULT_REPO_ROOT, emit, validateInitTier, type InitBindOptions } from './shared.js';
import {
  bindConstitution,
  bindFullPackage,
  bindOperationalLaw,
  bindSubprocessEffects,
} from './bind-package.js';
import { bindAdopterPolicy, bindHostAdapter, bindTrackingAdapter } from './bind-adapters.js';
export { initApplyArchitect, initApplyHarness, initApplyOwner } from './apply.js';

export { initPlan } from './plan.js';
export { initUpgrade } from './upgrade.js';

export const initBind = defineCommand({
  name: 'init bind',
  description: 'Bind the installed DEVAI package contracts into an adopter repository.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    cli
      .command('init-bind', 'Plan package binding materialization (or apply with --write)')
      .option('--target <path>', `Target directory (default: ${DEFAULT_REPO_ROOT})`)
      .option('--tier <tier>', 'Adoption tier persisted in project.json: tier1 | tier2 | tier3')
      .option(
        '--full',
        'Run constitution, operational-law, subprocess-effects, and authority-policy binding in order.',
      )
      .option('--constitution', 'Bind the installed Constitution text and digest pin.')
      .option(
        '--subprocess-effects',
        'Bind subprocess-effects policy into .devai/config with byte identity.',
      )
      .option(
        '--operational-law',
        'Bind current operational policies into .devai/config with byte identity.',
      )
      .option(
        '--adopter-policy <path>',
        'Validate and bind an Architect-owned policy source under law/policy.',
      )
      .option(
        '--host-adapter <adapter>',
        'Bind a verified host adapter: post-merge | github-actions',
      )
      .option(
        '--tracking-adapter <adapter>',
        'Bind the opt-in governance tracking capability: github-issues',
      )
      .option(
        '--tracking-repository <owner/name>',
        'Exact remote repository the tracking binding authorizes',
      )
      .option('--write', 'Materialize the selected binding.')
      .option('--human', 'Human-readable output')
      .action((options: InitBindOptions) => {
        validateInitTier(options);
        const modes = [
          options.full === true,
          options.operationalLaw === true,
          options.subprocessEffects === true,
          options.constitution === true,
          options.adopterPolicy !== undefined,
          options.hostAdapter !== undefined,
          options.trackingAdapter !== undefined,
        ].filter(Boolean).length;
        if (modes > 1) {
          process.stderr.write('devai init bind: binding selectors are mutually exclusive\n');
          process.exitCode = EXIT_USAGE;
          return;
        }
        if (options.full === true) {
          bindFullPackage(options);
          return;
        }
        if (options.adopterPolicy !== undefined) {
          bindAdopterPolicy({ ...options, adopterPolicy: options.adopterPolicy });
          return;
        }
        if (options.trackingAdapter !== undefined) {
          bindTrackingAdapter({ ...options, trackingAdapter: options.trackingAdapter });
          return;
        }
        if (options.hostAdapter !== undefined) {
          bindHostAdapter({ ...options, hostAdapter: options.hostAdapter });
          return;
        }
        if (options.operationalLaw === true) {
          bindOperationalLaw(options);
          return;
        }
        if (options.subprocessEffects === true) {
          bindSubprocessEffects(options);
          return;
        }
        if (options.constitution === true) {
          bindConstitution(options);
          return;
        }
        if (options.write === true) {
          const artifact = executeAuthorityPolicyMaterialization() as {
            path: string;
            operation: string;
            digest_sha256: string;
          };
          emit(
            { artifact },
            options.human === true,
            `authority policy ${artifact.operation}: ${artifact.path} (${artifact.digest_sha256})`,
          );
          process.exitCode = EXIT_PASS;
          return;
        }
        emit(
          { plan: 'authority-policy' },
          options.human === true,
          'init bind (plan only): materialize the installed authority policy; re-run with --write',
        );
        process.exitCode = EXIT_PASS;
      });
  },
});
