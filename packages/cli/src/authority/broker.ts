import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import {
  authorizePolicyMaterialization,
  createAuthorityDecisionIssuer,
  deriveMachineAuthorityContext,
  loadAuthorityPolicy,
  materializeAuthorityPolicy,
  resolveAuthorityDeclaration,
  resolveAuthorityPolicy,
} from '@devai-nyx/authority';
import { createAuthorityBoundaryRuntime } from '@devai-nyx/authority';
import { assertAuthorityPathCapability } from '@devai-nyx/authority';
import {
  applyAuthorityHostEffectsAtomically,
  mkdirSync,
  writeFileSync,
  type AuthorityHostEffectRequest,
  type AuthorityHostEffectScope,
  type AtomicAuthorityHostEffect,
  protectedReleaseHostEffect,
  protectedArtifactSinkHostEffect,
  protectedExportHostEffect,
  assertProtectedReleasePrepareCapacityEffect,
  assertProtectedReleaseExportCapacityEffect,
  readProtectedReleaseRepositoryIdentity,
  assertProtectedReleaseRepositoryRoot,
  type ProtectedReleasePrepareCapacityBinding,
  type ProtectedReleasePrepareCapacity,
  type ProtectedReleaseExportCapacityBinding,
} from '@devai-nyx/authority';
import {
  computeManifestHash,
  deriveEvidenceId,
  gatherGitContext,
  type EvidenceChain,
  type EvidenceRecord,
} from '#runtime-core';
import { resolveCanonicalConstitution } from '@devai-nyx/skills';
import { validators } from '@devai-nyx/schemas';
import type { RegistryEntry } from '../define-command.js';
import { describeDeclaredCheckTaskRefusal } from '../services/check-runner/authority-process.js';
import {
  buildTrustedAuthoritySources,
  canonicalBytes,
  canonicalSha256,
  sha256Bytes,
} from './policy.js';
import { expectSuccess, flagValue, isRecord, type JsonRecord } from './broker-values.js';
import {
  canonicalRelativePath,
  existingRealpath,
  fsTarget,
  gitMetadataLayout,
  gitMetadataLogicalPath,
  physicalCanonicalPath,
  snapshot,
  within,
} from './broker-paths.js';
import {
  adapterId,
  boundedSelectors,
  makeEnvelope,
  processTarget,
  targetOperation,
} from './broker-targets.js';

type HumanRole = 'owner' | 'architect' | 'inspector' | 'engineer' | 'auditor';

interface BrokerInput {
  readonly entry: RegistryEntry;
  readonly entries: readonly RegistryEntry[];
  readonly argv: readonly string[];
  readonly role: HumanRole;
  readonly declaration: Readonly<{ as_role: HumanRole } | { authority_session: string }>;
  readonly repository_root: string;
  readonly package_version: string;
  readonly bootstrap_policy: boolean;
}

interface AuthorityResult<T = unknown> extends JsonRecord {
  readonly ok: boolean;
  readonly value?: T;
  readonly code?: string;
}

interface CapturedFilesystemEffect extends AtomicAuthorityHostEffect {
  readonly target: JsonRecord;
}

const INTERNAL_INIT_RECORD_CONTRACT = Object.freeze({
  schemaVersion: '1.0.0' as const,
  action_id: 'init record',
  effect: 'harness-write' as const,
  capabilities: ['fs:f5-state'] as const,
  subject: {
    kind: 'derived-machine' as const,
    actor: 'harness' as const,
    transition: 'harness-write' as const,
    initiator: {
      allowed_roles: ['owner', 'architect', 'inspector', 'engineer', 'auditor'] as const,
      preserve_in_context: true as const,
    },
  },
  consent: { write: true, allow_publish: false, experimental: false },
  planner: {
    kind: 'exact-plan' as const,
    planner_id: 'init-record-exact-plan',
    target_kinds: ['fs'] as const,
    atomicity: 'whole-plan' as const,
  },
  boundary: {
    kind: 'mutation-adapters' as const,
    adapter_ids: ['fs-authority-boundary'] as const,
    final_reverification: true as const,
  },
  readiness: { requires_binding: true, independent_acceptance_required: true as const },
});

const POLICY_PATH = '.devai/config/authority-policy.json';
const CONSTITUTION_BOOTSTRAP_TARGETS = new Set([
  '.devai/pin',
  '.devai/pin/constitution.md',
  '.devai/constitution.md',
  '.devai/config',
  '.devai/config/project.json',
]);
const READ_ONLY_PROCESS_COMMANDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  command: ['-v'],
  docker: ['version', 'ps'],
  git: [
    'cat-file',
    'diff',
    'diff-tree',
    'hash-object',
    'log',
    'ls-files',
    'ls-tree',
    'ls-remote',
    'merge-base',
    'rev-list',
    'rev-parse',
    'show',
    'status',
  ],
  which: ['mmdc'],
});

function actionContractRegistry(entries: readonly RegistryEntry[]) {
  const documents = new Map<string, unknown>(
    entries.map((entry) => {
      const view = entry.authority_contract;
      return [
        entry.name,
        Object.freeze({ raw: view, canonical_bytes: canonicalBytes(view), view }),
      ];
    }),
  );
  documents.set(
    INTERNAL_INIT_RECORD_CONTRACT.action_id,
    Object.freeze({
      raw: INTERNAL_INIT_RECORD_CONTRACT,
      canonical_bytes: canonicalBytes(INTERNAL_INIT_RECORD_CONTRACT),
      view: INTERNAL_INIT_RECORD_CONTRACT,
    }),
  );
  return Object.freeze({
    get(actionId: string): unknown {
      return documents.get(actionId);
    },
  });
}

function validatePolicySchema(value: unknown): AuthorityResult {
  if (!validators.authorityPolicy(value)) {
    return Object.freeze({
      ok: false,
      category: 'refused',
      code: 'AUTHORITY_POLICY_SCHEMA_INVALID',
      reasons: Object.freeze(['AUTHORITY_POLICY_SCHEMA_INVALID']),
    });
  }
  return Object.freeze({
    ok: true,
    value: Object.freeze({ raw: value, canonical_bytes: canonicalBytes(value), view: value }),
  });
}

function authorityPolicySemantics(value: JsonRecord): JsonRecord {
  const {
    materialized_at: _materializedAt,
    materialization: _materialization,
    ...semantics
  } = value;
  return semantics;
}

function unchangedAuthorityPolicy(path: string, nextBytes: Uint8Array): Buffer | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const currentBytes = readFileSync(path);
    const current = JSON.parse(currentBytes.toString('utf8')) as unknown;
    const next = JSON.parse(Buffer.from(nextBytes).toString('utf8')) as unknown;
    if (
      !isRecord(current) ||
      !isRecord(next) ||
      !validators.authorityPolicy(current) ||
      !validators.authorityPolicy(next)
    ) {
      return undefined;
    }
    return canonicalSha256(authorityPolicySemantics(current)) ===
      canonicalSha256(authorityPolicySemantics(next))
      ? currentBytes
      : undefined;
  } catch {
    return undefined;
  }
}

function isConstitutionBootstrap(input: BrokerInput): boolean {
  return (
    input.bootstrap_policy &&
    input.entry.name === 'init bind' &&
    input.argv.includes('--constitution') &&
    !input.argv.includes('--operational-law') &&
    !input.argv.includes('--subprocess-effects')
  );
}

function isFullBindingBootstrap(input: BrokerInput): boolean {
  return (
    input.bootstrap_policy && input.entry.name === 'init bind' && input.argv.includes('--full')
  );
}

const SAFE_UNBOUND_READ_ACTIONS = new Set([
  'audit scorecard',
  'catalog actions',
  'doctor',
  'init plan',
]);

