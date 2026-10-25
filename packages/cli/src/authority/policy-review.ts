import { performance } from 'node:perf_hooks';
import { canonicalSha256, sha256Bytes } from './policy-support.js';

type Document = Readonly<Record<string, unknown>>;

export interface AuthorityPolicyReview {
  start(): Document;
  confirm(confirmation: string): unknown;
  cancel(): Document;
}

function freeze(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}

/** Private host construction only: the printed report is never an apply capability. */
export function createAuthorityPolicyReview(input: {
  readonly ready: Document;
  readonly bytes: Uint8Array;
  readonly now?: () => number;
  readonly verifyActual: () => void;
  readonly publish: (bytes: Uint8Array) => unknown;
}): AuthorityPolicyReview {
  const bytes = Uint8Array.from(input.bytes);
  const verifyActual = input.verifyActual;
  const publish = input.publish;
  const sourceReady = JSON.parse(JSON.stringify(input.ready)) as Record<string, unknown>;
  const digest = sha256Bytes(bytes);
  const clock = input.now ?? (() => performance.now());
  let state: 'created' | 'waiting' | 'closed' = 'created';
  let started = 0;
  let report: Document;
  let planDigest = '';
  const handle: AuthorityPolicyReview = Object.freeze({
    start(): Document {
      if (this !== handle || state !== 'created')
        throw new Error('AUTHORITY_POLICY_REVIEW_HANDLE_INVALID');
      started = clock();
      const unsigned = {
        ...sourceReady,
        grants_authority: false,
        review_lifetime_ms: 300_000,
        expires_at: new Date(Date.now() + 300_000).toISOString(),
        artifact: {
          encoding: 'base64',
          bytes_base64: Buffer.from(bytes).toString('base64'),
          size_bytes: bytes.byteLength,
          sha256: digest,
        },
      };
      planDigest = canonicalSha256(unsigned);
      report = { ...unsigned, plan_sha256: planDigest };
      freeze(report);
      state = 'waiting';
      return report;
    },
    confirm(confirmation: string): unknown {
      if (this !== handle || state !== 'waiting')
        throw new Error('AUTHORITY_POLICY_REVIEW_HANDLE_INVALID');
      state = 'closed';
      if (clock() - started >= 300_000) throw new Error('AUTHORITY_POLICY_REVIEW_EXPIRED');
      if (confirmation !== `CREATE ${planDigest} ${digest}`)
        throw new Error('AUTHORITY_POLICY_REVIEW_CONFIRMATION_MISMATCH');
      const { plan_sha256: _hash, ...unsigned } = report;
      if (sha256Bytes(bytes) !== digest || canonicalSha256(unsigned) !== planDigest)
        throw new Error('AUTHORITY_POLICY_REVIEW_ARTIFACT_MISMATCH');
      verifyActual();
      // Never give the retained private buffer to an external callback.
      return publish(Uint8Array.from(bytes));
    },
    cancel(): Document {
      if (this !== handle || state === 'closed')
        throw new Error('AUTHORITY_POLICY_REVIEW_HANDLE_INVALID');
      state = 'closed';
      return Object.freeze({ status: 'cancelled', binding_performed: false });
    },
  });
  return handle;
}
