// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { CAC } from 'cac';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { runWithAuthorityPolicyMaterialization } from '../../src/authority/command-capabilities.js';
import { buildTrustedAuthoritySources } from '../../src/authority/policy.js';
import { doctor } from '../../src/commands/doctor.js';
import { canonicalRegistry } from '../../src/define-command.js';
import {
  buildGithubActionsAdapterPlan,
  executeGithubActionsAdapterPlan,
} from '../../src/services/github-actions-adapter/index.js';
import {
  buildHooksInstallPlan,
  executeHooksInstallPlan,
} from '../../src/services/hooks-install/index.js';
import { resolveCliVersion } from '../../src/version.js';

interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly info?: Record<string, unknown>;
  readonly errors?: readonly string[];
  readonly warnings?: readonly string[];
}

interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
}

type JsonObject = Record<string, unknown>;

const ROOT = resolve(import.meta.dirname, '../../../..');
const CONSTITUTION = readFileSync(join(ROOT, '.devai/pin/constitution.md'), 'utf8');
const AUTHORITY_POLICY_EXAMPLE = (
  JSON.parse(readFileSync(join(ROOT, 'law/schemas/authority-policy.schema.json'), 'utf8')) as {
    examples: JsonObject[];
  }
).examples[0] as JsonObject;
const POSTURE_ERROR =
  'authority posture is missing, stale, non-binding, or inconsistent; re-materialize with `devai init bind --as-role architect --write`';
const roots: string[] = [];
const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};
const originalArgv = process.argv;
const originalExit = process.exit;
const originalExitCode = process.exitCode;
const originalStdout = process.stdout.write;
const originalStderr = process.stderr.write;

afterEach(() => {
  process.argv = originalArgv;
  process.exit = originalExit;
  process.exitCode = originalExitCode;
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
});

afterAll(() => {
  for (const path of roots) rmSync(path, { recursive: true, force: true });
});

function put(repo: string, path: string, value: unknown): void {
  const absolute = join(repo, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(
    absolute,
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
}

function fixture(): { readonly repo: string; readonly policy: JsonObject } {
  const repo = mkdtempSync(join(tmpdir(), 'devai-doctor-authority-'));
  roots.push(repo);
  put(repo, '.devai/pin/constitution.md', CONSTITUTION);
  put(repo, '.devai/config/project.json', {
    schemaVersion: '1.0.0',
    name: 'doctor-authority-fixture',
    profile: 'tier3',
    devai_version: resolveCliVersion(),
    authority_enforcement: { mode: 'cli-only' },
  });
  const expected = buildTrustedAuthoritySources(
    canonicalRegistry(),
    repo,
    resolveCliVersion(),
  ).provenance;
  const policy = structuredClone(AUTHORITY_POLICY_EXAMPLE);
  Object.assign(policy, {
    repository_id: expected.repository_id,
    framework_package: expected.framework_package,
    constitution: expected.constitution,
    source_policy: expected.source_policy,
    additive_extensions: expected.additive_extensions,
    resolved_digest_sha256: expected.resolved_digest_sha256,
    enforcement: { mode: 'binding' },
    host_enforcement: { mode: 'cli-only' },
  });
  return { repo, policy };
}

async function invoke(repo: string): Promise<DoctorReport> {
  return JSON.parse(await invokeRaw(repo)) as DoctorReport;
}

async function invokeRaw(repo: string, ...extra: readonly string[]): Promise<string> {
  const cli = cac('devai-doctor-authority-enforcement-boundaries');
  doctor.register(cli);
  let stdout = '';
  process.argv = [
    'node',
    'devai',
    'doctor',
    '--repo-root',
    repo,
    '--skip',
    'docs-governance',
    ...extra,
  ];
  process.exitCode = undefined;
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  process.exit = ((code?: string | number | null) => {
    process.exitCode = typeof code === 'number' ? code : 0;
    throw new Error(`TEST_PROCESS_EXIT:${String(process.exitCode)}`);
  }) as typeof process.exit;

  try {
    cli.parse(process.argv, { run: false });
    await withAuthorityHostTestScope(() =>
      runWithAuthorityPolicyMaterialization(
        () => ({
          path: '.devai/config/authority-policy.json',
          operation: 'unchanged',
          digest_sha256: 'a'.repeat(64),
        }),
        () => cli.runMatchedCommand(),
      ),
    );
    throw new Error('doctor returned without an exit');
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('TEST_PROCESS_EXIT:')) throw error;
    await new Promise<void>((done) => setImmediate(done));
    return stdout;
  }
}

async function authorityCheck(
  update?: (fixture: {
    readonly repo: string;
    readonly policy: JsonObject;
  }) => void | Promise<void>,
): Promise<DoctorCheck> {
  const value = fixture();
  await update?.(value);
  put(value.repo, '.devai/config/authority-policy.json', value.policy);
  const report = await invoke(value.repo);
  const found = report.checks.find((candidate) => candidate.name === 'authority-enforcement');
  if (found === undefined) throw new Error('missing authority-enforcement check');
  return found;
}

function object(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected object');
  }
  return value as JsonObject;
}

