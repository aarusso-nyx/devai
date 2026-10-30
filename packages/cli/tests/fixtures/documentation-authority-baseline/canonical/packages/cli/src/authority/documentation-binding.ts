import { parseAdopterPolicyBinding } from '../services/adopter-policy-binding.js';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getValidator } from '@devai-nyx/schemas';
import {
  DOCUMENTATION_IMPLEMENTATION_CAPABILITY,
  documentationImplementationProvenanceValid,
  type DocumentationImplementationProvenance,
} from '@devai-nyx/authority';
import type { RegistryEntry } from '../define-command.js';
import { authorityBindings, canonicalSha256, sha256Bytes } from './policy-support.js';
import { compileDocumentationImplementationRules } from './policy-documentation-implementation.js';

const RECEIPT = '.devai/config/adopter-policy-binding.json';
const JOURNAL = '.devai/config/adopter-policy-binding.journal.json';
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const fail: () => never = () => {
  throw new Error('DOCUMENTATION_IMPLEMENTATION_BINDING_MISMATCH');
};

/** No path component can redirect a source or selected target through a link. */
export function verifyDocumentationPath(root: string, relative: string): void {
  let current = resolve(root);
  for (const [index, segment] of relative.split('/').entries()) {
    current = join(current, segment);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) fail();
      if (index < relative.split('/').length - 1 ? !stat.isDirectory() : !stat.isFile()) fail();
    } catch (error) {
      // A selected exact implementation may be created later; its existing parent
      // chain must still be lexical and non-symlinked. Sources are read below.
      if (record(error) && error['code'] === 'ENOENT') continue;
      throw error;
    }
  }
}

export function compileDocumentationBinding(input: {
  readonly root: string;
  readonly document: Record<string, unknown>;
  readonly sourceBytes: string;
  readonly bindings: ReturnType<typeof authorityBindings>;
  readonly entries: readonly RegistryEntry[];
}) {
  const compiled = compileDocumentationImplementationRules({
    block: input.document['documentation_implementation'],
    constitution: input.bindings.constitution_binding,
    repositoryId: input.bindings.repository_id,
    entries: input.entries,
  });
  if (compiled === undefined) return undefined;
  for (const path of compiled.files) verifyDocumentationPath(input.root, path);
  const provenance: DocumentationImplementationProvenance = {
    capability_id: DOCUMENTATION_IMPLEMENTATION_CAPABILITY,
    repository_id: input.bindings.repository_id,
    source_digest_sha256: sha256Bytes(new TextEncoder().encode(input.sourceBytes)),
    constitution: input.bindings.constitution_binding,
    framework_package: input.bindings.package_binding,
    compiled_digest_sha256: canonicalSha256(compiled),
    rule_count: compiled.rules.length,
  };
  return { ...compiled, provenance };
}

/** Ordinary uses require the complete receipt. Only the registered materializer may
 * inspect a complete pending receipt while its rollback journal is open. */
export function resolveDocumentationBinding(
  input: {
    readonly root: string;
    readonly bindings: ReturnType<typeof authorityBindings>;
    readonly entries: readonly RegistryEntry[];
  },
  materializing = false,
) {
  const receiptPath = join(resolve(input.root), RECEIPT);
  if (!existsSync(receiptPath)) return undefined;
  let receipt: unknown;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  } catch {
    return undefined;
  }
  if (!record(receipt)) return undefined;
  const bound = receipt['documentation_implementation'];
  const source = receipt['source_path'];
  // A non-specializing historical receipt remains on its old path. When a source is
  // legible we also detect an unbound newly added block, rather than grant implicitly.
  if (
    typeof source !== 'string' ||
    !/^law\/policy\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.json$/u.test(
      source,
    )
  ) {
    if (bound !== undefined) fail();
    return undefined;
  }
  let bytes: string;
  let document: unknown;
  try {
    verifyDocumentationPath(input.root, RECEIPT);
    verifyDocumentationPath(input.root, source);
    bytes = readFileSync(join(resolve(input.root), source), 'utf8');
    document = JSON.parse(bytes);
  } catch (error) {
    if (bound !== undefined) fail();
    return undefined;
  }
  if (!record(document)) {
    if (bound !== undefined) fail();
    return undefined;
  }
  if (document['documentation_implementation'] === undefined && bound === undefined)
    return undefined;
  if (!materializing && existsSync(join(input.root, JOURNAL))) fail();
  const closedReceipt = parseAdopterPolicyBinding(readFileSync(receiptPath, 'utf8'));
  if (
    'reason' in closedReceipt ||
    !documentationImplementationProvenanceValid(bound) ||
    !getValidator('adopter-policy.schema.json')(document)
  )
    fail();
  if (
    document['policy_id'] !== receipt['policy_id'] ||
    document['policy_version'] !== receipt['policy_version'] ||
    sha256Bytes(new TextEncoder().encode(bytes)) !== receipt['source_digest_sha256']
  )
    fail();
  const compiled = compileDocumentationBinding({ ...input, document, sourceBytes: bytes });
  if (compiled === undefined || canonicalSha256(compiled.provenance) !== canonicalSha256(bound))
    fail();
  return compiled;
}

/** Offline release replay uses only the already verified candidate byte population. */
export function verifyDocumentationBindingSnapshot(input: {
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly document: Record<string, unknown>;
  readonly bound: unknown;
  readonly sourceBytes: string;
  readonly frameworkVersion: string;
  readonly entries: readonly RegistryEntry[];
}): void {
  if (input.document['documentation_implementation'] === undefined && input.bound === undefined)
    return;
  if (!documentationImplementationProvenanceValid(input.bound)) fail();
  const bound = input.bound;
  const pin = input.files.get('.devai/pin/constitution.md');
  const policyBytes = input.files.get('.devai/config/authority-policy.json');
  if (pin === undefined || policyBytes === undefined) fail();
  const policy: unknown = JSON.parse(new TextDecoder().decode(policyBytes));
  if (!record(policy) || !Array.isArray(policy['rules'])) fail();
  const compiled = compileDocumentationImplementationRules({
    block: input.document['documentation_implementation'],
    constitution: bound.constitution,
    repositoryId: bound.repository_id,
    entries: input.entries,
  });
  if (
    compiled === undefined ||
    bound.rule_count !== compiled.rules.length ||
    bound.compiled_digest_sha256 !== canonicalSha256(compiled) ||
    bound.source_digest_sha256 !== sha256Bytes(new TextEncoder().encode(input.sourceBytes)) ||
    bound.constitution.digest_sha256 !== sha256Bytes(pin) ||
    bound.framework_package.version !== input.frameworkVersion ||
    canonicalSha256(policy['constitution']) !== canonicalSha256(bound.constitution) ||
    canonicalSha256(policy['framework_package']) !== canonicalSha256(bound.framework_package) ||
    policy['repository_id'] !== bound.repository_id
  )
    fail();
  const specialized = policy['rules'].filter(
    (entry: unknown) =>
      record(entry) &&
      typeof entry['rule_id'] === 'string' &&
      entry['rule_id'].startsWith('core-documentation-implementation-'),
  );
  if (canonicalSha256(specialized) !== canonicalSha256(compiled.rules)) fail();
}
