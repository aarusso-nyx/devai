import { existsSync, mkdirSync, writeFileSync } from '@devai-nyx/authority';
import { dirname, join } from 'node:path';

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
export const VERIFIER_COMMIT = '2c6e5acaade7aae65d23f86fc7f6fdf7e56d945c';
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

      - name: Check out pinned independent verifier
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
          TASK_POLICY_B64: \${{ secrets.DEVAI_LEDGER_TASK_POLICY_B64 }}
          TRUST_STORE_B64: \${{ secrets.DEVAI_LEDGER_TRUST_STORE_B64 }}
        run: |
          set -euo pipefail
          test -n "$ENVELOPE_B64"
          test -n "$RESULTS_TGZ_B64"
          test -n "$TASK_POLICY_B64"
          test -n "$TRUST_STORE_B64"
          control="$RUNNER_TEMP/devai-ledger-control"
          mkdir -p "$control/results"
          printf '%s' "$ENVELOPE_B64" | base64 --decode > "$control/envelope.json"
          printf '%s' "$TASK_POLICY_B64" | base64 --decode > "$control/task-policy.json"
          printf '%s' "$TRUST_STORE_B64" | base64 --decode > "$control/trust-store.json"
          printf '%s' "$RESULTS_TGZ_B64" | base64 --decode > "$control/results.tgz"
          if tar -tzf "$control/results.tgz" | grep -Eq '(^/|(^|/)${backslash}.${backslash}.(/|$))'; then
            echo 'DEVAI_LEDGER_RESULTS_ARCHIVE_PATH_INVALID' >&2
            exit 2
          fi
          tar -xzf "$control/results.tgz" -C "$control/results"

      - name: Bind exact candidate identity
        id: candidate
        shell: bash
        run: |
          set -euo pipefail
          test "$(git -C candidate rev-parse HEAD)" = "$CANDIDATE_SHA"
          echo "tree=$(git -C candidate rev-parse "\${CANDIDATE_SHA}^{tree}")" >> "$GITHUB_OUTPUT"

      - name: Verify ledger only
        shell: bash
        env:
          POLICY_DIGEST: \${{ vars.DEVAI_LEDGER_POLICY_DIGEST }}
        run: |
          set -euo pipefail
          test "$POLICY_DIGEST" != ""
          node .devai-verifier/src/cli.js ${backslash}
            --envelope "$RUNNER_TEMP/devai-ledger-control/envelope.json" ${backslash}
            --results-dir "$RUNNER_TEMP/devai-ledger-control/results" ${backslash}
            --task-policy "$RUNNER_TEMP/devai-ledger-control/task-policy.json" ${backslash}
            --trust "$RUNNER_TEMP/devai-ledger-control/trust-store.json" ${backslash}
            --repository "\${{ github.repository }}" ${backslash}
            --commit "$CANDIDATE_SHA" ${backslash}
            --tree "\${{ steps.candidate.outputs.tree }}" ${backslash}
            --policy-digest "$POLICY_DIGEST"
`;
}

export function buildCiScaffoldPlan(opts: CiScaffoldOptions): CiScaffoldPlan {
  const path = opts.outputPath ?? join(opts.targetRoot, DEFAULT_OUTPUT_RELATIVE);
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
