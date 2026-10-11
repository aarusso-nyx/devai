import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { canonicalJson } from '@devai-nyx/utils';
import type { NativeServiceRequest } from './native-service-plan.js';

export interface NativeTestResultContract {
  readonly schemaVersion: '1.0.0';
  readonly format: 'vitest-json' | 'node-tap' | 'playwright-json';
  readonly projectId: string;
  readonly serviceProfile?: NativeServiceRequest;
  readonly transport:
    { readonly kind: 'direct' } | { readonly kind: 'turbo'; readonly prefix: string };
  readonly executableFiles: readonly string[];
  readonly requiredTestIds: readonly string[];
  readonly selectionEvidence?: {
    readonly kind: 'devai-native-collection';
    readonly reporter: 'vitest-v1' | 'playwright-v1';
    readonly projectName: string;
  };
}

export interface NativeTestResultPopulation {
  readonly status: 'pass' | 'fail' | 'unknown';
  readonly testIds: readonly string[];
  readonly executedTestIds: readonly string[];
  readonly failedTestIds: readonly string[];
  readonly skippedTestIds: readonly string[];
  readonly executableFiles: readonly string[];
  readonly projectId: string;
  readonly nativePlanSha256: string;
  readonly findings: readonly string[];
}

type Row = Record<string, unknown>;
function record(value: unknown): Row {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('NATIVE_RESULT_OBJECT_REQUIRED');
  return value as Row;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('NATIVE_RESULT_ARRAY_REQUIRED');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error('NATIVE_RESULT_TEXT_REQUIRED');
  return value;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('NATIVE_RESULT_COUNTER_INVALID');
  return value;
}
function same(a: readonly string[], b: readonly string[]): boolean {
  return canonicalJson([...a].sort()) === canonicalJson([...b].sort());
}
export function nativeTestId(
  project: string,
  file: string,
  ancestors: readonly string[],
  title: string,
): string {
  return `test:v1:${encodeURIComponent(canonicalJson([project, file, ancestors, title]))}`;
}

