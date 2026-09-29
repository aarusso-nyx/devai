import {
  mkdirSync,
  runAuthorityHostEffectsWithRollback,
  writeFileSync,
} from '@devai-nyx/authority';
import { dirname, join, resolve } from 'node:path';
import type { CAC } from 'cac';
import {
  buildRecipeAdapterPlan,
  executeRecipeAdapterPlan,
  executeBootstrapPlan,
  preflightBootstrapPlan,
  preflightRecipeAdapterInstall,
} from '@devai-nyx/skills';
import { EXIT_PASS, EXIT_USAGE } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';
import { resolveCliVersion } from '../../version.js';
import { buildCiScaffoldPlan, executeCiScaffoldPlan } from '../../services/ci-scaffold/index.js';
import {
  buildHooksInstallPlan,
  executeHooksInstallPlan,
  HOOK_NAMES,
  preflightHooksInstallPlan,
  type HookName,
} from '../../services/hooks-install/index.js';
import {
  DEFAULT_REPO_ROOT,
  addInitOptions,
  emit,
  validateInitTarget,
  validateInitTier,
  type InitInclude,
  type InitOptions,
  type InitSegment,
} from './shared.js';
import { initPlanFor, inspectForInit, segmentedPlan } from './plan.js';

function requestedIncludes(options: InitOptions, segment: InitSegment): readonly InitInclude[] {
  if (options.include === undefined) return [];
  const includes = options.include
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const allowed =
    segment === 'architect' ? ['hooks'] : segment === 'harness' ? ['ci', 'skills'] : [];
  const invalid = includes.find((value) => !allowed.includes(value));
  if (
    includes.length === 0 ||
    invalid !== undefined ||
    new Set(includes).size !== includes.length
  ) {
    const expected = allowed.length === 0 ? 'no components' : allowed.join(' | ');
    process.stderr.write(
      `devai init apply ${segment}: --include accepts ${expected} (got '${options.include}')\n`,
    );
    process.exit(EXIT_USAGE);
  }
  return includes as readonly InitInclude[];
}

interface PreparedIncludedComponent {
  readonly component: InitInclude;
  readonly plan: Record<string, unknown>;
  readonly targets: readonly string[];
  readonly execute: () => Record<string, unknown>;
}

function prepareIncludedComponents(
  targetRoot: string,
  includes: readonly InitInclude[],
  force: boolean,
  options: InitOptions,
): readonly PreparedIncludedComponent[] {
  return includes.map((component) => {
    if (component === 'ci') {
      const plan = buildCiScaffoldPlan({
        targetRoot,
        ...(options.output !== undefined && { outputPath: options.output }),
      });
      return {
        component,
        plan: plan as unknown as Record<string, unknown>,
        targets: [plan.path],
        execute: () => ({ ...executeCiScaffoldPlan(plan, { force }) }),
      };
    }
    if (component === 'skills') {
      const adapterPlan = buildRecipeAdapterPlan();
      const resolved = preflightRecipeAdapterInstall(targetRoot, adapterPlan);
      return {
        component,
        plan: { hosts: ['codex', 'claude'], recipes: 7 },
        targets: resolved.map((file) => file.absolutePath),
        execute: () => ({ ...executeRecipeAdapterPlan(resolved) }),
      };
    }
    const plan = buildHooksInstallPlan({
      targetRoot,
      devaiVersion: resolveCliVersion(),
      ...(options.hook !== undefined && { hook: options.hook as HookName }),
      ...(options.command !== undefined && { command: options.command }),
    });
    const targets = preflightHooksInstallPlan(plan);
    return {
      component,
      plan: plan as unknown as Record<string, unknown>,
      targets,
      execute: () => {
        executeHooksInstallPlan(plan);
        return { executed: true };
      },
    };
  });
}

function executeIncludedComponents(
  prepared: readonly PreparedIncludedComponent[],
): readonly Record<string, unknown>[] {
  return prepared.map(({ component, plan, execute }) => ({ component, plan, result: execute() }));
}

