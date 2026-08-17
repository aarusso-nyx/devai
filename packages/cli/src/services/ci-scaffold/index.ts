import { existsSync, lstatSync, mkdirSync, writeFileSync } from '@devai-nyx/authority';
import { dirname, join, relative, resolve, sep } from 'node:path';

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
export const VERIFIER_REPOSITORY = 'devai-nyx/devai-verifier';
export const VERIFIER_COMMIT = '0b75ede0ae97d88b6fc0babcd6f5197eb33b9f77';
export const LEDGER_ENVIRONMENT = 'devai-ledger-verification';
export const CHECKOUT_COMMIT = '3d3c42e5aac5ba805825da76410c181273ba90b1';
export const SETUP_NODE_COMMIT = '820762786026740c76f36085b0efc47a31fe5020';

const DEFAULT_OUTPUT_RELATIVE = `.github/workflows/${LEDGER_WORKFLOW_FILE}`;

export function ledgerVerificationWorkflow(): string {
  const backslash = '\\';
  return `name: DEVAI ledger verification

on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review]
  push:
    branches: [main]
  workflow_dispatch: {}

concurrency:
  group: devai-ledger-verify-\${{ github.event.pull_request.head.sha || github.sha }}
  cancel-in-progress: \${{ github.event_name == 'pull_request_target' }}

permissions:
  contents: read

env:
  CANDIDATE_SHA: \${{ github.event.pull_request.head.sha || github.sha }}

jobs:
  verify-ledger:
    name: Verify externally attested local ledger
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

      - name: Check out pinned external verifier
        uses: actions/checkout@${CHECKOUT_COMMIT} # v7.0.1
        with:
          repository: ${VERIFIER_REPOSITORY}
          ref: ${VERIFIER_COMMIT}
          path: .devai-verifier
          fetch-depth: 1
          persist-credentials: false

      - name: Set up verifier runtime
        uses: actions/setup-node@${SETUP_NODE_COMMIT} # v7.0.0
        with:
          node-version: 24

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

      - name: Reconstruct policy and verify ledger
        shell: bash
        env:
          POLICY_DIGEST: \${{ vars.DEVAI_LEDGER_POLICY_DIGEST }}
        run: |
          set -euo pipefail
          test "$POLICY_DIGEST" != ""
          control="$RUNNER_TEMP/devai-ledger-control"
          node .devai-verifier/src/build-policy-cli.js ${backslash}
            --repo candidate ${backslash}
            --descriptor candidate/test-tasks.json ${backslash}
            --profile rc ${backslash}
            --commit "$CANDIDATE_SHA" ${backslash}
            --tree "\${{ steps.candidate.outputs.tree }}" ${backslash}
            --toolchain "$control/toolchain.json" ${backslash}
            --environment "$control/environment.json" ${backslash}
            --output "$control/expected-task-policy.json"
          cmp "$control/expected-task-policy.json" "$control/task-policy.json"
          node .devai-verifier/src/cli.js ${backslash}
            --envelope "$control/envelope.json" ${backslash}
            --results-dir "$control/results" ${backslash}
            --artifacts-dir "$control/artifacts" ${backslash}
            --task-policy "$control/task-policy.json" ${backslash}
            --trust "$control/trust-store.json" ${backslash}
            --repository "\${{ github.repository }}" ${backslash}
            --commit "$CANDIDATE_SHA" ${backslash}
            --tree "\${{ steps.candidate.outputs.tree }}" ${backslash}
            --policy-digest "$POLICY_DIGEST"
`;
}

export function buildCiScaffoldPlan(opts: CiScaffoldOptions): CiScaffoldPlan {
  const root = resolve(opts.targetRoot);
  const path = resolve(opts.outputPath ?? join(root, DEFAULT_OUTPUT_RELATIVE));
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
  return { path, content: ledgerVerificationWorkflow(), exists: existsSync(path) };
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
