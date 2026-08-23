import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  it('binds OIDC provenance, exact main SHA, audit-only ref, and publication consent', async () => {
    const root = repository();
    const plan = buildGithubActionsAdapterPlan(root, '1.1.0-rc.1');
    await withAuthorityHostTestScope(() => executeGithubActionsAdapterPlan(plan));

    expect(verifyGithubActionsAdapter(root, '1.1.0-rc.1')).toMatchObject({ ok: true });
    const workflow = readFileSync(plan.workflowPath, 'utf8');
    expect(parseDocument(workflow).errors).toEqual([]);
    expect(workflow).toContain(`"attestation_url":"%s"}\\n' "$GITHUB_REPOSITORY"`);
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
