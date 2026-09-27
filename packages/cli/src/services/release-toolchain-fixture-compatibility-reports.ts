import type { VerifiedReleasePolicyResolution } from './release-policy-resolution.js';
import {
  isVerifiedProtectedFixtureDiagnosticCustody,
  type ProtectedFixtureDiagnosticCustody,
} from './release-certification-provider.js';
import {
  same,
  VERSIONS,
  fail,
  object,
  hash,
  runtime,
  opaque,
  json,
  type Json,
  NODE,
  OUTPUTS,
  custodyContexts,
  type ContextData,
  COMPATIBILITY,
  RAW,
  type ProtectedToolchainFixtureCompatibility,
  compatibilities,
} from './release-toolchain-fixture-compatibility-support.js';

/** Pure bounded interpretation of private fixture bytes; never normalize into production evidence. */
function assertReports(custody: ProtectedFixtureDiagnosticCustody, data: ContextData): void {
  const captured = custody.read();
  if (
    captured.outcome !== 'success' ||
    data.request === undefined ||
    data.binding === undefined ||
    !same(captured.request, data.request) ||
    captured.runs.length !== 1 ||
    !same(captured.fixture_input_identity, data.identity) ||
    !same(captured.runtime_identity, data.runtime) ||
    !same(captured.execution_identity['container'], data.container)
  )
    fail();
  const run = captured.runs[0];
  if (
    !run ||
    run.task_node !== NODE ||
    !same(run.binding, data.binding) ||
    !same(run.process, { status: 0, signal: null, errorAbsent: true }) ||
    !same(
      run.output_census.map((entry) => entry.path),
      OUTPUTS,
    )
  )
    fail();
  const read = (path: string, maximum: number): Json => {
    const member = run.output_census.find((entry) => entry.path === path);
    if (
      !member ||
      member.mode !== '100644' ||
      member.task_node !== NODE ||
      member.size_bytes > maximum
    )
      return fail();
    const bytes = custody.readOutput({ run_index: 0, path, sha256: member.sha256 });
    if (bytes.length !== member.size_bytes || hash(bytes) !== member.sha256) fail();
    return json(bytes, maximum);
  };
  const compatibility = read(COMPATIBILITY, 8192);
  const discovery = object(compatibility['discovery']);
  const emitted = discovery['emitted'];
  if (!Array.isArray(emitted) || emitted.length !== 1) fail();
  const emittedFile = object(emitted[0]);
  const emittedIds = emittedFile['mutant_ids'];
  if (
    !Array.isArray(emittedIds) ||
    emittedIds.length === 0 ||
    emittedIds.length > 1000 ||
    emittedIds.some((id: unknown) => typeof id !== 'string') ||
    new Set(emittedIds).size !== emittedIds.length ||
    !same([...emittedIds].sort(), emittedIds) ||
    !same(emittedFile, {
      path: 'src/subject.ts',
      mutant_ids: emittedIds,
      mutant_count: emittedIds.length,
    }) ||
    !same(discovery, {
      algorithm: 'devai.fixed-fixture-instrumenter.v1',
      instrumenter_version: '9.6.1',
      options: { plugins: null, excludedMutations: [], ignorers: [] },
      selected: [
        { path: 'src/subject.ts', source_sha256: hash(data.subject) },
        { path: 'src/zero.ts', source_sha256: hash(data.zero) },
      ],
      instrumented: ['src/subject.ts', 'src/zero.ts'],
      emitted,
    })
  )
    fail();
  if (
    !same(compatibility, {
      scope: 'toolchain-compatibility-diagnostic-only',
      core: '9.6.1',
      checker: '9.6.1',
      runner: '9.6.1',
      vitest: VERSIONS.vitest,
      typescript: VERSIONS.typescript,
      node: VERSIONS.node,
      projectVitestResolved: true,
      readonlyDependencies: true,
      realMutationObserved: true,
      certification: false,
      reusable: false,
      discovery,
    })
  )
    fail();
  const raw = read(RAW, 1024 * 1024),
    framework = object(raw['framework']);
  if (
    raw['schemaVersion'] !== '1.0' ||
    raw['projectRoot'] !== '/workspace/candidate/packages/fixture' ||
    framework['name'] !== 'StrykerJS' ||
    framework['version'] !== '9.6.1' ||
    !same(raw['thresholds'], { break: 60, high: 60, low: 60 })
  )
    fail();
  const files = object(raw['files']);
  if (!same(Object.keys(files), ['src/subject.ts'])) fail();
  let killed = 0,
    detected = 0,
    survived = 0,
    scored = 0,
    total = 0;
  const ids = new Set<string>();
  for (const value of Object.values(files)) {
    const file = object(value);
    if (
      file['source'] !== data.subject.toString('utf8') ||
      file['language'] !== 'typescript' ||
      !Array.isArray(file['mutants']) ||
      file['mutants'].length > 1000
    )
      fail();
    for (const value of file['mutants']) {
      const mutant = object(value),
        status = mutant['status'];
      if (
        typeof mutant['id'] !== 'string' ||
        typeof status !== 'string' ||
        ids.has(mutant['id']) ||
        !['CompileError', 'Ignored', 'Killed', 'NoCoverage', 'Survived', 'Timeout'].includes(status)
      )
        fail();
      ids.add(mutant['id']);
      total += 1;
      if (status === 'Killed') killed += 1;
      if (status === 'Killed' || status === 'Timeout') detected += 1;
      if (status === 'Survived') survived += 1;
      if (['Killed', 'NoCoverage', 'Survived', 'Timeout'].includes(status)) scored += 1;
    }
  }
  if (
    total === 0 ||
    killed === 0 ||
    scored === 0 ||
    survived > 50 ||
    detected * 100 < scored * 60 ||
    !same([...ids].sort(), emittedIds)
  )
    fail();
}

export function issueProtectedToolchainFixtureCompatibility(
  custody: ProtectedFixtureDiagnosticCustody,
): ProtectedToolchainFixtureCompatibility {
  const data = custodyContexts.get(custody);
  custodyContexts.delete(custody);
  try {
    if (!data || !isVerifiedProtectedFixtureDiagnosticCustody(custody)) return fail();
    assertReports(custody, data);
    const result = opaque();
    compatibilities.set(result, data);
    return result;
  } catch {
    return fail();
  }
}

/** This only checks compatibility. It neither changes a plan nor clears any production gate. */
export function assertProtectedToolchainFixtureCompatibility(
  compatibility: ProtectedToolchainFixtureCompatibility,
  input: {
    readonly resolution: VerifiedReleasePolicyResolution;
    readonly container_identity: Json;
    readonly toolchain: Json;
    readonly environment: Json;
  },
): void {
  const data = compatibilities.get(compatibility);
  if (
    !data ||
    input.resolution !== data.production_resolution ||
    !same(
      object(input.resolution.readInput('release-verification-profile'))['mutation_execution'],
      data.template,
    ) ||
    !same(runtime(input.container_identity), data.runtime) ||
    !same(input.toolchain, data.toolchain) ||
    !same(input.environment, {})
  )
    fail();
}
