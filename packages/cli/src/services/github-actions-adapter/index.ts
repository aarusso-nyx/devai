import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from '@devai-nyx/authority';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { parseDocument } from 'yaml';

const WORKFLOW_PATH = '.github/workflows/devai-main-observation.yml';
const CONFIG_PATH = '.devai/config/github-actions-host-adapter.json';

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function workflowSyntaxValid(bytes: string): boolean {
  return parseDocument(bytes).errors.length === 0;
}

function gitCommonConfig(root: string): string {
  const marker = join(root, '.git');
  if (!existsSync(marker)) throw new Error('GITHUB_ACTIONS_ADAPTER_GIT_UNAVAILABLE');
  if (lstatSync(marker).isDirectory()) return join(marker, 'config');
  if (!lstatSync(marker).isFile()) throw new Error('GITHUB_ACTIONS_ADAPTER_GIT_UNAVAILABLE');
  const pointer = /^gitdir:\s*(.+)\s*$/u.exec(readFileSync(marker, 'utf8').trim())?.[1];
  if (pointer === undefined) throw new Error('GITHUB_ACTIONS_ADAPTER_GIT_UNAVAILABLE');
  const adminRoot = resolve(root, pointer);
  const commonMarker = join(adminRoot, 'commondir');
  const commonRoot = existsSync(commonMarker)
    ? resolve(adminRoot, readFileSync(commonMarker, 'utf8').trim())
    : adminRoot;
  return join(commonRoot, 'config');
}

function repositorySlug(root: string): string {
  const config = readFileSync(gitCommonConfig(root), 'utf8');
  const remote = /\[remote "origin"\][\s\S]*?\n\s*url\s*=\s*([^\n]+)/u.exec(config)?.[1]?.trim();
  const match = remote?.match(/github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?$/u);
  if (match?.[1] === undefined) throw new Error('GITHUB_ACTIONS_ADAPTER_ORIGIN_UNAVAILABLE');
  return match[1];
}

