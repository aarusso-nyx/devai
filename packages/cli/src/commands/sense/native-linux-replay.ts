import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { canonicalize, sha256Hex } from '../../services/check-runner/canonical.js';
import { deriveNativeLinuxTask } from './native-linux-plan.js';
import {
  inspectNativeInputProvenance,
  inspectNativeConfigurationSelection,
} from './native-input-provenance.js';
import { inspectNativeTestResults, type NativeTestResultContract } from './native-test-results.js';
import type { NativeServiceControlContext } from '../../native-service-docker-broker.js';
import { validNativeRedisProcessControl } from '../../native-service-docker-broker.js';
import type { NativeServiceParentExchange } from './native-service-replay.js';

const refuse = (code: string): never => {
  throw new Error(`NATIVE_LINUX_REPLAY_${code}`);
};
type Row = Record<string, unknown>;
const closed = (value: unknown, keys: readonly string[]): value is Row =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  canonicalize(Object.keys(value).sort()) === canonicalize([...keys].sort());
const hex = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);

/** Runs after task quiescence on the same immutable Linux snapshots; this never grants origin. */
export function replayNativeLinuxTask(raw: string): Readonly<Record<string, unknown>> {
  if (Buffer.byteLength(raw) > 132 * 1024 * 1024) return refuse('INPUT_TOO_LARGE');
  const input: unknown = JSON.parse(raw);
  if (
    !closed(input, [
      'schemaVersion',
      'nonce',
      'portableInput',
      'derived',
      'service',
      'execution',
      'trace',
    ]) ||
    input['schemaVersion'] !== '1.0.0' ||
    !hex(input['nonce']) ||
    !closed(input['portableInput'], ['json', 'sha256']) ||
    typeof input['portableInput']['json'] !== 'string' ||
    !hex(input['portableInput']['sha256']) ||
    sha256Hex(Buffer.from(input['portableInput']['json'])) !== input['portableInput']['sha256'] ||
    !closed(input['service'], ['context', 'exchanges']) ||
    !Array.isArray(input['service']['exchanges']) ||
    input['service']['exchanges'].length > 1024 ||
    !closed(input['execution'], [
      'status',
      'signal',
      'stdout',
      'stderr',
      'stdoutSha256',
      'stderrSha256',
    ]) ||
    typeof input['execution']['stdout'] !== 'string' ||
    typeof input['execution']['stderr'] !== 'string' ||
    !hex(input['execution']['stdoutSha256']) ||
    !hex(input['execution']['stderrSha256']) ||
    !(
      input['execution']['status'] === null ||
      (Number.isInteger(input['execution']['status']) &&
        Number(input['execution']['status']) >= 0 &&
        Number(input['execution']['status']) <= 255)
    ) ||
    !(
      input['execution']['signal'] === null ||
      (typeof input['execution']['signal'] === 'string' &&
        /^SIG[A-Z0-9]{1,20}$/u.test(input['execution']['signal']))
    ) ||
    !closed(input['trace'], ['path', 'sha256']) ||
    input['trace']['path'] !== '/evidence/trace.jsonl' ||
    !hex(input['trace']['sha256'])
  )
    return refuse('INPUT_INVALID');
  const derived = deriveNativeLinuxTask(input['portableInput']['json']);
  if (
    derived.nonce !== input['nonce'] ||
    derived.inputSha256 !== input['portableInput']['sha256'] ||
    canonicalize(derived) !== canonicalize(input['derived'])
  )
    return refuse('PLAN_CHANGED');
  const context = input['service']['context'] as NativeServiceControlContext;
  if (
    !closed(context, [
      'schemaVersion',
      'nonce',
      'repository',
      'candidate',
      'taskId',
      'population',
      'backend',
      'socket',
      'kinds',
      'redisProcessControl',
      'limits',
    ]) ||
    context.schemaVersion !== '1.0.0' ||
    context.nonce !== derived.nonce ||
    context.repository !== '/workspace' ||
    context.candidate !== derived.plan.repository.commit ||
    context.taskId !== derived.task.nodeId ||
    context.population !== derived.task.outputContract['population'] ||
    !validNativeRedisProcessControl(context.redisProcessControl) ||
    (context.redisProcessControl !== null && !context.kinds.includes('redis'))
  )
    return refuse('SERVICE_CONTEXT_MISMATCH');
  const execution = input['execution'];
  const stdout = execution['stdout'],
    stderr = execution['stderr'];
  if (typeof stdout !== 'string' || typeof stderr !== 'string') return refuse('INPUT_INVALID');
  if (
    Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 64 * 1024 * 1024 ||
    sha256Hex(Buffer.from(stdout)) !== execution['stdoutSha256'] ||
    sha256Hex(Buffer.from(stderr)) !== execution['stderrSha256']
  )
    return refuse('OUTPUT_CHANGED');
  const tracePath = input['trace']['path'];
  const stat = lstatSync(tracePath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > 64 * 1024 * 1024 ||
    realpathSync(tracePath) !== tracePath
  )
    return refuse('TRACE_INVALID');
  const bytes = readFileSync(tracePath);
  if (sha256Hex(bytes) !== input['trace']['sha256']) return refuse('TRACE_CHANGED');
  const contract = derived.task.outputContract['resultPopulation'] as NativeTestResultContract;
  const result = inspectNativeTestResults(contract, stdout, stderr, {
    repoRoot: '/workspace',
    collectionNonce: derived.nonce,
  });
  const findings = [
    ...inspectNativeConfigurationSelection('/workspace', stdout),
    ...inspectNativeInputProvenance(
      '/workspace',
      derived.nonce,
      bytes.toString('utf8'),
      stdout,
      derived.task,
      { context, exchanges: input['service']['exchanges'] as NativeServiceParentExchange[] },
    ),
    ...result.findings,
  ];
  const body = {
    schemaVersion: '1.0.0',
    nonce: derived.nonce,
    kind: 'linux-task-replay',
    reconstructedPlanDigest: derived.digest,
    result,
    findings: [...new Set(findings)].sort(),
    traceSha256: sha256Hex(bytes),
    stdoutSha256: execution['stdoutSha256'],
    stderrSha256: execution['stderrSha256'],
    complete:
      execution['status'] === 0 &&
      execution['signal'] === null &&
      result.status === 'pass' &&
      findings.length === 0,
  };
  return Object.freeze({ ...body, replaySha256: sha256Hex(body) });
}
