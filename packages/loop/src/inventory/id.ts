import { createHash } from 'node:crypto';

/**
 * Derive a content-hash inventory id with the given prefix from a
 * repo-relative path (or any canonical string input).
 *
 * Format: `<PREFIX>-<16hex>` where the 16 hex chars are the first 16 of
 * SHA-256(input). Matches the schema's pattern `^<PREFIX>-...$`.
 */
export function deriveInventoryId(prefix: string, input: string): string {
  const hash = createHash('sha256').update(input).digest('hex');
  return `${prefix}-${hash.slice(0, 16)}`;
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}