function workflow(): string {
  return `name: DEVAI main observation

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      publish_observation:
        description: Publish the authenticated observation to its dedicated audit ref
        required: true
        default: false
        type: boolean

permissions:
  contents: write
  id-token: write
  attestations: write
  packages: read

jobs:
  observe:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          ref: \${{ github.sha }}
          fetch-depth: 0
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: 24
          registry-url: https://npm.pkg.github.com
      - name: Install exact workspace
        env:
          NODE_AUTH_TOKEN: \${{ secrets.PACKAGES_READ_TOKEN }}
        run: |
          if [ -z "\${NODE_AUTH_TOKEN:-}" ]; then
            echo '::error::PACKAGES_READ_TOKEN is required for GitHub Packages access' >&2
            exit 1
          fi
          corepack enable
          corepack pnpm install --frozen-lockfile
      - name: Verify bound posture
        run: corepack pnpm exec devai doctor --repo-root . --format json
      - name: Observe exact main SHA
        run: corepack pnpm exec devai audit observe --repo-root . --at "$GITHUB_SHA" --as-role auditor --write --format json
      - id: provenance-mode
        name: Select supported provenance mode
        env:
          DEVAI_REPOSITORY_PRIVATE: \${{ github.event.repository.private }}
          DEVAI_REPOSITORY_OWNER_TYPE: \${{ github.event.repository.owner.type }}
        run: |
          if [ "$DEVAI_REPOSITORY_PRIVATE" = 'true' ] && [ "$DEVAI_REPOSITORY_OWNER_TYPE" = 'User' ]; then
            echo 'mode=github-artifact-digest' >> "$GITHUB_OUTPUT"
            echo 'GitHub artifact attestations are unavailable for user-owned private repositories; binding provenance to the immutable Actions artifact digest.'
          else
            echo 'mode=github-attestation' >> "$GITHUB_OUTPUT"
          fi
      - name: Prepare exact observation provenance
        env:
          DEVAI_PROVENANCE_MODE: \${{ steps.provenance-mode.outputs.mode }}
        run: |
          observation_root=".devai/state/audit-observations/$GITHUB_SHA"
          test -d "$observation_root"
          node <<'NODE'
          const { createHash } = require('node:crypto');
          const { readdirSync, readFileSync, writeFileSync } = require('node:fs');
          const { join } = require('node:path');
          const root = join('.devai/state/audit-observations', process.env.GITHUB_SHA);
          const files = readdirSync(root)
            .filter((name) => name.endsWith('.json') && name !== 'github-provenance.json')
            .sort()
            .map((name) => ({
              path: name,
              sha256: createHash('sha256').update(readFileSync(join(root, name))).digest('hex'),
            }));
          if (files.length === 0) throw new Error('DEVAI_OBSERVATION_FILES_MISSING');
          const document = {
            schemaVersion: '1.0.0',
            repository: process.env.GITHUB_REPOSITORY,
            workflow: process.env.GITHUB_WORKFLOW_REF,
            ref: process.env.GITHUB_REF,
            sha: process.env.GITHUB_SHA,
            run_id: process.env.GITHUB_RUN_ID,
            run_attempt: process.env.GITHUB_RUN_ATTEMPT,
            provenance_mode: process.env.DEVAI_PROVENANCE_MODE,
            files,
          };
          writeFileSync(join(root, 'github-provenance.json'), JSON.stringify(document, null, 2) + '\\n');
          NODE
      - id: observation-artifact
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          name: devai-main-observation-\${{ github.sha }}
          path: .devai/state/audit-observations/\${{ github.sha }}/
          if-no-files-found: error
          retention-days: 90
      - name: Verify immutable observation artifact binding
        env:
          DEVAI_ARTIFACT_ID: \${{ steps.observation-artifact.outputs.artifact-id }}
          DEVAI_ARTIFACT_URL: \${{ steps.observation-artifact.outputs.artifact-url }}
          DEVAI_ARTIFACT_DIGEST: \${{ steps.observation-artifact.outputs.artifact-digest }}
        run: |
          test -n "$DEVAI_ARTIFACT_ID"
          test -n "$DEVAI_ARTIFACT_URL"
          node -e "if (!/^[0-9a-f]{64}$/u.test(process.env.DEVAI_ARTIFACT_DIGEST ?? '')) { console.error('immutable observation artifact digest is missing or invalid'); process.exit(1); }"
      - id: attest
        if: steps.provenance-mode.outputs.mode == 'github-attestation'
        uses: actions/attest-build-provenance@977bb373ede98d70efdf65b84cb5f73e068dcc2a
        with:
          subject-path: .devai/state/audit-observations/\${{ github.sha }}/*
      - name: Record explicit provenance result
        env:
          DEVAI_PROVENANCE_MODE: \${{ steps.provenance-mode.outputs.mode }}
          DEVAI_ARTIFACT_ID: \${{ steps.observation-artifact.outputs.artifact-id }}
          DEVAI_ARTIFACT_URL: \${{ steps.observation-artifact.outputs.artifact-url }}
          DEVAI_ARTIFACT_DIGEST: \${{ steps.observation-artifact.outputs.artifact-digest }}
          DEVAI_ATTESTATION_URL: \${{ steps.attest.outputs.attestation-url }}
        run: |
          receipt_root=".devai/state/audit-receipts/$GITHUB_SHA"
          mkdir -p "$receipt_root"
          node <<'NODE'
          const { writeFileSync } = require('node:fs');
          const { join } = require('node:path');
          const mode = process.env.DEVAI_PROVENANCE_MODE;
          const attestationUrl = process.env.DEVAI_ATTESTATION_URL ?? '';
          if (mode === 'github-attestation' && attestationUrl.length === 0)
            throw new Error('DEVAI_GITHUB_ATTESTATION_REQUIRED');
          if (mode === 'github-artifact-digest' && attestationUrl.length !== 0)
            throw new Error('DEVAI_UNEXPECTED_GITHUB_ATTESTATION');
          if (!/^[0-9a-f]{64}$/u.test(process.env.DEVAI_ARTIFACT_DIGEST ?? ''))
            throw new Error('DEVAI_ARTIFACT_DIGEST_INVALID');
          const document = {
            schemaVersion: '1.0.0',
            repository: process.env.GITHUB_REPOSITORY,
            workflow: process.env.GITHUB_WORKFLOW_REF,
            ref: process.env.GITHUB_REF,
            sha: process.env.GITHUB_SHA,
            run_id: process.env.GITHUB_RUN_ID,
            run_attempt: process.env.GITHUB_RUN_ATTEMPT,
            provenance_mode: mode,
            artifact: {
              id: process.env.DEVAI_ARTIFACT_ID,
              url: process.env.DEVAI_ARTIFACT_URL,
              digest_sha256: process.env.DEVAI_ARTIFACT_DIGEST,
              immutable: true,
            },
            github_attestation:
              mode === 'github-attestation'
                ? { status: 'created', url: attestationUrl }
                : {
                    status: 'unavailable',
                    reason: 'github-artifact-attestations-unavailable-for-user-owned-private-repository',
                  },
          };
          writeFileSync(join('.devai/state/audit-receipts', process.env.GITHUB_SHA, 'github-provenance-receipt.json'), JSON.stringify(document, null, 2) + '\\n');
          NODE
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          name: devai-main-observation-receipt-\${{ github.sha }}
          path: .devai/state/audit-receipts/\${{ github.sha }}/github-provenance-receipt.json
          if-no-files-found: error
          retention-days: 90
      - name: Publish dedicated audit ref with explicit consent
        if: github.event_name == 'workflow_dispatch' && inputs.publish_observation && vars.DEVAI_ALLOW_OBSERVATION_PUBLICATION == 'true'
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          observation_repo="$RUNNER_TEMP/devai-observation"
          mkdir -p "$observation_repo/work/audit/post-merge/$GITHUB_SHA"
          cp ".devai/state/audit-observations/$GITHUB_SHA/"*.json "$observation_repo/work/audit/post-merge/$GITHUB_SHA/"
          cp ".devai/state/audit-receipts/$GITHUB_SHA/github-provenance-receipt.json" "$observation_repo/work/audit/post-merge/$GITHUB_SHA/"
          git -C "$observation_repo" init -b audit
          git -C "$observation_repo" config user.name 'DEVAI Auditor'
          git -C "$observation_repo" config user.email 'aarusso@nyxk.com.br'
          git -C "$observation_repo" add work
          git -C "$observation_repo" commit -m "audit(post-merge): observe $GITHUB_SHA"
          git -C "$observation_repo" push "https://x-access-token:$GH_TOKEN@github.com/$GITHUB_REPOSITORY.git" "HEAD:refs/devai/post-merge/$GITHUB_SHA"
`;
}

