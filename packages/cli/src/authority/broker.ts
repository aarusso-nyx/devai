import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
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
import { matchDeclaredCheckTaskProcess } from '../services/check-runner/authority-process.js';
import {
  buildTrustedAuthoritySources,
  canonicalBytes,
  canonicalSha256,
  sha256Bytes,
} from './policy.js';

type JsonRecord = Record<string, unknown>;
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
  gh: ['auth'],
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
    'status',
  ],
  which: ['mmdc'],
});

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function expectSuccess<T>(result: unknown): T {
  if (!isRecord(result) || result.ok !== true || !Object.hasOwn(result, 'value')) {
    const code = isRecord(result) && typeof result.code === 'string' ? result.code : 'UNKNOWN';
    throw new Error(code);
  }
  return result.value as T;
}

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

function isConstitutionBootstrap(input: BrokerInput): boolean {
  return (
    input.bootstrap_policy &&
    input.entry.name === 'init bind' &&
    input.argv.includes('--constitution') &&
    !input.argv.includes('--operational-law') &&
    !input.argv.includes('--subprocess-effects')
  );
}

function policyFor(input: BrokerInput, now: string) {
  const installedConstitution = isConstitutionBootstrap(input)
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

function existingRealpath(path: string): string {
  let cursor = path;
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return path;
    suffix.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...suffix);
}

