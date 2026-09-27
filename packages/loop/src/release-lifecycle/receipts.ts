import { parsers } from '@devai-nyx/schemas';
import { canonicalSha256 } from '@devai-nyx/utils';
import type {
  ReleasePlanReceipt,
  ReleaseOfflineVerificationReceipt,
  ReleasePublicationReceipt,
} from './types.js';

function omitTopLevel(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('canonical release document must be an object');
  }
  const excluded = new Set(keys);
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>).filter(
      ([key]) => !excluded.has(key),
    ),
  );
}

export function same(left: unknown, right: unknown): boolean {
  return canonicalSha256(left) === canonicalSha256(right);
}

export function computeReleaseStateRecordDigest(record: unknown): string {
  return canonicalSha256(omitTopLevel(record, ['record_digest_sha256']));
}

export function computeReleaseReadReceiptDigest(receipt: unknown): string {
  return canonicalSha256(omitTopLevel(receipt, ['receipt_id', 'receipt_digest_sha256']));
}

export function finalizeReleasePlanReceipt(
  draft: Omit<ReleasePlanReceipt, 'receipt_id' | 'receipt_digest_sha256'>,
): ReleasePlanReceipt {
  const digest = canonicalSha256(draft);
  const parser =
    draft.schemaVersion === '2.0.0' ? parsers.releasePlanReceiptV2 : parsers.releasePlanReceipt;
  return parser.parse<ReleasePlanReceipt>({
    ...draft,
    receipt_id: `RPL-${digest.slice(0, 16)}`,
    receipt_digest_sha256: digest,
  });
}

export function finalizeReleaseOfflineVerificationReceipt(
  draft: Omit<ReleaseOfflineVerificationReceipt, 'receipt_id' | 'receipt_digest_sha256'>,
): ReleaseOfflineVerificationReceipt {
  const digest = canonicalSha256(draft);
  return parsers.releaseOfflineVerificationReceipt.parse<ReleaseOfflineVerificationReceipt>({
    ...draft,
    receipt_id: `ROV-${digest.slice(0, 16)}`,
    receipt_digest_sha256: digest,
  });
}

export function verifyReleasePlanReceiptIdentity(
  receiptInput: unknown,
): receiptInput is ReleasePlanReceipt {
  const version =
    receiptInput !== null && typeof receiptInput === 'object' && 'schemaVersion' in receiptInput
      ? receiptInput.schemaVersion
      : undefined;
  const parser = version === '2.0.0' ? parsers.releasePlanReceiptV2 : parsers.releasePlanReceipt;
  const parsed = parser.safeParse<ReleasePlanReceipt>(receiptInput);
  if (!parsed.ok) return false;
  const digest = computeReleaseReadReceiptDigest(parsed.value);
  return (
    parsed.value.receipt_digest_sha256 === digest &&
    parsed.value.receipt_id === `RPL-${digest.slice(0, 16)}`
  );
}

export function verifyReleaseOfflineReceiptIdentity(
  receiptInput: unknown,
): receiptInput is ReleaseOfflineVerificationReceipt {
  const parsed =
    parsers.releaseOfflineVerificationReceipt.safeParse<ReleaseOfflineVerificationReceipt>(
      receiptInput,
    );
  if (!parsed.ok) return false;
  const digest = computeReleaseReadReceiptDigest(parsed.value);
  return (
    parsed.value.receipt_digest_sha256 === digest &&
    parsed.value.receipt_id === `ROV-${digest.slice(0, 16)}`
  );
}

export function computePublicationSignedPayloadDigest(receipt: ReleasePublicationReceipt): string {
  const projection = omitTopLevel(receipt, ['receipt_id', 'receipt_digest_sha256']);
  const trust = { ...(projection['trust'] as Readonly<Record<string, unknown>>) };
  delete trust['signature'];
  delete trust['signed_payload_digest_sha256'];
  return canonicalSha256({ ...projection, trust });
}

export function computePublicationReceiptDigest(receipt: ReleasePublicationReceipt): string {
  return canonicalSha256(omitTopLevel(receipt, ['receipt_digest_sha256']));
}
