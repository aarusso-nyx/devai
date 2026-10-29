import { createHash } from 'node:crypto';
import { getValidator } from '@devai-nyx/schemas';

export type SourceExpected =
  Readonly<{ kind: 'absent' }> | Readonly<{ kind: 'file'; sha256: string; mode: number }>;

export interface SourceManifest {
  readonly schemaVersion: '1.0.0';
  readonly target: string;
  readonly expected: SourceExpected;
  readonly content_utf8: string;
  readonly content_sha256: string;
}

const digest = /^[a-f0-9]{64}$/u;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const keysAre = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

/** Parse data only; the invocation and effective policy supply authority separately. */
export function parseSourceManifest(raw: string): SourceManifest {
  const invalid = (): never => {
    throw new Error('SOURCE_MANIFEST_INVALID');
  };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return invalid();
  }
  if (!getValidator('source-apply-manifest.schema.json')(value)) return invalid();
  if (
    !record(value) ||
    !keysAre(value, ['schemaVersion', 'target', 'expected', 'content_utf8', 'content_sha256'])
  )
    return invalid();
  const { target, expected, content_utf8: content, content_sha256: hash } = value;
  if (
    value.schemaVersion !== '1.0.0' ||
    typeof target !== 'string' ||
    typeof content !== 'string' ||
    typeof hash !== 'string' ||
    !digest.test(hash)
  )
    return invalid();
  const segments = target.split('/');
  if (
    target.includes('\\') ||
    target.includes('\0') ||
    Buffer.from(target, 'utf8').toString('utf8') !== target ||
    segments.some((part) => part === '' || part === '.' || part === '..' || part === '.git') ||
    segments[0] === '.devai' ||
    segments[0] === 'record'
  )
    return invalid();
  // Buffer's UTF-8 conversion replaces unpaired surrogates; refuse rather than silently changing bytes.
  if (
    Buffer.from(content, 'utf8').toString('utf8') !== content ||
    createHash('sha256').update(content, 'utf8').digest('hex') !== hash
  )
    return invalid();
  if (!record(expected)) return invalid();
  let checked: SourceExpected;
  if (expected.kind === 'absent' && keysAre(expected, ['kind']))
    checked = Object.freeze({ kind: 'absent' });
  else if (
    expected.kind === 'file' &&
    keysAre(expected, ['kind', 'sha256', 'mode']) &&
    typeof expected.sha256 === 'string' &&
    digest.test(expected.sha256) &&
    typeof expected.mode === 'number' &&
    Number.isInteger(expected.mode) &&
    expected.mode >= 0 &&
    expected.mode <= 0o777
  )
    checked = Object.freeze({ kind: 'file', sha256: expected.sha256, mode: expected.mode });
  else return invalid();
  return Object.freeze({
    schemaVersion: '1.0.0',
    target,
    expected: checked,
    content_utf8: content,
    content_sha256: hash,
  });
}
