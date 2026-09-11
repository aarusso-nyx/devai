import { createHash, createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildHooksInstallPlan,
  executeHooksInstallPlan,
  preflightHooksInstallPlan,
  verifyInstalledPostMergeAdapter,
} from '../../src/services/hooks-install/index.js';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(root: string, relative: string, body: string | Buffer): string {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

async function installedAdapter() {
  const root = mkdtempSync(join(tmpdir(), 'devai-hooks-remediation-'));
  roots.push(root);
  expect(spawnSync('git', ['init', '--quiet'], { cwd: root }).status).toBe(0);
  put(root, 'README.md', '# fixture\n');
  expect(spawnSync('git', ['add', 'README.md'], { cwd: root }).status).toBe(0);
  expect(
    spawnSync(
      'git',
      [
        '-c',
        'user.name=DEVAI Test',
        '-c',
        'user.email=devai@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'fixture',
      ],
      { cwd: root },
    ).status,
  ).toBe(0);
  put(root, '.devai/config/authority-policy.json', '{"schemaVersion":"1.0.0"}\n');
  put(root, '.devai/pin/constitution.md', '# Pinned constitution\n');
  const binary = put(
    root,
    'node_modules/.bin/devai',
    '#!/usr/bin/env sh\nif [ "$1" = "--version" ]; then echo "devai/1.2.3"; fi\nexit 0\n',
  );
  chmodSync(binary, 0o755);
  const plan = buildHooksInstallPlan({
    targetRoot: root,
    hook: 'post-merge',
    devaiVersion: '1.2.3',
  });
  await withAuthorityHostTestScope(() => executeHooksInstallPlan(plan));
  return {
    root,
    plan,
    hookPath: plan.path,
    keyPath: join(root, '.git/devai/post-merge.key'),
    attestationPath: join(root, '.devai/config/post-merge-host-adapter.json'),
    policyPath: join(root, '.devai/config/authority-policy.json'),
    constitutionPath: join(root, '.devai/pin/constitution.md'),
    binary,
  };
}

async function verify(root: string) {
  return withAuthorityHostTestScope(() => verifyInstalledPostMergeAdapter(root, '1.2.3'));
}

function signedAttestation(
  path: string,
  keyPath: string,
  change: (value: Record<string, unknown>) => void,
) {
  const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  change(value);
  delete value['signature_hmac_sha256'];
  const signature = createHmac('sha256', readFileSync(keyPath))
    .update(JSON.stringify(value))
    .digest('hex');
  writeFileSync(
    path,
    `${JSON.stringify({ ...value, signature_hmac_sha256: signature }, null, 2)}\n`,
  );
}

describe('hooks install exact verification boundaries', () => {
  it('reports every signed adapter fact and each independently invalid binding', async () => {
    const fixture = await installedAdapter();
    const valid = await verify(fixture.root);
    expect(valid).toEqual({
      ok: true,
      errors: [],
      facts: {
        hook_present: true,
        key_present: true,
        attestation_present: true,
        policy_present: true,
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
    });

    for (const [path, fact] of [
      [fixture.hookPath, 'hook_present'],
      [fixture.keyPath, 'key_present'],
      [fixture.attestationPath, 'attestation_present'],
      [fixture.policyPath, 'policy_present'],
    ] as const) {
      const bytes = readFileSync(path);
      unlinkSync(path);
      const result = await verify(fixture.root);
      expect(result.errors).toEqual(['POST_MERGE_ADAPTER_BINDING_MISSING']);
      expect(result.facts[fact]).toBe(false);
      writeFileSync(path, bytes);
      if (path === fixture.keyPath) chmodSync(path, 0o600);
      if (path === fixture.hookPath) chmodSync(path, 0o755);
    }

    const originalAttestation = readFileSync(fixture.attestationPath, 'utf8');
    const attestationCase = async (field: string, value: unknown, error: string, resign = true) => {
      if (resign)
        signedAttestation(
          fixture.attestationPath,
          fixture.keyPath,
          (entry) => (entry[field] = value),
        );
      else {
        const entry = JSON.parse(originalAttestation) as Record<string, unknown>;
        entry[field] = value;
        writeFileSync(fixture.attestationPath, `${JSON.stringify(entry, null, 2)}\n`);
      }
      const result = await verify(fixture.root);
      expect(result.ok).toBe(false);
      expect(result.errors).toContain(error);
      writeFileSync(fixture.attestationPath, originalAttestation);
    };

    await attestationCase(
      'signature_hmac_sha256',
      false,
      'POST_MERGE_ADAPTER_SIGNATURE_VALID_INVALID',
      false,
    );
    await attestationCase('repository', 17, 'POST_MERGE_ADAPTER_REPOSITORY_BOUND_INVALID');
    await attestationCase(
      'hook_digest_sha256',
      '0'.repeat(64),
      'POST_MERGE_ADAPTER_HOOK_BOUND_INVALID',
    );
    await attestationCase(
      'key_digest_sha256',
      '0'.repeat(64),
      'POST_MERGE_ADAPTER_KEY_BOUND_INVALID',
    );
    await attestationCase(
      'policy_digest_sha256',
      '0'.repeat(64),
      'POST_MERGE_ADAPTER_POLICY_BOUND_INVALID',
    );
    await attestationCase(
      'constitution_digest_sha256',
      '0'.repeat(64),
      'POST_MERGE_ADAPTER_CONSTITUTION_BOUND_INVALID',
    );
    await attestationCase(
      'package_binding',
      { name: 'wrong', version: '1.2.3' },
      'POST_MERGE_ADAPTER_PACKAGE_BOUND_INVALID',
    );
    await attestationCase(
      'installed_at_head',
      'f'.repeat(40),
      'POST_MERGE_ADAPTER_INSTALLED_HEAD_BOUND_INVALID',
    );

    const originalHook = readFileSync(fixture.hookPath);
    writeFileSync(fixture.hookPath, '#!/usr/bin/env sh\nexit 0\n');
    chmodSync(fixture.hookPath, 0o755);
    signedAttestation(fixture.attestationPath, fixture.keyPath, (entry) => {
      entry['hook_digest_sha256'] = createHash('sha256')
        .update(readFileSync(fixture.hookPath))
        .digest('hex');
    });
    expect(await verify(fixture.root)).toMatchObject({
      ok: false,
      errors: ['POST_MERGE_ADAPTER_HOOK_LOCAL_BINARY_INVALID'],
      facts: { hook_local_binary: false, hook_bound: true },
    });
    writeFileSync(fixture.hookPath, originalHook);
    chmodSync(fixture.hookPath, 0o755);
    writeFileSync(fixture.attestationPath, originalAttestation);

    chmodSync(fixture.keyPath, 0o644);
    expect((await verify(fixture.root)).errors).toContain('POST_MERGE_ADAPTER_KEY_PRIVATE_INVALID');
    chmodSync(fixture.keyPath, 0o600);

    const originalBinary = readFileSync(fixture.binary);
    unlinkSync(fixture.binary);
    expect((await verify(fixture.root)).errors).toEqual([
      'POST_MERGE_ADAPTER_LOCAL_BINARY_PRESENT_INVALID',
      'POST_MERGE_ADAPTER_LOCAL_BINARY_VERSION_INVALID',
    ]);
    writeFileSync(fixture.binary, '#!/usr/bin/env sh\necho devai/9.9.9\n');
    chmodSync(fixture.binary, 0o755);
    expect((await verify(fixture.root)).errors).toContain(
      'POST_MERGE_ADAPTER_LOCAL_BINARY_VERSION_INVALID',
    );
    writeFileSync(fixture.binary, originalBinary);
    chmodSync(fixture.binary, 0o755);

    writeFileSync(fixture.binary, '#!/usr/bin/env sh\nprintf "  devai/1.2.3 details\\n"\n');
    chmodSync(fixture.binary, 0o755);
    expect((await verify(fixture.root)).facts['local_binary_version']).toBe(true);

    writeFileSync(fixture.attestationPath, '{ malformed json\n');
    expect(await verify(fixture.root)).toMatchObject({ ok: false });
  });

  it('replaces independently stale signed fields and emits the complete attestation surface', async () => {
    const fixture = await installedAdapter();
    const original = JSON.parse(readFileSync(fixture.attestationPath, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(original).toMatchObject({
      schemaVersion: '1.0.0',
      adapter_kind: 'installed-checkout',
      repository: realpathSync(fixture.root),
      repository_id: fixture.root.split('/').at(-1),
      hook_path: fixture.plan.path,
      package_binding: { name: '@aarusso-nyx/devai', version: '1.2.3' },
      cadence: { installed_checkout: 'persistent', remote_host: 'unknown' },
    });
    expect(original['adapter_id']).toBe(
      `post-merge-${createHash('sha256').update(realpathSync(fixture.root)).digest('hex').slice(0, 16)}`,
    );

    signedAttestation(fixture.attestationPath, fixture.keyPath, (entry) => {
      entry['repository_id'] = 'stale-repository';
    });
    await withAuthorityHostTestScope(() => executeHooksInstallPlan(fixture.plan));
    expect(JSON.parse(readFileSync(fixture.attestationPath, 'utf8'))).toMatchObject({
      repository_id: fixture.root.split('/').at(-1),
    });

    const stale = JSON.parse(readFileSync(fixture.attestationPath, 'utf8')) as Record<
      string,
      unknown
    >;
    stale['signature_hmac_sha256'] = '0'.repeat(64);
    writeFileSync(fixture.attestationPath, `${JSON.stringify(stale, null, 2)}\n`);
    await withAuthorityHostTestScope(() => executeHooksInstallPlan(fixture.plan));
    expect(
      JSON.parse(readFileSync(fixture.attestationPath, 'utf8'))['signature_hmac_sha256'],
    ).not.toBe('0'.repeat(64));
  });

  it('rejects path escapes and symlinks while returning every valid post-merge target', async () => {
    const fixture = await installedAdapter();
    const targets = await withAuthorityHostTestScope(() => preflightHooksInstallPlan(fixture.plan));
    expect(targets).toEqual([
      fixture.plan.path,
      fixture.keyPath,
      join(fixture.root, '.git/devai/issue-post-merge-receipt.cjs'),
      fixture.attestationPath,
    ]);

    const base = buildHooksInstallPlan({ targetRoot: fixture.root, hook: 'pre-commit' });
    for (const path of [
      fixture.root,
      dirname(fixture.root),
      `${fixture.root}-sibling/hook`,
      join(dirname(fixture.root), 'escape-hook'),
    ]) {
      await expect(
        withAuthorityHostTestScope(() => preflightHooksInstallPlan({ ...base, path })),
      ).rejects.toThrow(`HOOK_INSTALL_PATH_ESCAPE:${path}`);
    }

    mkdirSync(join(fixture.root, 'real'));
    symlinkSync(join(fixture.root, 'real'), join(fixture.root, 'linked'), 'dir');
    const intermediate = join(fixture.root, 'linked/hook');
    await expect(
      withAuthorityHostTestScope(() => preflightHooksInstallPlan({ ...base, path: intermediate })),
    ).rejects.toThrow(`HOOK_INSTALL_SYMLINK_REFUSED:${intermediate}`);

    mkdirSync(join(fixture.root, 'nested'));
    symlinkSync(join(fixture.root, 'real'), join(fixture.root, 'nested/linked'), 'dir');
    const deepIntermediate = join(fixture.root, 'nested/linked/hook');
    await expect(
      withAuthorityHostTestScope(() =>
        preflightHooksInstallPlan({ ...base, path: deepIntermediate }),
      ),
    ).rejects.toThrow(`HOOK_INSTALL_SYMLINK_REFUSED:${deepIntermediate}`);

    const finalTarget = join(fixture.root, 'final-hook');
    put(fixture.root, 'real/hook', 'existing target\n');
    symlinkSync(join(fixture.root, 'real/hook'), finalTarget);
    await expect(
      withAuthorityHostTestScope(() => preflightHooksInstallPlan({ ...base, path: finalTarget })),
    ).rejects.toThrow(`HOOK_INSTALL_SYMLINK_REFUSED:${finalTarget}`);

    const uninitialized = mkdtempSync(join(tmpdir(), 'devai-hooks-uninitialized-'));
    roots.push(uninitialized);
    const dryBootstrap = buildHooksInstallPlan({
      targetRoot: uninitialized,
      hook: 'pre-commit',
    });
    await expect(
      withAuthorityHostTestScope(() => preflightHooksInstallPlan(dryBootstrap)),
    ).resolves.toEqual([dryBootstrap.path]);

    const outside = join(dirname(fixture.root), `${fixture.root.split('/').at(-1)}-outside-hook`);
    rmSync(outside, { force: true });
    await expect(
      withAuthorityHostTestScope(() => executeHooksInstallPlan({ ...base, path: outside })),
    ).rejects.toThrow(`HOOK_INSTALL_PATH_ESCAPE:${outside}`);
    expect(existsSync(outside)).toBe(false);
  });
});
