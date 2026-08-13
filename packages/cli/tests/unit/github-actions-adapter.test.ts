import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain('--at "$GITHUB_SHA"');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('packages: read');
    expect(workflow).toContain('refs/devai/post-merge/$GITHUB_SHA');
    expect(workflow).not.toContain('HEAD:refs/heads/main');
  });

  it('detects workflow drift against the Architect-bound digest', async () => {
    const root = repository();
    const plan = buildGithubActionsAdapterPlan(root, '1.1.0-rc.1');
    await withAuthorityHostTestScope(() => executeGithubActionsAdapterPlan(plan));
    writeFileSync(plan.workflowPath, `${readFileSync(plan.workflowPath, 'utf8')}# drift\n`);
    expect(verifyGithubActionsAdapter(root, '1.1.0-rc.1').ok).toBe(false);
  });

  it('binds the common origin configuration from a linked Git worktree', async () => {
    const root = linkedWorktreeRepository();
    const plan = buildGithubActionsAdapterPlan(root, '1.1.0-rc.3');
    await withAuthorityHostTestScope(() => executeGithubActionsAdapterPlan(plan));
    expect(verifyGithubActionsAdapter(root, '1.1.0-rc.3')).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(plan.configPath, 'utf8'))).toMatchObject({
      repository: 'example/linked-adopter',
    });
  });
});
