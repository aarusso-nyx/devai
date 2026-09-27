import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  runAuthorityHostEffectsWithRollback,
  writeFileSync,
} from '@devai-nyx/authority';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { getValidator } from '@devai-nyx/schemas';
import { EXIT_FAIL, EXIT_PASS, EXIT_USAGE } from '@devai-nyx/utils';
import { executeAuthorityPolicyMaterialization } from '../../authority/command-capabilities.js';
import { resolveCliVersion } from '../../version.js';
import {
  loadTrackingPolicyDefaults,
  normalizeTrackingRepository,
  TRACKING_CONFIG_RELATIVE,
  TRACKING_WORKFLOW_RELATIVE,
  trackingDefaultsDigest,
} from '../../services/github-issues-tracking/config.js';
import {
  renderTrackingWorkflow,
  trackingWorkflowDigest,
} from '../../services/github-issues-tracking/workflow.js';
import {
  buildHooksInstallPlan,
  executeHooksInstallPlan,
  preflightHooksInstallPlan,
  verifyInstalledPostMergeAdapter,
} from '../../services/hooks-install/index.js';
import {
  buildGithubActionsAdapterPlan,
  executeGithubActionsAdapterPlan,
  verifyGithubActionsAdapter,
} from '../../services/github-actions-adapter/index.js';
import {
  jsonBytes,
  resolveAdopterPolicyMaterialization,
  type JsonObject,
} from '../../services/adopter-policy.js';
import { DEFAULT_REPO_ROOT, emit, type InitBindOptions } from './shared.js';

function sha256Bytes(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function materializeAdopterPolicy(targetRoot: string, sourceArgument: string) {
  const lawPolicyRoot = realpathSync(resolve(targetRoot, 'law/policy'));
  const sourcePath = realpathSync(resolve(targetRoot, sourceArgument));
  const sourceRelative = relative(lawPolicyRoot, sourcePath);
  if (
    sourceRelative.length === 0 ||
    sourceRelative === '..' ||
    sourceRelative.startsWith(`..${sep}`)
  ) {
    throw new Error('ADOPTER_POLICY_SOURCE_OUTSIDE_LAW_POLICY');
  }
  const sourceBytes = readFileSync(sourcePath, 'utf8');
  const policy: unknown = JSON.parse(sourceBytes);
  const document = policy as JsonObject;
  const projectPath = join(targetRoot, '.devai/config/project.json');
  const currentProject = existsSync(projectPath)
    ? (JSON.parse(readFileSync(projectPath, 'utf8')) as JsonObject)
    : {};
  const resolved = resolveAdopterPolicyMaterialization({
    policy,
    currentProject,
    frameworkVersion: resolveCliVersion(),
  });
  const outputs = new Map<string, string>(
    [...resolved].map(([path, bytes]) => [join(targetRoot, path), bytes]),
  );
  const receiptPath = join(targetRoot, '.devai/config/adopter-policy-binding.json');
  const receipt = {
    schemaVersion: '1.0.0',
    policy_id: document['policy_id'],
    policy_version: document['policy_version'],
    source_path: relative(targetRoot, sourcePath).split(sep).join('/'),
    source_digest_sha256: sha256Bytes(sourceBytes),
    materialized: Object.fromEntries(
      [...outputs].map(([path, bytes]) => [
        relative(targetRoot, path).split(sep).join('/'),
        sha256Bytes(bytes),
      ]),
    ),
  };
  outputs.set(receiptPath, jsonBytes(receipt));
  runAuthorityHostEffectsWithRollback([...outputs.keys()], () => {
    for (const [path, bytes] of outputs) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    }
  });
  return { receipt_path: relative(targetRoot, receiptPath).split(sep).join('/'), receipt };
}

