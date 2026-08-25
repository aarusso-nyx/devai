import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from '@devai-nyx/authority';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAttestedRcConfig } from '../../commands/check/ci-local-only.js';

export interface CiScaffoldOptions {
  readonly targetRoot: string;
  readonly outputPath?: string;
}

export interface CiScaffoldPlan {
  readonly path: string;
  readonly content: string;
  readonly exists: boolean;
}

export const LEDGER_WORKFLOW_FILE = 'devai-ledger-verify.yml';
export const ATTESTED_RC_WORKFLOW_FILE = 'devai-local-rc-verify.yml';
export const LEDGER_ENVIRONMENT = 'devai-ledger-verification';
export const CHECKOUT_COMMIT = '3d3c42e5aac5ba805825da76410c181273ba90b1';
export const SETUP_NODE_COMMIT = '820762786026740c76f36085b0efc47a31fe5020';

const DEFAULT_OUTPUT_RELATIVE = `.github/workflows/${LEDGER_WORKFLOW_FILE}`;

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
    policy.verifier.payload_file_count !== 21 ||
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

const verifierPackagePolicy = loadVerifierPackagePolicy();
export const VERIFIER_PACKAGE = verifierPackagePolicy.package.name;
export const VERIFIER_SOURCE_COMMIT = verifierPackagePolicy.verifier.source_commit;
// Kept as an API compatibility alias. The materializer accepts only this one exact commit.
export const NEXT_VERIFIER_SOURCE_COMMIT = VERIFIER_SOURCE_COMMIT;

