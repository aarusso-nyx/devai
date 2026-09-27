import { existsSync, readFileSync } from '@devai-nyx/authority';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface VerifierPackagePolicy {
  readonly package: {
    readonly name: string;
    readonly version: string;
    readonly registry: string;
    readonly tarball: string;
    readonly shasum_sha1: string;
    readonly integrity_sri: string;
    readonly release_source: {
      readonly repository: string;
      readonly commit: string;
      readonly tree: string;
    };
  };
  readonly authentication: {
    readonly secret: string;
    readonly github_token_fallback: boolean;
  };
  readonly workflow_permissions: {
    readonly contents: string;
    readonly packages: string;
    readonly checks: string;
  };
  readonly verifier: {
    readonly root: string;
    readonly provenance_sha256: string;
    readonly source_commit: string;
    readonly payload_file_count: number;
    readonly binaries: Readonly<Record<string, string>>;
  };
  readonly external_duplicate: {
    readonly name: string;
    readonly required: boolean;
    readonly sole_trust_root: boolean;
  };
  readonly adopter_fallbacks: readonly unknown[];
}

function loadVerifierPackagePolicy(): VerifierPackagePolicy {
  const moduleRoot = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleRoot, '../../law/policy/trusted-local-rc-verifier-package.json'),
    resolve(moduleRoot, '../../../../../law/policy/trusted-local-rc-verifier-package.json'),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path === undefined) throw new Error('CI_SCAFFOLD_VERIFIER_PACKAGE_POLICY_MISSING');
  const policy = JSON.parse(readFileSync(path, 'utf8')) as VerifierPackagePolicy;
  if (
    policy.package?.name === '' ||
    !/^\d+\.\d+\.\d+$/u.test(policy.package?.version ?? '') ||
    policy.authentication?.secret !== 'PACKAGES_READ_TOKEN' ||
    policy.authentication.github_token_fallback !== false ||
    policy.workflow_permissions?.contents !== 'read' ||
    policy.workflow_permissions.packages !== 'read' ||
    policy.workflow_permissions.checks !== 'write' ||
    policy.verifier?.root !== 'dist/runtime/evidence-verification' ||
    !/^[0-9a-f]{64}$/u.test(policy.verifier.provenance_sha256) ||
    !/^[0-9a-f]{40}$/u.test(policy.verifier.source_commit) ||
    !Number.isSafeInteger(policy.verifier.payload_file_count) ||
    policy.verifier.payload_file_count < 1 ||
    Object.keys(policy.verifier.binaries ?? {}).length !== 5 ||
    policy.external_duplicate?.name !== 'DEVAI_LEDGER_VERIFIER_PROVENANCE_SHA256' ||
    policy.external_duplicate.required !== true ||
    policy.external_duplicate.sole_trust_root !== false ||
    policy.adopter_fallbacks?.length !== 0
  ) {
    throw new Error('CI_SCAFFOLD_VERIFIER_PACKAGE_POLICY_INVALID');
  }
  return policy;
}

export const verifierPackagePolicy = loadVerifierPackagePolicy();
export const VERIFIER_PACKAGE = verifierPackagePolicy.package.name;
export const VERIFIER_SOURCE_COMMIT = verifierPackagePolicy.verifier.source_commit;
// Kept as an API compatibility alias. The materializer accepts only this one exact commit.
export const NEXT_VERIFIER_SOURCE_COMMIT = VERIFIER_SOURCE_COMMIT;

