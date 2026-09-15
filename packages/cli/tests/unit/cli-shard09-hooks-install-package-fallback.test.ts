import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const moduleLocation = vi.hoisted(
  () => `/tmp/devai-hooks-package-fallback-${process.pid}/dist/services/hooks-install/index.js`,
);

vi.mock('node:url', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:url')>()),
  fileURLToPath: () => moduleLocation,
}));

vi.mock('@devai-nyx/authority', async () => {
  const fs = await import('node:fs');
  const childProcess = await import('node:child_process');
  return {
    chmodSync: fs.chmodSync,
    existsSync: fs.existsSync,
    lstatSync: fs.lstatSync,
    mkdirSync: fs.mkdirSync,
    readFileSync: fs.readFileSync,
    realpathSync: fs.realpathSync,
    spawnSync: childProcess.spawnSync,
    statSync: fs.statSync,
    writeFileSync: fs.writeFileSync,
  };
});

const { buildHooksInstallPlan, executeHooksInstallPlan } =
  await import('../../src/services/hooks-install/index.js');

const roots: string[] = [];

afterAll(() => {
  for (const path of roots) rmSync(path, { recursive: true, force: true });
  const [moduleRoot] = moduleLocation.split('/dist/services/');
  if (!moduleRoot) throw new Error('module fixture root missing');
  rmSync(moduleRoot, { recursive: true, force: true });
});

function put(root: string, path: string, value: string): string {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value);
  return target;
}

describe('CLI shard 09 hooks install package fallback', () => {
  it('binds the installed package constitution when the repository has no local copy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-hooks-package-target-'));
    roots.push(root);
    mkdirSync(join(root, '.git/hooks'), { recursive: true });
    put(root, '.git/HEAD', `${'a'.repeat(40)}\n`);
    put(root, '.devai/config/authority-policy.json', '{}\n');

    const constitution = '# Installed package constitution\n';
    const packageFallback = resolve(dirname(moduleLocation), '../..', 'dist/law/constitution.md');
    put('/', packageFallback, constitution);

    const plan = buildHooksInstallPlan({
      targetRoot: root,
      hook: 'post-merge',
      devaiVersion: '1.2.3',
    });
    executeHooksInstallPlan(plan);

    const attestation = JSON.parse(
      readFileSync(join(root, '.devai/config/post-merge-host-adapter.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(attestation['constitution_digest_sha256']).toBe(
      createHash('sha256').update(constitution).digest('hex'),
    );
  });
});
