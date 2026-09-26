/**
 * Interactive configuration for `init plan --interactive` (ADR-CFG-0001).
 *
 * The flow authors an adoption plan through schema-driven prompts and never
 * writes on its own: every write is an existing `init bind` or `init apply`
 * invocation, run in process through the registered command definitions with
 * exactly the argv the flow prints. Declining write consent ends the session
 * with the plan diff and the argv it would have run, and no write.
 *
 * Bind mode materializes from the installed package. Edit mode touches only
 * adopter-owned keys and refuses materialized policy files and bind records with
 * a structured error that offers a re-bind.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { cac, type CAC } from 'cac';
import { buildBootstrapPlan } from '@devai-nyx/skills';
import { loadSchema } from '@devai-nyx/schemas';
import { isAdoptionProfile } from '@devai-nyx/utils';
import { cliError } from '../cli-error.js';
import { resolveCliVersion } from '../version.js';
import {
  initApplyArchitect,
  initApplyHarness,
  initApplyOwner,
  initBind,
} from '../commands/init/index.js';
import {
  promptForProperty,
  promptYesNo,
  propertySchema,
  type PromptIo,
  type PromptSchema,
} from './schema-prompts.js';

export type InteractiveMode = 'bind' | 'edit';

export interface RunInteractiveInitPlanInput {
  readonly repoRoot: string;
  readonly target: string;
  /** Adoption tier from `--tier`; it is the default answer of the profile prompt. */
  readonly tier?: string;
  readonly mode: InteractiveMode;
  readonly io: PromptIo;
  readonly stampVersion?: string;
}

export interface InteractiveInitPlanResult {
  /** Exact CLI tokens after `devai` for each invocation, in execution order. */
  readonly argv: readonly (readonly string[])[];
  readonly plan: unknown;
  readonly executed: boolean;
}

type InitCommandName =
  'init-bind' | 'init-apply-owner' | 'init-apply-architect' | 'init-apply-harness';

const COMMANDS: Readonly<Record<InitCommandName, { register(cli: CAC): void }>> = {
  'init-bind': initBind,
  'init-apply-owner': initApplyOwner,
  'init-apply-architect': initApplyArchitect,
  'init-apply-harness': initApplyHarness,
};

/** Include components each apply segment accepts, as `init apply --include` defines them. */
const INCLUDE_SEGMENT: Readonly<Record<string, 'architect' | 'harness'>> = {
  hooks: 'architect',
  ci: 'harness',
  skills: 'harness',
};

/** Materialized files pinned byte-identical to `law/policy`, with the re-bind that refreshes each. */
const MATERIALIZED_FILES: Readonly<Record<string, string | null>> = {
  'domains.json': '--operational-law',
  'forbidden-actions.json': '--operational-law',
  'glob-guards.json': '--operational-law',
  'scorecard-na.json': '--operational-law',
  'thresholds.json': '--operational-law',
  'subprocess-effects.json': '--subprocess-effects',
  'release-verification.json': null,
  'change-taxonomy.json': null,
};

/** Bind records written only by `init bind`. */
const BIND_RECORDS: Readonly<Record<string, string>> = {
  'adopter-policy-binding.json': '--adopter-policy <path>',
  'github-issues-tracking.json': '--tracking-adapter github-issues',
  'authority-policy.json': '--full',
};

/** project.json keys that are machine-managed or bind-mode concerns. */
const BIND_ONLY_KEYS: Readonly<Record<string, string>> = {
  schemaVersion: 'a schema constant',
  devai_version: 'stamped by initialization',
  'constitution.version': 'refreshed by init bind --constitution',
  'constitution.sha256': 'refreshed by init bind --constitution',
  governance_tracking: 'bound by init bind --tracking-adapter',
};