export function protectedVerifierPackageStep(name: string): string {
  const packageIdentity = verifierPackagePolicy.package;
  const verifier = verifierPackagePolicy.verifier;
  const encodedPackageName = encodeURIComponent(packageIdentity.name).replace('%40', '@');
  const expectedBins = JSON.stringify(verifier.binaries);
  return `      - name: ${name}
        id: verifier-package
        shell: bash
        env:
          NODE_AUTH_TOKEN: \${{ secrets.${verifierPackagePolicy.authentication.secret} }}
          VERIFIER_PROVENANCE_SHA256: \${{ vars.DEVAI_LEDGER_VERIFIER_PROVENANCE_SHA256 }}
        run: |
          set -euo pipefail
          test -n "$NODE_AUTH_TOKEN"
          test "$VERIFIER_PROVENANCE_SHA256" != ""
          test "\${#VERIFIER_PROVENANCE_SHA256}" = 64
          control="$RUNNER_TEMP/devai-verifier-package"
          rm -rf "$control"
          mkdir -p "$control/download" "$control/extracted"
          metadata="$control/download/metadata.json"
          archive="$control/download/package.tgz"
          auth_header="Authorization: Bearer $NODE_AUTH_TOKEN"
          curl --fail-with-body --silent --show-error --location \
            --header "$auth_header" \
            --output "$metadata" \
            "${packageIdentity.registry}/${encodedPackageName}"
          node - "$metadata" <<'NODE'
          const { readFileSync } = require('node:fs');
          const metadata = JSON.parse(readFileSync(process.argv[2], 'utf8'));
          const selected = metadata.versions?.['${packageIdentity.version}'];
          if (metadata.name !== '${packageIdentity.name}') throw new Error('DEVAI_VERIFIER_PACKAGE_NAME_INVALID');
          if (selected?.version !== '${packageIdentity.version}') throw new Error('DEVAI_VERIFIER_PACKAGE_VERSION_INVALID');
          if (selected.dist?.tarball !== '${packageIdentity.tarball}') throw new Error('DEVAI_VERIFIER_PACKAGE_TARBALL_URL_INVALID');
          if (selected.dist?.shasum !== '${packageIdentity.shasum_sha1}') throw new Error('DEVAI_VERIFIER_PACKAGE_SHASUM_INVALID');
          if (selected.dist?.integrity !== '${packageIdentity.integrity_sri}') throw new Error('DEVAI_VERIFIER_PACKAGE_INTEGRITY_INVALID');
          NODE
          curl --fail-with-body --silent --show-error --location \
            --header "$auth_header" \
            --output "$archive" \
            "${packageIdentity.tarball}"
          node - "$archive" <<'NODE'
          const { createHash } = require('node:crypto');
          const { readFileSync } = require('node:fs');
          const bytes = readFileSync(process.argv[2]);
          if (createHash('sha1').update(bytes).digest('hex') !== '${packageIdentity.shasum_sha1}') throw new Error('DEVAI_VERIFIER_PACKAGE_SHASUM_INVALID');
          if ('sha512-' + createHash('sha512').update(bytes).digest('base64') !== '${packageIdentity.integrity_sri}') throw new Error('DEVAI_VERIFIER_PACKAGE_INTEGRITY_INVALID');
          NODE
          release_ref="$control/download/release-ref.json"
          release_tag="$control/download/release-tag.json"
          release_commit="$control/download/release-commit.json"
          curl --fail-with-body --silent --show-error \
            --header "$auth_header" \
            --header "Accept: application/vnd.github+json" \
            --output "$release_ref" \
            "https://api.github.com/repos/${packageIdentity.release_source.repository}/git/ref/tags/v${packageIdentity.version}"
          tag_url="$(node -e 'const x=require(process.argv[1]); if(x.object?.type!=="tag"||typeof x.object?.url!=="string") process.exit(1); process.stdout.write(x.object.url)' "$release_ref")"
          curl --fail-with-body --silent --show-error \
            --header "$auth_header" \
            --header "Accept: application/vnd.github+json" \
            --output "$release_tag" "$tag_url"
          commit_url="$(node -e 'const x=require(process.argv[1]); if(x.object?.type!=="commit"||typeof x.object?.url!=="string") process.exit(1); process.stdout.write(x.object.url)' "$release_tag")"
          curl --fail-with-body --silent --show-error \
            --header "$auth_header" \
            --header "Accept: application/vnd.github+json" \
            --output "$release_commit" "$commit_url"
          node - "$release_tag" "$release_commit" <<'NODE'
          const { readFileSync } = require('node:fs');
          const tag = JSON.parse(readFileSync(process.argv[2], 'utf8'));
          const commit = JSON.parse(readFileSync(process.argv[3], 'utf8'));
          if (tag.object?.sha !== '${packageIdentity.release_source.commit}' || commit.sha !== '${packageIdentity.release_source.commit}') throw new Error('DEVAI_VERIFIER_PACKAGE_RELEASE_COMMIT_INVALID');
          if (commit.tree?.sha !== '${packageIdentity.release_source.tree}') throw new Error('DEVAI_VERIFIER_PACKAGE_RELEASE_TREE_INVALID');
          NODE
          node - "$archive" <<'NODE'
          const { readFileSync } = require('node:fs');
          const { gunzipSync } = require('node:zlib');
          const archive = gunzipSync(readFileSync(process.argv[2]));
          const text = (buffer) => buffer.toString('utf8').replace(/\\0.*$/su, '');
          const octal = (buffer) => Number.parseInt(text(buffer).trim() || '0', 8);
          for (let offset = 0; offset + 512 <= archive.length;) {
            const header = archive.subarray(offset, offset + 512);
            if (header.every((byte) => byte === 0)) break;
            const name = [text(header.subarray(345, 500)), text(header.subarray(0, 100))].filter(Boolean).join('/');
            const type = String.fromCharCode(header[156] ?? 0);
            if (name.startsWith('/') || /^[A-Za-z]:/u.test(name)) throw new Error('DEVAI_VERIFIER_ARCHIVE_ABSOLUTE_PATH_INVALID:' + name);
            if (name.includes('\\\\') || name.split('/').includes('..')) throw new Error('DEVAI_VERIFIER_ARCHIVE_PATH_TRAVERSAL_INVALID:' + name);
            if (!(name === 'package' || name.startsWith('package/'))) throw new Error('DEVAI_VERIFIER_ARCHIVE_PATH_TRAVERSAL_INVALID:' + name);
            if (type === '2') throw new Error('DEVAI_VERIFIER_ARCHIVE_SYMLINK_INVALID:' + name);
            if (type === '1') throw new Error('DEVAI_VERIFIER_ARCHIVE_HARDLINK_INVALID:' + name);
            if (!(type === '\\0' || type === '0' || type === '5')) throw new Error('DEVAI_VERIFIER_ARCHIVE_SPECIAL_FILE_INVALID:' + name);
            const size = octal(header.subarray(124, 136));
            if (!Number.isSafeInteger(size) || size < 0) throw new Error('DEVAI_VERIFIER_ARCHIVE_SPECIAL_FILE_INVALID:' + name);
            offset += 512 + Math.ceil(size / 512) * 512;
          }
          NODE
          tar -xzf "$archive" --directory "$control/extracted" --no-same-owner --no-same-permissions
          package_root="$control/extracted/package"
          verifier_root="$package_root/${verifier.root}"
          provenance="$verifier_root/provenance.json"
          actual_provenance_sha256="$(sha256sum "$provenance" | cut -d' ' -f1)"
          test "$actual_provenance_sha256" = "${verifier.provenance_sha256}"
          test "$actual_provenance_sha256" = "$VERIFIER_PROVENANCE_SHA256"
          node - "$package_root" "$verifier_root" <<'NODE'
          const { createHash } = require('node:crypto');
          const { lstatSync, readFileSync, readdirSync } = require('node:fs');
          const { join, relative } = require('node:path');
          const [packageRoot, verifierRoot] = process.argv.slice(2);
          const expectedBins = ${expectedBins};
          const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
          if (manifest.name !== '${packageIdentity.name}') throw new Error('DEVAI_VERIFIER_PACKAGE_NAME_INVALID');
          if (manifest.version !== '${packageIdentity.version}') throw new Error('DEVAI_VERIFIER_PACKAGE_VERSION_INVALID');
          const evidenceBins = Object.fromEntries(Object.entries(manifest.bin ?? {}).filter(([name]) => name.startsWith('devai-evidence-')));
          if (JSON.stringify(evidenceBins) !== JSON.stringify(expectedBins)) throw new Error('DEVAI_VERIFIER_PACKAGE_BIN_INVALID:population');
          for (const [name, path] of Object.entries(expectedBins)) {
            if (manifest.bin?.[name] !== path) throw new Error('DEVAI_VERIFIER_PACKAGE_BIN_INVALID:' + name);
          }
          const provenancePath = join(verifierRoot, 'provenance.json');
          const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
          if (provenance.schemaVersion !== '1.0.0' || provenance.sourceCommit !== '${verifier.source_commit}') {
            throw new Error('DEVAI_VERIFIER_PACKAGE_PROVENANCE_INVALID');
          }
          if (!Array.isArray(provenance.files) || provenance.files.length !== ${String(verifier.payload_file_count)}) {
            throw new Error('DEVAI_VERIFIER_PACKAGE_POPULATION_INVALID');
          }
          const listed = new Map(provenance.files.map((entry) => [entry.path, entry.sha256]));
          const walk = (root, directory = root) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
            const path = join(directory, entry.name);
            const stat = lstatSync(path);
            if (stat.isSymbolicLink()) {
              throw new Error('DEVAI_VERIFIER_PACKAGE_SYMLINK_INVALID:' + relative(root, path));
            }
            if (!stat.isDirectory() && !stat.isFile()) {
              throw new Error('DEVAI_VERIFIER_PACKAGE_SPECIAL_FILE_INVALID:' + relative(root, path));
            }
            return stat.isDirectory() ? walk(root, path) : [relative(root, path).replaceAll('\\\\', '/')];
          });
          const actual = walk(verifierRoot).filter((path) => path !== 'provenance.json').sort();
          const expected = [...listed.keys()].sort();
          const missing = expected.filter((path) => !actual.includes(path));
          const extra = actual.filter((path) => !listed.has(path));
          if (missing.length > 0) throw new Error('DEVAI_VERIFIER_PACKAGE_FILE_MISSING:' + missing.join(','));
          if (extra.length > 0) throw new Error('DEVAI_VERIFIER_PACKAGE_FILE_EXTRA:' + extra.join(','));
          for (const [path, expected] of listed) {
            const file = join(verifierRoot, path);
            const actualDigest = createHash('sha256').update(readFileSync(file)).digest('hex');
            if (actualDigest !== expected) throw new Error('DEVAI_VERIFIER_PACKAGE_FILE_DIGEST_INVALID:' + path);
          }
          NODE
          {
            echo "DEVAI_EVIDENCE_POLICY=$verifier_root/src/build-policy-cli.js"
            echo "DEVAI_EVIDENCE_VERIFY=$verifier_root/src/cli.js"
            echo "DEVAI_EVIDENCE_BUNDLE_VERIFY=$verifier_root/src/bundle-cli.js"
          } >> "$GITHUB_ENV"
          echo "version=${packageIdentity.version}" >> "$GITHUB_OUTPUT"
          echo "provenance_sha256=$actual_provenance_sha256" >> "$GITHUB_OUTPUT"
`.trimEnd();
}
