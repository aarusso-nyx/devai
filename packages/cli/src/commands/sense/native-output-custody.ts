import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { canonicalize } from '../../services/check-runner/canonical.js';

type Row = Record<string, unknown>;
type Entry = { kind: 'directory' | 'file'; mode: number; sha256?: string; utf8Sha256?: string };

/** Same-execution intermediates are outputs, never an exemption for external inputs. */
export function nativeOutputCustody(
  root: string,
  nonce: string,
  rows: readonly Row[],
  stdout: string,
): ((row: Row) => boolean) & { finish(): void; hasTransformedSource(sha256: string): boolean } {
  const runtime = resolve(root, '.devai/state/native-config-traces', nonce, 'runtime');
  const physical = realpathSync(runtime);
  const main = rows.find((row) => row['kind'] === 'begin' && row['scope'] === 'main');
  if (
    main?.['runtimeRoot'] !== runtime ||
    main['runtimePhysicalRoot'] !== physical ||
    canonicalize(main['initialRuntimeEntries']) !== '[]'
  )
    throw new Error('NATIVE_OUTPUT_ROOT_NOT_FRESH');
  const report = JSON.parse(stdout) as {
    devaiCollection?: {
      reporter?: string;
      runtimeOutputRoots?: unknown;
      runtimeResultRoot?: unknown;
      resolvedSelection?: Row[];
    };
  };
  const vitest = report.devaiCollection?.reporter === 'vitest-v1';
  const results = resolve(runtime, 'playwright-results');
  if (
    !vitest &&
    (report.devaiCollection?.reporter !== 'playwright-v1' ||
      report.devaiCollection.runtimeResultRoot !== results ||
      !Array.isArray(report.devaiCollection.resolvedSelection) ||
      report.devaiCollection.resolvedSelection.length === 0 ||
      !report.devaiCollection.resolvedSelection.every(
        (project) => project['outputDir'] === results,
      ))
  )
    throw new Error('NATIVE_OUTPUT_ROOT_SELECTION_INVALID');
  const declared = report.devaiCollection?.runtimeOutputRoots;
  if (
    vitest &&
    (!Array.isArray(declared) ||
      declared.length === 0 ||
      !declared.every(
        (path) =>
          typeof path === 'string' &&
          dirname(path) === runtime &&
          /^[A-Za-z0-9_-]{21}$/u.test(path.slice(runtime.length + 1)),
      ))
  )
    throw new Error('NATIVE_OUTPUT_ROOT_SELECTION_INVALID');
  if (
    typeof main['runtimeRootMode'] !== 'number' ||
    (main['runtimeRootMode'] & 0o170000) !== 0o040000
  )
    throw new Error('NATIVE_OUTPUT_ROOT_MODE_INVALID');
  const entries = new Map<string, Entry>([
    [runtime, { kind: 'directory', mode: main['runtimeRootMode'] }],
  ]);
  const pending = new Map<
    string,
    { kind: string; scope: unknown; fingerprint: string; target?: unknown }
  >();
  const fingerprint = (path: string, recursive = false): string =>
    canonicalize(
      [...entries].filter(([key]) => key === path || (recursive && key.startsWith(`${path}/`))),
    );
  const start = (row: Row, path: string, kind: string): void => {
    if (pending.has(path)) throw new Error('NATIVE_OUTPUT_OPERATION_AMBIGUOUS');
    pending.set(path, {
      kind,
      scope: row['scope'],
      fingerprint: fingerprint(path, kind === 'remove'),
      ...(kind === 'rename' ? { target: row['target'] } : {}),
    });
  };
  const complete = (row: Row, path: string, kind: string): void => {
    const operation = pending.get(path);
    if (
      operation?.kind !== kind ||
      operation.scope !== row['scope'] ||
      operation.fingerprint !== fingerprint(path, kind === 'remove') ||
      (kind === 'rename' && operation.target !== row['target'])
    )
      throw new Error('NATIVE_OUTPUT_OPERATION_INCOMPLETE');
    pending.delete(path);
  };
  const known = (path: unknown): path is string =>
    typeof path === 'string' &&
    isAbsolute(path) &&
    resolve(path) === path &&
    (path === runtime || path.startsWith(`${runtime}/`));
  const permitted = (path: string): boolean => {
    const part = relative(runtime, path);
    if (part === '') return true;
    if (vitest) {
      const [project] = part.split('/');
      return (
        (declared as string[]).includes(resolve(runtime, project ?? '')) &&
        /^[A-Za-z0-9_-]{21}(?:\/ssr(?:\/(?:[0-9a-f]{40}|\.tmp-[0-9]+-[a-z0-9]+))?)?$/u.test(part)
      );
    }
    return (
      /^playwright(?:\/[0-9a-f]{2}(?:\/[0-9a-f]{10}_[0-9a-f]{7}_[A-Za-z0-9_]*\.(?:js|map|data))?)?$/u.test(
        part,
      ) ||
      /^playwright-results(?:\/(?:[A-Za-z0-9_-]+|\.playwright-artifacts-[0-9]+|\.last-run\.json))?$/u.test(
        part,
      )
    );
  };
  const resultPath = (path: string): boolean => path === results || path.startsWith(`${results}/`);
  const resultFile = (path: string): boolean => path === resolve(results, '.last-run.json');
  const cacheSource = (path: string): boolean =>
    /^playwright\/[0-9a-f]{2}\/[0-9a-f]{10}_[0-9a-f]{7}_[A-Za-z0-9_]*\.js$/u.test(
      relative(runtime, path),
    );
  const physicalPath = (path: string): string => resolve(physical, relative(runtime, path));
  const sha = (value: unknown): value is string =>
    typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
  const consume = (row: Row): boolean => {
    const kind = String(row['kind']);
    const path = row['path'];
    if (!kind.startsWith('output-') && !known(path)) return false;
    if (!known(path) || !permitted(path)) throw new Error('NATIVE_OUTPUT_PATH_INVALID');
    if (kind === 'output-mkdir') {
      if (!Array.isArray(row['created'])) throw new Error('NATIVE_OUTPUT_CREATION_INVALID');
      for (const raw of row['created']) {
        const entry = raw as Row;
        const created = entry['path'];
        if (
          !known(created) ||
          !permitted(created) ||
          (resultPath(created) && resultFile(created)) ||
          entries.has(created) ||
          entry['realpath'] !== physicalPath(created) ||
          typeof entry['mode'] !== 'number' ||
          (entry['mode'] & 0o170000) !== 0o040000 ||
          entries.get(dirname(created))?.kind !== 'directory'
        )
          throw new Error('NATIVE_OUTPUT_CREATION_INVALID');
        entries.set(created, { kind: 'directory', mode: entry['mode'] });
      }
      if (entries.get(path)?.kind !== 'directory')
        throw new Error('NATIVE_OUTPUT_CREATION_MISSING');
      return true;
    }
    if (kind === 'output-write-intent') {
      if (resultPath(path) && !resultFile(path)) throw new Error('NATIVE_OUTPUT_PATH_INVALID');
      const entry = entries.get(path);
      if (
        row['present'] !== (entry !== undefined) ||
        (entry !== undefined && (entry.kind !== 'file' || entry.sha256 !== row['sha256'])) ||
        (entry === undefined && row['sha256'] !== null)
      )
        throw new Error('NATIVE_OUTPUT_UNOWNED_OVERWRITE');
      start(row, path, 'write');
      return true;
    }
    if (kind === 'output-rename-intent') {
      if (
        resultPath(path) ||
        (known(row['target']) && resultPath(row['target'])) ||
        row['targetPresent'] !== false ||
        entries.get(path)?.kind !== 'file' ||
        !known(row['target']) ||
        !permitted(row['target']) ||
        entries.has(row['target'])
      )
        throw new Error('NATIVE_OUTPUT_UNOWNED_OVERWRITE');
      start(row, path, 'rename');
      return true;
    }
    if (kind === 'output-cleanup') {
      if (path === runtime || !Array.isArray(row['entries']))
        throw new Error('NATIVE_OUTPUT_CLEANUP_INVALID');
      const expected = [...entries].filter(([key]) => key === path || key.startsWith(`${path}/`));
      if (row['entries'].length !== expected.length)
        throw new Error('NATIVE_OUTPUT_CLEANUP_UNOWNED');
      const observed = new Set<string>();
      for (const raw of row['entries']) {
        const item = raw as Row;
        const key = item['path'];
        if (!known(key) || observed.has(key) || (key !== path && !key.startsWith(`${path}/`)))
          throw new Error('NATIVE_OUTPUT_CLEANUP_INVALID');
        observed.add(key);
        const entry = entries.get(key);
        if (
          entry === undefined ||
          item['realpath'] !== physicalPath(key) ||
          item['mode'] !== entry.mode ||
          item['sha256'] !== (entry.sha256 ?? null)
        )
          throw new Error('NATIVE_OUTPUT_CLEANUP_CHANGED');
      }
      start(row, path, 'remove');
      return true;
    }
    if (kind === 'output-write') {
      if (resultPath(path) && !resultFile(path)) throw new Error('NATIVE_OUTPUT_PATH_INVALID');
      complete(row, path, 'write');
      if (
        entries.get(dirname(path))?.kind !== 'directory' ||
        entries.get(path)?.kind === 'directory' ||
        row['realpath'] !== physicalPath(path) ||
        !sha(row['sha256']) ||
        !sha(row['utf8Sha256']) ||
        typeof row['mode'] !== 'number' ||
        (row['mode'] & 0o170000) !== 0o100000 ||
        typeof row['size'] !== 'number' ||
        !Number.isSafeInteger(row['size']) ||
        row['size'] < 0
      )
        throw new Error('NATIVE_OUTPUT_WRITE_INVALID');
      entries.set(path, {
        kind: 'file',
        mode: row['mode'],
        sha256: row['sha256'],
        utf8Sha256: row['utf8Sha256'],
      });
      return true;
    }
    if (kind === 'output-rename') {
      complete(row, path, 'rename');
      const target = row['target'];
      const entry = entries.get(path);
      if (
        !known(target) ||
        !permitted(target) ||
        resultPath(path) ||
        resultPath(target) ||
        entry?.kind !== 'file' ||
        entries.has(target) ||
        entries.get(dirname(target))?.kind !== 'directory' ||
        row['realpath'] !== physicalPath(target)
      )
        throw new Error('NATIVE_OUTPUT_RENAME_INVALID');
      entries.delete(path);
      entries.set(target, entry);
      return true;
    }
    if (kind === 'output-remove') {
      complete(row, path, 'remove');
      // Recursive cleanup sees every extant entry through the observed directory walk.
      for (const key of entries.keys())
        if (key === path || key.startsWith(`${path}/`)) entries.delete(key);
      return true;
    }
    if (kind !== 'observation') throw new Error('NATIVE_OUTPUT_EVENT_INVALID');
    const entry = entries.get(path);
    const operation = row['operation'];
    if (resultPath(path) && operation === 'readFile')
      throw new Error('NATIVE_OUTPUT_RESULT_INPUT_REFUSED');
    const observation = row['observation'] as Row;
    if (entry === undefined) {
      if (
        (operation === 'exists' && canonicalize(observation) === '{"value":false}') ||
        (['readFile', 'stat', 'lstat', 'readdir', 'access', 'realpath'].includes(
          String(operation),
        ) &&
          canonicalize(observation) === '{"error":"ENOENT"}')
      )
        return true;
      throw new Error('NATIVE_OUTPUT_READ_BEFORE_WRITE');
    }
    let expected: Row;
    if (
      operation === 'readFile' &&
      entry.kind === 'file' &&
      (row['encoding'] === null || ['utf8', 'utf-8'].includes(String(row['encoding'])))
    )
      expected = {
        sha256: row['encoding'] === null ? entry.sha256 : entry.utf8Sha256,
        realpath: physicalPath(path),
      };
    else if (operation === 'exists') expected = { value: true };
    else if (operation === 'realpath') expected = { value: physicalPath(path) };
    else if (operation === 'stat' || operation === 'lstat')
      expected = {
        present: true,
        ...(operation === 'stat' ? { realpath: physicalPath(path) } : {}),
      };
    else if (operation === 'stat-field' && row['field'] === 'mode')
      expected = { value: row['bigint'] === true ? String(entry.mode) : entry.mode };
    else if (operation === 'readdir' && entry.kind === 'directory') {
      const children = [...entries]
        .filter(([child]) => child !== path && dirname(child) === path)
        .map(([child, value]) =>
          row['dirents'] === true ? [relative(path, child), value.kind] : [relative(path, child)],
        );
      if (
        canonicalize((observation['entries'] as unknown[][])?.toSorted()) !==
        canonicalize(children.toSorted())
      )
        throw new Error('NATIVE_OUTPUT_DIRECTORY_CHANGED');
      return true;
    } else throw new Error('NATIVE_OUTPUT_OBSERVATION_UNSUPPORTED');
    if (canonicalize(observation) !== canonicalize(expected))
      throw new Error('NATIVE_OUTPUT_OBSERVATION_CHANGED');
    return true;
  };
  return Object.assign(consume, {
    finish(): void {
      if (pending.size > 0) throw new Error('NATIVE_OUTPUT_OPERATION_INCOMPLETE');
    },
    hasTransformedSource(sha256: string): boolean {
      return (
        !vitest &&
        [...entries].some(
          ([path, entry]) => cacheSource(path) && entry.kind === 'file' && entry.sha256 === sha256,
        )
      );
    },
  });
}
