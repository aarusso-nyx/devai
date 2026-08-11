import { existsSync, mkdirSync, readFileSync, writeFileSync } from '@devai-nyx/authority';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import type { CAC } from 'cac';
import {
  buildBootstrapPlan,
  buildConstitutionBindingPlan,
  executeBootstrapPlan,
  introspectRepo,
  installRecipeAdapters,
  resolveCanonicalConstitution,
  verifyConstitutionBinding,
} from '@devai-nyx/skills';
import { validators } from '@devai-nyx/schemas';
import { isAdoptionProfile, EXIT_FAIL, EXIT_PASS, EXIT_USAGE } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';
import { executeAuthorityPolicyMaterialization } from '../../authority/command-capabilities.js';
import { resolveCliVersion } from '../../version.js';
import { buildCiScaffoldPlan, executeCiScaffoldPlan } from '../../services/ci-scaffold/index.js';
import {
  buildHooksInstallPlan,
  executeHooksInstallPlan,
  HOOK_NAMES,
  type HookName,
} from '../../services/hooks-install/index.js';

const DEFAULT_REPO_ROOT = '.';

function emit(json: unknown, human: boolean, humanText: string): void {
  if (human) process.stdout.write(humanText.endsWith('\n') ? humanText : humanText + '\n');
  else process.stdout.write(JSON.stringify(json) + '\n');
}

interface InitOptions {
  readonly target?: string;
  readonly force?: boolean;
  readonly stampVersion?: string;
  readonly introspect?: boolean;
  readonly tier?: string;
  readonly include?: string;
  readonly hook?: string;
  readonly command?: string;
  readonly output?: string;
  readonly human?: boolean;
}

type InitSegment = 'owner' | 'architect' | 'harness';
type InitInclude = 'ci' | 'hooks' | 'skills';

function validateInitTier(options: InitOptions): void {
  if (options.tier !== undefined && !isAdoptionProfile(options.tier)) {
    process.stderr.write(
      `devai init: --tier must be one of tier1 | tier2 | tier3 (got '${options.tier}')\n`,
    );
    process.exit(EXIT_USAGE);
  }
}

function initPlanFor(options: InitOptions) {
  const targetRoot = options.target ?? DEFAULT_REPO_ROOT;
  return buildBootstrapPlan({
    targetRoot,
    version: options.stampVersion ?? resolveCliVersion(),
    ...(options.tier !== undefined && isAdoptionProfile(options.tier) && { profile: options.tier }),
  });
}

function inspectForInit(options: InitOptions) {
  if (options.introspect !== true) return null;
  const targetRoot = options.target ?? DEFAULT_REPO_ROOT;
  const introspection = introspectRepo({ targetRoot: resolve(targetRoot) });
  if (!validators.repoIntrospection(introspection)) {
    process.stderr.write(
      `devai init --introspect: introspection failed schema validation: ${JSON.stringify(validators.repoIntrospection.errors)}\n`,
    );
    process.exit(EXIT_FAIL);
  }
  return introspection;
}

function segmentedPlan(plan: ReturnType<typeof buildBootstrapPlan>, segment: InitSegment) {
  const entries = plan.entries.filter((entry) => {
    if (segment === 'owner') {
      return entry.path.startsWith('product/') || entry.path.startsWith('law/glossary/');
    }
    if (segment === 'architect') {
      return (
        entry.path.startsWith('docs/') ||
        entry.path.startsWith('work/') ||
        (entry.path.startsWith('law/') && !entry.path.startsWith('law/glossary/'))
      );
    }
    return (
      !entry.path.startsWith('product/') &&
      !entry.path.startsWith('docs/') &&
      !entry.path.startsWith('work/') &&
      !entry.path.startsWith('law/')
    );
  });
  return {
    ...plan,
    entries,
    summary: {
      create: entries.filter((entry) => entry.action === 'create').length,
      overwrite: entries.filter((entry) => entry.action === 'overwrite').length,
      skip: entries.filter((entry) => entry.action === 'skip-exists').length,
    },
  };
}

function canonicalInitPlanFor(options: InitOptions) {
  const plan = initPlanFor(options);
  const segments = (['owner', 'architect', 'harness'] as const).map((segment) => {
    const projection = segmentedPlan(plan, segment);
    return { segment, entries: projection.entries, summary: projection.summary };
  });
  const partition = segments.flatMap(({ entries }) => entries.map(({ path }) => path));
  if (partition.length !== plan.entries.length || new Set(partition).size !== partition.length) {
    throw new Error('INIT_SEGMENT_PARTITION_INVALID');
  }
  return {
    ...plan,
    segments,
  };
}

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

