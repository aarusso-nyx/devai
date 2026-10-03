// Invariants: INV-CORE-003, INV-HARNESS-006, INV-DEVAI-002, INV-DEVAI-003
// Fetch and consume authentic bytes in one process. No serialized verifier handles.
import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson } from '../../packages/utils/dist/index.js';
import { getValidator, extractStructuredReply } from '../../packages/schemas/dist/index.js';
import { fetchCiInvariantEvidence } from './fetch-ci-invariant-evidence.mjs';
const built = new URL('../../packages/sensors/dist/ci-invariant-gate.js', import.meta.url);
const gate = await import(
  existsSync(built)
    ? built.href
    : new URL('../../packages/sensors/src/ci-invariant-gate.ts', import.meta.url).href
);
const demand = (v) => {
  if (!v) throw new Error('CI_INVARIANT_GATE_REFUSED');
};
const canonical = (v) => Buffer.from(canonicalJson(v));
const hash = gate.evidenceSha256;
export function checkCiInvariantGate({ rawEvidence, hostObservation, gateInput }) {
  const verifiedSoftEvidence = gate.verifySoftGatePayload(rawEvidence);
  demand(verifiedSoftEvidence.status === 'pass');
  const verifiedHostObservation = gate.verifySoftGateHostObservation(hostObservation);
  demand(verifiedHostObservation.status === 'pass');
  const softEvidenceCustody = {
    verifiedPayload: verifiedSoftEvidence,
    trustBytes: rawEvidence.trustBytes,
    members: rawEvidence.members,
    expected: rawEvidence.expected,
    now: rawEvidence.now,
  };
  const result = gate.evaluateCiInvariantGate({
    ...gateInput,
    verifiedSoftEvidence,
    verifiedHostObservation,
    softEvidenceCustody,
    hostObservation,
  });
  demand(result.status === 'pass');
  return result;
}
/** Reopen all authenticated observations; executable bytes are pinned by external control trust. */
export function reopenHostObservation(raw) {
  const manifest = gate.canonicalEvidenceObject(
    raw.manifestBytes,
    'soft-gate-evidence.schema.json',
  );
  const role = (r) => {
    const b = raw.members.get(manifest.payload_roles[r]);
    demand(b);
    return b;
  };
  const control = JSON.parse(Buffer.from(role('control_observation')).toString());
  const invocation = JSON.parse(Buffer.from(role('invocation_envelope')).toString());
  const executable = raw.members.get('producer-executable.bin'),
    version = raw.members.get('host-version.txt');
  demand(executable && version);
  // Probe exit statuses come only from the signed control observation; absent or non-integer
  // statuses refuse instead of being filled in.
  demand(
    Number.isSafeInteger(control.versionStatus) && Number.isSafeInteger(control.hostHelpStatus),
  );
  const selectedControls = Object.fromEntries(
    [
      'executablePath',
      'executableSha256',
      'version',
      'hostHelpSha256',
      'configurationSha256',
      'argvSha256',
      'versionStatus',
      'hostHelpStatus',
    ].map((k) => [k, control[k]]),
  );
  // stderr is not retained as a member; the empty stream is bound by the signed
  // invocation_envelope stderr_sha256 checked below, and the gate requires it to be empty.
  const stdout = role('host_envelope'),
    stderr = Buffer.alloc(0);
  demand(hash(stdout) === invocation.stdout_sha256 && hash(stderr) === invocation.stderr_sha256);
  return {
    workingAgent: manifest.working_agent,
    evaluator: manifest.evaluator,
    executable: { path: control.executablePath, bytes: executable },
    version: { status: control.versionStatus, stdout: version },
    hostHelp: { status: control.hostHelpStatus, stdout: role('host_help_observation') },
    configuration: JSON.parse(Buffer.from(role('configuration_observation')).toString()),
    configurationBytes: role('configuration_observation'),
    selectedControls,
    invocation: {
      process_instance_id: invocation.process_instance_id,
      argv: invocation.argv,
      status: invocation.status,
      stdout,
      stderr,
    },
  };
}
function validateCheckReport(report, member) {
  demand(
    report.ok === true &&
      report.execution_status === 'pass' &&
      report.readiness_status === 'pass' &&
      report.exit_code === 0 &&
      report.selection?.kind === 'only' &&
      report.selection.member === member &&
      Array.isArray(report.results) &&
      report.results.length === 1,
  );
  demand(
    report.results[0].status === 'pass' &&
      (report.results[0].exit_code === undefined || report.results[0].exit_code === 0),
  );
}
function validateRunnerReport(report, target, candidate) {
  demand(
    report.schemaVersion === '1.0.0' &&
      report.operation === 'run' &&
      report.exitCode === 0 &&
      report.plan?.target === target &&
      report.plan.repository.commit === candidate.commit &&
      report.plan.repository.tree === candidate.tree &&
      report.plan.baseCommit === candidate.base_commit &&
      Array.isArray(report.plan.tasks) &&
      report.plan.tasks.length > 0 &&
      Array.isArray(report.execution) &&
      report.execution.length === report.plan.tasks.length,
  );
  const ids = new Set();
  for (const task of report.plan.tasks) {
    demand(!ids.has(task.nodeId));
    ids.add(task.nodeId);
    const values = report.execution.filter(
      (e) => e.nodeId === task.nodeId && e.taskKey === task.taskKey,
    );
    demand(
      values.length === 1 &&
        values[0].outcome === 'PASS' &&
        ['executed', 'reused'].includes(values[0].disposition) &&
        /^[a-f0-9]{64}$/u.test(values[0].resultDigest ?? '') &&
        (values[0].exitCode === undefined || values[0].exitCode === 0),
    );
  }
}
export async function runCiInvariantGate({
  repoRoot,
  base,
  trustBytes,
  reports,
  now = new Date().toISOString(),
  fetchImpl,
  token,
}) {
  const root = resolve(repoRoot),
    git = (args) =>
      execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      }).trim();
  const candidate = {
    commit: git(['rev-parse', 'HEAD']),
    tree: git(['rev-parse', 'HEAD^{tree}']),
    base_commit: git(['rev-parse', base]),
  };
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const selected =
    process.env.GITHUB_EVENT_NAME === 'merge_group'
      ? { commit: event.merge_group?.head_sha, base: event.merge_group?.base_sha }
      : { commit: event.pull_request?.head?.sha, base: event.pull_request?.base?.sha };
  demand(
    ['pull_request', 'merge_group'].includes(process.env.GITHUB_EVENT_NAME) &&
      candidate.commit === selected.commit &&
      candidate.base_commit === selected.base,
  );
  const trust = gate.canonicalEvidenceObject(trustBytes, 'soft-gate-trust.schema.json');
  demand(canonical(candidate).equals(canonical(trust.candidate)));
  validateCheckReport(reports.trace, 'trace');
  validateCheckReport(reports.testTrace, 'test-trace');
  validateRunnerReport(reports.preflight, 'preflight', candidate);
  validateRunnerReport(reports.affected, 'affected', candidate);
  demand(
    getValidator('scorecard.schema.json')(reports.scorecard) &&
      reports.scorecard.integration_head === candidate.commit &&
      reports.scorecard.overall.verdict === 'PASS',
  );
  const sourceFiles = new Map();
  for (const entry of git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean)) {
    const match = /^(100644|100755) ([a-f0-9]{40}) 0\t(.+)$/su.exec(entry);
    demand(match && gate.containedEvidencePath(match[3]));
    const path = match[3];
    demand(lstatSync(join(root, path)).isFile());
    sourceFiles.set(path, readFileSync(join(root, path)));
  }
  const invariants = readdirSync(join(root, 'law/invariants'))
    .filter((p) => p.endsWith('.json'))
    .sort()
    .map((p) => JSON.parse(readFileSync(join(root, 'law/invariants', p), 'utf8')))
    .map((i) => ({ id: i.id, severity: i.status === 'active' ? i.severity : 'advisory' }));
  const trace = JSON.parse(readFileSync(join(root, 'law/trace.json'), 'utf8'));
  demand(getValidator('trace.schema.json')(trace));
  const traceEntries = trace.invariants.map((i) => ({
    invariant_id: i.id,
    tests: i.tests.map((t) => t.path),
  }));
  const hardVerdicts = reports.scorecard.invariant_rollups
    .filter((i) => i.invariant_id !== 'INV-HARNESS-006')
    .map((i) => ({ invariant_id: i.invariant_id, status: i.verdict.toLowerCase() }));
  const expected = {
    repository: 'aarusso-nyx/devai',
    evidenceCommit: trust.evidence_commit,
    candidate,
    producerControl: trust.producer_control,
    workingAgent: trust.working_agent,
    boundInputs: {},
  };
  // An ambient token is used only when a caller supplies one; the PR soft-gate step declares
  // none (law/policy/credential-requirements.json), so it uses the unauthenticated budget.
  const raw = await fetchCiInvariantEvidence({ trustBytes, expected, now, fetchImpl, token });
  const manifest = gate.canonicalEvidenceObject(
    raw.manifestBytes,
    'soft-gate-evidence.schema.json',
  );
  const role = (r) => {
    const b = raw.members.get(manifest.payload_roles[r]);
    demand(b);
    return b;
  };
  const thresholdBytes = readFileSync(join(root, '.devai/config/thresholds.json'));
  const thresholdSha256 = hash(thresholdBytes);
  const thresholds = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(thresholdBytes));
  demand(getValidator('thresholds.schema.json')(thresholds));
  const boundInputs = {
    source_population_sha256: hash(
      canonical(
        [...sourceFiles].map(([path, b]) => ({ path, byte_length: b.length, sha256: hash(b) })),
      ),
    ),
    lockfile_population_sha256: hash(readFileSync(join(root, 'pnpm-lock.yaml'))),
    toolchain_sha256: trust.producer_control.executable_sha256,
    task_roster_sha256: hash(canonical(hardVerdicts)),
    context_sha256: hash(role('context_inventory')),
    rubric_sha256: hash(
      canonical(JSON.parse(readFileSync(join(root, 'law/policy/soft-gate-rubric.json'), 'utf8'))),
    ),
    thresholds_sha256: thresholdSha256,
    configuration_sha256: hash(role('configuration_observation')),
    inventory_sha256: hash(role('inventory_observation')),
    host_help_sha256: hash(role('host_help_observation')),
  };
  expected.boundInputs = boundInputs;
  raw.expected = expected;
  raw.sourceFiles = sourceFiles;
  const score = extractStructuredReply(
    { text: Buffer.from(role('score_reply')).toString(), finish_reason: 'stop' },
    'soft-gate-score.schema.json',
  );
  demand(score.ok);
  const hostObservation = reopenHostObservation(raw);
  const trackedTestPaths = [...sourceFiles.keys()].filter(
    (p) => /(?:^|\/)tests\//u.test(p) && /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(p),
  );
  const gateInput = {
    invariants,
    traceEntries,
    hardVerdicts,
    candidate,
    producerControl: expected.producerControl,
    workingAgent: expected.workingAgent,
    boundInputs,
    testFiles: new Map(trackedTestPaths.map((p) => [p, sourceFiles.get(p)])),
    trackedTestPaths,
    scoreInput: {
      score: score.document,
      rubric: JSON.parse(Buffer.from(role('effective_rubric')).toString()),
      thresholds,
      thresholdBytes,
      sourceFiles,
    },
  };
  // Recheck actual candidate and source bytes after network observation, before consumption.
  demand(
    candidate.commit === git(['rev-parse', 'HEAD']) &&
      candidate.tree === git(['rev-parse', 'HEAD^{tree}']) &&
      candidate.base_commit === git(['rev-parse', base]),
  );
  for (const [path, bytes] of sourceFiles)
    demand(
      lstatSync(join(root, path)).isFile() && hash(readFileSync(join(root, path))) === hash(bytes),
    );
  return checkCiInvariantGate({ rawEvidence: raw, hostObservation, gateInput });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 2) {
    demand(process.argv[i]?.startsWith('--') && process.argv[i + 1] && !args.has(process.argv[i]));
    args.set(process.argv[i], process.argv[i + 1]);
  }
  // The base is the one job-bound DEVAI_PREFLIGHT_BASE (ADR-CHK-0004 binds it once per job);
  // it is never a separate argument that could diverge from the preflight/affected base.
  const base = process.env.DEVAI_PREFLIGHT_BASE ?? '';
  demand(
    args.get('--fetch-script') === 'scripts/process/fetch-ci-invariant-evidence.mjs' &&
      !args.has('--base') &&
      args.size === 6 &&
      /^[a-f0-9]{40}$/u.test(base),
  );
  const load = (k) => JSON.parse(readFileSync(args.get(k), 'utf8'));
  const result = await runCiInvariantGate({
    repoRoot: process.cwd(),
    base,
    trustBytes: Buffer.from(process.env.DEVAI_SOFT_GATE_TRUST_JSON ?? ''),
    reports: {
      preflight: load('--preflight'),
      affected: load('--affected'),
      trace: load('--trace'),
      testTrace: load('--test-trace'),
      scorecard: load('--scorecard'),
    },
  });
  process.stdout.write(JSON.stringify(result) + '\n');
}