function protectedVerifierPackageStep(name: string): string {
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

export function attestedRcVerificationWorkflow(): string {
  const backslash = '\\';
  return `name: DEVAI trusted local RC verification

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      candidate_sha:
        description: Exact candidate commit carrying published local RC evidence
        required: true
        type: string

concurrency:
  group: devai-local-rc-verify-\${{ inputs.candidate_sha || github.sha }}
  cancel-in-progress: false

permissions:
  contents: ${verifierPackagePolicy.workflow_permissions.contents}
  packages: ${verifierPackagePolicy.workflow_permissions.packages}
  checks: ${verifierPackagePolicy.workflow_permissions.checks}

env:
  CANDIDATE_SHA: \${{ inputs.candidate_sha || github.sha }}

jobs:
  verify-attested-rc:
    name: Verify trusted local RC evidence
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Check out candidate as inert data
        uses: actions/checkout@${CHECKOUT_COMMIT} # v7.0.1
        with:
          ref: \${{ env.CANDIDATE_SHA }}
          path: candidate
          fetch-depth: 1
          persist-credentials: false

      - name: Check out default-branch controls
        uses: actions/checkout@${CHECKOUT_COMMIT} # v7.0.1
        with:
          ref: main
          path: control
          fetch-depth: 1
          persist-credentials: false

      - name: Set up verifier runtime
        uses: actions/setup-node@${SETUP_NODE_COMMIT} # v7.0.0
        with:
          node-version: 24

${protectedVerifierPackageStep('Materialize protected DEVAI verifier package')}

      - name: Bind candidate and protected evidence tag
        id: identity
        shell: bash
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          set -euo pipefail
          test "\${#CANDIDATE_SHA}" = 40 -o "\${#CANDIDATE_SHA}" = 64
          test "$(git -C candidate rev-parse HEAD)" = "$CANDIDATE_SHA"
          tree="$(git -C candidate rev-parse "\${CANDIDATE_SHA}^{tree}")"
          tag="devai-local-evidence/$tree"
          tag_object="$(gh api "repos/\${GITHUB_REPOSITORY}/git/ref/tags/$tag" --jq '.object.type + ":" + .object.sha')"
          test "\${tag_object%%:*}" = tag
          tag_sha="\${tag_object#*:}"
          proof_commit="$(gh api "repos/\${GITHUB_REPOSITORY}/git/tags/$tag_sha" --jq 'select(.object.type == "commit") | .object.sha')"
          test -n "$proof_commit"
          {
            echo "tree=$tree"
            echo "tag=$tag"
            echo "proof_commit=$proof_commit"
            if test "$GITHUB_EVENT_NAME" = push; then
              echo "binding=exact-tree"
            else
              echo "binding=exact-commit"
            fi
          } >> "$GITHUB_OUTPUT"

      - name: Check out immutable proof commit
        uses: actions/checkout@${CHECKOUT_COMMIT} # v7.0.1
        with:
          ref: \${{ steps.identity.outputs.proof_commit }}
          path: evidence
          fetch-depth: 1
          persist-credentials: false

      - name: Reconstruct exact RC task policy
        id: policy
        shell: bash
        run: |
          set -euo pipefail
          mkdir -p "$RUNNER_TEMP/devai-local-rc"
          node "$DEVAI_EVIDENCE_POLICY" ${backslash}
            --repo candidate ${backslash}
            --descriptor control/test-tasks.json ${backslash}
            --profile rc ${backslash}
            --commit "$CANDIDATE_SHA" ${backslash}
            --tree "\${{ steps.identity.outputs.tree }}" ${backslash}
            --toolchain control/law/policy/devai-local-rc-toolchain.json ${backslash}
            --environment control/law/policy/devai-local-rc-environment.json ${backslash}
            --schema-version 1.1.0 ${backslash}
            --output "$RUNNER_TEMP/devai-local-rc/expected-task-policy.json" ${backslash}
            > "$RUNNER_TEMP/devai-local-rc/policy-result.json"
          cmp "$RUNNER_TEMP/devai-local-rc/expected-task-policy.json" evidence/task-policy.json
          digest="$(node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(process.argv[1]));process.stdout.write(x.taskPolicyDigest)' "$RUNNER_TEMP/devai-local-rc/policy-result.json")"
          echo "digest=$digest" >> "$GITHUB_OUTPUT"

      - name: Verify complete trusted local RC bundle
        id: verify
        continue-on-error: true
        shell: bash
        run: |
          set -euo pipefail
          node "$DEVAI_EVIDENCE_BUNDLE_VERIFY" ${backslash}
            --bundle evidence ${backslash}
            --trust control/law/policy/devai-local-rc-trust-store.json ${backslash}
            --repository "$GITHUB_REPOSITORY" ${backslash}
            --commit "$CANDIDATE_SHA" ${backslash}
            --tree "\${{ steps.identity.outputs.tree }}" ${backslash}
            --policy-digest "\${{ steps.policy.outputs.digest }}" ${backslash}
            --binding "\${{ steps.identity.outputs.binding }}" ${backslash}
            > "$RUNNER_TEMP/devai-local-rc/verified.json"

      - name: Build concise verification artifact
        if: always()
        shell: bash
        env:
          VERIFY_OUTCOME: \${{ steps.verify.outcome }}
          CANDIDATE_TREE: \${{ steps.identity.outputs.tree }}
          BINDING: \${{ steps.identity.outputs.binding }}
          POLICY_DIGEST: \${{ steps.policy.outputs.digest }}
        run: |
          set -euo pipefail
          node - "$RUNNER_TEMP/devai-local-rc/verified.json" "$RUNNER_TEMP/devai-local-rc/verification-summary.json" <<'NODE'
          const fs = require('node:fs');
          const [input, output] = process.argv.slice(2);
          const verified = fs.existsSync(input) ? JSON.parse(fs.readFileSync(input, 'utf8')) : {};
          const mutation = Array.isArray(verified.verifiedMutation) ? verified.verifiedMutation : [];
          const summary = {
            schemaVersion: '1.0.0',
            verdict: process.env.VERIFY_OUTCOME === 'success' ? 'pass' : 'fail',
            signer: verified.signerId ?? null,
            evidenceCommit: verified.evidenceCommit ?? null,
            candidateCommit: process.env.CANDIDATE_SHA,
            tree: process.env.CANDIDATE_TREE,
            binding: process.env.BINDING,
            policyDigest: process.env.POLICY_DIGEST,
            rosterCount: mutation.reduce((count, entry) => count + Number(entry.packageCount ?? 0), 0),
          };
          fs.writeFileSync(output, JSON.stringify(summary) + '\\n');
          NODE

      - name: Upload verification summary
        if: always()
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: verified-local-rc-\${{ env.CANDIDATE_SHA }}
          path: \${{ runner.temp }}/devai-local-rc/verification-summary.json
          if-no-files-found: error
          retention-days: 90

      - name: Publish candidate check
        if: always()
        shell: bash
        env:
          GH_TOKEN: \${{ github.token }}
          VERIFY_OUTCOME: \${{ steps.verify.outcome }}
        run: |
          set -euo pipefail
          conclusion=failure
          test "$VERIFY_OUTCOME" != success || conclusion=success
          jq -n ${backslash}
            --arg name verified-local-rc ${backslash}
            --arg head_sha "$CANDIDATE_SHA" ${backslash}
            --arg conclusion "$conclusion" ${backslash}
            --arg title "Trusted local RC attestation" ${backslash}
            --arg summary "Binding: \${{ steps.identity.outputs.binding }}; tree: \${{ steps.identity.outputs.tree }}; tag: \${{ steps.identity.outputs.tag }}" ${backslash}
            '{name:$name,head_sha:$head_sha,status:"completed",conclusion:$conclusion,output:{title:$title,summary:$summary}}' ${backslash}
            | gh api --method POST "repos/$GITHUB_REPOSITORY/check-runs" --input -

      - name: Enforce verification result
        if: always()
        shell: bash
        env:
          VERIFY_OUTCOME: \${{ steps.verify.outcome }}
        run: test "$VERIFY_OUTCOME" = success
`;
}

export function ledgerVerificationWorkflow(): string {
  const backslash = '\\';
  return `name: DEVAI ledger verification

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  push:
    branches: [main]
  workflow_dispatch: {}

concurrency:
  group: devai-ledger-verify-\${{ github.event.pull_request.head.sha || github.sha }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}

permissions:
  contents: read

env:
  CANDIDATE_SHA: \${{ github.event.pull_request.head.sha || github.sha }}

jobs:
  candidate-preflight:
    name: Validate candidate verifier without protected inputs
    if: \${{ github.event_name == 'pull_request' }}
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Check out exact candidate
        uses: actions/checkout@${CHECKOUT_COMMIT} # v7.0.1
        with:
          ref: \${{ env.CANDIDATE_SHA }}
          path: candidate
          fetch-depth: 1
          persist-credentials: false

      - name: Set up verifier runtime
        uses: actions/setup-node@${SETUP_NODE_COMMIT} # v7.0.0
        with:
          node-version: 24

${protectedVerifierPackageStep('Materialize protected DEVAI verifier package')}

  verify-ledger:
    name: Verify externally attested local ledger
    if: \${{ github.event_name != 'pull_request' }}
    runs-on: ubuntu-latest
    environment: ${LEDGER_ENVIRONMENT}
    timeout-minutes: 5
    steps:
      - name: Check out exact candidate
        uses: actions/checkout@${CHECKOUT_COMMIT} # v7.0.1
        with:
          ref: \${{ env.CANDIDATE_SHA }}
          path: candidate
          fetch-depth: 1
          persist-credentials: false

      - name: Set up verifier runtime
        uses: actions/setup-node@${SETUP_NODE_COMMIT} # v7.0.0
        with:
          node-version: 24

${protectedVerifierPackageStep('Materialize protected DEVAI verifier package')}

      - name: Materialize externally controlled verification inputs
        shell: bash
        env:
          ENVELOPE_B64: \${{ secrets.DEVAI_LEDGER_ENVELOPE_B64 }}
          RESULTS_TGZ_B64: \${{ secrets.DEVAI_LEDGER_RESULTS_TGZ_B64 }}
          ARTIFACTS_TGZ_B64: \${{ secrets.DEVAI_LEDGER_ARTIFACTS_TGZ_B64 }}
          TASK_POLICY_B64: \${{ secrets.DEVAI_LEDGER_TASK_POLICY_B64 }}
          TRUST_STORE_B64: \${{ secrets.DEVAI_LEDGER_TRUST_STORE_B64 }}
          TOOLCHAIN_B64: \${{ secrets.DEVAI_LEDGER_TOOLCHAIN_B64 }}
          ENVIRONMENT_B64: \${{ secrets.DEVAI_LEDGER_ENVIRONMENT_B64 }}
        run: |
          set -euo pipefail
          test -n "$ENVELOPE_B64"
          test -n "$RESULTS_TGZ_B64"
          test -n "$ARTIFACTS_TGZ_B64"
          test -n "$TASK_POLICY_B64"
          test -n "$TRUST_STORE_B64"
          test -n "$TOOLCHAIN_B64"
          test -n "$ENVIRONMENT_B64"
          control="$RUNNER_TEMP/devai-ledger-control"
          mkdir -p "$control/results" "$control/artifacts"
          printf '%s' "$ENVELOPE_B64" | base64 --decode > "$control/envelope.json"
          printf '%s' "$TASK_POLICY_B64" | base64 --decode > "$control/task-policy.json"
          printf '%s' "$TRUST_STORE_B64" | base64 --decode > "$control/trust-store.json"
          printf '%s' "$TOOLCHAIN_B64" | base64 --decode > "$control/toolchain.json"
          printf '%s' "$ENVIRONMENT_B64" | base64 --decode > "$control/environment.json"
          printf '%s' "$RESULTS_TGZ_B64" | base64 --decode > "$control/results.tgz"
          printf '%s' "$ARTIFACTS_TGZ_B64" | base64 --decode > "$control/artifacts.tgz"
          if tar -tzf "$control/results.tgz" | grep -Eq '(^/|(^|/)${backslash}.${backslash}.(/|$))'; then
            echo 'DEVAI_LEDGER_RESULTS_ARCHIVE_PATH_INVALID' >&2
            exit 2
          fi
          tar -xzf "$control/results.tgz" -C "$control/results"
          if tar -tzf "$control/artifacts.tgz" | grep -Eq '(^/|(^|/)${backslash}.${backslash}.(/|$))'; then
            echo 'DEVAI_LEDGER_ARTIFACTS_ARCHIVE_PATH_INVALID' >&2
            exit 2
          fi
          tar -xzf "$control/artifacts.tgz" -C "$control/artifacts"

      - name: Bind exact candidate identity
        id: candidate
        shell: bash
        run: |
          set -euo pipefail
          test "$(git -C candidate rev-parse HEAD)" = "$CANDIDATE_SHA"
          echo "tree=$(git -C candidate rev-parse "\${CANDIDATE_SHA}^{tree}")" >> "$GITHUB_OUTPUT"
          if test "\${{ github.event_name }}" = push; then
            echo "binding=exact-tree" >> "$GITHUB_OUTPUT"
          else
            echo "binding=exact-commit" >> "$GITHUB_OUTPUT"
          fi

      - name: Reconstruct policy and verify ledger
        shell: bash
        env:
          POLICY_DIGEST: \${{ vars.DEVAI_LEDGER_POLICY_DIGEST }}
        run: |
          set -euo pipefail
          test "$POLICY_DIGEST" != ""
          control="$RUNNER_TEMP/devai-ledger-control"
          node "$DEVAI_EVIDENCE_POLICY" ${backslash}
            --repo candidate ${backslash}
            --descriptor candidate/test-tasks.json ${backslash}
            --profile rc ${backslash}
            --schema-version 1.1.0 ${backslash}
            --commit "$CANDIDATE_SHA" ${backslash}
            --tree "\${{ steps.candidate.outputs.tree }}" ${backslash}
            --toolchain "$control/toolchain.json" ${backslash}
            --environment "$control/environment.json" ${backslash}
            --output "$control/expected-task-policy.json"
          cmp "$control/expected-task-policy.json" "$control/task-policy.json"
          node "$DEVAI_EVIDENCE_VERIFY" ${backslash}
            --envelope "$control/envelope.json" ${backslash}
            --results-dir "$control/results" ${backslash}
            --artifacts-dir "$control/artifacts" ${backslash}
            --task-policy "$control/task-policy.json" ${backslash}
            --trust "$control/trust-store.json" ${backslash}
            --repository "\${{ github.repository }}" ${backslash}
            --commit "$CANDIDATE_SHA" ${backslash}
            --tree "\${{ steps.candidate.outputs.tree }}" ${backslash}
            --policy-digest "$POLICY_DIGEST" ${backslash}
            --binding "\${{ steps.candidate.outputs.binding }}"
`;
}

export function buildCiScaffoldPlan(opts: CiScaffoldOptions): CiScaffoldPlan {
  const root = resolve(opts.targetRoot);
  const attested = readAttestedRcConfig(root);
  if (attested.errors.length > 0)
    throw new Error(`CI_SCAFFOLD_ATTESTED_RC_INVALID:${attested.errors.join(';')}`);
  const defaultRelative =
    attested.config === undefined
      ? DEFAULT_OUTPUT_RELATIVE
      : `.github/workflows/${ATTESTED_RC_WORKFLOW_FILE}`;
  const path = resolve(opts.outputPath ?? join(root, defaultRelative));
  const fromRoot = relative(root, path);
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw new Error(`CI_SCAFFOLD_PATH_ESCAPE:${path}`);
  }
  let cursor = root;
  for (const segment of fromRoot.split(sep).slice(0, -1)) {
    cursor = join(cursor, segment);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`CI_SCAFFOLD_SYMLINK_REFUSED:${path}`);
    }
  }
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`CI_SCAFFOLD_SYMLINK_REFUSED:${path}`);
  }
  return {
    path,
    content:
      attested.config === undefined
        ? ledgerVerificationWorkflow()
        : attestedRcVerificationWorkflow(),
    exists: existsSync(path),
  };
}

export interface CiScaffoldResult {
  readonly written: boolean;
  readonly reason?: string;
}

export function executeCiScaffoldPlan(
  plan: CiScaffoldPlan,
  opts: { force?: boolean } = {},
): CiScaffoldResult {
  if (plan.exists && opts.force !== true) {
    return { written: false, reason: 'exists (use --force to overwrite)' };
  }
  mkdirSync(dirname(plan.path), { recursive: true });
  writeFileSync(plan.path, plan.content);
  return { written: true };
}