function configureHostIntegrated(
  repo: string,
  policy: JsonObject,
  adapterConfig: string,
  adapterId: string,
): void {
  put(
    repo,
    '.git/config',
    '[remote "origin"]\n\turl = https://github.com/example/doctor-authority-fixture.git\n',
  );
  put(repo, '.devai/config/project.json', {
    schemaVersion: '1.0.0',
    name: 'doctor-authority-fixture',
    profile: 'tier3',
    devai_version: resolveCliVersion(),
    authority_enforcement: {
      mode: 'host-integrated',
      adapter_config: adapterConfig,
    },
  });
  policy['host_enforcement'] = {
    mode: 'host-integrated',
    adapter: { adapter_id: adapterId, adapter_version: '1.5.0' },
  };
}

function initializeGitRepository(repo: string): void {
  const run = (args: readonly string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }
  };
  run(['init', '--quiet']);
  put(repo, 'README.md', '# Doctor authority fixture\n');
  run(['add', 'README.md']);
  run([
    '-c',
    'user.name=DEVAI Test',
    '-c',
    'user.email=devai@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
}

const POST_MERGE_CONFIG = '.devai/config/post-merge-host-adapter.json';
const GITHUB_ACTIONS_CONFIG = '.devai/config/github-actions-host-adapter.json';
const POST_MERGE_REBIND =
  'devai init bind --target . --host-adapter post-merge --as-role architect --write';
const GITHUB_ACTIONS_REBIND =
  'devai init bind --target . --host-adapter github-actions --as-role architect --write';

/** Install, in a real checkout, a post-merge host adapter selected as the host identity. */
async function bindPostMergeCheckout(
  repo: string,
  policy: JsonObject,
  manager: 'git' | 'husky' = 'git',
): Promise<void> {
  initializeGitRepository(repo);
  if (manager === 'husky') mkdirSync(join(repo, '.husky'));
  configureHostIntegrated(repo, policy, POST_MERGE_CONFIG, 'post-merge-host-adapter');
  put(repo, '.devai/config/authority-policy.json', policy);
  const binary = join(repo, 'node_modules/.bin/devai');
  put(
    repo,
    'node_modules/.bin/devai',
    `#!/usr/bin/env sh\nif [ "$1" = "--version" ]; then echo "devai/${resolveCliVersion()}"; fi\nexit 0\n`,
  );
  chmodSync(binary, 0o755);
  const plan = buildHooksInstallPlan({
    targetRoot: repo,
    hook: 'post-merge',
    devaiVersion: resolveCliVersion(),
  });
  await withAuthorityHostTestScope(() => executeHooksInstallPlan(plan));
}

async function bindGithubActions(repo: string): Promise<void> {
  const plan = buildGithubActionsAdapterPlan(repo, resolveCliVersion());
  await withAuthorityHostTestScope(() => executeGithubActionsAdapterPlan(plan));
}

describe('Doctor authority enforcement boundaries', () => {
  it('binds the materialized authority policy to recomputed trusted provenance', async () => {
    expect(await authorityCheck()).toMatchObject({
      ok: true,
      info: { policy_binding: 'current' },
    });
  });

  it.each([
    ['repository id', (policy: JsonObject) => (policy['repository_id'] = 'other-repository')],
    [
      'framework package',
      (policy: JsonObject) => (object(policy['framework_package'])['version'] = '1.5.0'),
    ],
    [
      'constitution digest',
      (policy: JsonObject) => (object(policy['constitution'])['digest_sha256'] = 'b'.repeat(64)),
    ],
    [
      'source policy digest',
      (policy: JsonObject) => (object(policy['source_policy'])['digest_sha256'] = 'c'.repeat(64)),
    ],
    [
      'additive extension version',
      (policy: JsonObject) => {
        const extensions = policy['additive_extensions'] as JsonObject[];
        object(extensions[0])['extension_version'] = '1.5.0';
      },
    ],
    [
      'resolved digest',
      (policy: JsonObject) => (policy['resolved_digest_sha256'] = 'd'.repeat(64)),
    ],
  ] satisfies ReadonlyArray<readonly [string, (policy: JsonObject) => void]>)(
    'refuses a policy whose %s differs from recomputed provenance',
    async (_name, perturb) => {
      const result = await authorityCheck(({ policy }) => perturb(policy));
      expect(result).toMatchObject({
        ok: false,
        info: { policy_binding: 'mismatch' },
        errors: [POSTURE_ERROR],
      });
    },
  );

  it('reports a cli-only posture without consulting the post-merge host adapter', async () => {
    const result = await authorityCheck();
    expect(result.info).toMatchObject({
      local_post_merge_enforced: false,
      local_post_merge_facts: {},
    });
    expect(result.errors).toBeUndefined();
  });

  it('passes only when binding, enforcement mode, host mode, and declared mode agree', async () => {
    expect(await authorityCheck()).toMatchObject({
      ok: true,
      info: {
        arbitrary_host_tools_enforced: false,
        cli_runtime_enforced: true,
        enforcement: 'binding',
        host_mode: 'cli-only',
        declared_mode: 'cli-only',
      },
    });
  });

  it('refuses a shadow enforcement mode while the policy binding is current', async () => {
    const result = await authorityCheck(({ policy }) => {
      policy['enforcement'] = {
        mode: 'shadow',
        shadow: {
          reason: 'bounded diagnostic fixture',
          approved_by: { role: 'architect', declaration_source: 'cli-flag' },
          expires_at: '2099-01-01T00:00:00.000Z',
        },
      };
    });
    expect(result).toMatchObject({
      ok: false,
      info: { policy_binding: 'current', cli_runtime_enforced: false },
      errors: [POSTURE_ERROR],
    });
  });

  it('refuses a host enforcement mode that does not match the declared mode', async () => {
    const result = await authorityCheck(({ policy }) => {
      policy['host_enforcement'] = {
        mode: 'host-integrated',
        adapter: { adapter_id: 'post-merge-host-adapter', adapter_version: '1.5.0' },
      };
    });
    expect(result).toMatchObject({
      ok: false,
      info: { host_mode: 'host-integrated', declared_mode: 'cli-only' },
      errors: [POSTURE_ERROR],
    });
  });

  it('projects every authority fact and never collapses the info envelope', async () => {
    expect((await authorityCheck()).info).toEqual({
      enforcement: 'binding',
      host_mode: 'cli-only',
      declared_mode: 'cli-only',
      policy_binding: 'current',
      selected_adapter_policy_bound: true,
      cli_runtime_enforced: true,
      local_post_merge_enforced: false,
      local_post_merge_facts: {},
      github_actions_enforced: false,
      github_actions_facts: { workflow_present: false, config_present: false },
      arbitrary_host_tools_enforced: false,
    });
  });

  it('does not claim host enforcement it has not verified', async () => {
    const mismatch = await authorityCheck(({ policy }) => {
      policy['repository_id'] = 'other-repository';
    });
    expect(mismatch.info).toMatchObject({
      cli_runtime_enforced: false,
      local_post_merge_enforced: false,
      github_actions_enforced: false,
    });

    const current = await authorityCheck();
    expect(current.info).toMatchObject({
      cli_runtime_enforced: true,
      local_post_merge_enforced: false,
      github_actions_enforced: false,
    });
  });

  it.each([
    [
      'post-merge policy and post-merge adapter',
      '.devai/config/post-merge-host-adapter.json',
      'post-merge-host-adapter',
      true,
    ],
    [
      'GitHub Actions policy and GitHub Actions adapter',
      '.devai/config/github-actions-host-adapter.json',
      'github-actions-main-observation',
      true,
    ],
    [
      'post-merge policy and GitHub Actions adapter',
      '.devai/config/post-merge-host-adapter.json',
      'github-actions-main-observation',
      false,
    ],
    [
      'GitHub Actions policy and post-merge adapter',
      '.devai/config/github-actions-host-adapter.json',
      'post-merge-host-adapter',
      false,
    ],
  ] as const)(
    'binds only the selected host adapter for %s',
    async (_name, adapterConfig, adapterId, selected) => {
      const result = await authorityCheck(({ repo, policy }) => {
        configureHostIntegrated(repo, policy, adapterConfig, adapterId);
      });
      expect(result).toMatchObject({
        ok: false,
        info: {
          host_mode: 'host-integrated',
          declared_mode: 'host-integrated',
          selected_adapter_policy_bound: selected,
          local_post_merge_enforced: false,
          github_actions_enforced: false,
        },
      });
    },
  );

  it('runs the selected post-merge verifier and reports its incomplete installation', async () => {
    const result = await authorityCheck(({ repo, policy }) => {
      configureHostIntegrated(
        repo,
        policy,
        '.devai/config/post-merge-host-adapter.json',
        'post-merge-host-adapter',
      );
    });
    expect(result).toMatchObject({
      ok: false,
      info: {
        selected_adapter_policy_bound: true,
        local_post_merge_enforced: false,
        local_post_merge_facts: {
          hook_present: false,
          key_present: false,
          attestation_present: false,
          policy_present: true,
        },
      },
      errors: [POSTURE_ERROR, 'POST_MERGE_ADAPTER_BINDING_MISSING'],
    });
  });

  it('accepts a fully installed and verified post-merge host adapter', async () => {
    let bound = '';
    const result = await authorityCheck(async ({ repo, policy }) => {
      await bindPostMergeCheckout(repo, policy);
      bound = realpathSync(repo);
    });
    expect(result).toMatchObject({
      ok: true,
      info: {
        selected_adapter_policy_bound: true,
        local_post_merge_enforced: true,
        local_post_merge_scope: 'bound',
        local_post_merge_bound_checkout: bound,
        local_post_merge_state: ['attestation', 'key', 'issuer'],
        local_post_merge_facts: {
          hook_present: true,
          key_present: true,
          attestation_present: true,
          declaration_present: true,
          policy_present: true,
          declaration_current: true,
          hook_local_binary: true,
          local_binary_present: true,
          local_binary_version: true,
          key_private: true,
          signature_valid: true,
          repository_bound: true,
          hook_bound: true,
          key_bound: true,
          policy_bound: true,
          constitution_bound: true,
          package_bound: true,
          installed_head_bound: true,
        },
      },
    });
    expect(result.errors).toBeUndefined();
  });

  it('accepts a generated and verified GitHub Actions host adapter', async () => {
    const result = await authorityCheck(async ({ repo, policy }) => {
      configureHostIntegrated(
        repo,
        policy,
        '.devai/config/github-actions-host-adapter.json',
        'github-actions-main-observation',
      );
      const plan = buildGithubActionsAdapterPlan(repo, resolveCliVersion());
      await withAuthorityHostTestScope(() => executeGithubActionsAdapterPlan(plan));
    });
    expect(result).toMatchObject({
      ok: true,
      info: {
        selected_adapter_policy_bound: true,
        github_actions_enforced: true,
        github_actions_facts: {
          workflow_present: true,
          config_present: true,
          workflow_syntax_valid: true,
          workflow_bound: true,
          repository_bound: true,
          package_bound: true,
        },
      },
    });
    expect(result.errors).toBeUndefined();
  });

  it('routes failures from the explicitly selected GitHub Actions adapter', async () => {
    const result = await authorityCheck(({ repo, policy }) => {
      configureHostIntegrated(
        repo,
        policy,
        '.devai/config/github-actions-host-adapter.json',
        'github-actions-main-observation',
      );
      put(repo, '.github/workflows/devai-main-observation.yml', 'not: [valid\n');
      put(repo, '.devai/config/github-actions-host-adapter.json', {});
    });
    expect(result).toMatchObject({
      ok: false,
      info: {
        selected_adapter_policy_bound: true,
        github_actions_enforced: false,
        github_actions_facts: {
          workflow_present: true,
          config_present: true,
          workflow_syntax_valid: false,
        },
      },
    });
    expect(result.errors).toContain('GITHUB_ACTIONS_WORKFLOW_SYNTAX_VALID_INVALID');
  });

  it('does not route GitHub Actions failures for an unselected adapter', async () => {
    const result = await authorityCheck(({ repo, policy }) => {
      policy['repository_id'] = 'other-repository';
      put(
        repo,
        '.git/config',
        '[remote "origin"]\n\turl = https://github.com/example/adopter.git\n',
      );
      put(repo, '.devai/config/project.json', {
        schemaVersion: '1.0.0',
        name: 'doctor-authority-fixture',
        profile: 'tier3',
        devai_version: resolveCliVersion(),
        authority_enforcement: {
          mode: 'cli-only',
          adapter_config: '.devai/config/custom-host-adapter.json',
        },
      });
      put(repo, '.github/workflows/devai-main-observation.yml', 'not: [valid\n');
      put(repo, '.devai/config/github-actions-host-adapter.json', {});
    });
    expect(result.info).toMatchObject({
      github_actions_facts: {
        workflow_present: true,
        config_present: true,
        workflow_syntax_valid: false,
      },
    });
    expect(result.errors).toEqual([POSTURE_ERROR]);
  });

  it('emits the exact refusal error set and no host adapter errors it did not collect', async () => {
    const result = await authorityCheck(({ repo, policy }) => {
      policy['repository_id'] = 'other-repository';
      put(repo, '.devai/config/project.json', {
        schemaVersion: '1.0.0',
        name: 'doctor-authority-fixture',
        profile: 'tier3',
        devai_version: resolveCliVersion(),
        authority_enforcement: {
          mode: 'cli-only',
          adapter_config: '.devai/config/custom-host-adapter.json',
        },
      });
    });
    expect(result).toEqual({
      name: 'authority-enforcement',
      ok: false,
      info: {
        enforcement: 'binding',
        host_mode: 'cli-only',
        declared_mode: 'cli-only',
        policy_binding: 'mismatch',
        selected_adapter_policy_bound: true,
        cli_runtime_enforced: false,
        local_post_merge_enforced: false,
        local_post_merge_facts: {},
        github_actions_enforced: false,
        github_actions_facts: { workflow_present: false, config_present: false },
        arbitrary_host_tools_enforced: false,
      },
      errors: [POSTURE_ERROR],
    });
  });
});

describe('Doctor post-merge state kept out of tracked configuration (#266, #291)', () => {
  const NOT_BOUND_NOTE = `POST_MERGE_ADAPTER_NOT_BOUND_HERE: the post-merge host adapter is declared but not bound in this checkout; bind it here with \`${POST_MERGE_REBIND}\` to issue and verify merge receipts from it.`;

  function adminDirectory(repo: string): string {
    return spawnSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: repo,
      encoding: 'utf8',
    }).stdout.trim();
  }

  /** A real checkout that bound the post-merge adapter; its tracked files are returned. */
  async function primaryCheckout(manager: 'git' | 'husky' = 'git'): Promise<{
    readonly root: string;
    readonly declaration: string;
    readonly huskyHook?: string;
  }> {
    const primary = fixture();
    await bindPostMergeCheckout(primary.repo, primary.policy, manager);
    return {
      root: realpathSync(primary.repo),
      declaration: readFileSync(join(primary.repo, POST_MERGE_CONFIG), 'utf8'),
      ...(manager === 'husky' && {
        huskyHook: readFileSync(join(primary.repo, '.husky/post-merge'), 'utf8'),
      }),
    };
  }

  /** Another clone of the same repository: every tracked file, no local post-merge state. */
  function foreignClone(
    repo: string,
    policy: JsonObject,
    tracked: { readonly declaration: string; readonly huskyHook?: string },
  ): void {
    initializeGitRepository(repo);
    configureHostIntegrated(repo, policy, POST_MERGE_CONFIG, 'post-merge-host-adapter');
    put(repo, POST_MERGE_CONFIG, tracked.declaration);
    if (tracked.huskyHook !== undefined) put(repo, '.husky/post-merge', tracked.huskyHook);
  }

  it('commits a path-free declaration and keeps the signed attestation in the git directory', async () => {
    const primary = await primaryCheckout();
    const declaration = JSON.parse(primary.declaration) as JsonObject;
    expect(declaration).toEqual({
      schemaVersion: '2.0.0',
      adapter_id: 'post-merge-host-adapter',
      adapter_kind: 'installed-checkout',
      required: true,
      local_state: 'git-dir',
      bind_command: POST_MERGE_REBIND,
    });
    expect(primary.declaration).not.toContain(primary.root);
    const attestation = JSON.parse(
      readFileSync(
        join(adminDirectory(primary.root), 'devai/post-merge-host-adapter.json'),
        'utf8',
      ),
    ) as JsonObject;
    expect(attestation).toMatchObject({ repository: primary.root });
    expect(attestation['signature_hmac_sha256']).toMatch(/^[0-9a-f]{64}$/u);
  }, 30_000);

  it.each(['git', 'husky'] as const)(
    'reports a %s-hooks clone not bound here and rests on a verified GitHub adapter',
    async (manager) => {
      const primary = await primaryCheckout(manager);
      let foreign = '';
      const result = await authorityCheck(async ({ repo, policy }) => {
        foreignClone(repo, policy, primary);
        await bindGithubActions(repo);
        foreign = repo;
      });
      expect(result).toMatchObject({
        ok: true,
        info: {
          selected_adapter_policy_bound: true,
          local_post_merge_enforced: false,
          local_post_merge_facts: {},
          local_post_merge_scope: 'unbound',
          github_actions_enforced: true,
          reason_ids: ['POST_MERGE_ADAPTER_NOT_BOUND_HERE'],
        },
      });
      expect(result.info?.['host_adapter_note']).toBe(
        `${NOT_BOUND_NOTE} Here authority enforcement rests on the GitHub Actions adapter.`,
      );
      expect(result.info?.['local_post_merge_bound_checkout']).toBeUndefined();
      expect(result.errors).toBeUndefined();
      expect(result.warnings).toBeUndefined();

      const human = await invokeRaw(foreign, '--human');
      expect(human).toContain('[✓] authority-enforcement');
      expect(human).toContain('note: POST_MERGE_ADAPTER_NOT_BOUND_HERE: the post-merge host');
    },
    30_000,
  );

  it('fails clearly when the selected adapter is not bound here and none verifies', async () => {
    const primary = await primaryCheckout('husky');
    const result = await authorityCheck(({ repo, policy }) => {
      foreignClone(repo, policy, primary);
    });
    expect(result).toMatchObject({
      ok: false,
      info: {
        selected_adapter_policy_bound: true,
        local_post_merge_scope: 'unbound',
        github_actions_enforced: false,
        reason_ids: ['POST_MERGE_ADAPTER_NOT_BOUND_HERE', 'POST_MERGE_ADAPTER_UNVERIFIABLE_HERE'],
      },
      errors: [
        POSTURE_ERROR,
        `POST_MERGE_ADAPTER_UNVERIFIABLE_HERE: the selected post-merge host adapter is not bound in this checkout and no GitHub Actions adapter verifies here; bind it here with \`${POST_MERGE_REBIND}\`, or bind the GitHub Actions adapter with \`${GITHUB_ACTIONS_REBIND}\`, then \`${POST_MERGE_REBIND}\`, and commit the result`,
      ],
    });
    expect(String(result.info?.['host_adapter_note'])).toContain(
      'rests on the GitHub Actions adapter, which this checkout does not verify.',
    );
  }, 30_000);

  it('routes the failures of a GitHub adapter bound here that does not verify', async () => {
    const primary = await primaryCheckout();
    const result = await authorityCheck(async ({ repo, policy }) => {
      foreignClone(repo, policy, primary);
      await bindGithubActions(repo);
      put(repo, '.github/workflows/devai-main-observation.yml', 'not: [valid\n');
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('GITHUB_ACTIONS_WORKFLOW_SYNTAX_VALID_INVALID');
    expect(result.errors?.[1]).toMatch(/^POST_MERGE_ADAPTER_UNVERIFIABLE_HERE: /u);
  }, 30_000);

  /** Point the bound checkout's local attestation at another checkout, without re-signing it. */
  function renameBinding(repo: string): string {
    const elsewhere = join(tmpdir(), 'devai-removed-primary-checkout');
    const path = join(adminDirectory(repo), 'devai/post-merge-host-adapter.json');
    const attestation = JSON.parse(readFileSync(path, 'utf8')) as JsonObject;
    attestation['repository'] = elsewhere;
    attestation['adapter_id'] = `post-merge-${'0'.repeat(16)}`;
    attestation['hook_path'] = join(elsewhere, '.husky/post-merge');
    writeFileSync(path, `${JSON.stringify(attestation, null, 2)}\n`);
    return elsewhere;
  }

  it('verifies, and refuses, a local attestation edited to name another checkout', async () => {
    let elsewhere = '';
    const result = await authorityCheck(async ({ repo, policy }) => {
      await bindPostMergeCheckout(repo, policy);
      await bindGithubActions(repo);
      elsewhere = renameBinding(repo);
    });
    expect(result).toMatchObject({
      ok: false,
      info: {
        local_post_merge_scope: 'bound',
        local_post_merge_bound_checkout: elsewhere,
        local_post_merge_state: ['attestation', 'key', 'issuer'],
        local_post_merge_enforced: false,
        local_post_merge_facts: {
          key_present: true,
          signature_valid: false,
          repository_bound: false,
        },
        github_actions_enforced: true,
      },
    });
    expect(result.errors).toEqual(
      expect.arrayContaining([
        POSTURE_ERROR,
        'POST_MERGE_ADAPTER_SIGNATURE_VALID_INVALID',
        'POST_MERGE_ADAPTER_REPOSITORY_BOUND_INVALID',
      ]),
    );
    expect(result.errors?.join('\n')).not.toMatch(/ENOENT/u);
    expect(JSON.stringify(result)).not.toContain('POST_MERGE_ADAPTER_NOT_BOUND_HERE');
  }, 30_000);

  it('refuses the bound checkout whose post-merge key was deleted', async () => {
    const result = await authorityCheck(async ({ repo, policy }) => {
      await bindPostMergeCheckout(repo, policy);
      await bindGithubActions(repo);
      rmSync(join(adminDirectory(repo), 'devai/post-merge.key'));
    });
    expect(result).toMatchObject({
      ok: false,
      info: {
        local_post_merge_scope: 'bound',
        local_post_merge_facts: { key_present: false, hook_present: true },
        github_actions_enforced: true,
      },
    });
    expect(result.errors).toContain('POST_MERGE_ADAPTER_BINDING_MISSING');
    expect(JSON.stringify(result)).not.toContain('POST_MERGE_ADAPTER_NOT_BOUND_HERE');
  }, 30_000);

  it.each(['git', 'husky'] as const)(
    'fails closed on a %s hook when the key and issuer are deleted and the attestation renamed',
    async (manager) => {
      const result = await authorityCheck(async ({ repo, policy }) => {
        await bindPostMergeCheckout(repo, policy, manager);
        await bindGithubActions(repo);
        const admin = adminDirectory(repo);
        rmSync(join(admin, 'devai/post-merge.key'));
        rmSync(join(admin, 'devai/issue-post-merge-receipt.cjs'));
        renameBinding(repo);
      });
      expect(result).toMatchObject({
        ok: false,
        info: {
          local_post_merge_scope: 'bound',
          local_post_merge_state: ['attestation'],
          local_post_merge_facts: { key_present: false, hook_present: true },
          github_actions_enforced: true,
        },
      });
      expect(result.errors).toContain('POST_MERGE_ADAPTER_BINDING_MISSING');
      expect(JSON.stringify(result)).not.toContain('POST_MERGE_ADAPTER_NOT_BOUND_HERE');
    },
    30_000,
  );

  it('refuses a selected legacy checkout-bound attestation and names init upgrade', async () => {
    const primary = fixture();
    await bindPostMergeCheckout(primary.repo, primary.policy);
    const legacy = readFileSync(
      join(adminDirectory(primary.repo), 'devai/post-merge-host-adapter.json'),
      'utf8',
    );
    const recorded = realpathSync(primary.repo);
    const upgrade = 'devai init upgrade --target . --as-role architect --write';
    const message = `POST_MERGE_ADAPTER_DECLARATION_LEGACY: ${POST_MERGE_CONFIG} is a checkout-bound post-merge attestation recording ${recorded}, which verifies in no other checkout; convert it with \`${upgrade}\`, which moves the binding into the git directory of the checkout that holds its key and leaves a path-free declaration to commit`;
    const selected = await authorityCheck(async ({ repo, policy }) => {
      foreignClone(repo, policy, { declaration: legacy });
      await bindGithubActions(repo);
    });
    expect(selected).toMatchObject({
      ok: false,
      info: {
        local_post_merge_scope: 'legacy',
        local_post_merge_bound_checkout: recorded,
        reason_ids: ['POST_MERGE_ADAPTER_DECLARATION_LEGACY'],
      },
      errors: [POSTURE_ERROR, message],
    });

    const unselected = await authorityCheck(async ({ repo, policy }) => {
      foreignClone(repo, policy, { declaration: legacy });
      await bindGithubActions(repo);
      configureHostIntegrated(
        repo,
        policy,
        GITHUB_ACTIONS_CONFIG,
        'github-actions-main-observation',
      );
    });
    expect(unselected).toMatchObject({
      ok: true,
      info: { reason_ids: ['POST_MERGE_ADAPTER_DECLARATION_LEGACY'] },
      warnings: [message],
    });
  }, 30_000);

  it("warns when a later bind left this checkout's unselected post-merge binding stale", async () => {
    const result = await authorityCheck(async ({ repo, policy }) => {
      await bindPostMergeCheckout(repo, policy);
      await bindGithubActions(repo);
      // Binding GitHub Actions last selects it and re-materializes the policy the attestation pins.
      configureHostIntegrated(
        repo,
        policy,
        GITHUB_ACTIONS_CONFIG,
        'github-actions-main-observation',
      );
    });
    expect(result).toMatchObject({
      ok: true,
      info: {
        selected_adapter_policy_bound: true,
        local_post_merge_scope: 'bound',
        local_post_merge_enforced: false,
        local_post_merge_facts: { key_present: true, policy_bound: false },
        github_actions_enforced: true,
        reason_ids: ['POST_MERGE_ADAPTER_BINDING_STALE'],
      },
      warnings: [
        `POST_MERGE_ADAPTER_BINDING_STALE: this checkout's post-merge host adapter does not verify (POST_MERGE_ADAPTER_POLICY_BOUND_INVALID); it is not the selected host identity, so it does not decide this check, but its merge receipts are refused until it is rebound with \`${POST_MERGE_REBIND}\`, which selects it`,
      ],
    });
    expect(result.errors).toBeUndefined();
  }, 30_000);

  it('warns on a host-adapter binding that lags the installed package, naming the rebind', async () => {
    let attestationPath = '';
    const bound = await authorityCheck(async ({ repo, policy }) => {
      await bindPostMergeCheckout(repo, policy);
      await bindGithubActions(repo);
      configureHostIntegrated(
        repo,
        policy,
        GITHUB_ACTIONS_CONFIG,
        'github-actions-main-observation',
      );
      attestationPath = join(adminDirectory(repo), 'devai/post-merge-host-adapter.json');
      const attestation = JSON.parse(readFileSync(attestationPath, 'utf8')) as JsonObject;
      attestation['package_binding'] = { name: '@aarusso-nyx/devai', version: '1.6.0' };
      writeFileSync(attestationPath, `${JSON.stringify(attestation, null, 2)}\n`);
    });
    expect(bound).toMatchObject({
      ok: true,
      info: {
        local_post_merge_scope: 'bound',
        reason_ids: ['POST_MERGE_ADAPTER_BINDING_STALE', 'POST_MERGE_ADAPTER_VERSION_LAG'],
      },
    });
    expect(bound.warnings).toContain(
      `POST_MERGE_ADAPTER_VERSION_LAG: this checkout's post-merge attestation (${attestationPath}) binds @aarusso-nyx/devai 1.6.0, behind the installed ${resolveCliVersion()}; rebind it with \`${POST_MERGE_REBIND}\``,
    );

    // An unbound clone has no attestation of its own, so it reports no post-merge lag.
    const primary = await primaryCheckout();
    const foreign = await authorityCheck(async ({ repo, policy }) => {
      foreignClone(repo, policy, primary);
      await bindGithubActions(repo);
    });
    expect(foreign.info?.['reason_ids']).toEqual(['POST_MERGE_ADAPTER_NOT_BOUND_HERE']);

    let selected = '';
    const github = await authorityCheck(async ({ repo, policy }) => {
      configureHostIntegrated(
        repo,
        policy,
        GITHUB_ACTIONS_CONFIG,
        'github-actions-main-observation',
      );
      await bindGithubActions(repo);
      const config = JSON.parse(
        readFileSync(join(repo, GITHUB_ACTIONS_CONFIG), 'utf8'),
      ) as JsonObject;
      config['package_binding'] = { name: '@aarusso-nyx/devai', version: '1.6.0' };
      put(repo, GITHUB_ACTIONS_CONFIG, config);
      selected = repo;
    });
    expect(github).toMatchObject({
      ok: false,
      info: { reason_ids: ['GITHUB_ACTIONS_ADAPTER_VERSION_LAG'] },
      warnings: [
        `GITHUB_ACTIONS_ADAPTER_VERSION_LAG: ${GITHUB_ACTIONS_CONFIG} binds @aarusso-nyx/devai 1.6.0, behind the installed ${resolveCliVersion()}; rebind with \`${GITHUB_ACTIONS_REBIND}\``,
      ],
    });
    expect(github.errors).toContain('GITHUB_ACTIONS_PACKAGE_BOUND_INVALID');
    expect(await invokeRaw(selected, '--human')).toContain(
      `warning: GITHUB_ACTIONS_ADAPTER_VERSION_LAG: ${GITHUB_ACTIONS_CONFIG} binds`,
    );
  }, 60_000);
});
