import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadBoundDocumentationImplementation,
  loadAuthorityPolicy,
  type DocumentationImplementationContext,
} from '@devai-nyx/authority';
import { validators } from '@devai-nyx/schemas';
import { canonicalRegistry } from '../define-command.js';
import { resolveCliVersion } from '../version.js';
import { buildTrustedAuthoritySources } from './policy.js';
import { canonicalBytes, canonicalSha256, sha256Bytes } from './policy-support.js';

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Resolve, verify and retain a freshness-bound opaque policy identity. A parsed list,
 * receipt or intent never supplies authority. No specialization means legacy defaults. */
export function loadDocumentationImplementationContext(
  root: string,
): DocumentationImplementationContext | undefined {
  const receiptPath = join(root, '.devai/config/adopter-policy-binding.json');
  const policyPath = join(root, '.devai/config/authority-policy.json');
  const read = (path: string) => {
    try {
      return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    } catch {
      return undefined;
    }
  };
  const receiptBytes = read(receiptPath);
  const policyBytes = read(policyPath);
  const parse = (bytes: string | undefined): unknown => {
    try {
      return bytes === undefined ? undefined : JSON.parse(bytes);
    } catch {
      return undefined;
    }
  };
  const receipt = parse(receiptBytes);
  const document = parse(policyBytes);
  const specialized =
    (record(receipt) && Object.hasOwn(receipt, 'documentation_implementation')) ||
    (record(document) &&
      Array.isArray(document['rules']) &&
      document['rules'].some(
        (rule: unknown) =>
          record(rule) &&
          typeof rule['rule_id'] === 'string' &&
          rule['rule_id'].startsWith('core-documentation-implementation-'),
      ));
  if (!specialized) return undefined;
  const entries = canonicalRegistry();
  const version = resolveCliVersion();
  const sources = buildTrustedAuthoritySources(entries, root, version);
  const context = loadBoundDocumentationImplementation(root);
  const loaded = loadAuthorityPolicy(
    { document },
    {
      now: new Date().toISOString(),
      validatePolicySchema: (value: unknown) =>
        validators.authorityPolicy(value)
          ? { ok: true, value: { raw: value, canonical_bytes: canonicalBytes(value), view: value } }
          : {
              ok: false,
              category: 'refused',
              code: 'AUTHORITY_POLICY_SCHEMA_INVALID',
              reasons: ['AUTHORITY_POLICY_SCHEMA_INVALID'],
            },
      canonicalBytes,
      canonicalSha256,
      sha256Bytes,
      immutableCore: sources.immutableCore,
      additiveExtensions: sources.additiveExtensions,
      expected_repository_id: sources.repository_id,
      expected_policy_id: sources.provenance.policy_id,
      expected_package: sources.package_binding,
      expected_constitution: sources.constitution_binding,
      expected_minimum_policy_version: sources.provenance.policy_version,
      documentationContext: context,
    },
  );
  if (!loaded.ok) throw new Error(loaded.code);
  return context;
}