export interface GithubActionsAdapterPlan {
  readonly workflowPath: string;
  readonly configPath: string;
  readonly workflowBytes: string;
  readonly configBytes: string;
}

export function buildGithubActionsAdapterPlan(
  targetRoot: string,
  devaiVersion: string,
): GithubActionsAdapterPlan {
  const root = resolve(targetRoot);
  const workflowBytes = workflow();
  if (!workflowSyntaxValid(workflowBytes))
    throw new Error('GITHUB_ACTIONS_ADAPTER_WORKFLOW_SYNTAX_INVALID');
  const repository = repositorySlug(root);
  const config = {
    schemaVersion: '1.0.0',
    adapter_id: 'github-actions-main-observation',
    adapter_version: devaiVersion,
    repository,
    workflow_path: WORKFLOW_PATH,
    workflow_digest_sha256: sha256(workflowBytes),
    branch: 'main',
    ref_prefix: 'refs/devai/post-merge/',
    provenance: {
      primary: 'github-attestation',
      capability_exception: {
        repository_visibility: 'private',
        repository_owner_type: 'User',
        mode: 'github-artifact-digest',
        attestation_status: 'unavailable',
      },
      artifact_immutability: 'actions-upload-artifact-v4',
      receipt_path: 'github-provenance-receipt.json',
    },
    publication_consent_variable: 'DEVAI_ALLOW_OBSERVATION_PUBLICATION',
    package_binding: { name: '@aarusso-nyx/devai', version: devaiVersion },
  };
  return {
    workflowPath: join(root, WORKFLOW_PATH),
    configPath: join(root, CONFIG_PATH),
    workflowBytes,
    configBytes: `${JSON.stringify(config, null, 2)}\n`,
  };
}

export function executeGithubActionsAdapterPlan(plan: GithubActionsAdapterPlan): void {
  for (const path of [plan.workflowPath, plan.configPath])
    mkdirSync(dirname(path), { recursive: true });
  writeFileSync(plan.workflowPath, plan.workflowBytes);
  writeFileSync(plan.configPath, plan.configBytes);
}