function canonicalRelativePath(root: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('AUTHORITY_FS_TARGET_INVALID');
  }
  // Mirror node:fs path semantics before checking repository containment.
  // Relative host-effect arguments are resolved from the process cwd, not
  // from the governed repository root. Resolving them from `root` duplicated
  // a relative `--target` prefix (for example adopter/adopter/docs/...) and
  // produced a late UNCLASSIFIED_RESOURCE refusal after command dispatch.
  const absolute = resolve(value);
  const canonical = existingRealpath(absolute);
  const canonicalRoot = realpathSync(root);
  if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${sep}`)) {
    throw new Error('AUTHORITY_FS_SYMLINK_ESCAPE');
  }
  const result = relative(canonicalRoot, canonical).split(sep).join('/');
  if (result.length === 0 || result.startsWith('../') || isAbsolute(result)) {
    throw new Error('AUTHORITY_FS_TARGET_INVALID');
  }
  return result;
}

function pathOperation(symbol: string, targetPath: string): 'create' | 'update' | 'delete' {
  if (['rmSync', 'unlinkSync'].includes(symbol)) return 'delete';
  if (['mkdirSync', 'mkdtempSync', 'symlinkSync'].includes(symbol)) return 'create';
  return existsSync(targetPath) ? 'update' : 'create';
}

function pathArgument(request: AuthorityHostEffectRequest): unknown {
  if (['copyFileSync', 'cpSync', 'symlinkSync'].includes(request.symbol)) {
    return request.arguments[1];
  }
  return request.arguments[0];
}

function fsTarget(
  request: AuthorityHostEffectRequest,
  root: string,
  repositoryId: string,
  descriptorTargets: ReadonlyMap<number, JsonRecord> = new Map(),
): JsonRecord {
  if (['writeSync', 'fsyncSync', 'closeSync'].includes(request.symbol)) {
    const descriptor = request.arguments[0];
    const bound = typeof descriptor === 'number' ? descriptorTargets.get(descriptor) : undefined;
    if (!bound) throw new Error('AUTHORITY_FS_DESCRIPTOR_UNKNOWN');
    return { ...bound, operation: 'update' };
  }
  if (request.symbol === 'renameSync') {
    const source = canonicalRelativePath(root, request.arguments[0]);
    const destination = canonicalRelativePath(root, request.arguments[1]);
    return {
      kind: 'fs',
      id: `fs:${source}->${destination}`,
      repository_id: repositoryId,
      canonical_relative_path: destination,
      operation: 'rename',
      rename_from_canonical_relative_path: source,
    };
  }
  const rawPath = pathArgument(request);
  if (typeof rawPath !== 'string') throw new Error('AUTHORITY_FS_TARGET_INVALID');
  const canonicalPath = canonicalRelativePath(root, rawPath);
  return {
    kind: 'fs',
    id: `fs:${canonicalPath}`,
    repository_id: repositoryId,
    canonical_relative_path: canonicalPath,
    operation: pathOperation(request.symbol, resolve(root, rawPath)),
  };
}

function readOnlyProcess(request: AuthorityHostEffectRequest, parentAction?: string): boolean {
  const executable = request.arguments[0];
  const args = request.arguments[1];
  if (typeof executable !== 'string' || !Array.isArray(args)) return false;
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
    basename(executable) === 'pnpm' &&
    args.length === 2 &&
    args[0] === '-r' &&
    args[1] === 'build'
  ) {
    return true;
  }
  if (parentAction === 'sense run' && basename(executable) === 'pnpm') {
    const governedConfigs = [
      'tests/config/t1.unit.config.ts',
      'tests/config/t3.integration.config.ts',
      'tests/config/t4.regression.config.ts',
      'tests/config/t5.e2e.config.ts',
    ];
    if (args.length === 2 && args[0] === 'vitest' && args[1] === 'run') {
      return true;
    }
    if (
      args.length === 4 &&
      args[0] === 'vitest' &&
      args[1] === 'run' &&
      args[2] === '--config' &&
      governedConfigs.includes(String(args[3]))
    ) {
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

function safeLogical(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replaceAll(/[^A-Za-z0-9._-]/gu, '-').replaceAll(/-+/gu, '-');
  return normalized.replaceAll(/^-|-$/gu, '') || fallback;
}

function processTarget(
  request: AuthorityHostEffectRequest,
  actionName: string,
  root: string,
  repositoryId: string,
  invocationArgv: readonly string[],
): JsonRecord | undefined {
  const executableValue = request.arguments[0];
  const argumentValue = request.arguments[1];
  if (typeof executableValue !== 'string' || !Array.isArray(argumentValue)) return undefined;
  const executable = basename(executableValue);
  const args = argumentValue.map(String);
  const verb = args[0];

  if (actionName === 'check') {
    const task = matchDeclaredCheckTaskProcess(root, invocationArgv, request);
    if (task !== undefined) {
      return {
        kind: 'fs',
        id: `fs:.devai/state/check-cache/v1:${safeLogical(task.nodeId, 'task')}`,
        repository_id: repositoryId,
        canonical_relative_path: '.devai/state/check-cache/v1',
        operation: 'update',
      };
    }
  }

  if (
    executable === 'psql' &&
    ['check', 'sense migrate', 'task finish', 'task start'].includes(actionName)
  ) {
    const sqlIndex = args.indexOf('-c');
    const sql = sqlIndex >= 0 ? (args[sqlIndex + 1] ?? '') : '';
    const keyword = /^\s*([A-Za-z]+)/u.exec(sql)?.[1]?.toUpperCase();
    const operation = ['CREATE', 'DROP', 'ALTER', 'TRUNCATE'].includes(keyword ?? '')
      ? 'ddl'
      : ['INSERT'].includes(keyword ?? '')
        ? 'insert'
        : ['UPDATE'].includes(keyword ?? '')
          ? 'update'
          : ['DELETE'].includes(keyword ?? '')
            ? 'delete'
            : 'execute';
    let databaseId = 'postgres';
    try {
      databaseId = safeLogical(
        new URL(args[0] ?? '').pathname.split('/').filter(Boolean).at(-1),
        'postgres',
      );
    } catch {
      databaseId = 'postgres';
    }
    return {
      kind: 'db',
      id: `db:devai-control:${databaseId}:${safeLogical(actionName, 'operation')}`,
      connection_id: 'devai-control',
      database_id: databaseId,
      object_id: safeLogical(actionName, 'operation'),
      operation,
    };
  }

  if (
    executable === 'docker' &&
    ['sense migrate', 'task finish', 'task start'].includes(actionName) &&
    ['run', 'start', 'stop'].includes(verb ?? '')
  ) {
    const nameIndex = args.indexOf('--name');
    const container =
      verb === 'run'
        ? safeLogical(nameIndex >= 0 ? args[nameIndex + 1] : undefined, 'devai-shared-pg')
        : safeLogical(args[1], 'devai-shared-pg');
    return {
      kind: 'db',
      id: `db:devai-control:cluster:${container}`,
      connection_id: 'devai-control',
      database_id: 'cluster',
      object_id: container,
      operation: 'execute',
    };
  }

  if (
    actionName === 'check' &&
    ((executable === 'docker' && verb === 'run') ||
      (executable === 'sandbox-exec' && verb === '-p'))
  ) {
    return {
      kind: 'fs',
      id: `fs:.devai/worktrees`,
      repository_id: repositoryId,
      canonical_relative_path: '.devai/worktrees',
      operation: 'update',
    };
  }

  if (executable === 'git') {
    if (verb === 'fetch') {
      const remote = safeLogical(args.at(-2), 'origin');
      const branch = safeLogical(args.at(-1), 'remote');
      return {
        kind: 'git-ref',
        id: `git-ref:${repositoryId}:refs/remotes/${remote}/${branch}`,
        repository_id: repositoryId,
        ref: `refs/remotes/${remote}/${branch}`,
        remote_id: remote,
        operation: 'update',
        protected: false,
      };
    }
    if (verb === 'checkout' && args[1] === '--orphan') {
      const branch = safeLogical(args[2], 'orphan');
      return {
        kind: 'git-ref',
        id: `git-ref:${repositoryId}:refs/heads/${branch}`,
        repository_id: repositoryId,
        ref: `refs/heads/${branch}`,
        operation: 'create',
        protected: false,
      };
    }
    if (verb === 'branch' && args[1] === '-D') {
      const branch = safeLogical(args[2], 'temporary');
      return {
        kind: 'git-ref',
        id: `git-ref:${repositoryId}:refs/heads/${branch}`,
        repository_id: repositoryId,
        ref: `refs/heads/${branch}`,
        operation: 'delete',
        protected: false,
      };
    }
    if (verb === 'worktree') {
      const operation = args[1];
      const branchIndex = args.indexOf('-b');
      const branch = branchIndex >= 0 ? safeLogical(args[branchIndex + 1], 'worktree') : 'detached';
      return {
        kind: 'git-ref',
        id: `git-ref:${repositoryId}:refs/worktrees/${branch}`,
        repository_id: repositoryId,
        ref: `refs/worktrees/${branch}`,
        operation: operation === 'remove' ? 'delete' : 'create',
        protected: false,
      };
    }
    if (['add', 'rm'].includes(verb ?? '')) {
      return {
        kind: 'git-ref',
        id: `git-ref:${repositoryId}:refs/devai/index`,
        repository_id: repositoryId,
        ref: 'refs/devai/index',
        operation: 'update',
        protected: false,
      };
    }
    if (verb === 'commit') {
      return {
        kind: 'git-ref',
        id: `git-ref:${repositoryId}:refs/heads/HEAD`,
        repository_id: repositoryId,
        ref: 'refs/heads/HEAD',
        operation: 'update',
        protected: false,
      };
    }
    if (verb === 'mv' && args.length >= 3) {
      const source = canonicalRelativePath(root, args[1]);
      const destination = canonicalRelativePath(root, args[2]);
      return {
        kind: 'fs',
        id: `fs:${source}->${destination}`,
        repository_id: repositoryId,
        canonical_relative_path: destination,
        rename_from_canonical_relative_path: source,
        operation: 'rename',
      };
    }
  }

  if (executable === 'gh' && verb === 'pr' && args[1] === 'create') {
    return {
      kind: 'remote',
      id: 'remote:github:pull-requests',
      system_id: 'github',
      endpoint_id: 'pull-requests',
      operation_id: 'create',
      publication: true,
    };
  }

  if (
    actionName === 'evidence test record' &&
    executable === 'sh' &&
    args[0] === '-c' &&
    typeof args[1] === 'string'
  ) {
    return {
      kind: 'remote',
      id: 'remote:local-command:test-runner',
      system_id: 'local-command',
      endpoint_id: 'test-runner',
      operation_id: 'invoke',
      publication: false,
    };
  }

  if (['claude', 'codex'].includes(executable) && actionName === 'sense run') {
    return {
      kind: 'remote',
      id: `remote:local-llm:${executable}`,
      system_id: 'local-llm',
      endpoint_id: executable,
      operation_id: 'invoke',
      publication: false,
    };
  }

  if (executable === 'mmdc' || executableValue.endsWith('/mmdc')) {
    const outputIndex = args.indexOf('--output');
    if (outputIndex >= 0 && args[outputIndex + 1]) {
      const output = args[outputIndex + 1] as string;
      return {
        kind: 'fs',
        id: `fs:${canonicalRelativePath(root, output)}`,
        repository_id: repositoryId,
        canonical_relative_path: canonicalRelativePath(root, output),
        operation: existsSync(resolve(root, output)) ? 'update' : 'create',
      };
    }
  }
  return undefined;
}

function adapterId(target: JsonRecord): string {
  return `${String(target.kind)}-authority-boundary`;
}

function targetOperation(target: JsonRecord): string {
  return String(target.kind === 'remote' ? target.operation_id : target.operation);
}

function boundedSelectors(kind: string, repositoryId: string, actionName: string): JsonRecord[] {
  if (kind === 'fs') {
    return [
      {
        kind,
        repository_id: repositoryId,
        canonical_relative_path_glob: '**',
        operations: ['create', 'update', 'delete', 'rename'],
      },
    ];
  }
  if (kind === 'git-ref') {
    return [
      {
        kind,
        repository_id: repositoryId,
        ref_glob: 'refs/**',
        operations: ['create', 'update', 'delete', 'merge', 'push'],
      },
    ];
  }
  if (kind === 'db') {
    return [
      {
        kind,
        connection_id: 'devai-control',
        database_id_glob: '**',
        object_id_glob: '**',
        operations: ['insert', 'update', 'delete', 'ddl', 'execute'],
      },
    ];
  }
  if (actionName === 'sense run' && kind === 'remote') {
    return [
      {
        kind,
        system_id: 'local-llm',
        endpoint_ids: ['claude', 'codex'],
        operation_ids: ['invoke'],
        publication: false,
      },
    ];
  }
  if (actionName === 'evidence test record') {
    return [
      {
        kind: 'remote',
        system_id: 'local-command',
        endpoint_ids: ['test-runner'],
        operation_ids: ['invoke'],
        publication: false,
      },
    ];
  }
  return [
    {
      kind: 'remote',
      system_id: 'local-llm',
      endpoint_ids: ['claude', 'codex'],
      operation_ids: ['invoke'],
      publication: false,
    },
  ];
}

function makeEnvelope(input: {
  invocationId: string;
  actionId: string;
  effect: string;
  repositoryId: string;
  consent: JsonRecord;
  policy: JsonRecord;
  now: string;
}): JsonRecord {
  const draft = {
    envelope_id: `envelope-${input.invocationId}`,
    request: {
      request_id: `request-${input.invocationId}`,
      repository_id: input.repositoryId,
      action_id: input.actionId,
      dry_run: false,
      requested_at: input.now,
      invocation_id: input.invocationId,
      consent: input.consent,
    },
    action_effect: input.effect,
    enforcement_mode: 'binding',
    policy: input.policy,
    issued_by: {
      adapter_id: 'devai-cli-authority',
      adapter_version: '1.0.0',
    },
  };
  return {
    ...draft,
    issued_by: {
      ...draft.issued_by,
      envelope_digest_sha256: canonicalSha256(draft),
    },
  };
}

function snapshot(root: string, relativePath: string): unknown {
  const path = resolve(root, relativePath);
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  return {
    kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file',
    mode: stat.mode,
    size: stat.size,
    mtime_ms: stat.mtimeMs,
  };
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
  let effectApply: (() => unknown) | undefined;
  let exactUnitApply: (() => unknown) | undefined;
  let effectResult: unknown;
  const runtime = createAuthorityBoundaryRuntime({
    receiptStore: issuer,
    invocation_id: invocationId,
    canonicalSha256,
    repository_root: repositoryRoot,
    fs: {
      realpath: (path: string) => existingRealpath(resolve(repositoryRoot, path)),
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
    if (request.kind === 'process') {
      if (readOnlyProcess(request, input.entry.name)) return apply();
      if (input.entry.effects === 'read')
        throw new Error('AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED');
      const target = processTarget(
        request,
        input.entry.name,
        repositoryRoot,
        sources.repository_id,
        input.argv,
      );
      if (!target) throw new Error('AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED');
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
            repository_id: sources.repository_id,
            policy_binding: sources.provenance,
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
                immutableCore: sources.immutableCore,
                additiveExtensions: sources.additiveExtensions,
              },
            ),
          );
          const materialized = expectSuccess<JsonRecord>(
            materializeAuthorityPolicy(
              {
                authorization,
                repository_id: sources.repository_id,
                target_operation: targetOperation,
                enforcement: { mode: 'binding' },
                host_enforcement: { mode: 'cli-only' },
              },
              {
                receiptStore: issuer,
                package_binding: sources.package_binding,
                constitution_binding: sources.constitution_binding,
                immutableCore: sources.immutableCore,
                additiveExtensions: sources.additiveExtensions,
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
      if (typeof runtime.dispose === 'function') runtime.dispose();
      else if (typeof issuer.dispose === 'function') issuer.dispose();
    },
  };
}
