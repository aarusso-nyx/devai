import { existsSync } from 'node:fs';
import { matchDeclaredSensorTaskProcess } from '../commands/sense/task-binding.js';
import { basename, resolve } from 'node:path';
import {
  type AuthorityHostEffectRequest,
  protectedReleaseBoundaryAdapterId,
} from '@devai-nyx/authority';
import {
  matchDeclaredCheckTaskProcess,
  matchDeclaredReleaseTaskProcess,
} from '../services/check-runner/authority-process.js';
import { matchDeclaredRoundTaskProcess } from '../services/round-run/authority-process.js';
import { matchExperimentalAgentProcess } from '../services/experimental-dispatch/authority-process.js';
import { canonicalSha256 } from './policy.js';
import { flagValue, type JsonRecord } from './broker-values.js';
import { canonicalRelativePath } from './broker-paths.js';

function safeLogical(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replaceAll(/[^A-Za-z0-9._-]/gu, '-').replaceAll(/-+/gu, '-');
  return normalized.replaceAll(/^-|-$/gu, '') || fallback;
}

export function processTarget(
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

  if (actionName === 'sense run') {
    const binding = matchDeclaredSensorTaskProcess(root, request);
    if (binding !== undefined) {
      return {
        kind: 'fs',
        id: `fs:.devai/state/check-cache/v1:sensor:${safeLogical(binding.task.nodeId, 'task')}`,
        repository_id: repositoryId,
        canonical_relative_path: '.devai/state/check-cache/v1',
        operation: 'update',
      };
    }
  }

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

  if (actionName === 'release preflight' || actionName === 'release certify') {
    const task = matchDeclaredReleaseTaskProcess(root, request);
    if (task !== undefined) {
      return {
        kind: 'fs',
        id: `fs:.devai/state/check-cache/v1:${safeLogical(task.nodeId, 'task')}:${String(
          task.taskPolicyDigest,
        ).slice(0, 16)}`,
        repository_id: repositoryId,
        canonical_relative_path: '.devai/state/check-cache/v1',
        operation: 'update',
      };
    }
  }

  if (actionName === 'round dispatch') {
    const task = matchExperimentalAgentProcess(root, invocationArgv, request);
    if (task !== undefined) {
      return {
        kind: 'remote',
        id: `remote:local-command:experimental-agent:${task.taskId}`,
        system_id: 'local-command',
        endpoint_id: 'experimental-agent',
        operation_id: 'invoke',
        publication: false,
      };
    }
  }

  if (actionName === 'round run') {
    const task = matchDeclaredRoundTaskProcess(root, invocationArgv, request);
    if (task !== undefined) {
      return {
        kind: 'remote',
        id: `remote:local-command:routine-executor:${task.taskId}`,
        system_id: 'local-command',
        endpoint_id: 'routine-executor',
        operation_id: 'invoke',
        publication: false,
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
    actionName === 'evidence record' &&
    request.symbol === 'spawnSync' &&
    executable === 'sh' &&
    flagValue(invocationArgv, '--kind') === 'test' &&
    args[0] === '-c' &&
    args.length === 2 &&
    typeof args[1] === 'string' &&
    args[1] === flagValue(invocationArgv, '--cmd')
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

export function adapterId(target: JsonRecord): string {
  const protectedAdapter = protectedReleaseBoundaryAdapterId(target);
  if (protectedAdapter !== undefined) return protectedAdapter;
  return `${String(target.kind)}-authority-boundary`;
}

export function targetOperation(target: JsonRecord): string {
  return String(target.kind === 'remote' ? target.operation_id : target.operation);
}

export function boundedSelectors(
  kind: string,
  repositoryId: string,
  actionName: string,
): JsonRecord[] {
  if (
    actionName === 'release export' &&
    (kind === 'artifact-sink' || kind === 'protected-export-signer')
  ) {
    const signer = kind === 'protected-export-signer';
    return [
      {
        kind: 'remote',
        system_id: signer ? 'protected-export-signer-v1' : 'trusted-export-artifact-sink-v1',
        endpoint_ids: ['host'],
        operation_ids: [signer ? 'sign' : 'write'],
        publication: false,
      },
    ];
  }
  if (actionName === 'release prepare' && kind === 'artifact-sink') {
    return [
      {
        kind: 'remote',
        system_id: 'trusted-artifact-sink-v3',
        endpoint_ids: ['host'],
        operation_ids: ['write'],
        publication: false,
      },
    ];
  }
  if (
    (actionName === 'release certify' || actionName === 'release preflight') &&
    kind === 'protected-certification-provider'
  ) {
    return [
      {
        kind: 'remote',
        system_id: 'devai-protected-certification-provider-v3',
        endpoint_ids: ['host'],
        operation_ids: ['execute'],
        publication: false,
      },
    ];
  }
  if (actionName === 'release certify' && kind === 'certification-evidence-sink') {
    return [
      {
        kind: 'remote',
        system_id: 'trusted-certification-evidence-sink-v1',
        endpoint_ids: ['host'],
        operation_ids: ['write'],
        publication: false,
      },
    ];
  }
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
  if (actionName === 'evidence record') {
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
  if (actionName === 'round dispatch' && kind === 'remote') {
    return [
      {
        kind: 'remote',
        system_id: 'local-command',
        endpoint_ids: ['experimental-agent'],
        operation_ids: ['invoke'],
        publication: false,
      },
    ];
  }
  if (actionName === 'round run' && kind === 'remote') {
    return [
      {
        kind: 'remote',
        system_id: 'local-command',
        endpoint_ids: ['routine-executor'],
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

export function makeEnvelope(input: {
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
