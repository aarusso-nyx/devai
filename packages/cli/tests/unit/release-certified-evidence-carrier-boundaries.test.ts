import { createHash } from 'node:crypto';
import { canonicalJson } from '@devai-nyx/utils';
import { describe, expect, it } from 'vitest';
import {
  createCertifiedEvidenceCarrier,
  finalizeCertifiedEvidenceNamespaceCensus,
  readCertifiedEvidenceCarrier,
} from '../../src/services/release-certified-evidence-carrier.js';

const ERROR = 'release-certified-evidence-carrier-invalid';
const MAXIMUM = 1_048_576;
const COMMIT = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const UNIT = '@fixture/carrier';

function bytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8');
}

function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function document(value: Buffer): {
  readonly sha256: string;
  readonly size_bytes: number;
  readonly bytes_base64: string;
} {
  return {
    sha256: digest(value),
    size_bytes: value.length,
    bytes_base64: value.toString('base64'),
  };
}

function identities(commit = COMMIT, tree = TREE, taskPolicy: unknown = { tasks: ['build'] }) {
  const taskPolicyDigest = digest(bytes(taskPolicy));
  const repository = { id: 'fixture/repository', commit, tree };
  return {
    repository,
    derivation: {
      repository,
      candidate: { commit, tree },
      task_policy_digest_sha256: taskPolicyDigest,
    },
    taskPolicy,
    taskPolicyDigest,
  };
}

function carrier(
  input: {
    readonly commit?: string;
    readonly tree?: string;
    readonly taskPolicy?: unknown;
    readonly taskPolicyDigest?: string;
  } = {},
): Buffer {
  const value = identities(input.commit, input.tree, input.taskPolicy);
  const derivation = {
    ...value.derivation,
    task_policy_digest_sha256: input.taskPolicyDigest ?? value.taskPolicyDigest,
  };
  const result = { nodeId: 'build', status: 'PASS' };
  const receipt = {
    repository: value.repository,
    taskPolicyDigest: derivation.task_policy_digest_sha256,
    tasks: [{ resultDigest: digest(bytes(result)) }],
  };
  const census = finalizeCertifiedEvidenceNamespaceCensus({
    release_unit: UNIT,
    derivation,
    entries: [],
  });
  return createCertifiedEvidenceCarrier({
    release_unit: UNIT,
    derivation,
    candidate_receipt: receipt,
    task_policy: value.taskPolicy,
    task_results: [result],
    namespace_census: census,
    maximum_bytes: MAXIMUM,
  });
}

function expectRefusal(run: () => unknown): void {
  expect(run).toThrowError(new Error(ERROR));
}

describe('certified evidence carrier scalar and byte boundaries', () => {
  it.each([
    [
      'a census member digest with a trailing hex byte',
      () =>
        finalizeCertifiedEvidenceNamespaceCensus({
          release_unit: UNIT,
          derivation: identities().derivation,
          entries: [
            {
              path: 'dist/output.js',
              mode: '100644',
              sha256: 'c'.repeat(65),
              size_bytes: 1,
              task_node: 'build',
            },
          ],
        }),
    ],
    [
      '41-character candidate and repository object identities',
      () => carrier({ commit: 'a'.repeat(41), tree: 'b'.repeat(41) }),
    ],
    [
      'non-hex 64-character candidate and repository object identities',
      () => carrier({ commit: 'g'.repeat(64), tree: 'h'.repeat(64) }),
    ],
  ] as const)('refuses %s through the public constructor', (_description, construct) => {
    expectRefusal(construct);
  });

  it.each([null, [], 'not-an-object'] as const)(
    'reports the stable refusal for a non-plain derivation %#',
    (derivation) => {
      expectRefusal(() =>
        finalizeCertifiedEvidenceNamespaceCensus({
          release_unit: UNIT,
          derivation,
          entries: [],
        }),
      );
    },
  );

  it('accepts and decodes a canonical one-byte task-policy document', () => {
    const encoded = carrier({ taskPolicy: 0 });
    const decoded = readCertifiedEvidenceCarrier(encoded, encoded.length);

    expect(decoded.task_policy).toEqual(Buffer.from('0'));
    expect(decoded.carrier.task_policy).toEqual(document(Buffer.from('0')));
  });

  it('refuses an otherwise authentic embedded document with an extra member', () => {
    const value = JSON.parse(carrier().toString('utf8')) as Record<string, unknown>;
    value.task_policy = { ...(value.task_policy as object), extra: true };
    const encoded = bytes(value);

    expectRefusal(() => readCertifiedEvidenceCarrier(encoded, encoded.length));
  });

  it('maps malformed embedded JSON to the carrier refusal after authenticating its bytes', () => {
    const value = JSON.parse(carrier().toString('utf8')) as Record<string, unknown>;
    value.candidate_receipt = document(Buffer.from('{', 'utf8'));
    const encoded = bytes(value);

    expectRefusal(() => readCertifiedEvidenceCarrier(encoded, encoded.length));
  });
});