/** Adopter-owned keys of `.devai/config/project.json` (docs/adopters/interactive-configuration.md). */
const ADOPTER_KEYS = [
  'project_type',
  'name',
  'profile',
  'adopted_at',
  'invariant_filters.include_tags',
  'invariant_filters.exclude_tags',
  'feature_flags',
  'authority_enforcement.mode',
  'authority_enforcement.adapter_config',
  'repo.kind',
  'docs.builder',
  'docs.build_command',
  'docs.output_dir',
  'docs.publish_target',
  'docs.gh_pages_branch',
  'docs.custom_domain',
  'docs.ia.collapsed_sections',
  'docs.ia.path_overrides',
  'ci_economy.profile',
  'ci_economy.local_evidence',
  'ci_economy.attested_rc',
] as const;

/** Adopter-owned binding files seeded at bind time and owned by the adopter thereafter. */
const ADOPTER_FILES = [
  'change-taxonomy-binding.json',
  'toolchain.json',
  'preflight-probes.json',
  'credential-requirements-binding.json',
] as const;

/** Keys whose change an existing init invocation carries, with the argv that carries it. */
const CARRIED_KEYS: Readonly<Record<string, (target: string, value: string) => string[]>> = {
  profile: (target, value) => ['init-apply-harness', '--target', target, '--tier', value],
};

function projectSchema(): PromptSchema {
  return loadSchema('project-config.schema.json') as PromptSchema;
}

function refusal(file: string): Error {
  const path = `.devai/config/${file}`;
  const materialized = file in MATERIALIZED_FILES;
  const selector = materialized ? MATERIALIZED_FILES[file] : BIND_RECORDS[file];
  const rebind =
    selector === null || selector === undefined ? 'init bind' : `init bind ${selector}`;
  const reason = materialized
    ? 'is materialized byte-identical from law/policy'
    : 'is a bind record written only by init bind';
  const envelope = cliError({
    code: 'INIT_INTERACTIVE_EDIT_REFUSED',
    class: 'precondition',
    exit: 5,
    message: `Edit mode refuses ${file}: ${path} ${reason}. Re-bind it with ${rebind} instead.`,
    remediation: `Run init plan --interactive --mode bind, or ${rebind} --target <path> --write, to re-bind ${file} from the installed package.`,
    context: { file, path, rebind },
  });
  return new Error(JSON.stringify(envelope));
}

function planDiff(plan: ReturnType<typeof buildBootstrapPlan>): string {
  return `init plan: ${String(plan.summary.create)} would be created, ${String(plan.summary.skip)} already exist\n${plan.entries
    .map(
      (entry) =>
        `  ${entry.action === 'create' ? '+' : entry.action === 'overwrite' ? '~' : '·'} ${entry.path}`,
    )
    .join('\n')}`;
}

