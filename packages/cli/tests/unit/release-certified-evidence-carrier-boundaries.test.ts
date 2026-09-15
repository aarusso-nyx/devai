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

  it('authenticates the declared length of a canonical embedded document', () => {
    const value = JSON.parse(carrier({ taskPolicy: 0 }).toString('utf8')) as {
      task_policy: { size_bytes: number };
    };
    value.task_policy.size_bytes = 2;
    const encoded = bytes(value);

    expectRefusal(() => readCertifiedEvidenceCarrier(encoded, encoded.length));
  });

  it('authenticates the canonical base64 spelling of an embedded document', () => {
    const value = JSON.parse(carrier({ taskPolicy: 0 }).toString('utf8')) as {
      task_policy: { bytes_base64: string };
    };
    value.task_policy.bytes_base64 = 'MB==';
    const encoded = bytes(value);

    expect(Buffer.from('MB==', 'base64')).toEqual(Buffer.from('0'));
    expectRefusal(() => readCertifiedEvidenceCarrier(encoded, encoded.length));
  });

  it('authenticates the declared digest of an embedded document', () => {
    const value = JSON.parse(carrier({ taskPolicy: 0 }).toString('utf8')) as {
      task_policy: { sha256: string };
    };
    value.task_policy.sha256 = '0'.repeat(64);
    const encoded = bytes(value);

    expectRefusal(() => readCertifiedEvidenceCarrier(encoded, encoded.length));
  });

  it('requires the namespace census document to preserve canonical entry order', () => {
    const value = JSON.parse(carrier().toString('utf8')) as Record<string, unknown>;
    const namespaceDocument = value.namespace_census as { bytes_base64: string };
    const namespace = JSON.parse(
      Buffer.from(namespaceDocument.bytes_base64, 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    namespace.entries = [
      {
        path: 'dist/z.js',
        mode: '100644',
        sha256: 'f'.repeat(64),
        size_bytes: 2,
        task_node: 'build',
      },
      {
        path: 'dist/a.js',
        mode: '100644',
        sha256: 'e'.repeat(64),
        size_bytes: 1,
        task_node: 'build',
      },
    ];
    value.namespace_census = document(bytes(namespace));
    const encoded = bytes(value);

    expectRefusal(() => readCertifiedEvidenceCarrier(encoded, encoded.length));
  });

  it('maps a typed-array carrier input to the stable public refusal', () => {
    const encoded = Uint8Array.from(bytes({}));

    expectRefusal(() => readCertifiedEvidenceCarrier(encoded as never, MAXIMUM));
  });

  it.each([
    ['schema version', 'schemaVersion', '2.0.0'],
    ['carrier kind', 'kind', 'devai.release-certified-evidence-carrier-json.v2'],
  ] as const)('binds the top-level %s identity', (_label, key, replacement) => {
    const value = JSON.parse(carrier().toString('utf8')) as Record<string, unknown>;
    value[key] = replacement;
    const encoded = bytes(value);

    expectRefusal(() => readCertifiedEvidenceCarrier(encoded, encoded.length));
  });

  it('binds the authenticated task-policy bytes to the protected derivation', () => {
    const value = JSON.parse(carrier().toString('utf8')) as Record<string, unknown>;
    value.task_policy = document(bytes({ tasks: ['test'] }));
    const encoded = bytes(value);

    expectRefusal(() => readCertifiedEvidenceCarrier(encoded, encoded.length));
  });
});