/** Validate and bind an Architect-owned adopter policy source (--adopter-policy). */
export function bindAdopterPolicy(
  options: InitBindOptions & { readonly adopterPolicy: string },
): void {
  const targetRoot = realpathSync(resolve(options.target ?? DEFAULT_REPO_ROOT));
  if (options.write !== true) {
    emit(
      { plan: { source: options.adopterPolicy, target: '.devai/config' } },
      options.human === true,
      `init bind --adopter-policy (plan only): ${options.adopterPolicy} → .devai/config`,
    );
    process.exitCode = EXIT_PASS;
    return;
  }
  try {
    const result = materializeAdopterPolicy(targetRoot, options.adopterPolicy);
    const artifact = executeAuthorityPolicyMaterialization();
    emit(
      { ...result, authority_policy: artifact },
      options.human === true,
      `init bind --adopter-policy: ${result.receipt_path}`,
    );
    process.exitCode = EXIT_PASS;
  } catch (error) {
    process.stderr.write(
      `devai init bind --adopter-policy: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = EXIT_FAIL;
  }
}

/** Bind the opt-in governance tracking capability (--tracking-adapter). */
export function bindTrackingAdapter(
  options: InitBindOptions & { readonly trackingAdapter: string },
): void {
  // Repository capability binding only. It activates no round, authorizes
  // no publication, and stores no credential; per-round activation is a
  // separate Owner action.
  if (options.trackingAdapter !== 'github-issues') {
    process.stderr.write('devai init bind --tracking-adapter: expected github-issues\n');
    process.exitCode = EXIT_USAGE;
    return;
  }
  if (options.trackingRepository === undefined) {
    process.stderr.write(
      'devai init bind --tracking-adapter: --tracking-repository <owner/name> is required\n',
    );
    process.exitCode = EXIT_USAGE;
    return;
  }
  try {
    // --target keeps its established meaning (the working tree); the
    // remote identity has its own flag so neither can be mistaken for
    // the other by the authority layer or by a reader.
    const targetRoot = realpathSync(resolve(options.target ?? DEFAULT_REPO_ROOT));
    const repository = normalizeTrackingRepository(options.trackingRepository);
    const defaults = loadTrackingPolicyDefaults();
    const workflowContent = renderTrackingWorkflow(defaults);
    const configPath = join(targetRoot, TRACKING_CONFIG_RELATIVE);
    const workflowPath = join(targetRoot, TRACKING_WORKFLOW_RELATIVE);
    const projectPath = join(targetRoot, '.devai/config/project.json');
    const config = {
      schemaVersion: '1.0.0',
      id: 'github-issues-tracking',
      binding: {
        repository,
        repository_id: repository.split('/')[1] ?? repository,
        package_version: resolveCliVersion(),
        bound_at: new Date().toISOString(),
        bound_by_role: 'architect',
      },
      defaults,
      digests: {
        policy_defaults_sha256: trackingDefaultsDigest(defaults),
        workflow_sha256: trackingWorkflowDigest(workflowContent),
      },
    };
    const validateConfig = getValidator('github-issues-tracking-config.schema.json');
    if (!validateConfig(config)) {
      throw new Error(`TRACKING_CONFIG_INVALID:${JSON.stringify(validateConfig.errors)}`);
    }
    if (options.write !== true) {
      emit(
        {
          plan: {
            repository,
            config: TRACKING_CONFIG_RELATIVE,
            workflow: TRACKING_WORKFLOW_RELATIVE,
            workflow_sha256: config.digests.workflow_sha256,
          },
        },
        options.human === true,
        `init bind --tracking-adapter github-issues (plan only): ${repository}`,
      );
      process.exitCode = EXIT_PASS;
      return;
    }
    const project = JSON.parse(readFileSync(projectPath, 'utf8')) as JsonObject;
    const nextProject = {
      ...project,
      governance_tracking: {
        adapter: 'github-issues',
        config: TRACKING_CONFIG_RELATIVE,
        workflow: TRACKING_WORKFLOW_RELATIVE,
      },
    };
    const validateProject = getValidator('project-config.schema.json');
    if (!validateProject(nextProject)) {
      throw new Error(`TRACKING_PROJECT_INVALID:${JSON.stringify(validateProject.errors)}`);
    }
    const result = runAuthorityHostEffectsWithRollback(
      [configPath, workflowPath, projectPath],
      () => {
        mkdirSync(dirname(configPath), { recursive: true });
        mkdirSync(dirname(workflowPath), { recursive: true });
        writeFileSync(configPath, jsonBytes(config));
        writeFileSync(workflowPath, workflowContent);
        writeFileSync(projectPath, jsonBytes(nextProject));
        return { repository, workflow_sha256: config.digests.workflow_sha256 };
      },
    );
    emit(
      {
        plan: { config: TRACKING_CONFIG_RELATIVE, workflow: TRACKING_WORKFLOW_RELATIVE },
        ...result,
      },
      options.human === true,
      `init bind --tracking-adapter github-issues: ${repository}`,
    );
    process.exitCode = EXIT_PASS;
  } catch (error) {
    process.stderr.write(
      `devai init bind --tracking-adapter github-issues: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = EXIT_FAIL;
  }
}

/** Bind a verified post-merge or GitHub Actions host adapter (--host-adapter). */
export function bindHostAdapter(options: InitBindOptions & { readonly hostAdapter: string }): void {
  if (!['post-merge', 'github-actions'].includes(options.hostAdapter)) {
    process.stderr.write('devai init bind --host-adapter: expected post-merge or github-actions\n');
    process.exitCode = EXIT_USAGE;
    return;
  }
  const targetRoot = realpathSync(resolve(options.target ?? DEFAULT_REPO_ROOT));
  if (options.hostAdapter === 'github-actions') {
    try {
      const plan = buildGithubActionsAdapterPlan(targetRoot, resolveCliVersion());
      if (options.write !== true) {
        emit(
          {
            plan: {
              workflow: relative(targetRoot, plan.workflowPath).split(sep).join('/'),
              config: relative(targetRoot, plan.configPath).split(sep).join('/'),
            },
          },
          options.human === true,
          'init bind --host-adapter github-actions (plan only)',
        );
        process.exitCode = EXIT_PASS;
        return;
      }
      const projectPath = join(targetRoot, '.devai/config/project.json');
      const authorityPolicyPath = join(targetRoot, '.devai/config/authority-policy.json');
      const project = JSON.parse(readFileSync(projectPath, 'utf8')) as JsonObject;
      const nextProject = {
        ...project,
        authority_enforcement: {
          mode: 'host-integrated',
          adapter_config: '.devai/config/github-actions-host-adapter.json',
        },
      };
      const validateProject = getValidator('project-config.schema.json');
      if (!validateProject(nextProject)) {
        throw new Error(`HOST_ADAPTER_PROJECT_INVALID:${JSON.stringify(validateProject.errors)}`);
      }
      const result = runAuthorityHostEffectsWithRollback(
        [plan.workflowPath, plan.configPath, projectPath, authorityPolicyPath],
        () => {
          writeFileSync(projectPath, jsonBytes(nextProject));
          executeGithubActionsAdapterPlan(plan);
          const verification = verifyGithubActionsAdapter(targetRoot, resolveCliVersion());
          if (!verification.ok) {
            throw new Error(`GITHUB_ACTIONS_ADAPTER_INVALID:${verification.errors.join(',')}`);
          }
          const authorityPolicy = executeAuthorityPolicyMaterialization();
          return { authorityPolicy, verification };
        },
      );
      emit(
        { plan: { workflow: plan.workflowPath, config: plan.configPath }, ...result },
        options.human === true,
        `init bind --host-adapter github-actions: ${plan.workflowPath}`,
      );
      process.exitCode = EXIT_PASS;
    } catch (error) {
      process.stderr.write(
        `devai init bind --host-adapter github-actions: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = EXIT_FAIL;
    }
    return;
  }
  const plan = buildHooksInstallPlan({
    targetRoot,
    hook: 'post-merge',
    devaiVersion: resolveCliVersion(),
  });
  if (options.write !== true) {
    emit(
      { plan },
      options.human === true,
      `init bind --host-adapter post-merge (plan only): ${plan.action} ${plan.path}`,
    );
    process.exitCode = EXIT_PASS;
    return;
  }
  try {
    const adapterTargets = preflightHooksInstallPlan(plan);
    const projectPath = join(targetRoot, '.devai/config/project.json');
    const authorityPolicyPath = join(targetRoot, '.devai/config/authority-policy.json');
    const project = JSON.parse(readFileSync(projectPath, 'utf8')) as JsonObject;
    const nextProject = {
      ...project,
      authority_enforcement: {
        mode: 'host-integrated',
        adapter_config: '.devai/config/post-merge-host-adapter.json',
      },
    };
    const validateProject = getValidator('project-config.schema.json');
    if (!validateProject(nextProject)) {
      throw new Error(`HOST_ADAPTER_PROJECT_INVALID:${JSON.stringify(validateProject.errors)}`);
    }
    const result = runAuthorityHostEffectsWithRollback(
      [...adapterTargets, projectPath, authorityPolicyPath],
      () => {
        writeFileSync(projectPath, jsonBytes(nextProject));
        const authorityPolicy = executeAuthorityPolicyMaterialization();
        executeHooksInstallPlan(plan);
        const verification = verifyInstalledPostMergeAdapter(targetRoot, resolveCliVersion());
        if (!verification.ok) {
          throw new Error(`POST_MERGE_ADAPTER_INVALID:${verification.errors.join(',')}`);
        }
        return { authorityPolicy, verification };
      },
    );
    emit(
      { plan, ...result },
      options.human === true,
      `init bind --host-adapter post-merge: ${plan.path}`,
    );
    process.exitCode = EXIT_PASS;
  } catch (error) {
    process.stderr.write(
      `devai init bind --host-adapter: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = EXIT_FAIL;
  }
}
