import { createHash } from 'node:crypto';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import type { ContainerArchiveEntry } from './container-archive.js';
import { assertBoundReleaseHostPackageSnapshot } from './release-host-package-binding.js';
import type { ReleasePackageSnapshot } from './release-package-snapshot.js';
import {
  assertReleaseMutationInputPackageIdentity,
  captureReleaseMutationInputExecutionContext,
  type ReleaseMutationInputExecutionContext,
  type ReleaseMutationInputPlanV21,
} from './release-mutation-inputs.js';
import type { ReleaseMutationArtifactLimitsV21 } from './release-mutation-artifacts.js';

const INVALID = 'release-mutation-program-invalid';
const PREFIX = 'dist/runtime/host/';
const SOURCES = ['mutation-production.mjs', 'mutation-vitest-plugin.mjs'] as const;
const MAXIMUM_DRIVER_BYTES = 128 * 1024;
const programs = new WeakMap<object, CapturedProtectedMutationProgram>();
const executionContexts = new WeakMap<object, ReleaseMutationInputExecutionContext>();
const packageInputs = new WeakMap<object, ProtectedMutationProgramPackage>();

export interface ProtectedMutationProgramPackage {
  readonly package: ReleaseMutationInputPlanV21['packages'][number];
  readonly limits: ReleaseMutationArtifactLimitsV21;
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function refuse(): never {
  throw new Error(INVALID);
}

export interface ProtectedMutationProgram {
  readonly kind: 'protected-mutation-program-v1';
  readonly identity_sha256: string;
}
export interface CapturedProtectedMutationProgram {
  readonly identity_sha256: string;
  readonly files: readonly ContainerArchiveEntry[];
  readonly argv: readonly string[];
  readonly maximum_observation_bytes: number;
  readonly maximum_raw_report_bytes: number;
}

// This wrapper never loads a candidate script. Both channels are captured by
// the trusted PID 1, not retained in candidate-writable files or inferred from
// stdout. Observation is sent before any test worker starts.
const RUN = `import{readFileSync,lstatSync,writeSync,existsSync}from'node:fs';
import{createHash}from'node:crypto';
import{createRequire}from'node:module';
import{runPinnedProductionMutation}from'./mutation-production.mjs';
const spec=JSON.parse(readFileSync('/devai-host/invocation.json','utf8'));
const fail=()=>{throw new Error('release-mutation-program-invalid')};
if(process.cwd()!=='/workspace/candidate'||process.version!==spec.node_version)fail();
const hash=b=>createHash('sha256').update(b).digest('hex');
const require=createRequire('/workspace/candidate/package.json');
for(const[name,version]of Object.entries(spec.versions))if(JSON.parse(readFileSync(require.resolve(name+'/package.json'),'utf8')).version!==version)fail();
for(const member of spec.inputs){const path='/workspace/candidate/'+member.path;const stat=lstatSync(path);if(!stat.isFile()||stat.size!==member.size||hash(readFileSync(path))!==member.sha256)fail()}
let observed=false;
const send=(fd,bytes,maximum)=>{if(bytes.length===0||bytes.length>maximum)fail();let offset=0;while(offset<bytes.length){const n=writeSync(fd,bytes,offset,bytes.length-offset);if(n<=0)fail();offset+=n}};
try{await runPinnedProductionMutation({options:{configFile:'/devai-host/stryker.config.json'},observationSpec:spec.observation,onObservation(value){if(observed)fail();observed=true;send(3,Buffer.from(JSON.stringify(value)),spec.maximum_observation_bytes)}})}finally{if(existsSync('/tmp/devai-mutation-report.json'))send(4,readFileSync('/tmp/devai-mutation-report.json'),spec.maximum_raw_report_bytes)}
if(!observed)fail();
if(!existsSync('/tmp/devai-mutation-report.json'))fail();
`;

/** Pure host construction; current fixture and prerequisite blockers must already be discharged. */
export function createProtectedMutationProgram(input: {
  readonly package_snapshot: ReleasePackageSnapshot;
  readonly input_plan: ReleaseMutationInputPlanV21;
  readonly package_name: string;
  readonly limits: ReleaseMutationArtifactLimitsV21;
}): ProtectedMutationProgram {
  assertBoundReleaseHostPackageSnapshot(input.package_snapshot);
  assertReleaseMutationInputPackageIdentity(input.input_plan, input.package_snapshot.identity);
  const derivedContext = captureReleaseMutationInputExecutionContext(input.input_plan);
  const plan = input.input_plan;
  const pkg = plan.packages.find((entry) => entry.expected.packageName === input.package_name);
  const limits = JSON.parse(canonicalJson(input.limits)) as ReleaseMutationArtifactLimitsV21;
  if (
    plan.execution_template_version !== '1.2.0' ||
    pkg === undefined ||
    pkg.execution_configuration === undefined ||
    !pkg.reuse.eligible ||
    pkg.reuse.unresolved.length !== 0 ||
    Object.keys(limits).sort().join(',') !==
      'maximum_document_bytes,maximum_files,maximum_mutants,maximum_raw_report_bytes' ||
    Object.values(limits).some(
      (value) => !Number.isSafeInteger(value) || value < 1 || value > 0x7fffffff,
    ) ||
    pkg.mutation_targets.length === 0 ||
    pkg.mutation_targets.length > limits.maximum_files ||
    pkg.selected_tests.length === 0 ||
    pkg.selected_tests.length > limits.maximum_files
  )
    refuse();
  const prerequisiteOutputs = (derivedContext.prerequisite_outputs ?? []).filter((entry) =>
    pkg.prerequisite_nodes.includes(entry.producer_task_node),
  );
  const executionContext = {
    ...derivedContext,
    ...(derivedContext.prerequisite_outputs === undefined
      ? {}
      : { prerequisite_outputs: prerequisiteOutputs }),
  };
  const config = pkg.execution_configuration;
  const files: ContainerArchiveEntry[] = SOURCES.map((name) => {
    const path = `${PREFIX}${name}`;
    const metadata = input.package_snapshot.manifest.find((entry) => entry.path === path);
    const bytes = input.package_snapshot.read(path);
    if (
      metadata === undefined ||
      metadata.mode !== 0o644 ||
      metadata.size !== bytes.length ||
      bytes.length === 0 ||
      bytes.length > MAXIMUM_DRIVER_BYTES ||
      hash(bytes) !== metadata.sha256
    )
      refuse();
    return { path: name, mode: '100644', bytes: Buffer.from(bytes) };
  });
  // Stryker normalizes backslashes to slashes before minimatch, so ordinary
  // backslash glob escaping would silently lose targets. Bracket literals are
  // stable through that conversion. Refuse encodings that its line-range,
  // brace-expansion or negated-class parser cannot represent exactly.
  const pattern = (path: string) => {
    if (/[:{}!]/u.test(path)) return refuse();
    return path.replace(/[?*[\]()+@]/gu, (character) => `[${character}]`);
  };
  const inputs = [
    ...new Map(
      [
        ...pkg.selected_source,
        ...pkg.selected_tests,
        config.vitest_config,
        config.typescript_config,
        ...config.typescript_closure,
        ...prerequisiteOutputs,
      ].map((entry) => [entry.path, { path: entry.path, size: entry.size, sha256: entry.sha256 }]),
    ).values(),
  ];
  const maximumObservation = limits.maximum_document_bytes;
  const invocation = {
    node_version: pkg.expected.toolVersions['node'],
    versions: {
      vitest: pkg.expected.toolVersions['vitest'],
      typescript: pkg.expected.toolVersions['typescript'],
    },
    input_digest: pkg.input_digest,
    observation: {
      workspace: pkg.expected.workspace,
      targets: pkg.mutation_targets.map(({ path, sha256 }) => ({ path, sha256 })),
      maximum_files: limits.maximum_files,
      maximum_mutants: limits.maximum_mutants,
    },
    inputs,
    maximum_observation_bytes: maximumObservation,
    maximum_raw_report_bytes: limits.maximum_raw_report_bytes,
  };
  const options = {
    mutate: pkg.mutation_targets.map((entry) => pattern(`${pkg.expected.workspace}/${entry.path}`)),
    testFiles: pkg.selected_tests.map((entry) => pattern(entry.path)),
    plugins: ['@stryker-mutator/typescript-checker', '/devai-host/mutation-vitest-plugin.mjs'],
    appendPlugins: [],
    testRunner: 'devai-vitest',
    checkers: ['typescript'],
    coverageAnalysis: 'perTest',
    concurrency: 1,
    thresholds: {
      break: pkg.expected.thresholds.break,
      high: pkg.expected.thresholds.high,
      low: pkg.expected.thresholds.low,
    },
    reporters: ['json'],
    jsonReporter: { fileName: '/tmp/devai-mutation-report.json' },
    vitest: { configFile: config.vitest_config.path, related: false },
    tsconfigFile: config.typescript_config.path,
    tempDirName: '/tmp/devai-mutation-production',
    cleanTempDir: 'always',
    symlinkNodeModules: true,
    fileLogLevel: 'off',
    logLevel: 'off',
    timeoutMS: 10000,
    timeoutFactor: 2,
    ignorePatterns: [],
    ignorers: [],
    mutator: { excludedMutations: [] },
    incremental: false,
    inPlace: false,
    buildCommand: '',
  };
  files.push(
    { path: 'run.mjs', mode: '100644', bytes: Buffer.from(RUN) },
    { path: 'invocation.json', mode: '100644', bytes: Buffer.from(canonicalJson(invocation)) },
    { path: 'stryker.config.json', mode: '100644', bytes: Buffer.from(canonicalJson(options)) },
  );
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const identity = canonicalSha256({
    input_digest: pkg.input_digest,
    package: input.package_snapshot.identity,
    files: files.map((entry) => ({
      path: entry.path,
      mode: entry.mode,
      size: entry.bytes.length,
      sha256: hash(entry.bytes),
    })),
  });
  const program: ProtectedMutationProgram = Object.freeze({
    kind: 'protected-mutation-program-v1',
    identity_sha256: identity,
  });
  programs.set(program, {
    identity_sha256: identity,
    files,
    argv: ['node', '/devai-host/run.mjs'],
    maximum_observation_bytes: maximumObservation,
    maximum_raw_report_bytes: limits.maximum_raw_report_bytes,
  });
  executionContexts.set(program, executionContext);
  packageInputs.set(program, {
    package: pkg,
    limits: JSON.parse(canonicalJson(limits)) as ReleaseMutationArtifactLimitsV21,
  });
  return program;
}

/** Exact factory-bound package inputs, never a caller-selected normalization projection. */
export function captureProtectedMutationProgramPackage(
  program: ProtectedMutationProgram,
): ProtectedMutationProgramPackage {
  const captured = packageInputs.get(program);
  if (captured === undefined || !programs.has(program)) return refuse();
  return JSON.parse(canonicalJson(captured)) as ProtectedMutationProgramPackage;
}

/**
 * Validate the actual container invocation before its first effect, not merely
 * the program's earlier input derivation. Every candidate member must be the
 * exact Git blob/mode from that plan; additional files cannot influence config
 * or test execution. Generated prerequisites need their own verified closure,
 * so an arbitrary caller-supplied prior-output map is never accepted here.
 */
export function assertProtectedMutationProgramExecution(
  program: ProtectedMutationProgram,
  input: {
    readonly container_identity: Readonly<Record<string, unknown>>;
    readonly environment: Readonly<Record<string, string>>;
    readonly source: readonly ContainerArchiveEntry[];
    readonly prior_outputs: ReadonlyMap<string, ContainerArchiveEntry>;
  },
): void {
  const expected = executionContexts.get(program);
  if (
    !programs.has(program) ||
    expected === undefined ||
    canonicalJson(input.container_identity) !== canonicalJson(expected.container_identity) ||
    canonicalJson(input.environment) !== canonicalJson(expected.environment) ||
    input.prior_outputs.size !== (expected.prerequisite_outputs?.length ?? 0) ||
    input.source.length !== expected.candidate_files.length
  )
    refuse();
  for (const member of expected.prerequisite_outputs ?? []) {
    const entry = input.prior_outputs.get(member.path);
    if (
      entry === undefined ||
      entry.path !== member.path ||
      entry.mode !== member.mode ||
      entry.bytes.length !== member.size ||
      hash(entry.bytes) !== member.sha256
    )
      refuse();
  }
  const members = new Map(expected.candidate_files.map((entry) => [entry.path, entry]));
  const seen = new Set<string>();
  const algorithm = expected.repository.commit.length === 40 ? 'sha1' : 'sha256';
  for (const entry of input.source) {
    const member = members.get(entry.path);
    if (
      member === undefined ||
      seen.has(entry.path) ||
      entry.mode !== member.mode ||
      !['100644', '100755'].includes(member.mode)
    )
      refuse();
    const bytes = Buffer.from(entry.bytes);
    const objectId = createHash(algorithm)
      .update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
      .update(bytes)
      .digest('hex');
    if (objectId !== member.object_id) refuse();
    seen.add(entry.path);
  }
}

/** Same-instance capability only; serialized lookalikes and caller-owned buffers are never used. */
export function captureProtectedMutationProgram(
  program: ProtectedMutationProgram,
): CapturedProtectedMutationProgram {
  const captured = programs.get(program);
  if (captured === undefined) return refuse();
  return {
    ...captured,
    argv: [...captured.argv],
    files: captured.files.map((entry) => ({ ...entry, bytes: Buffer.from(entry.bytes) })),
  };
}
