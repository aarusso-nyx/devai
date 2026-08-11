import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chmodSync, mkdirSync, writeFileSync } from '@devai-nyx/authority';
import { canonicalBytes, sha256Hex } from './canonical.js';
import type {
  CandidateReceipt,
  PlannedTask,
  TaskExecutionResult,
  TaskOutcome,
  TaskResult,
} from './types.js';

const MAX_DIAGNOSTIC_STREAM_BYTES = 8 * 1024;

interface NodeIndex {
  readonly schemaVersion: '1.0.0';
  readonly nodeId: string;
  readonly taskKey: string;
  readonly outcome: TaskOutcome;
  readonly updatedAt: string;
  readonly resultDigest?: string;
}

export interface CacheInspection {
  readonly cacheState: 'reusable' | 'execute' | 'stale';
  readonly reason: string;
  readonly cachedResultDigest?: string;
  readonly result?: TaskResult;
}

function safeNodeId(nodeId: string): string {
  return Buffer.from(nodeId, 'utf8').toString('base64url');
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function isStringMap(value: unknown): value is Readonly<Record<string, string>> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every(isDigest)
  );
}

function parseTaskResult(value: unknown): TaskResult | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = value as Partial<TaskResult>;
  if (
    result.schemaVersion !== '1.0.0' ||
    typeof result.nodeId !== 'string' ||
    !isDigest(result.taskKey) ||
    result.status !== 'PASS' ||
    !isDigest(result.inputDigest) ||
    !isStringMap(result.dependencyResultDigests) ||
    !isStringMap(result.outputDigests) ||
    typeof result.startedAt !== 'string' ||
    typeof result.finishedAt !== 'string'
  ) {
    return undefined;
  }
  return result as TaskResult;
}

function outputFilesMatch(
  repoRoot: string,
  task: Pick<PlannedTask, 'outputContract'>,
  result: TaskResult,
): boolean {
  const paths = task.outputContract.paths;
  if (paths === undefined) return true;
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string')) return false;
  for (const path of paths as string[]) {
    const expected = result.outputDigests[path];
    if (expected === undefined) return false;
    try {
      if (sha256Hex(readFileSync(join(repoRoot, path))) !== expected) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function boundedTail(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  return bytes.subarray(Math.max(0, bytes.length - MAX_DIAGNOSTIC_STREAM_BYTES)).toString('utf8');
}

export class CheckCache {
  readonly #root: string;
  readonly #repoRoot: string;

  constructor(repoRoot: string, root: string) {
    this.#repoRoot = repoRoot;
    this.#root = root;
  }

  get root(): string {
    return this.#root;
  }

  inspect(
    task: PlannedTask,
    dependencyResultDigests: Readonly<Record<string, string>>,
  ): CacheInspection {
    const indexPath = join(this.#root, 'nodes', `${safeNodeId(task.nodeId)}.json`);
    if (!existsSync(indexPath)) return { cacheState: 'execute', reason: 'cache-miss' };
    let index: NodeIndex;
    try {
      index = readJson(indexPath) as NodeIndex;
    } catch {
      return { cacheState: 'stale', reason: 'cache-index-malformed' };
    }
    if (index.nodeId !== task.nodeId || index.schemaVersion !== '1.0.0') {
      return { cacheState: 'stale', reason: 'cache-index-malformed' };
    }
    if (index.taskKey !== task.taskKey) {
      return { cacheState: 'stale', reason: 'task-key-changed' };
    }
    if (index.outcome !== 'PASS' || index.resultDigest === undefined) {
      return { cacheState: 'execute', reason: `previous-${index.outcome.toLowerCase()}` };
    }
    if (!isDigest(index.resultDigest)) {
      return { cacheState: 'stale', reason: 'cache-index-malformed' };
    }
    const resultPath = join(this.#root, 'results', `${index.resultDigest}.json`);
    let value: unknown;
    try {
      value = readJson(resultPath);
    } catch {
      return { cacheState: 'stale', reason: 'cached-result-missing' };
    }
    const result = parseTaskResult(value);
    if (
      result === undefined ||
      sha256Hex(result) !== index.resultDigest ||
      result.nodeId !== task.nodeId ||
      result.taskKey !== task.taskKey
    ) {
      return { cacheState: 'stale', reason: 'cached-result-invalid' };
    }
    if (
      JSON.stringify(result.dependencyResultDigests) !== JSON.stringify(dependencyResultDigests)
    ) {
      return { cacheState: 'stale', reason: 'dependency-result-changed' };
    }
    if (!outputFilesMatch(this.#repoRoot, task, result)) {
      return { cacheState: 'stale', reason: 'output-digest-changed' };
    }
    return {
      cacheState: 'reusable',
      reason: 'fresh-pass',
      cachedResultDigest: index.resultDigest,
      result,
    };
  }

  writeResult(result: TaskResult): string {
    const digest = sha256Hex(result);
    const path = join(this.#root, 'results', `${digest}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, canonicalBytes(result));
    return digest;
  }

  writeAttempt(
    nodeId: string,
    taskKey: string,
    outcome: TaskOutcome,
    updatedAt: string,
    resultDigest?: string,
  ): void {
    const index: NodeIndex = {
      schemaVersion: '1.0.0',
      nodeId,
      taskKey,
      outcome,
      updatedAt,
      ...(resultDigest !== undefined && { resultDigest }),
    };
    const path = join(this.#root, 'nodes', `${safeNodeId(nodeId)}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, canonicalBytes(index));
  }

  writeFailureDiagnostic(
    task: Pick<PlannedTask, 'nodeId' | 'taskKey'>,
    outcome: Exclude<TaskOutcome, 'PASS'>,
    finishedAt: string,
    reason: string,
    execution: TaskExecutionResult,
  ): string {
    const diagnostic = {
      schemaVersion: '1.0.0',
      nodeId: task.nodeId,
      taskKey: task.taskKey,
      outcome,
      finishedAt,
      reason,
      exitCode: execution.status,
      signal: execution.signal,
      errorCode: execution.errorCode ?? null,
      stdoutTail: boundedTail(execution.stdout),
      stderrTail: boundedTail(execution.stderr),
    };
    const path = join(
      this.#root,
      'diagnostics',
      `${safeNodeId(task.nodeId)}-${sha256Hex(diagnostic)}.json`,
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, canonicalBytes(diagnostic), { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  }

  writeReceipt(receipt: CandidateReceipt): Readonly<{ digest: string; path: string }> {
    const digest = sha256Hex(receipt);
    const path = join(this.#root, 'receipts', `${digest}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, canonicalBytes(receipt));
    return { digest, path };
  }
}