function usesInstalledConstitution(input: BrokerInput): boolean {
  return (
    isConstitutionBootstrap(input) ||
    isFullBindingBootstrap(input) ||
    SAFE_UNBOUND_READ_ACTIONS.has(input.entry.name)
  );
}

function policyFor(input: BrokerInput, now: string) {
  const installedConstitution = usesInstalledConstitution(input)
    ? resolveCanonicalConstitution()
    : null;
  if (installedConstitution !== null && installedConstitution.version === null) {
    throw new Error('AUTHORITY_BOOTSTRAP_CONSTITUTION_VERSION_MISSING');
  }
  const sources = buildTrustedAuthoritySources(
    input.entries,
    input.repository_root,
    input.package_version,
    installedConstitution?.text,
  );
  if (input.bootstrap_policy) return { policy: sources.virtualPolicy, sources };

  const path = resolve(input.repository_root, POLICY_PATH);
  const document = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
  const loaded = loadAuthorityPolicy(
    { document },
    {
      now,
      validatePolicySchema,
      canonicalBytes,
      canonicalSha256,
      sha256Bytes,
      immutableCore: sources.immutableCore,
      additiveExtensions: sources.additiveExtensions,
      expected_repository_id: sources.repository_id,
      expected_policy_id: sources.provenance.policy_id,
      expected_package: sources.package_binding,
      expected_constitution: sources.constitution_binding,
      expected_minimum_policy_version: sources.provenance.policy_version,
    },
  );
  return { policy: expectSuccess(loaded), sources };
}

const GH_RUN_LIST_WORKFLOW = /^[A-Za-z0-9_.-]+\.ya?ml$/u;
const GH_RUN_LIST_EVENT = /^(?:push|pull_request|merge_group|workflow_dispatch|schedule)$/u;
const GH_RUN_LIST_BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,255}$/u;
const GH_RUN_LIST_JSON_FIELDS = /^[A-Za-z]+(?:,[A-Za-z]+){0,15}$/u;
const GH_RUN_LIST_LIMIT = /^[1-9][0-9]{0,3}$/u;
const GH_RUN_LIST_CREATED =
  /^>=[0-9]{4}-[0-9]{2}-[0-9]{2}(?:T[0-9:.]+(?:Z|[+-][0-9]{2}:?[0-9]{2})?)?$/u;

/**
 * The Pages publication journal the site_drift sensor reads (ADR-AUT-0002): the journal
 * repository packages/sensors/src/site-drift.ts declares, and the two exact GET endpoints
 * templates gh-api-pages-deployments and gh-api-pages-deployment-statuses describe. The
 * endpoint and query are fixed strings; only the decimal deployment id varies.
 */
const GH_API_PAGES_JOURNAL_REPOSITORY = 'aarusso-nyx/devai';
const GH_API_PAGES_DEPLOYMENTS = `/repos/${GH_API_PAGES_JOURNAL_REPOSITORY}/deployments?environment=devai-pages-publication&per_page=100`;
const GH_API_PAGES_DEPLOYMENT_STATUSES =
  /^\/repos\/aarusso-nyx\/devai\/deployments\/[1-9][0-9]{0,15}\/statuses\?per_page=100$/u;

/**
 * `gh api <endpoint>` with exactly one endpoint argument and no option, so the method is
 * the implicit GET and no field, input, pagination, header, or host can be supplied.
 */
function pagesJournalGhApi(argv: readonly string[]): boolean {
  if (argv.length !== 2 || argv[0] !== 'api') return false;
  const endpoint = argv[1] ?? '';
  return endpoint === GH_API_PAGES_DEPLOYMENTS || GH_API_PAGES_DEPLOYMENT_STATUSES.test(endpoint);
}

/**
 * The declared read-only GitHub CLI shapes (ADR-SCR-0005 IA-004, ADR-SCR-0010): `gh auth`
 * (usage), `gh auth status`, and the argv the harness sensors emit:
 * `gh run list --workflow <file> --event <event> [--branch <ref>] --json <fields>
 * --limit <n> [--created >=<date>]`. Declared by templates gh-auth-status, gh-run-list,
 * gh-run-list-created, gh-run-list-branch, and gh-run-list-branch-created in
 * law/policy/subprocess-effects.json, plus the two Pages journal GET shapes of
 * templates gh-api-pages-deployments and gh-api-pages-deployment-statuses
 * (ADR-AUT-0002). Those templates are descriptive for the effect-inference sensor and
 * are not loaded here, so this literal is the executable policy and mirrors them; it
 * is not gated by parent action, so `sense run` and `check` both admit it. Each option
 * appears once and in the stated order.
 * Every other gh argv is refused.
 */
function readOnlyGhProcess(args: readonly unknown[]): boolean {
  if (args.some((argument) => typeof argument !== 'string')) return false;
  const argv = args as readonly string[];
  if (pagesJournalGhApi(argv)) return true;
  if (argv[0] === 'auth' && (argv.length === 1 || (argv.length === 2 && argv[1] === 'status'))) {
    return true;
  }
  return runListGhProcess(argv);
}

function runListGhProcess(argv: readonly string[]): boolean {
  if (argv.length < 10 || argv.length > 14) return false;
  if (argv[0] !== 'run' || argv[1] !== 'list') return false;
  if (argv[2] !== '--workflow' || !GH_RUN_LIST_WORKFLOW.test(argv[3] ?? '')) return false;
  if (argv[4] !== '--event' || !GH_RUN_LIST_EVENT.test(argv[5] ?? '')) return false;
  let at = 6;
  if (argv[at] === '--branch') {
    if (!GH_RUN_LIST_BRANCH.test(argv[at + 1] ?? '')) return false;
    at += 2;
  }
  if (argv[at] !== '--json' || !GH_RUN_LIST_JSON_FIELDS.test(argv[at + 1] ?? '')) return false;
  if (argv[at + 2] !== '--limit' || !GH_RUN_LIST_LIMIT.test(argv[at + 3] ?? '')) return false;
  at += 4;
  if (at === argv.length) return true;
  return (
    argv.length === at + 2 &&
    argv[at] === '--created' &&
    GH_RUN_LIST_CREATED.test(argv[at + 1] ?? '')
  );
}

/** The executable and argv of a refused process request, as strings, for the refusal context. */
function refusedProcessContext(request: AuthorityHostEffectRequest): {
  readonly executable: string;
  readonly argv: readonly string[];
} {
  const args = request.arguments[1];
  return {
    executable: String(request.arguments[0]),
    argv: Array.isArray(args) ? args.map((argument: unknown) => String(argument)) : [],
  };
}

/**
 * #241: a refused `sense run` process names the sensor and the declaration that admits its
 * process, rather than the task descriptor wording used for `check`.
 */
function refusedSensorProcessContext(
  request: AuthorityHostEffectRequest,
  action: string,
  argv: readonly string[],
): object | undefined {
  if (action !== 'sense run') return undefined;
  const run = argv.findIndex((word, index) => word === 'run' && argv[index - 1] === 'sense');
  const candidate = run < 0 ? undefined : argv[run + 1];
  const sensor = candidate === undefined || candidate.startsWith('-') ? undefined : candidate;
  return {
    ...refusedProcessContext(request),
    action,
    ...(sensor === undefined ? {} : { sensor }),
    descriptor_path: '.devai/config/sensor-inputs.json',
  };
}

/** One repository-relative path under tests/: no option, no absolute path, no parent segment. */
function governedTestPath(value: unknown): boolean {
  if (typeof value !== 'string' || isAbsolute(value)) return false;
  const segments = value.split(/[\\/]/u);
  return (
    segments[0] === 'tests' &&
    segments.length > 1 &&
    segments.every((segment) => segment.length > 0 && segment !== '..' && segment !== '.')
  );
}

/**
 * The pnpm executable as the build sensor resolves it: a path whose basename is `pnpm`, or
 * the corepack shim `<prefix>/corepack/dist/pnpm.js` that a corepack-managed `pnpm` on PATH
 * resolves to (#155). The shim is pnpm itself, so admitting it widens no argv; the argv is
 * still matched exactly by the caller.
 */