interface CapturedRun {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run one registered init command in process with exactly `tokens`, capturing its streams. */
async function runInitCommand(tokens: readonly string[]): Promise<CapturedRun> {
  const definition = COMMANDS[tokens[0] as InitCommandName];
  const cli = cac('devai');
  definition.register(cli);
  const originalExitCode = process.exitCode;
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let stdout = '';
  let stderr = '';
  try {
    process.exitCode = undefined;
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    cli.parse(['node', 'devai', ...tokens], { run: false });
    await cli.runMatchedCommand();
    const code = process.exitCode;
    return { exit: typeof code === 'number' ? code : Number(code ?? 0), stdout, stderr };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    process.exitCode = originalExitCode;
  }
}

/**
 * Show the argv, ask for the role declaration and write consent, then run each
 * invocation through its registered init action and print the argv it executed.
 */
async function consentAndRun(
  io: PromptIo,
  argv: readonly (readonly string[])[],
  role: string,
  plan: unknown,
): Promise<InteractiveInitPlanResult> {
  io.print(`Write consent covers these invocations as ${role}:`);
  const consent = await promptYesNo(
    io,
    'write consent',
    'Run the invocations above now. Declining ends the session with no write.',
  );
  if (!consent) {
    io.print('Write consent declined; no write was performed. Replay with:');
    for (const tokens of argv) io.print(tokens.join(' '));
    return { argv, plan, executed: false };
  }
  for (const tokens of argv) {
    const run = await runInitCommand(tokens);
    if (run.exit !== 0) {
      const envelope = cliError({
        code: 'INIT_INTERACTIVE_INVOCATION_FAILED',
        class: 'precondition',
        exit: 5,
        message: `${tokens.join(' ')} exited ${String(run.exit)}: ${run.stderr.trim()}`,
        remediation:
          'Inspect the failed invocation, resolve its precondition, and replay the printed argv.',
        context: { argv: tokens, exit: run.exit },
      });
      throw new Error(JSON.stringify(envelope));
    }
  }
  io.print(`Executed as ${role} (declare --as-role ${role} --write when replaying through devai):`);
  for (const tokens of argv) io.print(tokens.join(' '));
  return { argv, plan, executed: true };
}

async function promptRole(io: PromptIo, roles: readonly string[]): Promise<string> {
  return (await promptForProperty(io, {
    key: 'role',
    schema: {
      enum: roles,
      description: 'Role declaration for the writes: the role that owns the projected paths.',
    },
  })) as string;
}

async function runBindMode(input: RunInteractiveInitPlanInput): Promise<InteractiveInitPlanResult> {
  const { io, target } = input;
  const schema = projectSchema();
  const ask = (key: string, defaultValue?: unknown) =>
    promptForProperty(io, {
      key,
      schema: propertySchema(schema, key),
      ...(defaultValue !== undefined && { defaultValue }),
    });
  const profile = (await ask(
    'profile',
    input.tier !== undefined && isAdoptionProfile(input.tier) ? input.tier : undefined,
  )) as 'tier1' | 'tier2' | 'tier3';
  const projectType = (await ask('project_type')) as string;
  const repoKind = (await ask('repo.kind')) as string;
  const docsBuilder = (await ask('docs.builder')) as string;
  const includes = (await promptForProperty(io, {
    key: 'includes',
    schema: {
      type: 'array',
      uniqueItems: true,
      items: { enum: Object.keys(INCLUDE_SEGMENT) },
      description:
        'Optional components installed with an apply segment: hooks (architect), ci and skills (harness).',
    },
  })) as string[];
  const tracking = await promptYesNo(
    io,
    'governance_tracking',
    'Opt in to the github-issues governance tracking binding (off by default).',
  );
  const trackingRepository = tracking
    ? ((await promptForProperty(io, {
        key: 'tracking repository',
        schema: {
          type: 'string',
          pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$',
          description: 'Exact remote repository the tracking binding authorizes, as owner/name.',
        },
      })) as string)
    : undefined;

  const plan = buildBootstrapPlan({
    targetRoot: target,
    version: input.stampVersion ?? resolveCliVersion(),
    profile,
  });
  io.print(planDiff(plan));
  io.print(
    `project.json plan input: project_type=${projectType} repo.kind=${repoKind} docs.builder=${docsBuilder}; no init bind or init apply flag carries these, so they are reported and not written.`,
  );

  const role = await promptRole(io, ['architect', 'owner']);
  const include = (segment: 'architect' | 'harness') => {
    const selected = includes.filter((component) => INCLUDE_SEGMENT[component] === segment);
    return selected.length === 0 ? [] : ['--include', selected.join(',')];
  };
  const argv: string[][] =
    role === 'owner'
      ? [['init-apply-owner', '--target', target, '--tier', profile]]
      : [
          ['init-bind', '--target', target, '--tier', profile, '--constitution', '--write'],
          ['init-bind', '--target', target, '--operational-law', '--write'],
          ['init-bind', '--target', target, '--subprocess-effects', '--write'],
          ['init-apply-architect', '--target', target, '--tier', profile, ...include('architect')],
          ['init-apply-harness', '--target', target, '--tier', profile, ...include('harness')],
          ...(trackingRepository === undefined
            ? []
            : [
                [
                  'init-bind',
                  '--target',
                  target,
                  '--tracking-adapter',
                  'github-issues',
                  '--tracking-repository',
                  trackingRepository,
                  '--write',
                ],
              ]),
        ];
  if (role === 'owner' && (includes.length > 0 || tracking)) {
    io.print(
      'includes and tracking are Architect bindings; the owner session applies the owner segment only.',
    );
  }
  for (const tokens of argv) io.print(tokens.join(' '));
  if (role !== 'owner') {
    io.print(
      `authority-policy: bind it afterwards with devai init bind --target ${target} --as-role architect --write; it needs the authority policy materialization only the devai entry point provides, so this session does not run it.`,
    );
  }
  return consentAndRun(io, argv, role, {
    plan,
    inputs: {
      profile,
      project_type: projectType,
      repo_kind: repoKind,
      docs_builder: docsBuilder,
      includes,
      tracking_repository: trackingRepository ?? null,
    },
  });
}

async function runEditMode(input: RunInteractiveInitPlanInput): Promise<InteractiveInitPlanResult> {
  const { io, target } = input;
  const refused = [...Object.keys(MATERIALIZED_FILES), ...Object.keys(BIND_RECORDS)];
  io.print(
    `Adopter-owned keys in .devai/config/project.json: ${ADOPTER_KEYS.join(', ')}\nAdopter-owned files in .devai/config: ${ADOPTER_FILES.join(', ')}\nRefused (re-bind only): ${[...refused, ...Object.keys(BIND_ONLY_KEYS)].join(', ')}`,
  );
  const selection = (await promptForProperty(io, {
    key: 'edit',
    schema: {
      enum: [...ADOPTER_KEYS, ...ADOPTER_FILES, ...refused, ...Object.keys(BIND_ONLY_KEYS)],
      description: 'The adopter-owned key or file to change.',
    },
  })) as string;
  if (refused.includes(selection)) throw refusal(selection);
  if (selection in BIND_ONLY_KEYS) {
    const envelope = cliError({
      code: 'INIT_INTERACTIVE_EDIT_REFUSED',
      class: 'precondition',
      exit: 5,
      message: `Edit mode refuses ${selection} in project.json: it is ${BIND_ONLY_KEYS[selection] ?? 'bind-owned'}. Use init bind instead.`,
      remediation: 'Run init plan --interactive --mode bind to re-bind this key.',
      context: { file: 'project.json', key: selection },
    });
    throw new Error(JSON.stringify(envelope));
  }
  const carry = CARRIED_KEYS[selection];
  if ((ADOPTER_FILES as readonly string[]).includes(selection) || carry === undefined) {
    io.print(
      `${selection} is adopter-owned, but no init bind or init apply invocation carries it; edit it by hand against its schema. No write was performed.`,
    );
    return { argv: [], plan: null, executed: false };
  }
  const schema = projectSchema();
  const value = (await promptForProperty(io, {
    key: selection,
    schema: propertySchema(schema, selection),
  })) as string;
  const plan = buildBootstrapPlan({
    targetRoot: target,
    version: input.stampVersion ?? resolveCliVersion(),
    ...(isAdoptionProfile(value) && { profile: value }),
  });
  io.print(planDiff(plan));
  const role = await promptRole(io, ['architect']);
  const argv = [carry(target, value)];
  for (const tokens of argv) io.print(tokens.join(' '));
  return consentAndRun(io, argv, role, { plan, inputs: { [selection]: value } });
}

/** Run one interactive `init plan` session in the given mode. */
export async function runInteractiveInitPlan(
  input: RunInteractiveInitPlanInput,
): Promise<InteractiveInitPlanResult> {
  if (!existsSync(resolve(input.target))) {
    const envelope = cliError({
      code: 'INIT_TARGET_PRECONDITION_UNSATISFIED',
      class: 'precondition',
      exit: 5,
      message: `Init target must exist and be a directory: ${resolve(input.target)}`,
      remediation: 'Choose an existing directory inside a Git work tree and retry.',
      context: { target_root: resolve(input.target) },
    });
    throw new Error(JSON.stringify(envelope));
  }
  return input.mode === 'edit' ? runEditMode(input) : runBindMode(input);
}
