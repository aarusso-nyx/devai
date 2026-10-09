import { actionPinDigestIfPresent, getActionPins } from './action-pins.js';
import { verifierPackagePolicy, protectedVerifierPackageStep } from './verifier-package.js';

export const LEDGER_ENVIRONMENT = 'devai-ledger-verification';
// The generated workflows share one action pin set, read from the adopter toolchain defaults
// (#383) when a workflow is generated, never at import. These two informational exports are the
// empty string where the packaged defaults are absent; the generators below fail closed.
export const CHECKOUT_COMMIT = actionPinDigestIfPresent('checkout');
export const SETUP_NODE_COMMIT = actionPinDigestIfPresent('setupNode');

export function attestedRcVerificationWorkflow(): string {
  const { checkout, setupNode, uploadArtifact } = getActionPins();
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
        uses: actions/checkout@${checkout.digest} # ${checkout.ref}
        with:
          ref: \${{ env.CANDIDATE_SHA }}
          path: candidate
          fetch-depth: 1
          persist-credentials: false

      - name: Check out default-branch controls
        uses: actions/checkout@${checkout.digest} # ${checkout.ref}
        with:
          ref: main
          path: control
          fetch-depth: 1
          persist-credentials: false

      - name: Set up verifier runtime
        uses: actions/setup-node@${setupNode.digest} # ${setupNode.ref}
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
        uses: actions/checkout@${checkout.digest} # ${checkout.ref}
        with:
          ref: \${{ steps.identity.outputs.proof_commit }}
          path: evidence
          fetch-depth: 1
          persist-credentials: false

      - name: Materialize inert versioned proof payload
        id: proof
        shell: bash
        run: |
          set -euo pipefail
          proof="$RUNNER_TEMP/devai-local-rc/proof"
          mkdir -p "$proof"
          git -C evidence archive "\${{ steps.identity.outputs.proof_commit }}" ${backslash}
            | tar -x -C "$proof" --no-same-owner --no-same-permissions
          test ! -e "$proof/.git"
          echo "path=$proof" >> "$GITHUB_OUTPUT"

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
          cmp "$RUNNER_TEMP/devai-local-rc/expected-task-policy.json" "\${{ steps.proof.outputs.path }}/task-policy.json"
          digest="$(node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(process.argv[1]));process.stdout.write(x.taskPolicyDigest)' "$RUNNER_TEMP/devai-local-rc/policy-result.json")"
          echo "digest=$digest" >> "$GITHUB_OUTPUT"

      - name: Verify complete trusted local RC bundle
        id: verify
        continue-on-error: true
        shell: bash
        run: |
          set -euo pipefail
          node "$DEVAI_EVIDENCE_BUNDLE_VERIFY" ${backslash}
            --bundle "\${{ steps.proof.outputs.path }}" ${backslash}
            --trust control/law/policy/devai-local-rc-trust-store.json ${backslash}
            --repository "$GITHUB_REPOSITORY" ${backslash}
            --commit "$CANDIDATE_SHA" ${backslash}
            --tree "\${{ steps.identity.outputs.tree }}" ${backslash}
            --policy-digest "\${{ steps.policy.outputs.digest }}" ${backslash}
            --binding "\${{ steps.identity.outputs.binding }}" ${backslash}
            > "$RUNNER_TEMP/devai-local-rc/verified.json" ${backslash}
            2> "$RUNNER_TEMP/devai-local-rc/verifier-error.json"

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
          node - "$RUNNER_TEMP/devai-local-rc/verified.json" "$RUNNER_TEMP/devai-local-rc/verifier-error.json" "$RUNNER_TEMP/devai-local-rc/verification-summary.json" <<'NODE'
          const fs = require('node:fs');
          const [successInput, failureInput, output] = process.argv.slice(2);
          const parseDiagnostic = (path) => {
            if (!fs.existsSync(path)) return {};
            const text = fs.readFileSync(path, 'utf8').trim();
            if (text === '') return {};
            for (const candidate of [text, ...text.split(/\\r?\\n/u).reverse()]) {
              try {
                const value = JSON.parse(candidate);
                if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
              } catch {}
            }
            return {};
          };
          const success = parseDiagnostic(successInput);
          const failure = parseDiagnostic(failureInput);
          const verified = Object.keys(success).length > 0 ? success : failure;
          const mutation = Array.isArray(verified.verifiedMutation) ? verified.verifiedMutation : [];
          const passed = process.env.VERIFY_OUTCOME === 'success';
          const summary = {
            schemaVersion: '1.0.0',
            verdict: passed ? 'pass' : 'fail',
            signer: verified.signerId ?? null,
            evidenceCommit: verified.evidenceCommit ?? null,
            candidateCommit: process.env.CANDIDATE_SHA,
            tree: process.env.CANDIDATE_TREE,
            binding: process.env.BINDING,
            policyDigest: process.env.POLICY_DIGEST,
            rosterCount: mutation.reduce((count, entry) => count + Number(entry.packageCount ?? 0), 0),
            failureCode: passed ? null : (verified.code ?? verified.error?.code ?? 'VERIFIER_FAILED'),
            failureMessage: passed ? null : (verified.message ?? verified.error?.message ?? null),
          };
          fs.writeFileSync(output, JSON.stringify(summary) + '\\n');
          NODE

      - name: Upload verification summary
        if: always()
        uses: actions/upload-artifact@${uploadArtifact.digest} # ${uploadArtifact.ref}
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
  const { checkout, setupNode } = getActionPins();
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
        uses: actions/checkout@${checkout.digest} # ${checkout.ref}
        with:
          ref: \${{ env.CANDIDATE_SHA }}
          path: candidate
          fetch-depth: 1
          persist-credentials: false

      - name: Set up verifier runtime
        uses: actions/setup-node@${setupNode.digest} # ${setupNode.ref}
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
        uses: actions/checkout@${checkout.digest} # ${checkout.ref}
        with:
          ref: \${{ env.CANDIDATE_SHA }}
          path: candidate
          fetch-depth: 1
          persist-credentials: false

      - name: Set up verifier runtime
        uses: actions/setup-node@${setupNode.digest} # ${setupNode.ref}
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
