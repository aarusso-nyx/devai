import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawnSync: spawnSyncMock,
}));

const { buildHooksInstallPlan, executeHooksInstallPlan } =
  await import('../../src/services/hooks-install/index.js');

const roots: string[] = [];

beforeEach(() => {
  spawnSyncMock.mockReset();
  spawnSyncMock.mockReturnValue({ status: 128, stdout: '', stderr: 'unavailable' });
});

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function put(root: string, path: string, value: string): string {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value);
  return target;
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-hooks-head-'));
  roots.push(root);
  mkdirSync(join(root, '.git/hooks'), { recursive: true });
  put(root, '.devai/config/authority-policy.json', '{}\n');
  put(root, '.devai/pin/constitution.md', '# Fixture constitution\n');
  return root;
}

async function install(root: string, version = '1.2.3'): Promise<Record<string, unknown>> {
  const plan = buildHooksInstallPlan({
    targetRoot: root,
    hook: 'post-merge',
    devaiVersion: version,
  });
  await withAuthorityHostTestScope(() => executeHooksInstallPlan(plan));
  return JSON.parse(
    readFileSync(join(root, '.devai/config/post-merge-host-adapter.json'), 'utf8'),
  ) as Record<string, unknown>;
}

describe('CLI shard 09 hooks install HEAD and validation boundaries', () => {
  it('accepts a resolved HEAD only after a successful exact full-SHA probe', async () => {
    for (const [name, status, stdout] of [
      ['failed-valid-output', 128, 'b'.repeat(40)],
      ['successful-prefixed-output', 0, `x${'b'.repeat(40)}`],
      ['successful-suffixed-output', 0, `${'b'.repeat(40)}x`],
    ] as const) {
      const root = repository();
      put(root, '.git/HEAD', `${'a'.repeat(40)}\n`);
      spawnSyncMock.mockReturnValueOnce({ status, stdout, stderr: name });
      expect((await install(root))['installed_at_head'], name).toBe('a'.repeat(40));
    }
  });

  it('rejects non-anchored direct and symbolic HEAD values', async () => {
    for (const [name, head, loose] of [
      ['direct-prefix', `x${'a'.repeat(40)}`, false],
      ['direct-suffix', `${'a'.repeat(40)}x`, false],
      ['symbolic-prefix', 'junk ref: refs/heads/main', true],
      ['symbolic-extra-line', 'ref: refs/heads/main\njunk', true],
    ] as const) {
      const root = repository();
      put(root, '.git/HEAD', `${head}\n`);
      if (loose) put(root, '.git/refs/heads/main', `${'b'.repeat(40)}\n`);
      await expect(install(root), name).rejects.toThrow('POST_MERGE_ADAPTER_HEAD_UNAVAILABLE');
    }
  });

  it('selects the exact symbolic ref from a multi-entry packed refs file', async () => {
    const root = repository();
    put(root, '.git/HEAD', 'ref: refs/heads/main\n');
    put(
      root,
      '.git/packed-refs',
      `# pack-refs with: peeled fully-peeled sorted\n${'c'.repeat(40)} refs/heads/other\n${'d'.repeat(40)} refs/heads/main\n`,
    );

    expect((await install(root))['installed_at_head']).toBe('d'.repeat(40));
  });

  it('requires anchored version text while accepting multi-digit semantic components', async () => {
    for (const version of ['x1.2.3', '1.2.3x']) {
      const root = repository();
      put(root, '.git/HEAD', `${'a'.repeat(40)}\n`);
      await expect(install(root, version), version).rejects.toThrow(
        'POST_MERGE_ADAPTER_PACKAGE_VERSION_MISSING',
      );
      expect(existsSync(join(root, '.git/hooks/post-merge'))).toBe(false);
    }

    for (const version of ['10.2.3', '1.20.3', '1.2.30']) {
      const root = repository();
      put(root, '.git/HEAD', `${'a'.repeat(40)}\n`);
      const attestation = await install(root, version);
      expect(attestation['package_binding'], version).toEqual({
        name: '@aarusso-nyx/devai',
        version,
      });
    }
  });
});
