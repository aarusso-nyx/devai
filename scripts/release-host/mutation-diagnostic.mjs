import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Fixed, nonpromoting fixture driver. Child logs and raw reports never reach the
// host log. The separate fd 3 observation is emitted before semantic assertions,
// so an assertion failure cannot erase the status population that explains it.
const STATUSES = [
  'CompileError',
  'Ignored',
  'Killed',
  'NoCoverage',
  'Pending',
  'RuntimeError',
  'Survived',
  'Timeout',
];
const SIGNALS = [
  'SIGABRT',
  'SIGBUS',
  'SIGFPE',
  'SIGHUP',
  'SIGILL',
  'SIGINT',
  'SIGKILL',
  'SIGPIPE',
  'SIGQUIT',
  'SIGSEGV',
  'SIGTERM',
  'SIGTRAP',
];
const MAX_OBSERVATION_BYTES = 8192;
const MAX_REPORT_BYTES = 1024 * 1024;
const FIXTURE_ROOT = '/workspace/candidate/packages/fixture/';
const TARGETS = ['src/subject.ts', 'src/zero.ts'];
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
const count = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 100000;
const closed = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  canonical(Object.keys(value).sort()) === canonical([...keys].sort());

/** Fixed-fixture discovery only: no raw report establishes this independent census. */
export function summarizeFixtureDiscovery(selected, result) {
  assert(Array.isArray(selected) && selected.length === TARGETS.length);
  assert.deepEqual(
    selected.map(({ name }) => name),
    TARGETS.map((path) => FIXTURE_ROOT + path),
  );
  assert(selected.every(({ content, mutate }) => typeof content === 'string' && mutate === true));
  assert(Array.isArray(result.files) && result.files.length === TARGETS.length);
  const instrumented = result.files
    .map(({ name }) => {
      assert(typeof name === 'string' && name.startsWith(FIXTURE_ROOT));
      return name.slice(FIXTURE_ROOT.length);
    })
    .sort();
  assert.deepEqual(instrumented, TARGETS);
  assert(
    Array.isArray(result.mutants) && result.mutants.length > 0 && result.mutants.length <= 1000,
  );
  const ids = new Set();
  const byFile = new Map(TARGETS.map((path) => [path, []]));
  for (const mutant of result.mutants) {
    assert(typeof mutant.fileName === 'string' && mutant.fileName.startsWith(FIXTURE_ROOT));
    const path = mutant.fileName.slice(FIXTURE_ROOT.length);
    assert(byFile.has(path) && typeof mutant.id === 'string' && !ids.has(mutant.id));
    ids.add(mutant.id);
    byFile.get(path).push(mutant.id);
  }
  assert.equal(byFile.get('src/zero.ts').length, 0);
  return {
    algorithm: 'devai.fixed-fixture-instrumenter.v1',
    instrumenter_version: '9.6.1',
    options: { plugins: null, excludedMutations: [], ignorers: [] },
    selected: selected.map(({ name, content }) => ({
      path: name.slice(FIXTURE_ROOT.length),
      source_sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    })),
    instrumented,
    emitted: [...byFile]
      .filter(([, ids]) => ids.length !== 0)
      .map(([path, ids]) => ({
        path,
        mutant_ids: ids.sort(),
        mutant_count: ids.length,
      })),
  };
}

