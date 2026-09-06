import { createHash } from 'node:crypto';
import { canonicalJson } from '@devai-nyx/utils';
import { getValidator } from '@devai-nyx/schemas';
import { finalizeMutationEvidenceV21 } from './mutation-evidence-v21.js';

type Json = Readonly<Record<string, unknown>>;
const STATUS = [
  'CompileError',
  'Ignored',
  'Killed',
  'NoCoverage',
  'Pending',
  'RuntimeError',
  'Survived',
  'Timeout',
] as const;
type Status = (typeof STATUS)[number];
const INVALID = 'MUTATION_REPORT_INVALID';
const DIGEST = /^[a-f0-9]{64}$/u;
const PACKAGE = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/u;

export interface ReleaseMutationThresholdsV21 {
  readonly break: number;
  readonly high: number;
  readonly low: number;
  readonly scoreMin: number;
  readonly survivedMax: number;
}

/** Complete expected data supplied by the protected producer, not an execution/trust brand. */
export interface ReleaseMutationPackageInputsV21 {
  readonly packageName: string;
  readonly workspace: string;
  readonly inputProjection: Json;
  readonly thresholds: ReleaseMutationThresholdsV21;
  readonly toolVersions: Readonly<Record<string, string>>;
}

export interface ReleaseMutationArtifactV21 {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: Buffer;
}

export interface ReleaseMutationPackageArtifactsV21 {
  readonly inputDigest: string;
  readonly report: ReleaseMutationArtifactV21;
  readonly result: ReleaseMutationArtifactV21;
}

export interface ReleaseMutationArtifactLimitsV21 {
  readonly maximum_raw_report_bytes: number;
  readonly maximum_document_bytes: number;
  readonly maximum_files: number;
  readonly maximum_mutants: number;
}

/** Instrumenter-derived identity only; execution statuses must come from the runner. */
export interface ReleaseMutationDiscoveredMutantV21 {
  readonly id: string;
  readonly mutatorName: string;
  readonly replacementDigest: string;
  /** Report coordinates: the pinned Stryker reporter adds one to internal line and column. */
  readonly location: {
    readonly start: { readonly line: number; readonly column: number };
    readonly end: { readonly line: number; readonly column: number };
  };
}

