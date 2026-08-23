import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  buildGithubActionsAdapterPlan,
  executeGithubActionsAdapterPlan,
  verifyGithubActionsAdapter,
} from '../../src/services/github-actions-adapter/index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-github-actions-adapter-'));
  roots.push(root);
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(
    join(root, '.git/config'),
    '[remote "origin"]\n\turl = https://github.com/example/adopter.git\n',
  );
  return root;
}

function linkedWorktreeRepository(): string {
  const fixture = mkdtempSync(join(tmpdir(), 'devai-github-actions-linked-worktree-'));
  roots.push(fixture);
  const root = join(fixture, 'checkout');
  const common = join(fixture, 'common.git');
  const admin = join(common, 'worktrees', 'checkout');
  mkdirSync(root, { recursive: true });
  mkdirSync(admin, { recursive: true });
  writeFileSync(join(root, '.git'), `gitdir: ${admin}\n`);
  writeFileSync(join(admin, 'commondir'), '../..\n');
  writeFileSync(
    join(common, 'config'),
    '[remote "origin"]\n\turl = git@github.com:example/linked-adopter.git\n',
  );
  return root;
}

describe('GitHub Actions main-observation adapter', () => {
  it('binds capability-aware provenance, exact main SHA, audit-only ref, and publication consent', async () => {
    const root = repository();
    const plan = buildGithubActionsAdapterPlan(root, '1.1.0-rc.1');
    await withAuthorityHostTestScope(() => executeGithubActionsAdapterPlan(plan));

    expect(verifyGithubActionsAdapter(root, '1.1.0-rc.1')).toMatchObject({ ok: true });
    const workflow = readFileSync(plan.workflowPath, 'utf8');
    expect(parseDocument(workflow).errors).toEqual([]);
    expect(workflow).toContain('echo \'mode=github-artifact-digest\' >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain("if: steps.provenance-mode.outputs.mode == 'github-attestation'");
    expect(workflow).toContain('steps.observation-artifact.outputs.artifact-digest');
    expect(workflow).toContain("status: 'unavailable'");
    expect(workflow).toContain(
      "reason: 'github-artifact-attestations-unavailable-for-user-owned-private-repository'",
    );
    expect(workflow).toContain('github-provenance-receipt.json');
    expect(workflow).not.toContain('continue-on-error: true');
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain('--at "$GITHUB_SHA"');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('packages: read');
    expect(workflow).toContain('NODE_AUTH_TOKEN: ${{ secrets.PACKAGES_READ_TOKEN }}');
    expect(workflow).toContain('if [ -z "${NODE_AUTH_TOKEN:-}" ]; then');
    expect(workflow).not.toContain(
      'NODE_AUTH_TOKEN: ${{ secrets.DEVAI_REPO_TOKEN || secrets.GITHUB_TOKEN }}',
    );
    expect(workflow).not.toContain('NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    expect(workflow).toContain('refs/devai/post-merge/$GITHUB_SHA');
    expect(workflow).toContain(
      'cp ".devai/state/audit-observations/$GITHUB_SHA/"*.json "$observation_repo/work/audit/post-merge/$GITHUB_SHA/"',
    );
    expect(workflow).not.toContain('HEAD:refs/heads/main');
  });

  it('selects the immutable artifact-digest path only for a private user-owned repository', async () => {
    const root = repository();
    const plan = buildGithubActionsAdapterPlan(root, '1.2.6');
    const document = parseDocument(plan.workflowBytes).toJS() as {
      jobs: { observe: { steps: Array<Record<string, unknown>> } };
    };
    const step = document.jobs.observe.steps.find((entry) => entry['id'] === 'provenance-mode');
    const output = join(root, 'provenance-mode-output');
    const privateUser = spawnSync('bash', ['-euo', 'pipefail', '-c', String(step?.['run'])], {
      env: {
        ...process.env,
        DEVAI_REPOSITORY_PRIVATE: 'true',
        DEVAI_REPOSITORY_OWNER_TYPE: 'User',
        GITHUB_OUTPUT: output,
      },
      encoding: 'utf8',
    });
    expect(privateUser.status).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe('mode=github-artifact-digest\n');

    writeFileSync(output, '');
    const publicUser = spawnSync('bash', ['-euo', 'pipefail', '-c', String(step?.['run'])], {
      env: {
        ...process.env,
        DEVAI_REPOSITORY_PRIVATE: 'false',
        DEVAI_REPOSITORY_OWNER_TYPE: 'User',
        GITHUB_OUTPUT: output,
      },
      encoding: 'utf8',
    });
    expect(publicUser.status).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe('mode=github-attestation\n');
  });

  it('records unavailable GitHub attestation without claiming that an attestation exists', async () => {
    const root = repository();
    const plan = buildGithubActionsAdapterPlan(root, '1.2.6');
    const document = parseDocument(plan.workflowBytes).toJS() as {
      jobs: { observe: { steps: Array<Record<string, unknown>> } };
    };
    const step = document.jobs.observe.steps.find(
      (entry) => entry['name'] === 'Record explicit provenance result',
    );
    const sha = 'a'.repeat(40);
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', String(step?.['run'])], {
      cwd: root,
      env: {
        ...process.env,
        DEVAI_PROVENANCE_MODE: 'github-artifact-digest',
        DEVAI_ARTIFACT_ID: '1234',
        DEVAI_ARTIFACT_URL: 'https://github.com/example/adopter/actions/runs/7/artifacts/1234',
        DEVAI_ARTIFACT_DIGEST: 'b'.repeat(64),
        DEVAI_ATTESTATION_URL: '',
        GITHUB_REPOSITORY: 'example/adopter',
        GITHUB_WORKFLOW_REF:
          'example/adopter/.github/workflows/devai-main-observation.yml@refs/heads/main',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_SHA: sha,
        GITHUB_RUN_ID: '7',
        GITHUB_RUN_ATTEMPT: '1',
      },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(
      JSON.parse(
        readFileSync(
          join(root, '.devai/state/audit-receipts', sha, 'github-provenance-receipt.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({
      provenance_mode: 'github-artifact-digest',
      artifact: { digest_sha256: 'b'.repeat(64), immutable: true },
      github_attestation: {
        status: 'unavailable',
        reason: 'github-artifact-attestations-unavailable-for-user-owned-private-repository',
      },
    });
  });

  it('accepts the exact upload-artifact SHA-256 output and rejects malformed digests', async () => {
    const root = repository();
    const plan = buildGithubActionsAdapterPlan(root, '1.2.6');
    const document = parseDocument(plan.workflowBytes).toJS() as {
      jobs: { observe: { steps: Array<Record<string, unknown>> } };
    };
    const step = document.jobs.observe.steps.find(
      (entry) => entry['name'] === 'Verify immutable observation artifact binding',
    );
    const execute = (digest: string) =>
      spawnSync('bash', ['-euo', 'pipefail', '-c', String(step?.['run'])], {
        env: {
          ...process.env,
          DEVAI_ARTIFACT_ID: '9485713510',
          DEVAI_ARTIFACT_URL:
            'https://github.com/example/adopter/actions/runs/32611725469/artifacts/9485713510',
          DEVAI_ARTIFACT_DIGEST: digest,
        },
        encoding: 'utf8',
      });
    expect(execute('2f0fd477e3913500caa533d93431a4cb86ce295b01cd076eefeb85e8490e1fb3').status).toBe(
      0,
    );
    expect(execute('not-a-digest').status).not.toBe(0);
  });

  it('fails closed when an eligible repository does not produce a GitHub attestation', async () => {
    const root = repository();
    const plan = buildGithubActionsAdapterPlan(root, '1.2.6');
    const document = parseDocument(plan.workflowBytes).toJS() as {
      jobs: { observe: { steps: Array<Record<string, unknown>> } };
    };
    const step = document.jobs.observe.steps.find(
      (entry) => entry['name'] === 'Record explicit provenance result',
    );
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', String(step?.['run'])], {
      cwd: root,
      env: {
        ...process.env,
        DEVAI_PROVENANCE_MODE: 'github-attestation',
        DEVAI_ARTIFACT_ID: '1234',
        DEVAI_ARTIFACT_URL: 'https://github.com/example/adopter/actions/runs/7/artifacts/1234',
        DEVAI_ARTIFACT_DIGEST: 'b'.repeat(64),
        DEVAI_ATTESTATION_URL: '',
        GITHUB_REPOSITORY: 'example/adopter',
        GITHUB_WORKFLOW_REF:
          'example/adopter/.github/workflows/devai-main-observation.yml@refs/heads/main',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_SHA: 'a'.repeat(40),
        GITHUB_RUN_ID: '7',
        GITHUB_RUN_ATTEMPT: '1',
      },
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('DEVAI_GITHUB_ATTESTATION_REQUIRED');
  });

  it('rejects an adapter that makes the required attestation best-effort', async () => {
    const root = repository();
    const plan = buildGithubActionsAdapterPlan(root, '1.2.6');
    await withAuthorityHostTestScope(() => executeGithubActionsAdapterPlan(plan));
    writeFileSync(
      plan.workflowPath,
      readFileSync(plan.workflowPath, 'utf8').replace(
        '      - id: attest\n',
        '      - id: attest\n        continue-on-error: true\n',
      ),
    );
    expect(verifyGithubActionsAdapter(root, '1.2.6')).toMatchObject({
      ok: false,
      facts: { attestation_fail_closed_when_required: false },
    });
  });

  it('rejects drift in the closed private-user capability exception', async () => {
    const root = repository();
    const plan = buildGithubActionsAdapterPlan(root, '1.2.6');
    await withAuthorityHostTestScope(() => executeGithubActionsAdapterPlan(plan));
    const config = JSON.parse(readFileSync(plan.configPath, 'utf8')) as Record<string, unknown>;
    const provenance = config['provenance'] as Record<string, unknown>;
    const capability = provenance['capability_exception'] as Record<string, unknown>;
    capability['repository_owner_type'] = 'Organization';
    writeFileSync(plan.configPath, `${JSON.stringify(config, null, 2)}\n`);
    expect(verifyGithubActionsAdapter(root, '1.2.6')).toMatchObject({
      ok: false,
      facts: { provenance_capability_bound: false },
    });
  });

  it('detects workflow drift against the Architect-bound digest', async () => {
    const root = repository();
    const plan = buildGithubActionsAdapterPlan(root, '1.1.0-rc.1');
    await withAuthorityHostTestScope(() => executeGithubActionsAdapterPlan(plan));
    writeFileSync(plan.workflowPath, `${readFileSync(plan.workflowPath, 'utf8')}# drift\n`);
    expect(verifyGithubActionsAdapter(root, '1.1.0-rc.1').ok).toBe(false);
  });

  it('rejects a workflow that falls back to the repository-scoped token for package access', async () => {
    const root = repository();
    const plan = buildGithubActionsAdapterPlan(root, '1.1.6');
    await withAuthorityHostTestScope(() => executeGithubActionsAdapterPlan(plan));
    writeFileSync(
      plan.workflowPath,
      readFileSync(plan.workflowPath, 'utf8').replace(
        '${{ secrets.PACKAGES_READ_TOKEN }}',
        '${{ secrets.GITHUB_TOKEN }}',
      ),
    );
    expect(verifyGithubActionsAdapter(root, '1.1.6')).toMatchObject({
      ok: false,
      facts: {
        package_auth_secret_bound: false,
        package_auth_no_repository_token_fallback: false,
      },
    });
  });

  it('rejects the legacy optional package-token fallback even when the protected secret remains', async () => {
    const root = repository();
    const plan = buildGithubActionsAdapterPlan(root, '1.1.6');
    await withAuthorityHostTestScope(() => executeGithubActionsAdapterPlan(plan));
    writeFileSync(
      plan.workflowPath,
      `${readFileSync(plan.workflowPath, 'utf8')}# \${{ secrets.DEVAI_REPO_TOKEN || secrets.GITHUB_TOKEN }}\n`,
    );
    expect(verifyGithubActionsAdapter(root, '1.1.6')).toMatchObject({
      ok: false,
      facts: { package_auth_no_repository_token_fallback: false },
    });
  });

  it('rejects a workflow that does not fail closed when package credentials are absent', async () => {
    const root = repository();
    const plan = buildGithubActionsAdapterPlan(root, '1.1.6');
    await withAuthorityHostTestScope(() => executeGithubActionsAdapterPlan(plan));
    writeFileSync(
      plan.workflowPath,
      readFileSync(plan.workflowPath, 'utf8').replace(
        'if [ -z "${NODE_AUTH_TOKEN:-}" ]; then',
        'if false; then',
      ),
    );
    expect(verifyGithubActionsAdapter(root, '1.1.6')).toMatchObject({
      ok: false,
      facts: { package_auth_fail_closed: false },
    });
  });

  it('binds the common origin configuration from a linked Git worktree', async () => {
    const root = linkedWorktreeRepository();
    const plan = buildGithubActionsAdapterPlan(root, '1.1.0-rc.4');
    await withAuthorityHostTestScope(() => executeGithubActionsAdapterPlan(plan));
    expect(verifyGithubActionsAdapter(root, '1.1.0-rc.4')).toMatchObject({
      ok: true,
      facts: { workflow_syntax_valid: true },
    });
    expect(JSON.parse(readFileSync(plan.configPath, 'utf8'))).toMatchObject({
      repository: 'example/linked-adopter',
    });
  });
});