/** Pure diagnostic data, never an execution capability or certification receipt. */
export function summarizeDiagnostic({ status, signal, workerOutput, stdout, abnormal = false }) {
  let observation = null;
  try {
    if (!Buffer.isBuffer(workerOutput) || workerOutput.length > MAX_OBSERVATION_BYTES)
      throw new Error('invalid');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(workerOutput));
    if (!closed(value, ['report', 'mutants'])) throw new Error('invalid');
    const { report, mutants } = value;
    if (
      !closed(report, [
        'present',
        'parseable',
        'framework_matches',
        'file_count',
        'zero_file_present',
      ]) ||
      !closed(mutants, ['total', 'status_counts', 'unknown_status_count']) ||
      !closed(mutants.status_counts, STATUSES) ||
      !Object.values(mutants.status_counts).every(count) ||
      !count(mutants.total) ||
      !count(mutants.unknown_status_count) ||
      Object.values(mutants.status_counts).reduce((a, b) => a + b, 0) +
        mutants.unknown_status_count !==
        mutants.total ||
      typeof report.present !== 'boolean' ||
      typeof report.parseable !== 'boolean' ||
      (report.parseable && !report.present) ||
      (report.parseable
        ? typeof report.framework_matches !== 'boolean' ||
          !count(report.file_count) ||
          typeof report.zero_file_present !== 'boolean'
        : report.framework_matches !== null ||
          report.file_count !== null ||
          report.zero_file_present !== null)
    )
      throw new Error('invalid');
    observation = value;
  } catch {
    // Never echo malformed child bytes, parser errors, paths, or diagnostic logs.
  }
  const processStatus = Number.isInteger(status) && status >= 0 && status <= 255 ? status : null;
  const processSignal = signal === null ? null : SIGNALS.includes(signal) ? signal : 'other';
  return {
    schema_version: '1.0.0',
    kind: 'mutation-toolchain-diagnostic',
    certification: false,
    reusable: false,
    process: {
      status: processStatus,
      signal: processSignal,
      abnormal: abnormal !== false,
      observation_valid: observation !== null,
    },
    // A log marker is an observation, not proof of checker completion.
    checker_created:
      typeof stdout === 'string' &&
      stdout.includes('Creating 1 checker process(es) and 1 test runner process(es).')
        ? true
        : null,
    report: observation?.report ?? {
      present: null,
      parseable: null,
      framework_matches: null,
      file_count: null,
      zero_file_present: null,
    },
    mutants: observation?.mutants ?? {
      total: null,
      status_counts: Object.fromEntries(STATUSES.map((name) => [name, null])),
      unknown_status_count: null,
    },
    assertions_passed:
      processStatus === 0 && processSignal === null && abnormal === false && observation !== null,
  };
}

async function worker() {
  const require = createRequire(import.meta.url);
  assert.equal(process.version, 'v24.20.0');
  assert.equal(process.cwd(), '/workspace/candidate/packages/fixture');
  for (const [name, version] of Object.entries({
    '@stryker-mutator/core': '9.6.1',
    '@stryker-mutator/typescript-checker': '9.6.1',
    '@stryker-mutator/vitest-runner': '9.6.1',
    vitest: '4.1.10',
    typescript: '5.9.3',
  }))
    assert.equal(
      JSON.parse(readFileSync(require.resolve(name + '/package.json'))).version,
      version,
    );
  const projectRequire = createRequire(process.cwd() + '/package.json');
  assert.equal(
    realpathSync(projectRequire.resolve('vitest/package.json')),
    realpathSync(require.resolve('vitest/package.json')),
  );
  assert.throws(
    () => writeFileSync('/workspace/candidate/node_modules/.diagnostic-write', 'forbidden'),
    { code: 'EROFS' },
  );
  // The public pinned instrumenter exposes zero-mutant inputs that the raw
  // reporter intentionally omits. Resolve it through core's exact frozen graph.
  const coreRequire = createRequire(require.resolve('@stryker-mutator/core/package.json'));
  assert.equal(
    JSON.parse(readFileSync(coreRequire.resolve('@stryker-mutator/instrumenter/package.json')))
      .version,
    '9.6.1',
  );
  const { Instrumenter } = await import(
    pathToFileURL(coreRequire.resolve('@stryker-mutator/instrumenter')).href
  );
  const selected = TARGETS.map((path) => ({
    name: FIXTURE_ROOT + path,
    content: readFileSync(path, 'utf8'),
    mutate: true,
  }));
  const instrumenter = new Instrumenter({
    debug() {},
    info() {},
    warn() {},
    error() {},
    trace() {},
    fatal() {},
    isDebugEnabled: () => false,
    isTraceEnabled: () => false,
  });
  const discovery = summarizeFixtureDiscovery(
    selected,
    await instrumenter.instrument(selected, { plugins: null, excludedMutations: [], ignorers: [] }),
  );
  const { Stryker } = await import(pathToFileURL(require.resolve('@stryker-mutator/core')).href);
  const results = await new Stryker({ configFile: 'stryker.config.json' }).runMutationTest();
  let raw;
  const report = {
    present: false,
    parseable: false,
    framework_matches: null,
    file_count: null,
    zero_file_present: null,
  };
  try {
    const path = 'reports/mutation/raw.json';
    const stat = statSync(path);
    report.present = true;
    assert(stat.isFile() && stat.size <= MAX_REPORT_BYTES);
    raw = JSON.parse(readFileSync(path, 'utf8'));
    assert(raw !== null && typeof raw === 'object' && !Array.isArray(raw));
    assert(raw.files !== null && typeof raw.files === 'object' && !Array.isArray(raw.files));
    report.parseable = true;
    report.framework_matches = raw.framework?.version === '9.6.1';
    report.file_count = Object.keys(raw.files).length;
    const zeroFile = raw.files['src/zero.ts'];
    report.zero_file_present =
      Object.hasOwn(raw.files, 'src/zero.ts') &&
      zeroFile !== null &&
      typeof zeroFile === 'object' &&
      Array.isArray(zeroFile.mutants) &&
      zeroFile.mutants.length === 0;
  } catch {
    raw = undefined;
  }
  const statusCounts = Object.fromEntries(STATUSES.map((name) => [name, 0]));
  let unknown = 0;
  for (const result of results) {
    if (Object.hasOwn(statusCounts, result.status)) statusCounts[result.status] += 1;
    else unknown += 1;
  }
  writeFileSync(
    3,
    canonical({
      report,
      mutants: {
        total: results.length,
        status_counts: statusCounts,
        unknown_status_count: unknown,
      },
    }),
  );
  // Preserve the original semantic assertions. No NaN score or checker rejection
  // can substitute for a killed mutant, and no diagnostic grants production reuse.
  assert(results.length > 0);
  assert(results.some((result) => result.status === 'Killed'));
  assert(!results.some((result) => ['Pending', 'RuntimeError'].includes(result.status)));
  assert(results.filter((result) => result.status === 'Survived').length <= 50);
  assert.equal(raw?.framework.version, '9.6.1');
  assert(Object.keys(raw.files).includes('src/subject.ts'));
  assert(Object.values(raw.files).flatMap((file) => file.mutants).length > 0);
  assert.deepEqual(
    Object.keys(raw.files).sort(),
    discovery.emitted.map(({ path }) => path),
  );
  for (const emitted of discovery.emitted) {
    assert.equal(raw.files[emitted.path].mutants.length, emitted.mutant_count);
    assert.deepEqual(
      raw.files[emitted.path].mutants.map(({ id }) => id).sort(),
      emitted.mutant_ids,
    );
  }
  writeFileSync(
    'reports/mutation/compatibility.json',
    JSON.stringify({
      scope: 'toolchain-compatibility-diagnostic-only',
      core: '9.6.1',
      checker: '9.6.1',
      runner: '9.6.1',
      vitest: '4.1.10',
      typescript: '5.9.3',
      node: 'v24.20.0',
      projectVitestResolved: true,
      readonlyDependencies: true,
      realMutationObserved: true,
      certification: false,
      reusable: false,
      discovery,
    }),
  );
}