function initApplyDefinition(segment: InitSegment) {
  return defineCommand({
    name: `init apply ${segment}`,
    description:
      segment === 'owner'
        ? 'Apply the Owner-owned initialization projection with explicit write consent.'
        : segment === 'architect'
          ? 'Apply the Architect-owned initialization projection with explicit write consent.'
          : 'Apply the canonical harness projection with explicit Architect-initiated write consent.',
    authority: 'mesh_controller' as const,
    register(cli: CAC): void {
      const command = addInitOptions(
        cli.command(`init-apply-${segment}`, `Apply the exact ${segment} bootstrap segment`),
        segment === 'harness',
      ).option('--force', 'Overwrite existing non-provenance files in this segment');
      if (segment === 'architect') {
        command
          .option('--include <component>', 'Also install the hooks component: hooks')
          .option('--hook <name>', `${HOOK_NAMES.join(' | ')} (default: pre-push)`)
          .option(
            '--command <cmd>',
            'Hook command (default: ./node_modules/.bin/devai check --only forbidden-actions --strict)',
          );
      } else if (segment === 'harness') {
        command
          .option('--include <component>', 'Also install components: ci | skills')
          .option(
            '--output <path>',
            'CI output path (default: <target>/.github/workflows/devai-ledger-verify.yml)',
          );
      }
      command.action((options: InitOptions) => {
        validateInitTier(options);
        const includes = requestedIncludes(options, segment);
        if (options.hook !== undefined && !HOOK_NAMES.includes(options.hook as HookName)) {
          process.stderr.write(
            `devai init apply architect: --hook must be one of ${HOOK_NAMES.join(' | ')} (got '${options.hook}')\n`,
          );
          process.exit(EXIT_USAGE);
        }
        const requestedTarget = options.target ?? DEFAULT_REPO_ROOT;
        const target = {
          requested: requestedTarget,
          resolved: resolve(requestedTarget),
        };
        const introspectionTarget =
          segment === 'harness' && options.introspect === true
            ? validateInitTarget(options)
            : target;
        if (introspectionTarget === undefined) return;
        const introspection =
          segment === 'harness' ? inspectForInit(options, introspectionTarget) : null;
        const plan = segmentedPlan(initPlanFor(options, target), segment);
        const targetRoot = resolve(requestedTarget);
        const coreTargets = preflightBootstrapPlan(plan);
        const preparedIncludes = prepareIncludedComponents(
          targetRoot,
          includes,
          options.force === true,
          options,
        );
        const introspectionPath = join(targetRoot, '.devai/state/init-introspection.json');
        const transaction = runAuthorityHostEffectsWithRollback(
          [
            ...coreTargets,
            ...(segment === 'harness' && introspection !== null ? [introspectionPath] : []),
            ...preparedIncludes.flatMap((component) => component.targets),
          ],
          () => {
            const result = executeBootstrapPlan(plan, { force: options.force === true });
            if (segment === 'harness' && introspection !== null) {
              mkdirSync(dirname(introspectionPath), { recursive: true });
              writeFileSync(introspectionPath, JSON.stringify(introspection, null, 2) + '\n');
            }
            return { result, included: executeIncludedComponents(preparedIncludes) };
          },
        );
        const { result, included } = transaction;
        const includedHuman = included.map((entry) => {
          const component = entry['component'];
          const componentPlan = entry['plan'] as Record<string, unknown>;
          if (component === 'hooks') {
            return `hooks install: ${String(componentPlan['action'])} ${String(componentPlan['path'])} (${String(componentPlan['manager'])}, ${String(componentPlan['hook'])} → \`${String(componentPlan['command'])}\`)`;
          }
          const componentResult = entry['result'] as Record<string, unknown>;
          if (component === 'skills') {
            return `skills install: ${String((componentResult['written'] as readonly string[]).length)} written, ${String((componentResult['unchanged'] as readonly string[]).length)} unchanged`;
          }
          return `ci scaffold: ${componentResult['written'] === true ? 'wrote' : 'skipped'} ${String(componentPlan['path'])}`;
        });
        // ADR-GOV-0020: name every file --force kept (edited guidance, populated
        // provenance) so the adopter sees what the re-application did not touch.
        const preservedHuman = result.preserved.map((path) => `\n  = ${path} (preserved)`).join('');
        emit(
          introspection === null
            ? { plan, result, included }
            : { introspection, plan, result, included },
          options.human === true,
          `init apply ${segment}: ${String(result.created.length)} created, ${String(result.overwritten.length)} overwritten, ${String(result.skipped.length)} skipped, ${String(result.preserved.length)} preserved${included.length > 0 ? `, ${String(included.length)} included component(s)\n${includedHuman.join('\n')}` : ''}${preservedHuman}`,
        );
        process.exitCode = EXIT_PASS;
      });
    },
  });
}

export const initApplyOwner = initApplyDefinition('owner');
export const initApplyArchitect = initApplyDefinition('architect');
export const initApplyHarness = initApplyDefinition('harness');
