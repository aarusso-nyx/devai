import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  runAuthorityHostEffectsWithRollback,
  writeFileSync,
} from '@devai-nyx/authority';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
  postMergeAdapterFiles,
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
import { fsyncPath } from './durable-fs.js';
import { acquireUpgradeLock, assertUpgradeLockFree } from './upgrade-lock.js';
import { classWriteVerbs } from '../../authority/policy-support.js';
import { canonicalRegistry } from '../../define-command.js';
import { parseAdopterPolicyBinding } from '../../services/adopter-policy-binding.js';

function sha256Bytes(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export const ADOPTER_POLICY_RECEIPT = '.devai/config/adopter-policy-binding.json';
const ADOPTER_POLICY_JOURNAL = '.devai/config/adopter-policy-binding.journal.json';
const ADOPTER_POLICY_STAGED_SUFFIX = '.devai-bind-staged';
const ADOPTER_POLICY_PAIR: readonly string[] = [...ADOPTER_POLICY_TARGETS, ADOPTER_POLICY_RECEIPT];
/** The upgrade receipt init upgrade records beside the binding receipt (#264). */
export const UPGRADE_RECEIPT = '.devai/config/upgrade-receipt.json';
/**
 * The closed set of paths the bind journal may record and roll back: the adopter-policy
 * pair, plus every file init upgrade lands in its one durable transaction (#264): the
 * operational-law and subprocess-effects files, the authority policy, the host-adapter
 * configurations and workflow, the constitution pin and pointer, the CI verifier workflows,
 * and the upgrade receipt. A journal naming any other path is invalid and is never replayed.
 */
export const BIND_JOURNAL_PATHS: readonly string[] = [
  ...ADOPTER_POLICY_PAIR,
  '.devai/config/forbidden-actions.json',
  '.devai/config/subprocess-effects.json',
  '.devai/config/authority-policy.json',
  '.devai/config/github-actions-host-adapter.json',
  '.devai/config/post-merge-host-adapter.json',
  UPGRADE_RECEIPT,
  '.devai/pin/constitution.md',
  '.devai/constitution.md',
  '.github/workflows/devai-ledger-verify.yml',
  '.github/workflows/devai-local-rc-verify.yml',
  '.github/workflows/devai-main-observation.yml',
];

interface AdopterPolicyJournalEntry {
  /** A repository-relative path in BIND_JOURNAL_PATHS, or an absolute post-merge adapter file. */
  readonly path: string;
  /** The previous bytes: UTF-8 text, or base64 for an adapter file; null when absent. */
  readonly previous: string | null;
  readonly encoding?: 'base64';
  /** The previous mode of an adapter file: the hook and issuer are executable, the key 0600. */
  readonly mode?: number;
}

/** The bind journal init upgrade holds open across its whole write set (#264). */
let openJournal: { readonly root: string; readonly adapterFiles: readonly string[] } | undefined;

function readTextIfPresent(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** Land bytes on a final path by staging them beside it, flushing, and renaming into place. */
function landByRename(path: string, bytes: string): void {
  const staged = `${path}${ADOPTER_POLICY_STAGED_SUFFIX}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(staged, bytes);
  fsyncPath(staged);
  renameSync(staged, path);
}

/** Flush every existing path and each parent directory, so renames and removals persist. */
function flushPaths(paths: readonly string[]): void {
  for (const path of paths) fsyncPath(path);
  for (const directory of [...new Set(paths.map((path) => dirname(path)))]) fsyncPath(directory);
}

function adapterSnapshot(path: string): Pick<AdopterPolicyJournalEntry, 'previous' | 'mode'> {
  if (!existsSync(path)) return { previous: null };
  return {
    previous: readFileSync(path).toString('base64'),
    mode: lstatSync(path).mode & 0o7777,
  };
}

function journalEntryCurrent(targetRoot: string, entry: AdopterPolicyJournalEntry): boolean {
  if (entry.encoding !== 'base64') {
    return readTextIfPresent(join(targetRoot, entry.path)) === entry.previous;
  }
  const current = adapterSnapshot(entry.path);
  return current.previous === entry.previous && current.mode === entry.mode;
}

/**
 * Restore one journaled path to its previous bytes. Files under .devai/config are staged
 * and renamed; the pin, pointer, workflows and adapter files are written in place, which is
 * safe because recovery is idempotent and the journal stays until every path is restored.
 */
function restoreJournaledPath(targetRoot: string, entry: AdopterPolicyJournalEntry): string {
  const finalPath = entry.encoding === 'base64' ? entry.path : join(targetRoot, entry.path);
  if (entry.previous === null) {
    rmSync(finalPath, { force: true });
    return finalPath;
  }
  if (entry.encoding === 'base64') {
    mkdirSync(dirname(finalPath), { recursive: true });
    writeFileSync(finalPath, Buffer.from(entry.previous, 'base64'));
    chmodSync(finalPath, entry.mode ?? 0o644);
    return finalPath;
  }
  if (entry.path.startsWith('.devai/config/')) {
    landByRename(finalPath, entry.previous);
    return finalPath;
  }
  mkdirSync(dirname(finalPath), { recursive: true });
  writeFileSync(finalPath, entry.previous);
  return finalPath;
}

function validJournalEntry(entry: unknown, adapterFiles: readonly string[]): boolean {
  if (!isJsonObject(entry) || typeof entry['path'] !== 'string') return false;
  const previous = entry['previous'];
  if (previous !== null && typeof previous !== 'string') return false;
  if (isAbsolute(entry['path'])) {
    return (
      adapterFiles.includes(entry['path']) &&
      entry['encoding'] === 'base64' &&
      (previous === null || (typeof entry['mode'] === 'number' && Number.isInteger(entry['mode'])))
    );
  }
  return (
    BIND_JOURNAL_PATHS.includes(entry['path']) &&
    entry['encoding'] === undefined &&
    entry['mode'] === undefined
  );
}

/**
 * Finish a bind a previous process left interrupted. A journal next to the receipt
 * marks a committed write set; its presence means some renames may have landed, so
 * every journaled path is rolled back to its previous bytes and the new bind below
 * recomputes the projection from that complete previous pair. Staged files without a
 * journal never reached a final path and are discarded. The caller holds the binding lock.
 */
export function recoverInterruptedAdopterPolicyBind(
  targetRoot: string,
  upgradeLockToken?: string,
): 'rolled-back' | null {
  // Only the lock owner may recover: another holder's journal is a write set in flight.
  assertUpgradeLockFree(targetRoot, upgradeLockToken);
  const journalPath = join(targetRoot, ADOPTER_POLICY_JOURNAL);
  const stagedPaths = BIND_JOURNAL_PATHS.map(
    (path) => `${join(targetRoot, path)}${ADOPTER_POLICY_STAGED_SUFFIX}`,
  );
  const journalBytes = readTextIfPresent(journalPath);
  let recovered: 'rolled-back' | null = null;
  if (journalBytes !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(journalBytes);
    } catch {
      // A torn journal was never committed: no target write follows an incomplete journal.
      parsed = undefined;
    }
    if (parsed !== undefined) {
      const entries = isJsonObject(parsed) ? parsed['entries'] : undefined;
      const adapterFiles =
        Array.isArray(entries) &&
        entries.some((entry) => isJsonObject(entry) && isAbsolute(String(entry['path'])))
          ? postMergeAdapterFiles(targetRoot)
          : [];
      if (
        !Array.isArray(entries) ||
        !entries.every((entry) => validJournalEntry(entry, adapterFiles))
      ) {
        throw new Error('ADOPTER_POLICY_BINDING_JOURNAL_INVALID');
      }
      const restored: string[] = [];
      for (const entry of entries as AdopterPolicyJournalEntry[]) {
        if (journalEntryCurrent(targetRoot, entry)) continue;
        restored.push(restoreJournaledPath(targetRoot, entry));
      }
      // Every restored byte is durable before the journal that could replay it is removed.
      flushPaths(restored);
      recovered = 'rolled-back';
    }
  }
  for (const staged of stagedPaths) {
    if (existsSync(staged)) rmSync(staged, { force: true });
  }
  if (journalBytes !== null) {
    rmSync(journalPath, { force: true });
    fsyncPath(dirname(journalPath));
  }
  return recovered;
}

/**
 * Stage every file of the write set, commit the set with a journal of the previous
 * bytes, rename each staged file into place, and drop the journal. A process killed
 * at any point leaves either the previous complete pair or a journal the next bind
 * rolls back (ADR-CFG-0002, IA-003). The staged files and the journal are flushed before
 * the first rename, and the renames before the journal is removed (#264).
 */
export function writeAdopterPolicyPairAtomically(
  targetRoot: string,
  writes: ReadonlyMap<string, string>,
): void {
  const outside = [...writes.keys()].find((path) => !BIND_JOURNAL_PATHS.includes(path));
  if (outside !== undefined) {
    throw new Error(`ADOPTER_POLICY_BINDING_JOURNAL_PATH_INVALID:${outside}`);
  }
  if (openJournal?.root === targetRoot) {
    // The open upgrade journal already holds the previous bytes of every journaled path, so
    // the set is staged and renamed without a journal of its own, which would replace it.
    const finals = [...writes].map(([path, bytes]) => {
      const final = join(targetRoot, path);
      mkdirSync(dirname(final), { recursive: true });
      writeFileSync(`${final}${ADOPTER_POLICY_STAGED_SUFFIX}`, bytes);
      fsyncPath(`${final}${ADOPTER_POLICY_STAGED_SUFFIX}`);
      return final;
    });
    for (const final of finals) renameSync(`${final}${ADOPTER_POLICY_STAGED_SUFFIX}`, final);
    flushPaths(finals);
    return;
  }
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
        fsyncPath(entry.staged);
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
      flushPaths([journalPath]);
      for (const entry of entries) renameSync(entry.staged, entry.final);
      flushPaths(entries.map((entry) => entry.final));
      rmSync(journalPath, { force: true });
      fsyncPath(dirname(journalPath));
    },
  );
}

/**
 * Open the bind journal for a whole upgrade (#264): record the previous bytes of every
 * journaled path, and of the given post-merge adapter files (hook, key, issuer), and flush
 * the journal and its directory before any of them is written. Until commitBindJournal
 * drops it, a crash at any point leaves a journal the next recovery rolls back to that
 * complete previous state, so a new version stamp is never left without its receipt.
 */
export function openBindJournal(targetRoot: string, adapterFiles: readonly string[] = []): void {
  const journalPath = join(targetRoot, ADOPTER_POLICY_JOURNAL);
  if (openJournal !== undefined || existsSync(journalPath)) {
    throw new Error('ADOPTER_POLICY_BINDING_JOURNAL_OPEN');
  }
  const allowed = adapterFiles.length === 0 ? [] : postMergeAdapterFiles(targetRoot);
  const outside = adapterFiles.find((path) => !allowed.includes(path));
  if (outside !== undefined) {
    throw new Error(`ADOPTER_POLICY_BINDING_JOURNAL_PATH_INVALID:${outside}`);
  }
  mkdirSync(dirname(journalPath), { recursive: true });
  writeFileSync(
    journalPath,
    jsonBytes({
      entries: [
        ...BIND_JOURNAL_PATHS.map((path): AdopterPolicyJournalEntry => ({
          path,
          previous: readTextIfPresent(join(targetRoot, path)),
        })),
        ...adapterFiles.map((path): AdopterPolicyJournalEntry => ({
          path,
          encoding: 'base64',
          ...adapterSnapshot(path),
        })),
      ],
    }),
  );
  flushPaths([journalPath]);
  openJournal = { root: targetRoot, adapterFiles: [...adapterFiles] };
}

/**
 * Commit the open upgrade journal: flush every journaled target, the receipt among them,
 * with its directory, and only then remove the journal and flush its directory.
 */
export function commitBindJournal(targetRoot: string): void {
  if (openJournal?.root !== targetRoot) {
    throw new Error('ADOPTER_POLICY_BINDING_JOURNAL_NOT_OPEN');
  }
  flushPaths([
    ...BIND_JOURNAL_PATHS.map((path) => join(targetRoot, path)),
    ...openJournal.adapterFiles,
  ]);
  const journalPath = join(targetRoot, ADOPTER_POLICY_JOURNAL);
  rmSync(journalPath, { force: true });
  fsyncPath(dirname(journalPath));
  openJournal = undefined;
}

/** Forget an open journal after an in-process rollback has already removed its file. */
export function releaseBindJournal(): void {
  openJournal = undefined;
}

/** The bind journal path, for rollback scopes that must remove it with the write set. */
export const BIND_JOURNAL = ADOPTER_POLICY_JOURNAL;

/** Every absolute path a journaled transaction may touch: finals, staged siblings, journal. */
export function bindJournalTargets(targetRoot: string): readonly string[] {
  return [
    join(targetRoot, ADOPTER_POLICY_JOURNAL),
    ...BIND_JOURNAL_PATHS.flatMap((path) => [
      join(targetRoot, path),
      `${join(targetRoot, path)}${ADOPTER_POLICY_STAGED_SUFFIX}`,
    ]),
  ];
}

/** Resolve an adopter policy source argument, refusing any path outside law/policy. */
export function resolveAdopterPolicySource(targetRoot: string, sourceArgument: string): string {
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
  return sourcePath;
}

export interface AdopterPolicyBindPlan {
  readonly receipt: Readonly<Record<string, unknown>>;
  readonly resolved: ReadonlyMap<string, string>;
  readonly retiredKeys: readonly string[];
  readonly authorityExtension: AdopterAuthorityExtension | undefined;
  /** The exact write set a bind lands: empty when the projection and receipt stand. */
  readonly writes: ReadonlyMap<string, string>;
}

/**
 * Plan an adopter-policy bind without writing (ADR-CFG-0002): the projection over the given
 * project.json, the owned keys it retires, the receipt, and the write set measured against
 * the bytes on disk. init bind --adopter-policy lands the write set as is; init upgrade
 * composes it after the earlier segments it runs in the same invocation.
 */
export function planAdopterPolicyBind(
  targetRoot: string,
  sourcePath: string,
  options: {
    readonly currentProject?: JsonObject;
    readonly frameworkVersion?: string;
    readonly constitutionVersion?: string;
  } = {},
): AdopterPolicyBindPlan {
  const sourceBytes = readFileSync(sourcePath, 'utf8');
  const policy: unknown = JSON.parse(sourceBytes);
  const document = policy as JsonObject;
  const projectPath = join(targetRoot, '.devai/config/project.json');
  const currentProject =
    options.currentProject ??
    (existsSync(projectPath) ? (JSON.parse(readFileSync(projectPath, 'utf8')) as JsonObject) : {});
  const ownedTargets: string[] = [];
  const priorReceipt = readTextIfPresent(join(targetRoot, ADOPTER_POLICY_RECEIPT));
  if (priorReceipt !== null) {
    const parsed = parseAdopterPolicyBinding(priorReceipt);
    const sensorTarget = '.devai/config/sensor-inputs.json';
    if ('binding' in parsed && parsed.binding.materialized[sensorTarget] !== undefined) {
      const priorBytes = readTextIfPresent(join(targetRoot, sensorTarget));
      if (
        parsed.binding.policy_id !== document['policy_id'] ||
        priorBytes === null ||
        sha256Bytes(priorBytes) !== parsed.binding.materialized[sensorTarget]
      ) {
        throw new Error('ADOPTER_POLICY_SENSOR_INPUTS_OWNERSHIP_MISMATCH');
      }
      ownedTargets.push(sensorTarget);
    }
  }
  const projectionInput = {
    policy,
    currentProject,
    frameworkVersion: options.frameworkVersion ?? resolveCliVersion(),
    targetRoot,
    ownedTargets,
    ...(options.constitutionVersion !== undefined && {
      constitutionVersion: options.constitutionVersion,
    }),
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
  return { receipt, resolved, retiredKeys, authorityExtension, writes };
}

function materializeAdopterPolicy(targetRoot: string, sourceArgument: string, lockToken: string) {
  const sourcePath = resolveAdopterPolicySource(targetRoot, sourceArgument);
  const recovery = recoverInterruptedAdopterPolicyBind(targetRoot, lockToken);
  const { receipt, authorityExtension, writes } = planAdopterPolicyBind(targetRoot, sourcePath);
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
export function recordAuthorityExtension(
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
    // The same binding lock init upgrade holds (#264): journal recovery and every write of
    // this bind happen under it, so neither can roll back the other's live journal.
    const lock = acquireUpgradeLock(targetRoot, 'init bind --adopter-policy');
    try {
      const { authorityExtension, ...result } = materializeAdopterPolicy(
        targetRoot,
        options.adopterPolicy,
        lock.token,
      );
      const artifact = executeAuthorityPolicyMaterialization();
      const receipt = recordAuthorityExtension(targetRoot, result.receipt, authorityExtension);
      emit(
        { ...result, receipt, authority_policy: artifact },
        options.human === true,
        `init bind --adopter-policy: ${result.receipt_path}`,
      );
      process.exitCode = EXIT_PASS;
    } finally {
      lock.release();
    }
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