export async function runDiagnostic() {
  const marker = 'Creating 1 checker process(es) and 1 test runner process(es).';
  const environmentKeys = [
    'PATH',
    'HOME',
    'TMPDIR',
    'CI',
    'NO_COLOR',
    'LANG',
    'LC_ALL',
    'GIT_CONFIG_NOSYSTEM',
    'GIT_CONFIG_GLOBAL',
    'GIT_OPTIONAL_LOCKS',
  ];
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker'], {
    cwd: process.cwd(),
    env: Object.fromEntries(
      environmentKeys
        .filter((key) => process.env[key] !== undefined)
        .map((key) => [key, process.env[key]]),
    ),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  let abnormal = false;
  let checkerCreated = false;
  let tail = '';
  let bytes = 0;
  const chunks = [];
  const stop = () => {
    abnormal = true;
    child.kill('SIGKILL');
  };
  const timeout = setTimeout(stop, 120000);
  const diagnosticStream = child.stdio[3];
  // Drain logs rather than retaining them: verbosity must not kill the worker
  // before it emits the bounded observation. Only a fixed marker is retained.
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    const value = tail + chunk;
    checkerCreated ||= value.includes(marker);
    tail = value.slice(-marker.length);
  });
  child.stderr.resume();
  diagnosticStream.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_OBSERVATION_BYTES) {
      chunks.length = 0;
      stop();
    } else chunks.push(Buffer.from(chunk));
  });
  for (const stream of [child.stdout, child.stderr, diagnosticStream]) stream.on('error', stop);
  child.on('error', () => {
    abnormal = true;
  });
  const result = await new Promise((resolve) =>
    child.once('close', (status, signal) => resolve({ status, signal })),
  );
  clearTimeout(timeout);
  const observation = summarizeDiagnostic({
    status: result.status,
    signal: result.signal,
    workerOutput: bytes <= MAX_OBSERVATION_BYTES ? Buffer.concat(chunks) : undefined,
    stdout: checkerCreated ? marker : '',
    abnormal,
  });
  process.stdout.write(canonical(observation) + '\n');
  process.exitCode = observation.assertions_passed
    ? 0
    : Number.isInteger(result.status) && result.status > 0 && result.status <= 255
      ? result.status
      : 1;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  if (process.argv.length === 3 && process.argv[2] === '--worker') await worker();
  else if (process.argv.length === 2) await runDiagnostic();
  else process.exitCode = 1;
}
