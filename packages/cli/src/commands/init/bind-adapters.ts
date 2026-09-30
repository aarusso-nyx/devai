import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  runAuthorityHostEffectsWithRollback,
  writeFileSync,
} from '@devai-nyx/authority';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { getValidator } from '@devai-nyx/schemas';
import { EXIT_FAIL, EXIT_PASS, EXIT_USAGE } from '@devai-nyx/utils';
import { executeAuthorityPolicyMaterialization } from '../../authority/command-capabilities.js';
import type { AdopterAuthorityExtension } from '../../authority/policy-adopter-extension.js';
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
  ADOPTER_POLICY_TARGETS,
  compileAdopterPolicyAuthority,
  isJsonObject,
  jsonBytes,
  resolveAdopterPolicyProjection,
  type JsonObject,
} from '../../services/adopter-policy.js';
import { DEFAULT_REPO_ROOT, emit, type InitBindOptions } from './shared.js';
import { classWriteVerbs } from '../../authority/policy-support.js';
import { canonicalRegistry } from '../../define-command.js';

function sha256Bytes(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

const ADOPTER_POLICY_RECEIPT = '.devai/config/adopter-policy-binding.json';
const ADOPTER_POLICY_JOURNAL = '.devai/config/adopter-policy-binding.journal.json';
const ADOPTER_POLICY_STAGED_SUFFIX = '.devai-bind-staged';
const ADOPTER_POLICY_PAIR: readonly string[] = [...ADOPTER_POLICY_TARGETS, ADOPTER_POLICY_RECEIPT];

interface AdopterPolicyJournalEntry {
  readonly path: string;
  readonly previous: string | null;
}

function readTextIfPresent(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** Land bytes on a final path by staging them beside it and renaming into place. */
function landByRename(path: string, bytes: string): void {
  const staged = `${path}${ADOPTER_POLICY_STAGED_SUFFIX}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(staged, bytes);
  renameSync(staged, path);
}

/**
 * Finish a bind a previous process left interrupted. A journal next to the receipt
 * marks a committed write set; its presence means some renames may have landed, so
 * every journaled path is rolled back to its previous bytes and the new bind below
 * recomputes the projection from that complete previous pair. Staged files without a
 * journal never reached a final path and are discarded.
 */
function recoverInterruptedAdopterPolicyBind(targetRoot: string): 'rolled-back' | null {
  const journalPath = join(targetRoot, ADOPTER_POLICY_JOURNAL);
  const stagedPaths = ADOPTER_POLICY_PAIR.map(
    (path) => `${join(targetRoot, path)}${ADOPTER_POLICY_STAGED_SUFFIX}`,
  );
  const journalBytes = readTextIfPresent(journalPath);
  let recovered: 'rolled-back' | null = null;
  if (journalBytes !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(journalBytes);
    } catch {
      // A torn journal was never committed: no rename follows an incomplete journal.
      parsed = undefined;
    }
    if (parsed !== undefined) {
      const entries = isJsonObject(parsed) ? parsed['entries'] : undefined;
      if (
        !Array.isArray(entries) ||
        !entries.every(
          (entry): entry is AdopterPolicyJournalEntry =>
            isJsonObject(entry) &&
            typeof entry['path'] === 'string' &&
            ADOPTER_POLICY_PAIR.includes(entry['path']) &&
            (entry['previous'] === null || typeof entry['previous'] === 'string'),
        )
      ) {
        throw new Error('ADOPTER_POLICY_BINDING_JOURNAL_INVALID');
      }
      for (const entry of entries) {
        const finalPath = join(targetRoot, entry.path);
        const current = readTextIfPresent(finalPath);
        if (current === entry.previous) continue;
        if (entry.previous === null) rmSync(finalPath, { force: true });
        else landByRename(finalPath, entry.previous);
      }
      recovered = 'rolled-back';
    }
  }
  for (const staged of stagedPaths) {
    if (existsSync(staged)) rmSync(staged, { force: true });
  }
  if (journalBytes !== null) rmSync(journalPath, { force: true });
  return recovered;
}

/**
 * Stage every file of the write set, commit the set with a journal of the previous
 * bytes, rename each staged file into place, and drop the journal. A process killed
 * at any point leaves either the previous complete pair or a journal the next bind
 * rolls back (ADR-CFG-0002, IA-003).
 */
function writeAdopterPolicyPairAtomically(
  targetRoot: string,
  writes: ReadonlyMap<string, string>,
): void {
  const journalPath = join(targetRoot, ADOPTER_POLICY_JOURNAL);
  const entries = [...writes.keys()].map((path) => ({
    path,
    final: join(targetRoot, path),
    staged: `${join(targetRoot, path)}${ADOPTER_POLICY_STAGED_SUFFIX}`,
  }));
  runAuthorityHostEffectsWithRollback(
    [journalPath, ...entries.flatMap((entry) => [entry.final, entry.staged])],
    () => {
      for (const entry of entries) {
        mkdirSync(dirname(entry.final), { recursive: true });
        writeFileSync(entry.staged, writes.get(entry.path) ?? '');
      }
      writeFileSync(
        journalPath,
        jsonBytes({
          entries: entries.map((entry): AdopterPolicyJournalEntry => ({
            path: entry.path,
            previous: readTextIfPresent(entry.final),
          })),
        }),
      );
      for (const entry of entries) renameSync(entry.staged, entry.final);
      rmSync(journalPath, { force: true });
    },
  );
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
  const recovery = recoverInterruptedAdopterPolicyBind(targetRoot);
  const sourceBytes = readFileSync(sourcePath, 'utf8');
  const policy: unknown = JSON.parse(sourceBytes);
  const document = policy as JsonObject;
  const projectPath = join(targetRoot, '.devai/config/project.json');
  const currentProject = existsSync(projectPath)
    ? (JSON.parse(readFileSync(projectPath, 'utf8')) as JsonObject)
    : {};
  const projectionInput = {
    policy,
    currentProject,
    frameworkVersion: resolveCliVersion(),
    targetRoot,
  };
  const { files: resolved, retired_keys: retiredKeys } =
    resolveAdopterPolicyProjection(projectionInput);
  // ADR-AUT-0003: the extension this source compiles to. Its id, version, and rule count
  // do not depend on the repository identity; its digest does, so the receipt records it
  // from the authority policy once that is materialized (recordAuthorityExtension).
  const authorityExtension = compileAdopterPolicyAuthority(projectionInput, {
    repositoryId: 'adopter-repository',
    classWriteVerbs: classWriteVerbs(canonicalRegistry()),
  });
  const receipt = {
    schemaVersion: '1.0.0',
    policy_id: document['policy_id'],
    policy_version: document['policy_version'],
    source_path: relative(targetRoot, sourcePath).split(sep).join('/'),
    source_digest_sha256: sha256Bytes(sourceBytes),
    materialized: Object.fromEntries(
      [...resolved].map(([path, bytes]) => [path, sha256Bytes(bytes)]),
    ),
    retired_keys: retiredKeys,
  };
  const receiptBytes = jsonBytes(receipt);
  const targetsChanged = [...resolved].some(
    ([path, bytes]) => readTextIfPresent(join(targetRoot, path)) !== bytes,
  );
  const writes = new Map<string, string>();
  if (targetsChanged) {
    // A projection that moves lands every target with its receipt as one set.
    for (const [path, bytes] of resolved) writes.set(path, bytes);
    writes.set(ADOPTER_POLICY_RECEIPT, receiptBytes);
  } else {
    // Unchanged targets are never written. The receipt stands when it already records
    // this projection; its retired_keys then report the bind that last moved it.
    const currentReceipt = readTextIfPresent(join(targetRoot, ADOPTER_POLICY_RECEIPT));
    let recordedRetired: unknown;
    try {
      const parsed: unknown = currentReceipt === null ? undefined : JSON.parse(currentReceipt);
      recordedRetired = isJsonObject(parsed) ? parsed['retired_keys'] : undefined;
    } catch {
      recordedRetired = undefined;
    }
    const standing =
      Array.isArray(recordedRetired) &&
      currentReceipt === jsonBytes({ ...receipt, retired_keys: recordedRetired });
    if (!standing) writes.set(ADOPTER_POLICY_RECEIPT, receiptBytes);
  }
  if (writes.size > 0) writeAdopterPolicyPairAtomically(targetRoot, writes);
  return {
    receipt_path: ADOPTER_POLICY_RECEIPT,
    receipt,
    authorityExtension,
    ...(recovery !== null ? { recovered_interrupted_bind: recovery } : {}),
  };
}

/**
 * Record in the receipt the adopter extension the authority policy now carries
 * (ADR-AUT-0003): its id, version, the digest the materialized policy lists for it, and its
 * rule count. The digest is read back from the policy the trusted sources just derived, so
 * the receipt and the policy name the same bytes without a second repository-identity
 * lookup. From then on the trusted sources hold the source to this receipt strictly.
 */
function recordAuthorityExtension(
  targetRoot: string,
  receipt: Readonly<Record<string, unknown>>,
  extension: AdopterAuthorityExtension | undefined,
): Readonly<Record<string, unknown>> {
  if (extension === undefined) return receipt;
  const policy: unknown = JSON.parse(
    readFileSync(join(targetRoot, '.devai/config/authority-policy.json'), 'utf8'),
  );
  const listed = isJsonObject(policy) ? policy['additive_extensions'] : undefined;
  const entry = Array.isArray(listed)
    ? listed.find(
        (candidate: unknown) =>
          isJsonObject(candidate) &&
          candidate['extension_id'] === extension.extension_id &&
          candidate['extension_version'] === extension.extension_version,
      )
    : undefined;
  if (!isJsonObject(entry) || typeof entry['digest_sha256'] !== 'string') {
    throw new Error(
      `AUTHORITY_POLICY_DIGEST_MISMATCH:authority-policy.json lists no adopter extension ${extension.extension_id}`,
    );
  }
  const recorded = {
    ...receipt,
    authority_extension: {
      extension_id: extension.extension_id,
      extension_version: extension.extension_version,
      digest_sha256: entry['digest_sha256'],
      rule_count: extension.rules.length,
    },
  };
  const bytes = jsonBytes(recorded);
  if (readTextIfPresent(join(targetRoot, ADOPTER_POLICY_RECEIPT)) !== bytes) {
    writeAdopterPolicyPairAtomically(targetRoot, new Map([[ADOPTER_POLICY_RECEIPT, bytes]]));
  }
  return recorded;
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
    const { authorityExtension, ...result } = materializeAdopterPolicy(
      targetRoot,
      options.adopterPolicy,
    );
    const artifact = executeAuthorityPolicyMaterialization();
    const receipt = recordAuthorityExtension(targetRoot, result.receipt, authorityExtension);
    emit(
      { ...result, receipt, authority_policy: artifact },
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
