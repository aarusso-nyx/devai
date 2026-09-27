import { canonicalJson } from '@devai-nyx/utils';
import type {
  CertificationPackageEntryManifest,
  GitReleaseBlobLocator,
  ReleaseLifecycleRequest,
} from './release-lifecycle-execution.js';
import {
  safeRelativePath,
  certificationManifestDigest,
  type CertificationReceipt,
  certificationReceiptDigest,
  ENTRY_ORDER,
  same,
  CERTIFICATION_MANIFEST_DIGEST_CONTRACT,
  utf8Compare,
  type ImmutableReleaseContentSource,
  gitObjectDigest,
  sha256,
  type CertificationOutputClosureBinding,
  type CertificationOutputClosure,
  object,
} from './release-prepare-kernel-contract.js';

export function finalizeCertificationManifest(
  manifest: Omit<CertificationPackageEntryManifest, 'manifest_digest_sha256'>,
): CertificationPackageEntryManifest {
  return { ...manifest, manifest_digest_sha256: certificationManifestDigest(manifest) };
}

/** Canonicalizes bytes only; this does not prove external finalization or producer provenance. */
export function finalizeCertificationReceipt(
  referent: CertificationReceipt['referent'],
): CertificationReceipt {
  const draft = {
    kind: 'release-certification-evidence-receipt-v1' as const,
    canonicalization: 'utf-8-rfc8785-jcs-sha256' as const,
    referent,
  };
  return { ...draft, receipt_digest_sha256: certificationReceiptDigest(draft) };
}

export function verifyCertificationManifest(
  value: CertificationPackageEntryManifest,
  input: {
    readonly request: ReleaseLifecycleRequest;
    readonly package_id: string;
    readonly package_version: string;
    readonly task_policy_digests: ReadonlySet<string>;
  },
): CertificationPackageEntryManifest {
  const { manifest_digest_sha256: _digest, ...draft } = value;
  const paths = value.entries.map((entry) => entry.path);
  if (
    value.manifest_digest_sha256 !== certificationManifestDigest(draft) ||
    value.package_id !== input.package_id ||
    value.package_version !== input.package_version ||
    value.candidate.commit !== input.request.candidate_locator.commit ||
    value.candidate.tree !== input.request.candidate_locator.tree ||
    !input.task_policy_digests.has(value.task_policy_digest_sha256) ||
    value.entry_order !== ENTRY_ORDER ||
    !same(value.manifest_digest_contract, CERTIFICATION_MANIFEST_DIGEST_CONTRACT) ||
    paths.length === 0 ||
    new Set(paths).size !== paths.length ||
    paths.some(
      (path, index) =>
        !safeRelativePath(path) || (index > 0 && utf8Compare(paths[index - 1] ?? '', path) >= 0),
    ) ||
    value.entries.some(
      (entry) =>
        !/^[0-9a-f]{64}$/u.test(entry.sha256) ||
        !Number.isSafeInteger(entry.size_bytes) ||
        entry.size_bytes < 0 ||
        !['100644', '100755'].includes(entry.mode) ||
        (entry.immutable_blob_locator.kind === 'git-object' &&
          !gitLocatorMatches(entry, input.request, input.package_id)),
    ) ||
    !paths.includes('package.json')
  ) {
    throw new Error('release-prepare-certification-manifest-invalid');
  }
  return value;
}

function gitLocatorMatches(
  entry: CertificationPackageEntryManifest['entries'][number],
  request: ReleaseLifecycleRequest,
  packageId: string,
): boolean {
  const locator = entry.immutable_blob_locator;
  if (locator.kind !== 'git-object') return false;
  const pkg = request.candidate_locator.release_units
    .flatMap((unit) => unit.package_roster)
    .find((value) => value.package_id === packageId);
  const prefix = pkg?.manifest_path.slice(0, -'package.json'.length);
  const length =
    locator.object_format === 'sha1' ? 40 : locator.object_format === 'sha256' ? 64 : 0;
  return (
    prefix !== undefined &&
    length > 0 &&
    [locator.commit, locator.tree, locator.object_id].every(
      (id) => typeof id === 'string' && id.length === length && /^[0-9a-f]+$/u.test(id),
    ) &&
    locator.repository === request.repository_locator.id &&
    locator.commit === request.candidate_locator.commit &&
    locator.tree === request.candidate_locator.tree &&
    locator.path === `${prefix}${entry.path}` &&
    safeRelativePath(locator.path) &&
    locator.mode === entry.mode &&
    locator.size_bytes === entry.size_bytes &&
    locator.content_digest_sha256 === entry.sha256
  );
}