export function verifyGithubActionsAdapter(
  targetRoot: string,
  devaiVersion: string,
): {
  readonly ok: boolean;
  readonly facts: Readonly<Record<string, boolean>>;
  readonly errors: readonly string[];
} {
  const root = resolve(targetRoot);
  const workflowPath = join(root, WORKFLOW_PATH);
  const configPath = join(root, CONFIG_PATH);
  const facts: Record<string, boolean> = {
    workflow_present: existsSync(workflowPath),
    config_present: existsSync(configPath),
  };
  const errors: string[] = [];
  try {
    if (!facts['workflow_present'] || !facts['config_present']) return { ok: false, facts, errors };
    const bytes = readFileSync(workflowPath, 'utf8');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    facts['workflow_syntax_valid'] = workflowSyntaxValid(bytes);
    facts['workflow_bound'] = config['workflow_digest_sha256'] === sha256(bytes);
    facts['repository_bound'] = config['repository'] === repositorySlug(root);
    facts['main_bound'] =
      config['branch'] === 'main' && bytes.includes("github.ref == 'refs/heads/main'");
    facts['exact_sha_bound'] = bytes.includes('--at "$GITHUB_SHA"');
    facts['package_auth_secret_bound'] = bytes.includes(
      'NODE_AUTH_TOKEN: ${{ secrets.PACKAGES_READ_TOKEN }}',
    );
    facts['package_auth_fail_closed'] =
      bytes.includes('if [ -z "${NODE_AUTH_TOKEN:-}" ]; then') &&
      bytes.includes('PACKAGES_READ_TOKEN is required for GitHub Packages access');
    facts['package_auth_no_repository_token_fallback'] =
      !bytes.includes('secrets.DEVAI_REPO_TOKEN') &&
      !/NODE_AUTH_TOKEN:.*secrets\.GITHUB_TOKEN/u.test(bytes);
    facts['oidc_enabled'] =
      bytes.includes('id-token: write') && bytes.includes('attest-build-provenance@');
    const provenance = config['provenance'] as Record<string, unknown> | undefined;
    const capability = provenance?.['capability_exception'] as Record<string, unknown> | undefined;
    facts['provenance_capability_bound'] =
      provenance?.['primary'] === 'github-attestation' &&
      capability?.['repository_visibility'] === 'private' &&
      capability?.['repository_owner_type'] === 'User' &&
      capability?.['mode'] === 'github-artifact-digest' &&
      capability?.['attestation_status'] === 'unavailable';
    facts['private_user_artifact_digest_bound'] =
      bytes.includes('[ "$DEVAI_REPOSITORY_PRIVATE" = \'true\' ]') &&
      bytes.includes('[ "$DEVAI_REPOSITORY_OWNER_TYPE" = \'User\' ]') &&
      bytes.includes('echo \'mode=github-artifact-digest\' >> "$GITHUB_OUTPUT"') &&
      bytes.includes("if: steps.provenance-mode.outputs.mode == 'github-attestation'");
    facts['attestation_fail_closed_when_required'] =
      !bytes.includes('continue-on-error: true') &&
      bytes.includes("throw new Error('DEVAI_GITHUB_ATTESTATION_REQUIRED')");
    facts['immutable_artifact_digest_bound'] =
      bytes.includes('steps.observation-artifact.outputs.artifact-digest') &&
      bytes.includes("throw new Error('DEVAI_ARTIFACT_DIGEST_INVALID')") &&
      bytes.includes('immutable: true');
    facts['explicit_unavailable_receipt_bound'] =
      bytes.includes("status: 'unavailable'") &&
      bytes.includes(
        "reason: 'github-artifact-attestations-unavailable-for-user-owned-private-repository'",
      ) &&
      bytes.includes('github-provenance-receipt.json');
    facts['audit_ref_only'] =
      bytes.includes('refs/devai/post-merge/$GITHUB_SHA') &&
      !bytes.includes('HEAD:refs/heads/main');
    facts['publication_consent_bound'] =
      bytes.includes('inputs.publish_observation') &&
      bytes.includes("vars.DEVAI_ALLOW_OBSERVATION_PUBLICATION == 'true'");
    const binding = config['package_binding'] as Record<string, unknown> | undefined;
    facts['package_bound'] =
      binding?.['name'] === '@aarusso-nyx/devai' && binding['version'] === devaiVersion;
    for (const [name, value] of Object.entries(facts))
      if (!value) errors.push(`GITHUB_ACTIONS_${name.toUpperCase()}_INVALID`);
    return { ok: errors.length === 0, facts, errors };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return { ok: false, facts, errors };
  }
}
