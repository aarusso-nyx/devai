import { createHash } from 'node:crypto';
import { canonicalJson } from '@devai-nyx/utils';

const SHA256 = /^[a-f0-9]{64}$/u;
const ERROR = 'release-certified-evidence-carrier-invalid';

export interface CertifiedEvidenceByteDocument {
  readonly sha256: string;
  readonly size_bytes: number;
  readonly bytes_base64: string;
}

export interface CertifiedEvidenceCarrier {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'devai.release-certified-evidence-carrier-json.v1';
  readonly release_unit: string;
  readonly candidate_receipt: CertifiedEvidenceByteDocument;
  readonly task_policy: CertifiedEvidenceByteDocument;
  readonly task_results: readonly CertifiedEvidenceByteDocument[];
  readonly namespace_census: CertifiedEvidenceByteDocument;
}

function fail(): never {
  throw new Error(ERROR);
}
function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
function canonical(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8');
}
function document(value: unknown, maximum: number): CertifiedEvidenceByteDocument {
  const bytes = canonical(value);
  if (bytes.length < 1 || bytes.length > maximum) fail();
  return { sha256: digest(bytes), size_bytes: bytes.length, bytes_base64: bytes.toString('base64') };
}
function decode(value: unknown, maximum: number): Buffer {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
  const entry = value as Record<string, unknown>;
  const size = entry.size_bytes;
  if (
    Object.keys(entry).length !== 3 ||
    typeof entry.sha256 !== 'string' ||
    !SHA256.test(entry.sha256) ||
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > maximum ||
    typeof entry.bytes_base64 !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(entry.bytes_base64)
  )
    fail();
  const bytes = Buffer.from(entry.bytes_base64, 'base64');
  if (
    bytes.length !== size ||
    bytes.toString('base64') !== entry.bytes_base64 ||
    digest(bytes) !== entry.sha256
  )
    fail();
  try {
    if (!bytes.equals(canonical(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))))) fail();
  } catch {
    fail();
  }
  return bytes;
}
function receiptResultDigests(receipt: unknown): readonly string[] {
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) fail();
  const tasks = (receipt as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) fail();
  const values = tasks.map((task) => {
    if (
      task === null ||
      typeof task !== 'object' ||
      Array.isArray(task) ||
      typeof (task as { resultDigest?: unknown }).resultDigest !== 'string' ||
      !SHA256.test((task as { resultDigest: string }).resultDigest)
    )
      fail();
    return (task as { resultDigest: string }).resultDigest;
  });
  if (new Set(values).size !== values.length) fail();
  return values.sort();
}

/** Pure carrier construction; persistence and signing stay in their protected host boundaries. */
export function createCertifiedEvidenceCarrier(input: {
  readonly release_unit: string;
  readonly candidate_receipt: unknown;
  readonly task_policy: unknown;
  readonly task_results: readonly unknown[];
  readonly namespace_census: unknown;
  readonly maximum_bytes: number;
}): Buffer {
  if (
    typeof input.release_unit !== 'string' ||
    input.release_unit.length === 0 ||
    !Number.isSafeInteger(input.maximum_bytes) ||
    input.maximum_bytes < 1 ||
    !Array.isArray(input.task_results)
  )
    fail();
  const candidateReceipt = document(input.candidate_receipt, input.maximum_bytes);
  const taskPolicy = document(input.task_policy, input.maximum_bytes);
  const results = input.task_results.map((result) => document(result, input.maximum_bytes));
  const namespaceCensus = document(input.namespace_census, input.maximum_bytes);
  const receiptDigests = receiptResultDigests(input.candidate_receipt);
  if (
    results.length !== receiptDigests.length ||
    results.some((result, index) => result.sha256 !== receiptDigests[index])
  )
    fail();
  const carrier: CertifiedEvidenceCarrier = {
    schemaVersion: '1.0.0',
    kind: 'devai.release-certified-evidence-carrier-json.v1',
    release_unit: input.release_unit,
    candidate_receipt: candidateReceipt,
    task_policy: taskPolicy,
    task_results: results,
    namespace_census: namespaceCensus,
  };
  const bytes = canonical(carrier);
  if (bytes.length > input.maximum_bytes) fail();
  return bytes;
}

/** Decodes only canonical, self-authenticating documents and returns detached byte copies. */
export function readCertifiedEvidenceCarrier(
  bytes: Buffer,
  maximum_bytes: number,
): {
  readonly carrier: CertifiedEvidenceCarrier;
  readonly candidate_receipt: Buffer;
  readonly task_policy: Buffer;
  readonly task_results: readonly Buffer[];
  readonly namespace_census: Buffer;
} {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > maximum_bytes) fail();
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail();
  }
  if (!bytes.equals(canonical(value)) || value === null || typeof value !== 'object' || Array.isArray(value))
    fail();
  const carrier = value as CertifiedEvidenceCarrier;
  if (
    Object.keys(carrier).length !== 7 ||
    carrier.schemaVersion !== '1.0.0' ||
    carrier.kind !== 'devai.release-certified-evidence-carrier-json.v1' ||
    typeof carrier.release_unit !== 'string' ||
    carrier.release_unit.length === 0 ||
    !Array.isArray(carrier.task_results)
  )
    fail();
  const candidateReceipt = decode(carrier.candidate_receipt, maximum_bytes);
  const taskPolicy = decode(carrier.task_policy, maximum_bytes);
  const results = carrier.task_results.map((result) => decode(result, maximum_bytes));
  const namespaceCensus = decode(carrier.namespace_census, maximum_bytes);
  const receiptDigests = receiptResultDigests(JSON.parse(candidateReceipt.toString('utf8')));
  if (
    results.length !== receiptDigests.length ||
    results.some((result, index) => digest(result) !== receiptDigests[index])
  )
    fail();
  return {
    carrier: JSON.parse(canonicalJson(carrier)) as CertifiedEvidenceCarrier,
    candidate_receipt: Buffer.from(candidateReceipt),
    task_policy: Buffer.from(taskPolicy),
    task_results: results.map((result) => Buffer.from(result)),
    namespace_census: Buffer.from(namespaceCensus),
  };
}