function fail(code = INVALID): never {
  throw Object.assign(new Error(code), { code });
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function closed(value: unknown, fields: readonly string[]): void {
  const record = object(value);
  if (
    !([Object.prototype, null] as unknown[]).includes(Object.getPrototypeOf(record)) ||
    Reflect.ownKeys(record).length !== fields.length
  )
    fail();
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(record, field);
    if (!descriptor?.enumerable || !('value' in descriptor)) fail();
  }
}
function array(value: unknown, maximum: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  for (let i = 0; i < value.length; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor?.enumerable || !('value' in descriptor)) fail();
  }
  return value;
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : fail();
}
function path(value: unknown): string {
  const result = text(value);
  if (
    result.length === 0 ||
    result !== result.normalize('NFC') ||
    result.startsWith('/') ||
    /^[A-Za-z]:/u.test(result) ||
    result.includes('\\') ||
    /\p{Cc}|\p{Cs}/u.test(result) ||
    result.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    fail();
  return result;
}
function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
function canonical(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8');
}
function equal(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
function copy<T>(value: T): T {
  const inspect = (item: unknown, depth = 0): void => {
    if (depth > 64) fail();
    if (Array.isArray(item)) {
      for (const member of array(item, 1_000_000)) inspect(member, depth + 1);
    } else if (item !== null && typeof item === 'object') {
      closed(item, Object.keys(item));
      for (const member of Object.values(item)) inspect(member, depth + 1);
    } else if (
      item !== null &&
      !['string', 'boolean'].includes(typeof item) &&
      !(typeof item === 'number' && Number.isFinite(item))
    )
      fail();
  };
  inspect(value);
  return JSON.parse(canonical(value).toString('utf8')) as T;
}
function parse(value: Uint8Array, maximum: number, requireCanonical = true): Json {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > maximum)
    fail();
  const bytes = Buffer.from(value);
  const result = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  if (requireCanonical && !bytes.equals(canonical(result))) fail('NON_CANONICAL_JSON');
  return result;
}
function inputDigest(value: unknown): string {
  const payload = canonical(value);
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(payload.length));
  return sha256(
    Buffer.concat([
      Buffer.from('devai:mutation-input:v2.1', 'ascii'),
      Buffer.from([0]),
      length,
      payload,
    ]),
  );
}
function artifact(
  input: string,
  kind: 'report' | 'result',
  bytes: Buffer,
): ReleaseMutationArtifactV21 {
  const digest = sha256(bytes);
  return {
    path: `.devai/state/mutation/v2/store/inputs/${input}/objects/${digest}.${kind}.json`,
    sha256: digest,
    bytes: Buffer.from(bytes),
  };
}
function validate(value: unknown): void {
  if (!getValidator('mutation-report-set-v2.schema.json')(value)) fail();
}
function guarded<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (
      error instanceof Error &&
      /^(?:MUTATION_[A-Z0-9_]+|ARTIFACT_DIGEST_MISMATCH|NON_CANONICAL_JSON)$/u.test(error.message)
    )
      throw error;
    return fail();
  }
}
function packageInputs(value: ReleaseMutationPackageInputsV21): ReleaseMutationPackageInputsV21 {
  const input = copy(value);
  closed(input, ['packageName', 'workspace', 'inputProjection', 'thresholds', 'toolVersions']);
  if (!PACKAGE.test(input.packageName)) fail('MUTATION_ROSTER_MISMATCH');
  path(input.workspace);
  closed(input.thresholds, ['break', 'high', 'low', 'scoreMin', 'survivedMax']);
  if (
    ['break', 'high', 'low', 'scoreMin'].some((key) => {
      const value = input.thresholds[key as keyof ReleaseMutationThresholdsV21];
      return typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100;
    }) ||
    input.thresholds.low > input.thresholds.high ||
    !Number.isSafeInteger(input.thresholds.survivedMax) ||
    input.thresholds.survivedMax < 0
  )
    fail('MUTATION_THRESHOLD_MISMATCH');
  if (
    input.inputProjection['packageName'] !== input.packageName ||
    input.inputProjection['workspace'] !== input.workspace
  )
    fail('MUTATION_INPUT_DIGEST_MISMATCH');
  if (
    !Object.hasOwn(input.toolVersions, 'stryker') ||
    Object.entries(input.toolVersions).some(
      ([name, version]) =>
        !/^[A-Za-z0-9][A-Za-z0-9._+:-]*$/u.test(name) ||
        typeof version !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._+:-]*$/u.test(version),
    )
  )
    fail();
  return input;
}

/**
 * Data-only normalization of a raw schema-1 Stryker result captured by the protected producer.
 * This does NOT prove source derivation, execution custody, freshness, reuse or certification.
 * No v1 DEVAI evidence, composed result, or semantic receipt is accepted as a raw runner report.
 * Only replacement digests and bounded process fields survive; raw source/config/logs never do.
 */