function pnpmExecutable(executable: string): boolean {
  if (basename(executable) === 'pnpm') return true;
  const dist = dirname(executable);
  return (
    basename(executable) === 'pnpm.js' &&
    basename(dist) === 'dist' &&
    basename(dirname(dist)) === 'corepack'
  );
}

function readOnlyProcess(
  request: AuthorityHostEffectRequest,
  parentAction?: string,
  declaredCapabilities: readonly string[] = [],
): boolean {
  const executable = request.arguments[0];
  const args = request.arguments[1];
  if (typeof executable !== 'string' || !Array.isArray(args)) return false;
  if (
    declaredCapabilities.includes('proc:git') &&
    basename(executable) === 'git' &&
    args.length === 3 &&
    args[0] === 'config' &&
    args[1] === '--get' &&
    args[2] === 'remote.origin.url'
  ) {
    return true;
  }
  if (
    parentAction === 'sense run' &&
    basename(executable) === 'npx' &&
    args.length === 3 &&
    args[0] === 'eslint' &&
    args[1] === '--format=json' &&
    typeof args[2] === 'string'
  ) {
    return true;
  }
  if (
    parentAction === 'sense run' &&
    basename(executable) === 'npx' &&
    args[0] === 'tsc' &&
    args[1] === '--noEmit' &&
    (args.length === 2 ||
      (args.length === 4 &&
        args[2] === '-p' &&
        typeof args[3] === 'string' &&
        !isAbsolute(args[3]) &&
        !args[3].split(/[\\/]/u).includes('..')))
  ) {
    return true;
  }
  if (
    parentAction === 'sense run' &&
    pnpmExecutable(executable) &&
    args.length === 2 &&
    args[0] === '-r' &&
    args[1] === 'build'
  ) {
    // Mirrors template pnpm-recursive-build (ADR-AUT-0002): exactly `pnpm -r build`.
    return true;
  }
  if (parentAction === 'sense run' && basename(executable) === 'pnpm') {
    // Mirrors template pnpm-vitest-run-governed-config in law/policy/subprocess-effects.json.
    // A literal list: never read from disk, never a bare package script.
    const governedConfigs = [
      'tests/config/local.config.ts',
      'tests/config/local.coverage.config.ts',
      'tests/config/rc.e2e.config.ts',
      'tests/config/rc.performance.config.ts',
      'tests/config/t1.unit.config.ts',
      'tests/config/t3.integration.config.ts',
      'tests/config/t4.regression.config.ts',
      'tests/config/t5.e2e.config.ts',
    ];
    if (args.length === 2 && args[0] === 'vitest' && args[1] === 'run') {
      return true;
    }
    if (
      (args.length === 4 || (args.length === 5 && governedTestPath(args[4]))) &&
      args[0] === 'vitest' &&
      args[1] === 'run' &&
      args[2] === '--config' &&
      governedConfigs.includes(String(args[3]))
    ) {
      return true;
    }
  }
  if (parentAction === 'check' && basename(executable) === 'node') {
    // The planning-lane members of law/policy/check-suites.json (ADR-CHK-0003):
    // the exact literal argv each member declares. Both scripts only read the
    // tree; --check compares the rendered page and never writes it.
    const planningLaneArgvs = [
      ['scripts/check-campaign.mjs'],
      ['scripts/generate-scorecard-page.mjs', '--check'],
    ];
    if (planningLaneArgvs.some((declared) => JSON.stringify(declared) === JSON.stringify(args))) {
      return true;
    }
  }
  if (['true', 'false'].includes(basename(executable)) && args.length === 0) return true;
  if (
    basename(executable) === 'node' &&
    args.length === 2 &&
    args[0] === '-e' &&
    /^process\.exit\([01]\);?$/u.test(String(args[1]))
  ) {
    return true;
  }
  if (args.length === 1 && ['--version', '--help'].includes(String(args[0]))) return true;
  if (executable === 'gh') return readOnlyGhProcess(args);
  if (
    basename(executable) === 'pnpm' &&
    args.length === 2 &&
    args[0] === 'audit' &&
    args[1] === '--json'
  ) {
    return true;
  }
  if (
    basename(executable) === 'npm' &&
    args.length === 3 &&
    args[0] === 'audit' &&
    args[1] === '--json' &&
    args[2] === '--package-lock-only'
  ) {
    return true;
  }
  if (executable === 'sh' && args[0] === '-lc') {
    return typeof args[1] === 'string' && /^command -v (claude|codex)$/u.test(args[1]);
  }
  const allowed = READ_ONLY_PROCESS_COMMANDS[executable];
  return allowed?.includes(String(args[0])) === true;
}

