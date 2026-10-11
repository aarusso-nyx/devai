import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve, relative, sep } from 'node:path';
import { getValidator } from '@devai-nyx/schemas';
import { canonicalJson } from '@devai-nyx/utils';

/** Candidate-relative regular bytes, with no symlink in any selected component. */
export function readCandidateFile(root: string, path: string): Buffer {
  if (
    path.length === 0 ||
    path !== path.normalize('NFC') ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    throw new Error('AUDIT_PROJECTION_PATH_INVALID');
  const lexical = resolve(root, path);
  const rel = relative(resolve(root), lexical);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('AUDIT_PROJECTION_PATH_INVALID');
  let current = resolve(root);
  for (const part of path.split('/')) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('AUDIT_PROJECTION_LINK_REFUSED');
  }
  if (!lstatSync(current).isFile()) throw new Error('AUDIT_PROJECTION_REGULAR_FILE_REQUIRED');
  return readFileSync(current);
}

/** Optional projection standing comes from the registered source/target digest pair. */
export function loadCandidateAuditProjection(
  root: string,
  key: 'invariant_producers' | 'reviewed_workflow_steps',
): Record<string, unknown> | undefined {
  const file = key === 'invariant_producers' ? 'invariant-producers' : 'reviewed-workflow-steps';
  const target = `.devai/config/${file}.json`;
  if (!existsSync(join(root, target))) {
    const receiptPath = '.devai/config/adopter-policy-binding.json';
    if (existsSync(join(root, receiptPath))) {
      const receipt = JSON.parse(readCandidateFile(root, receiptPath).toString('utf8')) as {
        materialized?: Record<string, unknown>;
      };
      if (receipt.materialized?.[target] !== undefined)
        throw new Error('AUDIT_PROJECTION_OWNED_TARGET_MISSING');
    }
    return undefined;
  }
  const bytes = readCandidateFile(root, target);
  const value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  if (!getValidator(`${file}.schema.json`)(value))
    throw new Error('AUDIT_PROJECTION_SCHEMA_INVALID');
  const receipt = JSON.parse(
    readCandidateFile(root, '.devai/config/adopter-policy-binding.json').toString('utf8'),
  ) as Record<string, unknown>;
  const sourceBytes = readCandidateFile(root, String(receipt['source_path']));
  const source = JSON.parse(sourceBytes.toString('utf8')) as Record<string, unknown>;
  const hash = (raw: Buffer): string => createHash('sha256').update(raw).digest('hex');
  const materialized = receipt['materialized'] as Record<string, unknown> | undefined;
  if (
    receipt['schemaVersion'] !== '1.0.0' ||
    !getValidator('adopter-policy.schema.json')(source) ||
    receipt['policy_id'] !== source['policy_id'] ||
    receipt['policy_version'] !== source['policy_version'] ||
    receipt['source_digest_sha256'] !== hash(sourceBytes) ||
    materialized?.[target] !== hash(bytes)
  )
    throw new Error('AUDIT_PROJECTION_BINDING_MISMATCH');
  const empty =
    key === 'invariant_producers'
      ? { schemaVersion: '1.0.0', bindings: [] }
      : { schemaVersion: '1.0.0', steps: [] };
  if (canonicalJson(source[key] ?? empty) !== canonicalJson(value))
    throw new Error('AUDIT_PROJECTION_SOURCE_MISMATCH');
  return value;
}