export function normalizeReleaseMutationPackageV21(input: {
  readonly expected: ReleaseMutationPackageInputsV21;
  readonly raw_report: Uint8Array;
  /** Exact protected task cwd, checked before replacing the raw absolute root with '.'. */
  readonly execution_cwd: string;
  readonly process: {
    readonly errorAbsent: boolean;
    readonly signal: string | null;
    readonly status: number | null;
  };
  /**
   * Exact independently established emitted-target census from immutable source bytes.
   * This is NOT the complete selected source population bound in inputProjection: Stryker
   * legitimately omits selected files with zero mutants. The protected producer must prove
   * their distinction; report-supplied files or mutants cannot establish either census.
   * Mutant identities must be derived before execution from the effective instrumenter
   * configuration and immutable source, never copied from the report being checked.
   */
  readonly source_files: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly mutants: readonly ReleaseMutationDiscoveredMutantV21[];
  }[];
  /** Full allowed test population, not a runner-supplied selection. */
  readonly test_files: readonly string[];
  readonly limits: ReleaseMutationArtifactLimitsV21;
}): ReleaseMutationPackageArtifactsV21 {
  return guarded(() => {
    closed(input, [
      'expected',
      'raw_report',
      'execution_cwd',
      'process',
      'source_files',
      'test_files',
      'limits',
    ]);
    const limits = copy(input.limits);
    closed(limits, [
      'maximum_raw_report_bytes',
      'maximum_document_bytes',
      'maximum_files',
      'maximum_mutants',
    ]);
    if (
      Object.values(limits).some(
        (value) => !Number.isSafeInteger(value) || value < 1 || value > 0x7fffffff,
      )
    )
      fail();
    const expected = packageInputs(input.expected);
    const process = copy(input.process);
    closed(process, ['errorAbsent', 'signal', 'status']);
    const sources = new Map<
      string,
      { sha256: string; mutants: ReadonlyMap<string, ReleaseMutationDiscoveredMutantV21> }
    >();
    let discoveredCount = 0;
    for (const entry of array(input.source_files, limits.maximum_files)) {
      closed(entry, ['path', 'sha256', 'mutants']);
      const member = object(entry),
        name = path(member['path']),
        digest = text(member['sha256']);
      if (!DIGEST.test(digest) || sources.has(name)) fail();
      const mutants = new Map<string, ReleaseMutationDiscoveredMutantV21>();
      for (const value of array(member['mutants'], limits.maximum_mutants)) {
        closed(value, ['id', 'mutatorName', 'replacementDigest', 'location']);
        const mutant = copy(value) as ReleaseMutationDiscoveredMutantV21;
        if (
          typeof mutant.id !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(mutant.id) ||
          mutants.has(mutant.id) ||
          typeof mutant.mutatorName !== 'string' ||
          mutant.mutatorName.length === 0 ||
          mutant.mutatorName.length > 160 ||
          mutant.mutatorName.includes('/') ||
          mutant.mutatorName.includes('\\') ||
          [...mutant.mutatorName].some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          ) ||
          typeof mutant.replacementDigest !== 'string' ||
          !DIGEST.test(mutant.replacementDigest)
        )
          fail();
        closed(mutant.location, ['start', 'end']);
        for (const position of [mutant.location.start, mutant.location.end]) {
          closed(position, ['line', 'column']);
          if (
            !Number.isSafeInteger(position.line) ||
            !Number.isSafeInteger(position.column) ||
            position.line < 1 ||
            position.column < 1
          )
            fail();
        }
        if (
          mutant.location.end.line < mutant.location.start.line ||
          (mutant.location.end.line === mutant.location.start.line &&
            mutant.location.end.column < mutant.location.start.column)
        )
          fail();
        discoveredCount += 1;
        if (discoveredCount > limits.maximum_mutants) fail();
        mutants.set(mutant.id, mutant);
      }
      // Zero-emission selected files belong to the input projection, not this census.
      if (mutants.size === 0) fail();
      sources.set(name, { sha256: digest, mutants });
    }
    const tests = array(input.test_files, limits.maximum_files).map(path);
    if (new Set(tests).size !== tests.length) fail();
    const raw = parse(input.raw_report, limits.maximum_raw_report_bytes, false);
    const framework = object(raw['framework']);
    const cwd = text(input.execution_cwd);
    if (!cwd.startsWith('/') || `/${path(cwd.slice(1))}` !== cwd || raw['projectRoot'] !== cwd)
      fail('MUTATION_INPUT_DIGEST_MISMATCH');
    if (
      // StrykerJS 9.6.1 emits schema '1.0'; the frozen normalized contract records major '1'.
      raw['schemaVersion'] !== '1.0' ||
      Object.hasOwn(raw, 'kind') ||
      framework['name'] !== 'StrykerJS' ||
      framework['version'] !== expected.toolVersions['stryker']
    )
      fail('MUTATION_VERSION_UNSUPPORTED');
    const triplet = {
      break: expected.thresholds.break,
      high: expected.thresholds.high,
      low: expected.thresholds.low,
    };
    if (!equal(raw['thresholds'], triplet)) fail('MUTATION_THRESHOLD_MISMATCH');
    const rawFiles = object(raw['files']);
    if (!equal(Object.keys(rawFiles).sort(), [...sources.keys()].sort()))
      fail('MUTATION_ROSTER_MISMATCH');
    const statusTotals = Object.fromEntries(STATUS.map((status) => [status, 0])) as Record<
      Status,
      number
    >;
    let mutantCount = 0;
    const files = Object.fromEntries(
      Object.entries(rawFiles).map(([name, rawFile]) => {
        path(name);
        const file = object(rawFile);
        const discovered = sources.get(name);
        if (discovered === undefined) return fail('MUTATION_ROSTER_MISMATCH');
        if (sha256(Buffer.from(text(file['source']), 'utf8')) !== discovered.sha256)
          fail('MUTATION_INPUT_DIGEST_MISMATCH');
        if (file['language'] !== 'typescript' && file['language'] !== 'javascript') fail();
        const ids = new Set<string>();
        const mutants = array(file['mutants'], limits.maximum_mutants)
          .map((rawMutant) => {
            const mutant = object(rawMutant),
              id = text(mutant['id']),
              status = text(mutant['status']) as Status;
            if (
              !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id) ||
              ids.has(id) ||
              !STATUS.includes(status)
            )
              fail();
            ids.add(id);
            mutantCount += 1;
            if (mutantCount > limits.maximum_mutants) fail();
            statusTotals[status] += 1;
            const identity = {
              id,
              mutatorName: text(mutant['mutatorName']),
              replacementDigest: sha256(Buffer.from(text(mutant['replacement']), 'utf8')),
              location: copy(mutant['location']),
            };
            const expectedIdentity = discovered.mutants.get(id);
            if (expectedIdentity === undefined) fail('MUTATION_ROSTER_MISMATCH');
            if (!equal(identity, expectedIdentity)) fail('MUTATION_INPUT_DIGEST_MISMATCH');
            return { ...identity, status };
          })
          .sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
        if (ids.size !== discovered.mutants.size) fail('MUTATION_ROSTER_MISMATCH');
        return [name, { language: file['language'], mutants }];
      }),
    );
    const testFiles = Object.fromEntries(
      Object.keys(object(raw['testFiles'] ?? {})).map((name) => {
        if (!tests.includes(path(name))) fail('MUTATION_INPUT_DIGEST_MISMATCH');
        return [name, {}];
      }),
    );
    const report = {
      schemaVersion: '2.1.0',
      kind: 'mutation-normalized-stryker-report-v2',
      strykerSchemaVersion: '1',
      projectRoot: '.',
      thresholds: triplet,
      files,
      testFiles,
      config: {},
      framework: { name: 'StrykerJS' },
    };
    validate(report);
    const reportBytes = canonical(report);
    const detected = statusTotals.Killed + statusTotals.Timeout;
    const scored = detected + statusTotals.Survived + statusTotals.NoCoverage;
    const score = scored === 0 ? 100 : (detected / scored) * 100;
    const complete =
      process.errorAbsent === true &&
      process.signal === null &&
      process.status === 0 &&
      statusTotals.Pending === 0 &&
      mutantCount > 0 &&
      scored > 0;
    const digest = inputDigest(expected.inputProjection);
    const result = {
      schemaVersion: '2.1.0',
      kind: 'mutation-package-result-v2',
      packageName: expected.packageName,
      workspace: expected.workspace,
      inputProjection: expected.inputProjection,
      inputDigest: digest,
      reportDigest: sha256(reportBytes),
      toolVersions: expected.toolVersions,
      process,
      thresholds: expected.thresholds,
      statusTotals,
      targetCensus: { targetFileCount: sources.size, totalMutants: mutantCount },
      score,
      complete,
      passed:
        complete &&
        statusTotals.RuntimeError === 0 &&
        score >= Math.max(expected.thresholds.break, expected.thresholds.scoreMin) &&
        statusTotals.Survived <= expected.thresholds.survivedMax,
    };
    validate(result);
    const resultBytes = canonical(result);
    if (
      reportBytes.length > limits.maximum_document_bytes ||
      resultBytes.length > limits.maximum_document_bytes
    )
      fail();
    return {
      inputDigest: digest,
      report: artifact(digest, 'report', reportBytes),
      result: artifact(digest, 'result', resultBytes),
    };
  });
}