function executeIncludedComponents(
  targetRoot: string,
  includes: readonly InitInclude[],
  force: boolean,
  options: InitOptions,
): readonly Record<string, unknown>[] {
  return includes.map((component) => {
    if (component === 'ci') {
      const plan = buildCiScaffoldPlan({
        targetRoot,
        ...(options.output !== undefined && { outputPath: options.output }),
      });
      const result = executeCiScaffoldPlan(plan, { force });
      return { component, plan, result };
    }
    if (component === 'skills') {
      const result = installRecipeAdapters({ repoRoot: targetRoot });
      return {
        component,
        plan: { hosts: ['codex', 'claude'], recipes: 7 },
        result,
      };
    }
    const plan = buildHooksInstallPlan({
      targetRoot,
      devaiVersion: resolveCliVersion(),
      ...(options.hook !== undefined && { hook: options.hook as HookName }),
      ...(options.command !== undefined && { command: options.command }),
    });
    executeHooksInstallPlan(plan);
    return { component, plan, result: { executed: true } };
  });
}

function addInitOptions(command: ReturnType<CAC['command']>, includeIntrospection: boolean) {
  command
    .option('--target <path>', `Target directory (default: ${DEFAULT_REPO_ROOT})`)
    .option('--stamp-version <v>', 'DEVAI version stamp for reproducible plans')
    .option('--tier <tier>', 'Adoption tier: tier1 | tier2 | tier3')
    .option('--human', 'Human-readable output');
  if (includeIntrospection) command.option('--introspect', 'Include repository introspection');
  return command;
}

export const initPlan = defineCommand({
  name: 'init plan',
  description: 'Build the exact segmented bootstrap plan without authorizing a mutation.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    addInitOptions(
      cli.command('init-plan', 'Generate the non-authorizing bootstrap plan'),
      true,
    ).action((options: InitOptions) => {
      validateInitTier(options);
      const introspection = inspectForInit(options);
      const plan = canonicalInitPlanFor(options);
      emit(
        introspection === null ? plan : { introspection, plan },
        options.human === true,
        `init plan: ${String(plan.summary.create)} would be created, ${String(plan.summary.skip)} already exist\n${plan.entries
          .map((entry) => `  ${entry.action === 'create' ? '+' : '·'} ${entry.path}`)
          .join('\n')}`,
      );
      process.exitCode = EXIT_PASS;
    });
  },
});

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
            'Hook command (default: devai check --only forbidden-actions --strict)',
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
        const introspection = segment === 'harness' ? inspectForInit(options) : null;
        const plan = segmentedPlan(initPlanFor(options), segment);
        const result =
          includes.length === 0
            ? executeBootstrapPlan(plan, { force: options.force === true })
            : { created: [], overwritten: [], skipped: [], preserved: [] };
        if (includes.length === 0 && segment === 'harness' && introspection !== null) {
          const outPath = join(
            resolve(options.target ?? DEFAULT_REPO_ROOT),
            '.devai/state/init-introspection.json',
          );
          mkdirSync(dirname(outPath), { recursive: true });
          writeFileSync(outPath, JSON.stringify(introspection, null, 2) + '\n');
        }
        const included = executeIncludedComponents(
          options.target ?? DEFAULT_REPO_ROOT,
          includes,
          options.force === true,
          options,
        );
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
        emit(
          introspection === null
            ? { plan, result, included }
            : { introspection, plan, result, included },
          options.human === true,
          `init apply ${segment}: ${String(result.created.length)} created, ${String(result.overwritten.length)} overwritten, ${String(result.skipped.length)} skipped, ${String(result.preserved.length)} preserved${included.length > 0 ? `, ${String(included.length)} included component(s)\n${includedHuman.join('\n')}` : ''}`,
        );
        process.exitCode = EXIT_PASS;
      });
    },
  });
}

export const initApplyOwner = initApplyDefinition('owner');
export const initApplyArchitect = initApplyDefinition('architect');
export const initApplyHarness = initApplyDefinition('harness');