/** Complete native final results from this execution; authored counts never establish standing. */
export function inspectNativeTestResults(
  contract: NativeTestResultContract,
  stdout: string,
  stderr: string,
  context: { readonly repoRoot: string; readonly collectionNonce?: string },
): NativeTestResultPopulation {
  const ids = new Set<string>();
  const executed = new Set<string>();
  const skipped = new Set<string>();
  const files = new Set<string>();
  const failedIds = new Set<string>();
  let failed = 0;
  let plan = '';
  const result = (
    status: NativeTestResultPopulation['status'],
    findings: readonly string[],
  ): NativeTestResultPopulation => ({
    status,
    testIds: [...ids].sort(),
    executedTestIds: [...executed].sort(),
    skippedTestIds: [...skipped].sort(),
    failedTestIds: [...failedIds].sort(),
    executableFiles: [...files].sort(),
    projectId: contract.projectId,
    nativePlanSha256: createHash('sha256').update(plan).digest('hex'),
    findings,
  });
  const portable = (value: unknown, base = context.repoRoot): string => {
    const path = text(value);
    const absolute = resolve(base, path);
    const rel = relative(resolve(context.repoRoot), absolute);
    if (
      rel === '' ||
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      isAbsolute(rel) ||
      rel !== rel.normalize('NFC') ||
      rel.includes('\\')
    )
      throw new Error('NATIVE_RESULT_SOURCE_OUTSIDE_CANDIDATE');
    return rel.split(sep).join('/');
  };
  const add = (
    file: string,
    ancestors: readonly string[],
    title: string,
    state: 'passed' | 'failed' | 'skipped',
  ): void => {
    const id = nativeTestId(contract.projectId, file, ancestors, title);
    if (ids.has(id)) throw new Error('NATIVE_RESULT_DUPLICATE_ID');
    ids.add(id);
    files.add(file);
    if (state === 'skipped') skipped.add(id);
    else {
      executed.add(id);
      if (state === 'failed') {
        failed += 1;
        failedIds.add(id);
      }
    }
  };
  try {
    if (
      contract.schemaVersion !== '1.0.0' ||
      contract.projectId.length === 0 ||
      contract.executableFiles.length === 0 ||
      contract.requiredTestIds.length === 0 ||
      new Set(contract.executableFiles).size !== contract.executableFiles.length ||
      new Set(contract.requiredTestIds).size !== contract.requiredTestIds.length
    )
      throw new Error('NATIVE_RESULT_DECLARATION_INVALID');
    for (const id of contract.requiredTestIds) {
      const decoded: unknown = JSON.parse(decodeURIComponent(id.slice('test:v1:'.length)));
      if (
        !id.startsWith('test:v1:') ||
        !Array.isArray(decoded) ||
        decoded.length !== 4 ||
        decoded[0] !== contract.projectId ||
        !Array.isArray(decoded[2]) ||
        !decoded[2].every((title: unknown) => typeof title === 'string') ||
        nativeTestId(
          text(decoded[0]),
          text(decoded[1]),
          decoded[2] as string[],
          text(decoded[3]),
        ) !== id
      )
        throw new Error('NATIVE_RESULT_NONCANONICAL_ID');
    }
    const cacheReplay = (line: string): boolean =>
      /\bcache hit\b|\breplaying (?:cached )?logs\b|\bFULL TURBO\b/iu.test(line);
    if (contract.transport.kind === 'turbo') {
      const prefix = contract.transport.prefix;
      if (prefix.length === 0) throw new Error('NATIVE_RESULT_TRANSPORT_PREFIX_REQUIRED');
      const selected = stdout
        .split('\n')
        .filter((line) => line.startsWith(prefix))
        .map((line) => line.slice(prefix.length));
      const start = selected.findIndex((line) => line.trimStart().startsWith('{'));
      if (start < 0) throw new Error('NATIVE_RESULT_PLAN_MISSING');
      const diagnostics = stderr
        .split('\n')
        .filter((line) => line.startsWith(prefix))
        .map((line) => line.slice(prefix.length));
      if ([...selected.slice(0, start), ...diagnostics].some(cacheReplay))
        throw new Error('NATIVE_RESULT_CACHE_REPLAY');
      plan = selected.slice(start).join('\n').trim();
    } else {
      const lines = stdout.split('\n');
      const start = lines.findIndex((line) => line.trimStart().startsWith('{'));
      if (
        [...lines.slice(0, start < 0 ? lines.length : start), ...stderr.split('\n')].some(
          cacheReplay,
        )
      )
        throw new Error('NATIVE_RESULT_CACHE_REPLAY');
      plan = stdout.trim();
    }
    if (contract.format === 'node-tap') throw new Error('NATIVE_TAP_SOURCE_PROVENANCE_UNAVAILABLE');
    const native = record(JSON.parse(plan));
    if (context.collectionNonce !== undefined) {
      const declaration = contract.selectionEvidence;
      const collection = record(native['devaiCollection']);
      if (
        declaration === undefined ||
        declaration.kind !== 'devai-native-collection' ||
        collection['schemaVersion'] !== '1.0.0' ||
        collection['reporter'] !== declaration.reporter ||
        collection['nonce'] !== context.collectionNonce ||
        list(collection['invalid']).length > 0
      )
        throw new Error('NATIVE_COLLECTION_CUSTODY_INVALID');
      const selected = list(collection['plannedFiles']).map((path) => portable(path));
      if (new Set(selected).size !== selected.length || !same(selected, contract.executableFiles))
        throw new Error('NATIVE_COLLECTION_SELECTED_FILES_DISAGREE');
      const collectedIds = list(collection['tests']).map((value) => {
        const test = record(value);
        if (test['project'] !== declaration.projectName)
          throw new Error('NATIVE_COLLECTION_PROJECT_DISAGREEMENT');
        const ancestors = list(test['ancestors']).map((title) =>
          typeof title === 'string' ? title : text(title),
        );
        return nativeTestId(
          contract.projectId,
          portable(test['file']),
          ancestors,
          text(test['title']),
        );
      });
      if (
        new Set(collectedIds).size !== collectedIds.length ||
        !same(collectedIds, contract.requiredTestIds)
      )
        throw new Error('NATIVE_COLLECTION_TEST_IDS_DISAGREE');
      const selection = list(collection['resolvedSelection']).map(record);
      if (!selection.some((project) => project['project'] === declaration.projectName))
        throw new Error('NATIVE_COLLECTION_RESOLVED_SELECTION_MISSING');
    }
    if (contract.format === 'vitest-json') {
      for (const suiteValue of list(native['testResults'])) {
        const suite = record(suiteValue);
        const file = portable(suite['name']);
        if (files.has(file)) throw new Error('NATIVE_RESULT_DUPLICATE_FILE');
        files.add(file);
        const assertions = list(suite['assertionResults']);
        if (assertions.length === 0 || !['passed', 'failed'].includes(String(suite['status'])))
          throw new Error('NATIVE_RESULT_FILE_PLAN_INCOMPLETE');
        const beforeFailed = failed;
        for (const assertionValue of assertions) {
          const assertion = record(assertionValue);
          const ancestors = list(assertion['ancestorTitles']).map((value) =>
            typeof value === 'string' ? value : text(value),
          );
          const state = text(assertion['status']);
          if (!['passed', 'failed', 'pending', 'todo', 'skipped', 'disabled'].includes(state))
            throw new Error('NATIVE_RESULT_TERMINAL_STATE_UNKNOWN');
          add(
            file,
            ancestors,
            text(assertion['title']),
            state === 'passed' ? 'passed' : state === 'failed' ? 'failed' : 'skipped',
          );
        }
        if (suite['status'] !== (failed > beforeFailed ? 'failed' : 'passed'))
          throw new Error('NATIVE_RESULT_FILE_STATUS_DISAGREEMENT');
      }
      const passed = count(native['numPassedTests']);
      const pending = count(native['numPendingTests']);
      const todo = count(native['numTodoTests']);
      if (
        count(native['numTotalTests']) !== ids.size ||
        count(native['numFailedTests']) !== failed ||
        passed !== executed.size - failed ||
        pending + todo !== skipped.size ||
        native['success'] !== (failed === 0 && count(native['numFailedTestSuites']) === 0)
      )
        throw new Error('NATIVE_RESULT_COUNTER_DISAGREEMENT');
      if (
        count(native['numTotalTestSuites']) !==
        count(native['numPassedTestSuites']) +
          count(native['numFailedTestSuites']) +
          count(native['numPendingTestSuites'])
      )
        throw new Error('NATIVE_RESULT_SUITE_COUNTER_DISAGREEMENT');
    } else {
      const config = record(native['config']);
      const reportRoot = text(config['rootDir']);
      if (!isAbsolute(reportRoot)) throw new Error('NATIVE_RESULT_REPORT_ROOT_INVALID');
      let expected = 0;
      let unexpected = 0;
      let flaky = 0;
      const visit = (suiteValue: unknown, ancestors: readonly string[], fileRoot = false): void => {
        const suite = record(suiteValue);
        const suiteTitle = typeof suite['title'] === 'string' ? suite['title'] : '';
        const next = ancestors.length === 0 ? [] : [...ancestors];
        if (suiteTitle.length > 0 && !fileRoot) next.push(suiteTitle);
        for (const specValue of list(suite['specs'] ?? [])) {
          const spec = record(specValue);
          const file = portable(spec['file'] ?? suite['file'], reportRoot);
          for (const testValue of list(spec['tests'])) {
            const test = record(testValue);
            if (
              test['projectName'] !==
              (contract.selectionEvidence?.projectName ?? contract.projectId)
            )
              throw new Error('NATIVE_RESULT_PROJECT_MISMATCH');
            const attempts = list(test['results']).map(record);
            const state = text(test['status']);
            if (!['expected', 'unexpected', 'flaky', 'skipped'].includes(state))
              throw new Error('NATIVE_RESULT_TERMINAL_STATE_UNKNOWN');
            if (state === 'skipped') {
              add(file, next, text(spec['title']), 'skipped');
              continue;
            }
            if (
              attempts.length === 0 ||
              attempts.some(
                (attempt, index) =>
                  count(attempt['retry']) !== index ||
                  !['passed', 'failed', 'timedOut', 'interrupted', 'skipped'].includes(
                    String(attempt['status']),
                  ),
              )
            )
              throw new Error('NATIVE_RESULT_ATTEMPT_PLAN_INCOMPLETE');
            const terminal = attempts.at(-1);
            const actualPass = terminal?.['status'] === 'passed';
            if (state === 'expected') expected += 1;
            if (state === 'unexpected') unexpected += 1;
            if (state === 'flaky') flaky += 1;
            add(
              file,
              next,
              text(spec['title']),
              actualPass && state === 'expected' ? 'passed' : 'failed',
            );
          }
        }
        for (const child of list(suite['suites'] ?? [])) visit(child, next);
      };
      for (const suite of list(native['suites'])) visit(suite, [], true);
      const stats = record(native['stats']);
      if (
        list(native['errors']).length !== 0 ||
        count(stats['expected']) !== expected ||
        count(stats['unexpected']) !== unexpected ||
        count(stats['flaky']) !== flaky ||
        count(stats['skipped']) !== skipped.size
      )
        throw new Error('NATIVE_RESULT_COUNTER_DISAGREEMENT');
    }
    if (!same([...files], contract.executableFiles) || !same([...ids], contract.requiredTestIds))
      throw new Error('NATIVE_RESULT_POPULATION_DISAGREEMENT');
    if (
      contract.format === 'vitest-json' &&
      (native['success'] !== true || count(native['numFailedTestSuites']) > 0) &&
      failed === 0
    )
      return result('unknown', ['NATIVE_RESULT_GLOBAL_SUITE_FAILURE']);
    if (skipped.size > 0) return result('unknown', ['NATIVE_RESULT_UNEXECUTED_OBLIGATIONS']);
    return result(failed > 0 ? 'fail' : 'pass', []);
  } catch (error) {
    return result('unknown', [error instanceof Error ? error.message : String(error)]);
  }
}