export function createAuthorityHostBroker(input: BrokerInput): {
  readonly scope: AuthorityHostEffectScope;
  readonly record_init: (segment: string) => Readonly<{
    scope: AuthorityHostEffectScope;
    execute: () => void;
  }>;
  readonly session_operation?: () => unknown;
  readonly policy_materialization?: () => unknown;
  readonly commit_exact?: () => void;
  readonly dispose: () => void;
} {
  const repositoryRoot = realpathSync(input.repository_root);
  const invocationId = `cli-${String(process.pid)}-${randomUUID()}`;
  const now = new Date().toISOString();
  const contracts = actionContractRegistry(
    input.entries.map((entry) => (entry.name === input.entry.name ? input.entry : entry)),
  );
  const { policy, sources } = policyFor(input, now);
  const constitutionBootstrap = isConstitutionBootstrap(input);
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'devai-cli-authority',
    issuer_version: '1.0.0',
    invocation_id: invocationId,
    canonicalSha256,
    randomId: randomUUID,
    now: () => new Date().toISOString(),
    receipt_ttl_ms: 30_000,
  }) as JsonRecord;
  let disposed = false;
  let effectApply: (() => unknown) | undefined;
  let exactUnitApply: (() => unknown) | undefined;
  let effectResult: unknown;
  const runtime = createAuthorityBoundaryRuntime({
    receiptStore: issuer,
    invocation_id: invocationId,
    canonicalSha256,
    repository_root: repositoryRoot,
    fs: {
      realpath: (path: string) => {
        const physical = existingRealpath(physicalCanonicalPath(repositoryRoot, path));
        const metadataPath = gitMetadataLogicalPath(repositoryRoot, physical);
        // The broker has already admitted only the two exact Git metadata
        // namespaces above. Present their stable logical repository names to
        // the generic boundary while snapshots continue to inspect the real
        // physical files.
        return metadataPath ? resolve(repositoryRoot, metadataPath) : physical;
      },
      lstat: (path: string) => snapshot(repositoryRoot, path),
      writeAtomic: () => {
        if (!effectApply) throw new Error('AUTHORITY_EFFECT_APPLY_MISSING');
        effectResult = effectApply();
        return `authority-boundary:${invocationId}`;
      },
      renameAtomic: () => {
        if (!effectApply) throw new Error('AUTHORITY_EFFECT_APPLY_MISSING');
        effectResult = effectApply();
        return `authority-boundary:${invocationId}`;
      },
      applyAtomic: () => {
        if (!exactUnitApply) throw new Error('AUTHORITY_ATOMIC_UNIT_APPLY_MISSING');
        return exactUnitApply();
      },
    },
    git: {
      updateRef: () => {
        if (!effectApply) throw new Error('AUTHORITY_EFFECT_APPLY_MISSING');
        effectResult = effectApply();
      },
      deleteRef: () => {
        if (!effectApply) throw new Error('AUTHORITY_EFFECT_APPLY_MISSING');
        effectResult = effectApply();
      },
      push: () => {
        if (!effectApply) throw new Error('AUTHORITY_EFFECT_APPLY_MISSING');
        effectResult = effectApply();
      },
    },
    db: {
      execute: () => {
        if (!effectApply) throw new Error('AUTHORITY_EFFECT_APPLY_MISSING');
        effectResult = effectApply();
      },
    },
    remote: {
      invoke: () => {
        if (!effectApply) throw new Error('AUTHORITY_EFFECT_APPLY_MISSING');
        effectResult = effectApply();
      },
    },
  }) as JsonRecord;
  let effectCounter = 0;
  const plannerRegistry = runtime.plannerRegistry as JsonRecord;
  const actionPlanner = input.entry.authority_contract.planner;
  const actionConsent = {
    ...input.entry.authority_contract.consent,
    allow_publish: input.argv.includes('--publish'),
    experimental: input.argv.includes('--experimental'),
  } as JsonRecord;
  const actionEnvelope = makeEnvelope({
    invocationId,
    actionId: input.entry.name,
    effect: input.entry.effects,
    repositoryId: sources.repository_id,
    consent: actionConsent,
    policy: (policy as JsonRecord).provenance as JsonRecord,
    now,
  });
  const boundedPlan =
    actionPlanner.kind === 'bounded-batches'
      ? {
          plan_id: `${actionPlanner.planner_id}-${invocationId}`,
          envelope: actionEnvelope,
          strategy: 'bounded-batches',
          selectors: actionPlanner.target_kinds.flatMap((kind) =>
            boundedSelectors(kind, sources.repository_id, input.entry.name),
          ),
          bounds: actionPlanner.bounds,
          batch_atomicity: 'each-batch',
          recovery: 'preserve-and-report',
        }
      : undefined;
  const boundedPlanHandle =
    boundedPlan === undefined
      ? undefined
      : expectSuccess<JsonRecord>(
          (plannerRegistry.registerPlan as (value: unknown) => unknown)({
            subject: { plan: boundedPlan },
            invocation_id: invocationId,
          }),
        );
  const boundedPlanDigest = boundedPlan === undefined ? undefined : canonicalSha256(boundedPlan);
  let releaseRequestDigest: string | undefined;
  let exportBindingDigest: string | undefined;
  const readReleaseCapacity = (
    binding: ProtectedReleasePrepareCapacityBinding | ProtectedReleaseExportCapacityBinding,
  ): ProtectedReleasePrepareCapacity => {
    const isExport = binding.action_id === 'release export';
    const action = isExport ? 'release export' : 'release prepare';
    const unavailable = isExport
      ? 'release-export-capacity-unavailable'
      : 'release-prepare-capacity-unavailable';
    const expectedPlanner = {
      kind: 'bounded-batches',
      planner_id: isExport ? 'release-export-bounded-plan' : 'release-prepare-bounded-plan',
      target_kinds: isExport
        ? ['fs', 'artifact-sink', 'protected-export-signer']
        : ['fs', 'artifact-sink'],
      bounds: {
        max_batches: isExport ? 128 : 256,
        max_targets_per_batch: 64,
        max_total_targets: 8192,
      },
      recovery: 'preserve-and-report',
    };
    try {
      assertProtectedReleaseRepositoryRoot(repositoryRoot);
      const identity = readProtectedReleaseRepositoryIdentity();
      if (
        disposed ||
        input.entry.name !== action ||
        input.entry.effects !== 'local-write' ||
        input.role !== 'architect' ||
        !input.argv.includes('--write') ||
        binding.action_id !== input.entry.name ||
        identity.authority_repository_id !== sources.repository_id ||
        binding.repository.id !== identity.expected_release_repository_id ||
        binding.repository.commit !== identity.repository.commit ||
        binding.repository.tree !== identity.repository.tree ||
        boundedPlan === undefined ||
        boundedPlanHandle === undefined ||
        canonicalSha256(boundedPlan) !== boundedPlanDigest ||
        canonicalSha256(actionPlanner) !== canonicalSha256(expectedPlanner)
      )
        throw new Error(unavailable);
      const requestPath = flagValue(input.argv, '--request');
      if (requestPath === undefined) throw new Error(unavailable);
      const request = JSON.parse(readFileSync(resolve(requestPath), 'utf8')) as unknown;
      if (
        !isRecord(request) ||
        request.action_id !== binding.action_id ||
        canonicalSha256(request.repository_locator) !== canonicalSha256(binding.repository) ||
        !isRecord(request.candidate_locator) ||
        request.candidate_locator.commit !== binding.candidate.commit ||
        request.candidate_locator.tree !== binding.candidate.tree ||
        !Array.isArray(request.receipt_locators)
      )
        throw new Error(unavailable);
      const planReceipts = request.receipt_locators.filter(
        (locator: unknown): locator is JsonRecord =>
          isRecord(locator) && locator.kind === 'release-plan-receipt',
      );
      const requestDigest = canonicalSha256(request);
      if (
        planReceipts.length !== 1 ||
        planReceipts[0]?.receipt_digest_sha256 !== binding.plan_receipt_digest_sha256 ||
        (releaseRequestDigest !== undefined && requestDigest !== releaseRequestDigest)
      )
        throw new Error(unavailable);
      const recovery = expectSuccess<JsonRecord>(
        (plannerRegistry.recovery as (value: unknown) => unknown)({
          plan_handle: boundedPlanHandle,
        }),
      );
      const batches = recovery.applied_batch_ids;
      const targets = recovery.applied_target_count;
      if (
        !Array.isArray(batches) ||
        batches.some((batch: unknown) => typeof batch !== 'string' || batch.length === 0) ||
        new Set(batches).size !== batches.length ||
        batches.length > boundedPlan.bounds.max_batches ||
        typeof targets !== 'number' ||
        !Number.isSafeInteger(targets) ||
        targets < batches.length ||
        targets > boundedPlan.bounds.max_total_targets
      )
        throw new Error(unavailable);
      releaseRequestDigest = requestDigest;
      return Object.freeze({
        remaining_batches: boundedPlan.bounds.max_batches - batches.length,
        remaining_targets: boundedPlan.bounds.max_total_targets - targets,
      });
    } catch {
      throw new Error(unavailable);
    }
  };
  const exactEffects: CapturedFilesystemEffect[] = [];
  const descriptorTargets = new Map<number, JsonRecord>();

  const authorizeTarget = (
    action: {
      readonly name: string;
      readonly effects: 'harness-write' | 'local-write' | 'remote-write';
      readonly authority_contract:
        typeof INTERNAL_INIT_RECORD_CONTRACT | RegistryEntry['authority_contract'];
    },
    target: JsonRecord,
    apply: () => unknown,
  ): unknown => {
    assertProtectedReleasePrepareCapacityEffect(issuer);
    assertProtectedReleaseExportCapacityEffect(issuer);
    effectCounter += 1;
    if (target.kind === 'fs') {
      const canonicalPath = String(target.canonical_relative_path ?? '');
      if (
        constitutionBootstrap &&
        action.name === input.entry.name &&
        (!CONSTITUTION_BOOTSTRAP_TARGETS.has(canonicalPath) ||
          !['create', 'update'].includes(String(target.operation)))
      ) {
        throw new Error(
          `AUTHORITY_BOOTSTRAP_TARGET_FORBIDDEN:${String(target.operation)}:${canonicalPath}`,
        );
      }
      try {
        assertAuthorityPathCapability(
          action.authority_contract.capabilities.filter((capability) =>
            capability.startsWith('fs:'),
          ),
          repositoryRoot,
          canonicalPath,
        );
      } catch {
        throw new Error(`AUTHORITY_PATH_DOMAIN_VIOLATION:${action.name}:${canonicalPath}`);
      }
    }
    const consent =
      action.name === input.entry.name
        ? actionConsent
        : (action.authority_contract.consent as JsonRecord);
    const declaration = expectSuccess<JsonRecord>(
      resolveAuthorityDeclaration(
        {
          action_id: action.name,
          invocation_id: invocationId,
          dry_run: false,
          declaration: input.declaration,
          consent,
        },
        {
          actionContracts: contracts,
          receiptStore: issuer,
          repository_id: sources.repository_id,
          policy_binding: (policy as JsonRecord).provenance,
          constitution_binding: sources.constitution_binding,
          package_binding: sources.package_binding,
          now: new Date().toISOString(),
          readSession: (sessionId: string) => {
            const sessionPath = resolve(
              repositoryRoot,
              '.devai/state/authority-sessions',
              `${sessionId}.json`,
            );
            return {
              ok: true,
              value: existsSync(sessionPath)
                ? JSON.parse(readFileSync(sessionPath, 'utf8'))
                : undefined,
            };
          },
          validateSessionSchema: (document: unknown) =>
            validators.authoritySession(document)
              ? { ok: true, value: document }
              : {
                  ok: false,
                  category: 'refused',
                  code: 'AUTHORITY_SESSION_SCHEMA_INVALID',
                  reasons: ['AUTHORITY_SESSION_SCHEMA_INVALID'],
                },
          canonicalSha256,
        },
      ),
    );
    const contextReceipt =
      declaration.kind === 'machine-initiation'
        ? expectSuccess<JsonRecord>(
            deriveMachineAuthorityContext(
              {
                action_id: action.name,
                invocation_id: invocationId,
                consent,
                declaration_receipt: declaration.declaration_receipt,
              },
              {
                receiptStore: issuer,
                actionContracts: contracts,
                canonicalSha256,
                trusted_adapter_id: 'devai-cli-authority',
                verifiedOrigin:
                  'authority_session' in input.declaration
                    ? {
                        kind: 'interactive-session',
                        session_id: input.declaration.authority_session,
                      }
                    : { kind: 'direct-cli', invocation_id: invocationId },
              },
            ),
          ).context_receipt
        : declaration.context_receipt;
    const planner = action.authority_contract.planner;
    if (planner.kind === 'none') throw new Error('AUTHORITY_ACTION_PLANNER_REQUIRED');
    const recovery =
      planner.kind === 'bounded-batches'
        ? expectSuccess<JsonRecord>(
            (plannerRegistry.recovery as (value: unknown) => unknown)({
              plan_handle: boundedPlanHandle,
            }),
          )
        : undefined;
    const batch =
      planner.kind === 'bounded-batches'
        ? {
            batch_id: `${planner.planner_id}-batch-${String(effectCounter)}`,
            plan_id: boundedPlan?.plan_id,
            ordinal: Array.isArray(recovery?.applied_batch_ids)
              ? recovery.applied_batch_ids.length + 1
              : 1,
            targets: [target],
            atomicity: 'whole-batch',
          }
        : undefined;
    const subject =
      planner.kind === 'bounded-batches'
        ? { plan: boundedPlan, batch }
        : {
            plan: {
              plan_id: `${planner.planner_id}-${String(effectCounter)}`,
              envelope: makeEnvelope({
                invocationId,
                actionId: action.name,
                effect: action.effects,
                repositoryId: sources.repository_id,
                consent,
                policy: (policy as JsonRecord).provenance as JsonRecord,
                now,
              }),
              strategy: 'exact-plan',
              targets: [target],
              atomicity: 'whole-plan',
            },
          };
    const resolution = resolveAuthorityPolicy(
      policy,
      {
        action_id: action.name,
        context_receipt: contextReceipt,
        consent,
        resource: target,
        operation: targetOperation(target),
      },
      { receiptStore: issuer },
    ) as JsonRecord;
    if (resolution.outcome !== 'allow') {
      throw new Error(String(resolution.code ?? 'AUTHORITY_POLICY_DENIED'));
    }
    const boundaryAdapterId = adapterId(target);
    const issued = (issuer.issueAllow as (value: unknown) => unknown)({
      resolutions: [resolution],
      subject,
      context_receipt: contextReceipt,
      invocation_id: invocationId,
      boundary_adapter_id: boundaryAdapterId,
    }) as JsonRecord;
    if (issued.issued !== true || issued.outcome !== 'allow') {
      throw new Error(String(issued.code ?? 'AUTHORITY_DECISION_NOT_ISSUED'));
    }
    const planHandle =
      boundedPlanHandle ??
      expectSuccess<JsonRecord>(
        (plannerRegistry.registerPlan as (value: unknown) => unknown)({
          subject,
          context_receipt: contextReceipt,
          invocation_id: invocationId,
        }),
      );
    const batchHandle =
      batch === undefined
        ? undefined
        : expectSuccess<JsonRecord>(
            (plannerRegistry.registerBatch as (value: unknown) => unknown)({
              plan_handle: planHandle,
              batch,
              invocation_id: invocationId,
              plan_digest_sha256: canonicalSha256(boundedPlan),
              target_digest_sha256: canonicalSha256([target.id]),
              recovery,
            }),
          );
    const prepared = expectSuccess<JsonRecord>(
      (runtime.prepare as (value: unknown) => unknown)({
        target,
        subject,
        ...(batch === undefined ? {} : { batch, batch_handle: batchHandle }),
        context_receipt: contextReceipt,
        decision_receipt: issued.receipt,
        plan_handle: planHandle,
        adapter_id: boundaryAdapterId,
      }),
    );
    effectApply = apply;
    effectResult = undefined;
    try {
      expectSuccess((runtime.apply as (value: unknown) => unknown)({ prepared }));
      return effectResult;
    } finally {
      effectApply = undefined;
      effectResult = undefined;
    }
  };

  const applyEffect = (request: AuthorityHostEffectRequest, apply: () => unknown): unknown => {
    assertProtectedReleasePrepareCapacityEffect(issuer);
    assertProtectedReleaseExportCapacityEffect(issuer);
    if (request.kind === 'protected-release') {
      const operation =
        protectedReleaseHostEffect(request) ??
        protectedArtifactSinkHostEffect(request) ??
        protectedExportHostEffect(request);
      const artifact = operation?.kind === 'artifact-sink';
      const provider = operation?.kind === 'provider';
      const exportSink = operation?.kind === 'export-sink';
      const exportSigner = operation?.kind === 'export-signer';
      const isExport = exportSink || exportSigner;
      const requiredCapability = exportSigner
        ? 'protected-export-signer-v1:sign'
        : artifact || exportSink
          ? 'artifact-sink:write'
          : provider
            ? 'protected-certification-provider-v3:execute'
            : 'certification-evidence-sink:write';
      const requiredKind = exportSigner
        ? 'protected-export-signer'
        : artifact || exportSink
          ? 'artifact-sink'
          : provider
            ? 'protected-certification-provider'
            : 'certification-evidence-sink';
      const requiredAdapter = exportSigner
        ? 'protected-export-signer-v1'
        : exportSink
          ? 'trusted-export-artifact-sink-v1'
          : artifact
            ? 'trusted-artifact-sink-v3'
            : provider
              ? 'protected-certification-provider-v3'
              : 'trusted-certification-evidence-sink-v1';
      if (
        operation === undefined ||
        input.entry.effects === 'read' ||
        operation.binding.action_id !== input.entry.name ||
        input.role !== (artifact || isExport ? 'architect' : 'inspector') ||
        !input.argv.includes('--write') ||
        !input.entry.authority_contract.capabilities.some(
          (capability) => capability === requiredCapability,
        ) ||
        !('target_kinds' in actionPlanner) ||
        !actionPlanner.target_kinds.includes(requiredKind) ||
        input.entry.authority_contract.boundary.kind !== 'mutation-adapters' ||
        !input.entry.authority_contract.boundary.adapter_ids.includes(requiredAdapter)
      )
        throw new Error('AUTHORITY_PROTECTED_RELEASE_ACTION_MISMATCH');
      const requestPath = flagValue(input.argv, '--request');
      if (requestPath === undefined) throw new Error('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
      const declaredRequest = JSON.parse(readFileSync(resolve(requestPath), 'utf8')) as JsonRecord;
      assertProtectedReleaseRepositoryRoot(repositoryRoot);
      if (
        declaredRequest.action_id !== input.entry.name ||
        canonicalSha256(declaredRequest.repository_locator) !==
          canonicalSha256(operation.binding.repository) ||
        operation.binding.authority_repository_id !== sources.repository_id ||
        operation.binding.repository.id !== operation.binding.expected_release_repository_id ||
        !isRecord(declaredRequest.candidate_locator) ||
        declaredRequest.candidate_locator.commit !== operation.binding.repository.commit ||
        declaredRequest.candidate_locator.tree !== operation.binding.repository.tree ||
        !Array.isArray(declaredRequest.receipt_locators) ||
        !declaredRequest.receipt_locators.some(
          (locator: unknown) =>
            isRecord(locator) &&
            locator.kind === 'release-plan-receipt' &&
            locator.receipt_digest_sha256 === operation.binding.plan_receipt_digest_sha256,
        )
      )
        throw new Error('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
      if (isExport) {
        // The request selects a destination, never a sink/parent or key. Pin the
        // entire externally supplied export control tuple for this live account.
        const binding = operation.binding;
        const destination = declaredRequest.destination;
        if (
          !('destination' in binding) ||
          !isRecord(destination) ||
          destination.kind !== binding.destination.kind ||
          destination.exact_identifier !== binding.destination.exact_identifier ||
          (Object.hasOwn(destination, 'trust') &&
            canonicalSha256(destination.trust) !== canonicalSha256(binding.trust)) ||
          (exportBindingDigest !== undefined && exportBindingDigest !== canonicalSha256(binding))
        )
          throw new Error('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
        exportBindingDigest = canonicalSha256(binding);
      }
      const target: JsonRecord = {
        kind: 'remote',
        id: `protected-release:${operation.operation_id}`,
        system_id: exportSigner
          ? 'protected-export-signer-v1'
          : exportSink
            ? 'trusted-export-artifact-sink-v1'
            : artifact
              ? 'trusted-artifact-sink-v3'
              : provider
                ? 'devai-protected-certification-provider-v3'
                : 'trusted-certification-evidence-sink-v1',
        endpoint_id: 'host',
        operation_id: exportSigner ? 'sign' : provider ? 'execute' : 'write',
        publication: false,
        protected_release_binding: operation.binding,
        protected_operation_id: operation.operation_id,
      };
      return authorizeTarget(
        {
          name: input.entry.name,
          effects: input.entry.effects,
          authority_contract: input.entry.authority_contract,
        },
        target,
        apply,
      );
    }
    if (request.kind === 'process') {
      if (readOnlyProcess(request, input.entry.name, input.entry.authority_contract.capabilities))
        return apply();
      if (input.entry.effects === 'read') {
        // Name the refused argv so the reader sees which command was not admitted
        // (ADR-SCR-0007 IA-002); the argv is the caller's own declared command.
        const error = new Error('AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED') as Error & {
          context?: object;
        };
        error.context =
          refusedSensorProcessContext(request, input.entry.name, input.argv) ??
          refusedProcessContext(request);
        throw error;
      }
      const target = processTarget(
        request,
        input.entry.name,
        repositoryRoot,
        sources.repository_id,
        input.argv,
      );
      if (!target) {
        const context =
          input.entry.name === 'check'
            ? describeDeclaredCheckTaskRefusal(repositoryRoot, request)
            : undefined;
        const error = new Error('AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED') as Error & {
          context?: object;
        };
        error.context =
          context ??
          refusedSensorProcessContext(request, input.entry.name, input.argv) ??
          refusedProcessContext(request);
        throw error;
      }
      if (actionPlanner.kind === 'exact-plan') {
        throw new Error('AUTHORITY_EXACT_PROCESS_ADAPTER_REQUIRED');
      }
      return authorizeTarget(
        {
          name: input.entry.name,
          effects: input.entry.effects,
          authority_contract: input.entry.authority_contract,
        },
        target,
        apply,
      );
    }
    if (input.entry.effects === 'read') {
      throw new Error('AUTHORITY_READ_ACTION_MUTATION_FORBIDDEN');
    }
    if (
      request.symbol === 'mkdirSync' &&
      typeof request.arguments[0] === 'string' &&
      existsSync(request.arguments[0]) &&
      lstatSync(request.arguments[0]).isDirectory()
    ) {
      return undefined;
    }
    if (actionPlanner.kind === 'exact-plan') {
      exactEffects.push({
        request,
        apply,
        target: fsTarget(request, repositoryRoot, sources.repository_id),
      });
      return undefined;
    }
    const target = fsTarget(request, repositoryRoot, sources.repository_id, descriptorTargets);
    if (request.symbol === 'closeSync') {
      try {
        return authorizeTarget(
          {
            name: input.entry.name,
            effects: input.entry.effects,
            authority_contract: input.entry.authority_contract,
          },
          target,
          apply,
        );
      } finally {
        const descriptor = request.arguments[0];
        if (typeof descriptor === 'number') descriptorTargets.delete(descriptor);
      }
    }
    const result = authorizeTarget(
      {
        name: input.entry.name,
        effects: input.entry.effects,
        authority_contract: input.entry.authority_contract,
      },
      target,
      apply,
    );
    if (request.symbol === 'openSync' && typeof result === 'number') {
      descriptorTargets.set(result, target);
    }
    return result;
  };

  const commitCapturedExact = (
    action: {
      readonly name: string;
      readonly effects: 'harness-write' | 'local-write' | 'remote-write';
      readonly authority_contract:
        typeof INTERNAL_INIT_RECORD_CONTRACT | RegistryEntry['authority_contract'];
    },
    captured: readonly CapturedFilesystemEffect[],
  ): void => {
    if (captured.length === 0) return;
    const targetsById = new Map<string, JsonRecord>();
    for (const effect of captured) {
      const prior = targetsById.get(String(effect.target.id));
      if (prior && canonicalSha256(prior) !== canonicalSha256(effect.target)) {
        throw new Error('AUTHORITY_EXACT_PLAN_TARGET_CONFLICT');
      }
      targetsById.set(String(effect.target.id), effect.target);
    }
    const targets = [...targetsById.values()];
    const consent =
      action.name === input.entry.name
        ? actionConsent
        : (action.authority_contract.consent as JsonRecord);
    const declaration = expectSuccess<JsonRecord>(
      resolveAuthorityDeclaration(
        {
          action_id: action.name,
          invocation_id: invocationId,
          dry_run: false,
          declaration: input.declaration,
          consent,
        },
        {
          actionContracts: contracts,
          receiptStore: issuer,
          repository_id: sources.repository_id,
          policy_binding: (policy as JsonRecord).provenance,
          constitution_binding: sources.constitution_binding,
          package_binding: sources.package_binding,
          now: new Date().toISOString(),
          readSession: (sessionId: string) => {
            const path = resolve(
              repositoryRoot,
              '.devai/state/authority-sessions',
              `${sessionId}.json`,
            );
            return {
              ok: true,
              value: existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined,
            };
          },
          validateSessionSchema: (document: unknown) =>
            validators.authoritySession(document)
              ? { ok: true, value: document }
              : {
                  ok: false,
                  category: 'refused',
                  code: 'AUTHORITY_SESSION_SCHEMA_INVALID',
                  reasons: ['AUTHORITY_SESSION_SCHEMA_INVALID'],
                },
          canonicalSha256,
        },
      ),
    );
    const contextReceipt =
      declaration.kind === 'machine-initiation'
        ? expectSuccess<JsonRecord>(
            deriveMachineAuthorityContext(
              {
                action_id: action.name,
                invocation_id: invocationId,
                consent,
                declaration_receipt: declaration.declaration_receipt,
              },
              {
                receiptStore: issuer,
                actionContracts: contracts,
                canonicalSha256,
                trusted_adapter_id: 'devai-cli-authority',
                verifiedOrigin:
                  'authority_session' in input.declaration
                    ? {
                        kind: 'interactive-session',
                        session_id: input.declaration.authority_session,
                      }
                    : { kind: 'direct-cli', invocation_id: invocationId },
              },
            ),
          ).context_receipt
        : declaration.context_receipt;
    const planner = action.authority_contract.planner;
    if (planner.kind !== 'exact-plan') throw new Error('AUTHORITY_EXACT_PLAN_REQUIRED');
    const subject = {
      plan: {
        plan_id: `${planner.planner_id}-${invocationId}`,
        envelope: makeEnvelope({
          invocationId,
          actionId: action.name,
          effect: action.effects,
          repositoryId: sources.repository_id,
          consent,
          policy: (policy as JsonRecord).provenance as JsonRecord,
          now,
        }),
        strategy: 'exact-plan',
        targets,
        atomicity: 'whole-plan',
      },
    };
    const resolutions = targets.map((target) =>
      resolveAuthorityPolicy(
        policy,
        {
          action_id: action.name,
          context_receipt: contextReceipt,
          consent,
          resource: target,
          operation: targetOperation(target),
        },
        { receiptStore: issuer },
      ),
    );
    const denied = resolutions.find(
      (resolution) => !isRecord(resolution) || resolution.outcome !== 'allow',
    );
    if (denied) {
      throw new Error(
        isRecord(denied)
          ? String(denied.code ?? 'AUTHORITY_POLICY_DENIED')
          : 'AUTHORITY_POLICY_DENIED',
      );
    }
    const issued = (issuer.issueAllow as (value: unknown) => unknown)({
      resolutions,
      subject,
      context_receipt: contextReceipt,
      invocation_id: invocationId,
      boundary_adapter_id: 'fs-authority-boundary',
    }) as JsonRecord;
    if (issued.issued !== true) {
      throw new Error(String(issued.code ?? 'AUTHORITY_DECISION_NOT_ISSUED'));
    }
    const planHandle = expectSuccess<JsonRecord>(
      (plannerRegistry.registerPlan as (value: unknown) => unknown)({
        subject,
        invocation_id: invocationId,
      }),
    );
    const prepared = expectSuccess<JsonRecord>(
      (runtime.prepareUnit as (value: unknown) => unknown)({
        targets,
        subject,
        decision_receipt: issued.receipt,
        plan_handle: planHandle,
        adapter_id: 'fs-authority-boundary',
      }),
    );
    exactUnitApply = () =>
      applyAuthorityHostEffectsAtomically(
        captured.map(({ request, apply }) => ({ request, apply })),
      );
    try {
      expectSuccess((runtime.applyUnit as (value: unknown) => unknown)({ prepared }));
    } finally {
      exactUnitApply = undefined;
    }
  };

  const declaredSessionId =
    'authority_session' in input.declaration ? input.declaration.authority_session : undefined;
  const sessionOperation =
    input.entry.name === 'work session start'
      ? () => {
          const ttl = Number(flagValue(input.argv, '--ttl-minutes') ?? '60');
          if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 1440) {
            throw new Error('AUTHORITY_SESSION_TTL_INVALID');
          }
          const sessionId = `AUTH-SESSION-${randomUUID().replaceAll('-', '')}`;
          const createdAt = new Date().toISOString();
          const unsigned = {
            schemaVersion: '1.0.0',
            session_id: sessionId,
            repository_id: sources.repository_id,
            role: input.role,
            declaration_source: 'cli-flag',
            status: 'active',
            created_at: createdAt,
            expires_at: new Date(Date.parse(createdAt) + ttl * 60_000).toISOString(),
            created_by_invocation_id: invocationId,
            policy_binding: {
              policy_id: ((policy as JsonRecord).provenance as JsonRecord).policy_id,
              policy_version: ((policy as JsonRecord).provenance as JsonRecord).policy_version,
              resolved_digest_sha256: ((policy as JsonRecord).provenance as JsonRecord)
                .resolved_digest_sha256,
            },
            constitution_binding: sources.constitution_binding,
            package_binding: sources.package_binding,
          };
          const record = { ...unsigned, session_digest_sha256: canonicalSha256(unsigned) };
          if (!validators.authoritySession(record)) {
            throw new Error('AUTHORITY_SESSION_SCHEMA_INVALID');
          }
          const directory = resolve(repositoryRoot, '.devai/state/authority-sessions');
          mkdirSync(directory, { recursive: true });
          writeFileSync(
            resolve(directory, `${sessionId}.json`),
            `${JSON.stringify(record, null, 2)}\n`,
          );
          return record;
        }
      : input.entry.name === 'work session end' && declaredSessionId !== undefined
        ? () => {
            const sessionId = declaredSessionId;
            const path = resolve(
              repositoryRoot,
              '.devai/state/authority-sessions',
              `${sessionId}.json`,
            );
            if (!existsSync(path)) throw new Error('AUTHORITY_SESSION_NOT_FOUND');
            const existing = JSON.parse(readFileSync(path, 'utf8')) as JsonRecord;
            const { session_digest_sha256: _digest, ...current } = existing;
            const revokedAt = new Date().toISOString();
            const unsigned = {
              ...current,
              status: 'revoked',
              revocation: {
                revoked_at: revokedAt,
                revoked_by_invocation_id: invocationId,
                reason: 'Explicit session end.',
              },
            };
            const record = { ...unsigned, session_digest_sha256: canonicalSha256(unsigned) };
            if (!validators.authoritySession(record)) {
              throw new Error('AUTHORITY_SESSION_SCHEMA_INVALID');
            }
            writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
            return record;
          }
        : undefined;
  const policyMaterialization =
    input.entry.name === 'init bind'
      ? () => {
          // Binding inputs may themselves have been atomically updated by the
          // current init-bind invocation (for example adopter policy or a host
          // adapter declaration). Re-read every trusted source at commit time
          // so the materialized policy cannot lag the bytes just bound.
          const currentSources = buildTrustedAuthoritySources(
            input.entries,
            repositoryRoot,
            input.package_version,
          );
          const policyPath = resolve(repositoryRoot, POLICY_PATH);
          // The existing policy is never an authority for its own replacement.
          // An explicit Architect invocation authorizes the binding machine to
          // replace stale, divergent, or malformed bytes with the exact policy
          // derived from current trusted sources. Requiring the old digest to
          // match made legitimate package/Constitution/action changes
          // impossible to recover through the supported verb.
          const targetOperation = existsSync(policyPath) ? 'update' : 'create';
          const declarationDependencies = {
            actionContracts: contracts,
            repository_id: currentSources.repository_id,
            policy_binding: currentSources.provenance,
            constitution_binding: currentSources.constitution_binding,
            package_binding: currentSources.package_binding,
            now: new Date().toISOString(),
            readSession: (sessionId: string) => {
              const path = resolve(
                repositoryRoot,
                '.devai/state/authority-sessions',
                `${sessionId}.json`,
              );
              return {
                ok: true,
                value: existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined,
              };
            },
            validateSessionSchema: (document: unknown) =>
              validators.authoritySession(document)
                ? { ok: true, value: document }
                : {
                    ok: false,
                    category: 'refused',
                    code: 'AUTHORITY_SESSION_SCHEMA_INVALID',
                    reasons: ['AUTHORITY_SESSION_SCHEMA_INVALID'],
                  },
            canonicalSha256,
          };
          const authorization = expectSuccess(
            authorizePolicyMaterialization(
              {
                action_id: 'init bind',
                invocation_id: invocationId,
                dry_run: false,
                declaration: input.declaration,
                consent: actionConsent,
                target_operation: targetOperation,
              },
              {
                receiptStore: issuer,
                declaration: declarationDependencies,
                derivation: {
                  actionContracts: contracts,
                  canonicalSha256,
                  trusted_adapter_id: 'devai-cli-authority',
                  verifiedOrigin:
                    declaredSessionId === undefined
                      ? { kind: 'direct-cli', invocation_id: invocationId }
                      : { kind: 'interactive-session', session_id: declaredSessionId },
                },
                immutableCore: currentSources.immutableCore,
                additiveExtensions: currentSources.additiveExtensions,
              },
            ),
          );
          const materialized = expectSuccess<JsonRecord>(
            materializeAuthorityPolicy(
              {
                authorization,
                repository_id: currentSources.repository_id,
                target_operation: targetOperation,
                enforcement: { mode: 'binding' },
                host_enforcement: (() => {
                  try {
                    const project = JSON.parse(
                      readFileSync(resolve(repositoryRoot, '.devai/config/project.json'), 'utf8'),
                    ) as JsonRecord;
                    const declaration = project['authority_enforcement'];
                    const adapterConfig = isRecord(declaration)
                      ? declaration['adapter_config']
                      : undefined;
                    const adapterId =
                      adapterConfig === '.devai/config/github-actions-host-adapter.json'
                        ? 'github-actions-main-observation'
                        : 'post-merge-host-adapter';
                    return isRecord(declaration) && declaration['mode'] === 'host-integrated'
                      ? {
                          mode: 'host-integrated' as const,
                          adapter: {
                            adapter_id: adapterId,
                            adapter_version: input.package_version,
                          },
                        }
                      : { mode: 'cli-only' as const };
                  } catch {
                    return { mode: 'cli-only' as const };
                  }
                })(),
              },
              {
                receiptStore: issuer,
                package_binding: currentSources.package_binding,
                constitution_binding: currentSources.constitution_binding,
                immutableCore: currentSources.immutableCore,
                additiveExtensions: currentSources.additiveExtensions,
                canonicalBytes,
                canonicalSha256,
                sha256Bytes,
                materialized_at: new Date().toISOString(),
                validatePolicySchema,
              },
            ),
          );
          const artifact = materialized.artifact as JsonRecord;
          if (!(artifact.bytes instanceof Uint8Array)) {
            throw new Error('AUTHORITY_POLICY_ARTIFACT_INVALID');
          }
          const unchangedBytes = unchangedAuthorityPolicy(policyPath, artifact.bytes);
          if (unchangedBytes !== undefined) {
            return {
              path: POLICY_PATH,
              operation: 'unchanged',
              digest_sha256: sha256Bytes(unchangedBytes),
            };
          }
          mkdirSync(dirname(policyPath), { recursive: true });
          writeFileSync(policyPath, Buffer.from(artifact.bytes));
          return {
            path: POLICY_PATH,
            operation: targetOperation,
            digest_sha256: artifact.digest_sha256,
          };
        }
      : undefined;

  return {
    scope: Object.freeze({
      action_id: input.entry.name,
      invocation_id: invocationId,
      effect: input.entry.effects,
      receipt_store: issuer,
      apply_effect: applyEffect,
      ...(input.entry.name === 'release prepare'
        ? { read_prepare_capacity: readReleaseCapacity }
        : {}),
      ...(input.entry.name === 'release export'
        ? { read_export_capacity: readReleaseCapacity }
        : {}),
    }),
    ...(sessionOperation === undefined ? {} : { session_operation: sessionOperation }),
    ...(policyMaterialization === undefined
      ? {}
      : { policy_materialization: policyMaterialization }),
    ...(actionPlanner.kind === 'exact-plan'
      ? {
          commit_exact: () =>
            commitCapturedExact(
              {
                name: input.entry.name,
                effects: input.entry.effects as 'harness-write' | 'local-write' | 'remote-write',
                authority_contract: input.entry.authority_contract,
              },
              exactEffects,
            ),
        }
      : {}),
    record_init: (segment: string) => {
      const recordEffects: CapturedFilesystemEffect[] = [];
      const internalScope: AuthorityHostEffectScope = Object.freeze({
        action_id: INTERNAL_INIT_RECORD_CONTRACT.action_id,
        invocation_id: invocationId,
        effect: INTERNAL_INIT_RECORD_CONTRACT.effect,
        receipt_store: issuer,
        apply_effect: (request: AuthorityHostEffectRequest, apply: () => unknown) => {
          if (request.kind === 'process') {
            if (readOnlyProcess(request)) return apply();
            throw new Error('AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED');
          }
          if (
            request.symbol === 'mkdirSync' &&
            typeof request.arguments[0] === 'string' &&
            existsSync(request.arguments[0]) &&
            lstatSync(request.arguments[0]).isDirectory()
          ) {
            return undefined;
          }
          recordEffects.push({
            request,
            apply,
            target: fsTarget(request, repositoryRoot, sources.repository_id),
          });
          return undefined;
        },
      });
      return Object.freeze({
        scope: internalScope,
        execute: () => {
          const stateDir = resolve(repositoryRoot, '.devai/state');
          mkdirSync(stateDir, { recursive: true });
          const chainPath = resolve(stateDir, 'evidence-chain.json');
          const countersPath = resolve(stateDir, 'counters.json');
          if (!existsSync(countersPath)) writeFileSync(countersPath, '{}\n');
          const chain: EvidenceChain = existsSync(chainPath)
            ? (JSON.parse(readFileSync(chainPath, 'utf8')) as EvidenceChain)
            : { head: null, records: [] };
          const timestamp = new Date().toISOString();
          const git = gatherGitContext(repositoryRoot);
          const action = `init.apply-${segment}`;
          const id = deriveEvidenceId({
            timestamp,
            actor: 'devai-cli',
            actor_role: 'harness',
            action,
            status: 'completed',
            git_head_sha: git.head_sha,
            artifact_sha256s: [],
            previous_run_hash: chain.head,
          });
          const manifest_hash = computeManifestHash({
            id,
            timestamp,
            actor: 'devai-cli',
            actor_role: 'harness',
            action,
            status: 'completed',
            git_head_sha: git.head_sha,
            artifact_sha256s: [],
            previous_run_hash: chain.head,
          });
          const record: EvidenceRecord = {
            schemaVersion: '1.0.0',
            id,
            timestamp,
            actor: 'devai-cli',
            actor_role: 'harness',
            action,
            status: 'completed',
            context: { repo_root: repositoryRoot, git },
            artifacts: [],
            notes: [`initiated_by=${input.role}`],
            previous_run_hash: chain.head,
            manifest_hash,
          };
          if (!validators.evidence(record)) {
            throw new Error('AUTHORITY_INIT_RECORD_INVALID');
          }
          writeFileSync(
            chainPath,
            `${JSON.stringify({ head: manifest_hash, records: [...chain.records, record] }, null, 2)}\n`,
          );
          commitCapturedExact(
            {
              name: INTERNAL_INIT_RECORD_CONTRACT.action_id,
              effects: INTERNAL_INIT_RECORD_CONTRACT.effect,
              authority_contract: INTERNAL_INIT_RECORD_CONTRACT,
            },
            recordEffects,
          );
        },
      });
    },
    dispose: () => {
      disposed = true;
      if (typeof runtime.dispose === 'function') runtime.dispose();
      else if (typeof issuer.dispose === 'function') issuer.dispose();
    },
  };
}

export {
  actionContractRegistry,
  authorityPolicySemantics,
  boundedSelectors,
  canonicalRelativePath,
  existingRealpath,
  expectSuccess,
  flagValue,
  gitMetadataLayout,
  gitMetadataLogicalPath,
  isRecord,
  makeEnvelope,
  physicalCanonicalPath,
  processTarget,
  readOnlyProcess,
  unchangedAuthorityPolicy,
  validatePolicySchema,
  within,
};