/**
 * Pure refinalization against a complete externally frozen required roster. It never executes,
 * writes artifacts, resolves reuse, signs or emits semantic verification receipts. A returned
 * summary is a canonical calculation, not proof that supplied populations came from a candidate.
 * The protected producer must independently derive/compare those inputs before compose/verify.
 */
export async function finalizeReleaseMutationArtifactsV21(input: {
  readonly candidate: {
    readonly releaseUnit: string;
    readonly commit: string;
    readonly tree: string;
  };
  readonly releasePlanReceiptDigest: string;
  readonly releaseProfileDigest: string;
  readonly policyDigest: string;
  readonly summaryPath: string;
  readonly semanticReceiptPath: string;
  readonly expected: readonly ReleaseMutationPackageInputsV21[];
  readonly packages: readonly {
    readonly packageName: string;
    readonly disposition: 'executed' | 'reused';
    readonly origin: unknown;
    readonly artifacts: ReleaseMutationPackageArtifactsV21;
  }[];
  readonly maximum_document_bytes: number;
}): Promise<{
  readonly contract: Json;
  readonly summary: Json;
  readonly materials: readonly Json[];
}> {
  let captured: {
    readonly contract: Json;
    readonly candidate: Json;
    readonly packages: readonly Json[];
  };
  try {
    closed(input, [
      'candidate',
      'releasePlanReceiptDigest',
      'releaseProfileDigest',
      'policyDigest',
      'summaryPath',
      'semanticReceiptPath',
      'expected',
      'packages',
      'maximum_document_bytes',
    ]);
    const maximum = input.maximum_document_bytes;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 0x7fffffff) fail();
    const expected = array(input.expected, 8192).map((value) =>
      packageInputs(value as ReleaseMutationPackageInputsV21),
    );
    const values = array(input.packages, 8192);
    if (
      expected.length === 0 ||
      expected.length !== values.length ||
      new Set(expected.map((entry) => entry.packageName)).size !== expected.length ||
      new Set(expected.map((entry) => entry.workspace)).size !== expected.length
    )
      fail('MUTATION_ROSTER_MISMATCH');
    const materials: Json[] = [];
    const entries = expected.map((entry, index) => {
      const raw = values[index];
      closed(raw, ['packageName', 'disposition', 'origin', 'artifacts']);
      const value = object(raw);
      if (value['packageName'] !== entry.packageName) fail('MUTATION_ROSTER_MISMATCH');
      const pair = value['artifacts'] as ReleaseMutationPackageArtifactsV21;
      closed(pair, ['inputDigest', 'report', 'result']);
      const read = (kind: 'report' | 'result') => {
        const declared = pair[kind];
        closed(declared, ['path', 'sha256', 'bytes']);
        if (!(declared.bytes instanceof Uint8Array) || declared.bytes.byteLength > maximum) fail();
        // One defensive capture is both parsed and hashed; never reread caller-owned memory.
        const bytes = Buffer.from(declared.bytes);
        const parsed = parse(bytes, maximum);
        const addressed = artifact(inputDigest(entry.inputProjection), kind, bytes);
        if (declared.path !== addressed.path || declared.sha256 !== addressed.sha256)
          fail('ARTIFACT_DIGEST_MISMATCH');
        return parsed;
      };
      const report = read('report'),
        result = read('result'),
        digest = inputDigest(entry.inputProjection);
      if (
        pair.inputDigest !== digest ||
        result['inputDigest'] !== digest ||
        !equal(result['inputProjection'], entry.inputProjection) ||
        !equal(result['thresholds'], entry.thresholds) ||
        !equal(result['toolVersions'], entry.toolVersions)
      )
        fail('MUTATION_INPUT_DIGEST_MISMATCH');
      materials.push({
        disposition: value['disposition'],
        origin: copy(value['origin']),
        report,
        result,
      });
      return {
        packageName: entry.packageName,
        workspace: entry.workspace,
        requirement: 'required',
        inputProjection: entry.inputProjection,
        inputDigest: digest,
        reportPath: pair.report.path,
        resultPath: pair.result.path,
        thresholds: entry.thresholds,
      };
    });
    const contract = {
      schemaVersion: '2.1.0',
      kind: 'mutation-report-set-v2',
      expectedPackageCount: entries.length,
      summaryPath: path(input.summaryPath),
      semanticReceiptPath: path(input.semanticReceiptPath),
      releasePlanReceiptDigest: text(input.releasePlanReceiptDigest),
      releaseProfileDigest: text(input.releaseProfileDigest),
      policyDigest: text(input.policyDigest),
      packages: entries,
      paths: [
        input.summaryPath,
        input.semanticReceiptPath,
        ...entries.flatMap((entry) => [entry.reportPath, entry.resultPath]),
      ],
    };
    validate(contract);
    captured = { contract, candidate: copy(input.candidate), packages: materials };
  } catch (error) {
    return guarded(() => {
      throw error;
    });
  }
  // The existing gate rehashes the approved verifier implementation and policy before applying
  // canonical v2.1 metrics, process/status semantics, threshold rules and exact result closure.
  const summary = await finalizeMutationEvidenceV21(captured);
  return {
    contract: copy(captured.contract),
    summary: copy(summary),
    materials: copy(captured.packages),
  };
}