export const initBind = defineCommand({
  name: 'init bind',
  description: 'Bind the installed DEVAI package contracts into an adopter repository.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    cli
      .command('init-bind', 'Plan package binding materialization (or apply with --write)')
      .option('--target <path>', `Target directory (default: ${DEFAULT_REPO_ROOT})`)
      .option('--constitution', 'Bind the installed Constitution text and digest pin.')
      .option(
        '--subprocess-effects',
        'Bind subprocess-effects policy into .devai/config with byte identity.',
      )
      .option(
        '--operational-law',
        'Bind current operational policies into .devai/config with byte identity.',
      )
      .option('--write', 'Materialize the selected binding.')
      .option('--human', 'Human-readable output')
      .action(
        (options: {
          target?: string;
          constitution?: boolean;
          subprocessEffects?: boolean;
          operationalLaw?: boolean;
          write?: boolean;
          human?: boolean;
        }) => {
          if (options.operationalLaw === true) {
            const targetRoot = resolve(options.target ?? DEFAULT_REPO_ROOT);
            const files = [
              'domains.json',
              'forbidden-actions.json',
              'glob-guards.json',
              'scorecard-na.json',
              'thresholds.json',
            ] as const;
            const materializations = files.map((file) => {
              const sourcePath = join(targetRoot, 'law/policy', file);
              if (!existsSync(sourcePath)) {
                throw new Error(`canonical operational-law source is missing: ${sourcePath}`);
              }
              const bytes = readFileSync(sourcePath);
              JSON.parse(bytes.toString('utf8'));
              return {
                source: `law/policy/${file}`,
                target: `.devai/config/${file}`,
                digest_sha256: createHash('sha256').update(bytes).digest('hex'),
                byte_identity_required: true as const,
                bytes,
              };
            });
            const plan = materializations.map(({ bytes: _bytes, ...entry }) => entry);
            if (options.write !== true) {
              emit(
                { plan },
                options.human === true,
                `init bind --operational-law (plan only): ${String(plan.length)} exact materializations`,
              );
              process.exitCode = EXIT_PASS;
              return;
            }
            for (const entry of materializations) {
              const targetPath = join(targetRoot, entry.target);
              mkdirSync(dirname(targetPath), { recursive: true });
              writeFileSync(targetPath, entry.bytes);
            }
            emit(
              { materialized: plan },
              options.human === true,
              `init bind --operational-law: ${String(plan.length)} exact materializations`,
            );
            process.exitCode = EXIT_PASS;
            return;
          }
          if (options.subprocessEffects === true) {
            const targetRoot = resolve(options.target ?? DEFAULT_REPO_ROOT);
            const sourcePath = join(targetRoot, 'law/policy/subprocess-effects.json');
            const targetPath = join(targetRoot, '.devai/config/subprocess-effects.json');
            if (!existsSync(sourcePath)) {
              process.stderr.write(
                'devai init bind --subprocess-effects: canonical source is missing\n',
              );
              process.exitCode = EXIT_FAIL;
              return;
            }
            const bytes = readFileSync(sourcePath);
            let document: unknown;
            try {
              document = JSON.parse(bytes.toString('utf8')) as unknown;
            } catch {
              process.stderr.write(
                'devai init bind --subprocess-effects: canonical source is not valid JSON\n',
              );
              process.exitCode = EXIT_FAIL;
              return;
            }
            if (!validators.subprocessEffects(document)) {
              process.stderr.write(
                `devai init bind --subprocess-effects: canonical source fails schema validation: ${JSON.stringify(validators.subprocessEffects.errors)}\n`,
              );
              process.exitCode = EXIT_FAIL;
              return;
            }
            const digestSha256 = createHash('sha256').update(bytes).digest('hex');
            const plan = {
              source: 'law/policy/subprocess-effects.json',
              target: '.devai/config/subprocess-effects.json',
              digest_sha256: digestSha256,
              byte_identity_required: true,
            };
            if (options.write !== true) {
              emit(
                { plan },
                options.human === true,
                `init bind --subprocess-effects (plan only): ${plan.source} → ${plan.target} (${digestSha256})`,
              );
              process.exitCode = EXIT_PASS;
              return;
            }
            mkdirSync(dirname(targetPath), { recursive: true });
            writeFileSync(targetPath, bytes);
            emit(
              { materialized: plan },
              options.human === true,
              `init bind --subprocess-effects: ${plan.target} (${digestSha256})`,
            );
            process.exitCode = EXIT_PASS;
            return;
          }
          if (options.constitution === true) {
            const targetRoot = options.target ?? DEFAULT_REPO_ROOT;
            const canonical = resolveCanonicalConstitution();
            if (canonical === null) {
              process.stderr.write(
                'devai init bind --constitution: no installed Constitution text could be resolved\n',
              );
              process.exit(EXIT_FAIL);
            }
            const before = verifyConstitutionBinding(targetRoot);
            const toVersion = canonical.version ?? 'unknown';
            const fromVersion = before.pin?.version ?? 'none';

            if (options.write !== true) {
              emit(
                {
                  from: fromVersion,
                  to: toVersion,
                  source: canonical.source,
                  sha256: canonical.sha256,
                },
                options.human === true,
                `init bind --constitution (plan only): ${fromVersion} → ${toVersion} (source: ${canonical.source})\n` +
                  '  re-run with --write to refresh .devai/pin/constitution.md + the project.json pin',
              );
              process.exitCode = EXIT_PASS;
              return;
            }

            const vendoredPath = join(targetRoot, '.devai/pin/constitution.md');
            mkdirSync(dirname(vendoredPath), { recursive: true });
            writeFileSync(vendoredPath, canonical.text);
            const pointerPath = join(targetRoot, '.devai/constitution.md');
            if (!existsSync(pointerPath)) {
              const binding = buildConstitutionBindingPlan(targetRoot, resolveCliVersion());
              writeFileSync(pointerPath, binding.pointerFile.content);
            }

            const configPath = join(targetRoot, '.devai/config/project.json');
            const config = existsSync(configPath)
              ? (JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>)
              : {};
            const pin =
              canonical.version !== null
                ? { version: canonical.version, sha256: canonical.sha256 }
                : null;
            if (pin !== null) {
              mkdirSync(dirname(configPath), { recursive: true });
              writeFileSync(
                configPath,
                JSON.stringify({ ...config, constitution: pin }, null, 2) + '\n',
              );
            }

            emit(
              { from: fromVersion, to: toVersion, source: canonical.source },
              options.human === true,
              `init bind --constitution: ${fromVersion} → ${toVersion} (source: ${canonical.source})`,
            );
            process.exitCode = EXIT_PASS;
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
        },
      );
  },
});