export async function verifyGitMembership(
  source: Pick<ImmutableReleaseContentSource, 'readGitObject'>,
  request: ReleaseLifecycleRequest,
  locator: GitReleaseBlobLocator,
): Promise<void> {
  const read = async (type: 'commit' | 'tree', objectId: string): Promise<Buffer> => {
    const bytes = await source.readGitObject({
      repository: request.repository_locator,
      object_format: locator.object_format,
      object_id: objectId,
      type,
    });
    if (!Buffer.isBuffer(bytes) || gitObjectDigest(bytes, type, locator.object_format) !== objectId)
      throw new Error('release-prepare-git-tree-membership-invalid');
    return Buffer.from(bytes);
  };
  try {
    const commit = await read('commit', locator.commit);
    const firstLine = commit.subarray(0, commit.indexOf(10)).toString('utf8');
    if (firstLine !== `tree ${locator.tree}`) throw new Error('membership');
    let tree = locator.tree;
    const parts = locator.path.split('/');
    const oidBytes = locator.object_format === 'sha1' ? 20 : 32;
    for (const [index, part] of parts.entries()) {
      const bytes = await read('tree', tree);
      const entries = new Map<string, { mode: string; id: string }>();
      let offset = 0;
      while (offset < bytes.length) {
        const space = bytes.indexOf(32, offset);
        const nul = bytes.indexOf(0, space + 1);
        if (space <= offset || nul <= space + 1 || nul + 1 + oidBytes > bytes.length)
          throw new Error('tree');
        const mode = bytes.subarray(offset, space).toString('ascii');
        const nameBytes = bytes.subarray(space + 1, nul);
        const name = nameBytes.toString('utf8');
        if (
          !nameBytes.equals(Buffer.from(name)) ||
          !safeRelativePath(name) ||
          name.includes('/') ||
          entries.has(name)
        )
          throw new Error('tree');
        entries.set(name, {
          mode,
          id: bytes.subarray(nul + 1, nul + 1 + oidBytes).toString('hex'),
        });
        offset = nul + 1 + oidBytes;
      }
      const entry = entries.get(part);
      if (entry === undefined) throw new Error('membership');
      if (index === parts.length - 1) {
        if (entry.mode !== locator.mode || entry.id !== locator.object_id)
          throw new Error('membership');
      } else {
        if (entry.mode !== '40000') throw new Error('membership');
        tree = entry.id;
      }
    }
  } catch {
    throw new Error('release-prepare-git-tree-membership-invalid');
  }
}

/** Protected certification uses the same raw-object membership proof before executing source. */
export async function verifyGitCertificationSource(
  source: Pick<ImmutableReleaseContentSource, 'readGitObject' | 'readGitBlob'>,
  request: ReleaseLifecycleRequest,
  locator: GitReleaseBlobLocator,
): Promise<Buffer> {
  if (
    locator.repository !== request.repository_locator.id ||
    locator.commit !== request.candidate_locator.commit ||
    locator.tree !== request.candidate_locator.tree ||
    !safeRelativePath(locator.path) ||
    !['100644', '100755'].includes(locator.mode)
  ) {
    throw new Error('release-prepare-git-locator-invalid');
  }
  await verifyGitMembership(source, request, locator);
  const bytes = await source.readGitBlob({
    repository: request.repository_locator,
    candidate: request.candidate_locator,
    object_id: locator.object_id,
    locator,
  });
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length !== locator.size_bytes ||
    sha256(bytes) !== locator.content_digest_sha256 ||
    gitObjectDigest(bytes, 'blob', locator.object_format) !== locator.object_id
  ) {
    throw new Error('release-prepare-content-digest-mismatch');
  }
  return Buffer.from(bytes);
}

export async function verifyCertificationOutputClosure(
  source: Pick<ImmutableReleaseContentSource, 'readCertificationOutputClosure'>,
  request: ReleaseLifecycleRequest,
  manifest: CertificationPackageEntryManifest,
): Promise<void> {
  const binding: CertificationOutputClosureBinding = {
    repository: request.repository_locator,
    candidate: { commit: request.candidate_locator.commit, tree: request.candidate_locator.tree },
    task_policy_digest_sha256: manifest.task_policy_digest_sha256,
    package_id: manifest.package_id,
  };
  const outputs = manifest.entries.flatMap((entry) =>
    entry.immutable_blob_locator.kind === 'generated-output'
      ? [
          {
            path: entry.path,
            mode: entry.mode,
            output_blob_handle: entry.immutable_blob_locator.output_blob_handle,
            certification_evidence_receipt:
              entry.immutable_blob_locator.certification_evidence_receipt,
          },
        ]
      : [],
  );
  let observed: CertificationOutputClosure;
  try {
    observed = await source.readCertificationOutputClosure(binding);
  } catch {
    throw new Error('release-certification-generated-output-untrusted');
  }
  if (!same(observed, { ...binding, outputs }))
    throw new Error('release-certification-output-closure-invalid');
}

export function verifyCertificationReceipt(
  observed: unknown,
  expected: CertificationReceipt,
): CertificationReceipt {
  const value = object(observed);
  const draft = {
    kind: value['kind'],
    canonicalization: value['canonicalization'],
    referent: value['referent'],
  };
  if (
    !same(value, expected) ||
    value['receipt_digest_sha256'] !== sha256(Buffer.from(canonicalJson(draft), 'utf8'))
  ) {
    throw new Error('release-prepare-immutable-blob-locator-invalid');
  }
  return expected;
}
