import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { mkdirSync, writeFileSync } from '@devai-nyx/authority';
import { canonicalJson } from '@devai-nyx/utils';
import type { OperationHostRequest, OperationResult } from './types.js';

interface CandidateFile {
  readonly path: string;
  readonly content: string;
  readonly source_documents: readonly string[];
}

function repositoryPath(root: string, path: string): string {
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, path);
  if (target === absoluteRoot || !target.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`OPERATION_WRITE_PATH_ESCAPE:${path}`);
  }
  return target;
}

function materialize(
  request: OperationHostRequest,
  files: readonly { readonly path: string; readonly content: string }[],
  evidence: Readonly<Record<string, unknown>>,
): OperationResult {
  const resolved = files.map((file) => ({
    ...file,
    absolute: repositoryPath(request.repo_root, file.path),
  }));
  const drifted = resolved
    .filter(
      (file) => existsSync(file.absolute) && readFileSync(file.absolute, 'utf8') !== file.content,
    )
    .map((file) => file.path);
  if (drifted.length > 0) {
    return { operation: request.operation, status: 'review', evidence: { ...evidence, drifted } };
  }
  const written: string[] = [];
  const unchanged: string[] = [];
  for (const file of resolved) {
    if (existsSync(file.absolute)) {
      unchanged.push(file.path);
      continue;
    }
    mkdirSync(dirname(file.absolute), { recursive: true });
    writeFileSync(file.absolute, file.content, 'utf8');
    written.push(file.path);
  }
  return {
    operation: request.operation,
    status: written.length === 0 ? 'skipped' : 'pass',
    evidence: { ...evidence, written, unchanged },
  };
}

function candidateFiles(request: OperationHostRequest): readonly CandidateFile[] {
  const value = request.inputs?.['files'];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('OPERATION_INPUT_REQUIRED:files');
  }
  const files = value.map((candidate) => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('OPERATION_INPUT_INVALID:files');
    }
    const record = candidate as Record<string, unknown>;
    const sources = record['source_documents'];
    if (
      typeof record['path'] !== 'string' ||
      typeof record['content'] !== 'string' ||
      !Array.isArray(sources) ||
      sources.length === 0 ||
      sources.some((source) => typeof source !== 'string' || !source.startsWith('docs/'))
    ) {
      throw new Error('OPERATION_INPUT_INVALID:files');
    }
    return {
      path: record['path'],
      content: record['content'],
      source_documents: sources as readonly string[],
    };
  });
  const requested = [...new Set(request.write_paths ?? [])].sort();
  const supplied = [...new Set(files.map((file) => file.path))].sort();
  if (files.length !== supplied.length) throw new Error('OPERATION_INPUT_DUPLICATE_PATH');
  if (
    requested.length !== supplied.length ||
    requested.some((path, index) => path !== supplied[index])
  ) {
    throw new Error('OPERATION_INPUT_WRITE_PATH_MISMATCH');
  }
  return files;
}

function previewRecord(request: OperationHostRequest): OperationResult {
  const phases = {
    'round.plan.preview': 'plan',
    'round.run.preview': 'run',
    'round.close.preview': 'close',
  } as const;
  const phase = phases[request.operation as keyof typeof phases];
  if (phase === undefined) throw new Error(`MATERIALIZE_OPERATION_UNKNOWN:${request.operation}`);
  const paths = request.write_paths ?? [];
  if (paths.length !== 1) throw new Error('OPERATION_PREVIEW_EXACT_PATH_REQUIRED');
  const match =
    /^\.devai\/state\/round-runs\/([A-Za-z0-9][A-Za-z0-9._-]*)\/(plan|run|close)\.json$/u.exec(
      paths[0] ?? '',
    );
  if (match === null || match[2] !== phase) throw new Error('OPERATION_PREVIEW_PATH_INVALID');
  const payloadKey = phase === 'plan' ? 'plan' : phase === 'run' ? 'child_results' : 'verification';
  const payload = request.inputs?.[payloadKey];
  if (
    (phase === 'run' && (!Array.isArray(payload) || payload.length === 0)) ||
    (phase !== 'run' && (payload === null || typeof payload !== 'object' || Array.isArray(payload)))
  ) {
    throw new Error(`OPERATION_INPUT_REQUIRED:${payloadKey}`);
  }
  if (phase === 'close' && (payload as Readonly<Record<string, unknown>>)['complete'] !== true) {
    throw new Error('OPERATION_PREVIEW_CLOSE_INCOMPLETE');
  }
  const record = {
    schemaVersion: '1.0.0',
    operation: request.operation,
    phase,
    round_run_id: match[1],
    [payloadKey]: payload,
  };
  return materialize(request, [{ path: paths[0] ?? '', content: `${canonicalJson(record)}\n` }], {
    phase,
  });
}

export function executeMaterializeOperation(request: OperationHostRequest): OperationResult {
  if (request.operation === 'scaffold.tests-from-docs') {
    const files = candidateFiles(request);
    return materialize(request, files, {
      source_documents: [...new Set(files.flatMap((file) => file.source_documents))].sort(),
    });
  }
  return previewRecord(request);
}
