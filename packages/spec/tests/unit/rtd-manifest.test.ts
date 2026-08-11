import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  buildRtdManifest,
  getRtdManifestDir,
  persistRtdManifest,
} from '../../src/rtd-manifest/index.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('RTD manifest', () => {
  it('builds a deterministic current-contract snapshot and persists its exact bytes', async () => {
    const build = () =>
      withAuthorityHostTestScope(() =>
        buildRtdManifest({
          repoRoot: ROOT,
          id: 'RTM-0001',
          now: '2026-08-10T00:00:00.000Z',
          integrationHead: 'a'.repeat(40),
        }),
      );

    const first = await build();
    const second = await build();
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      schemaVersion: '1.0.0',
      id: 'RTM-0001',
      integration_head: 'a'.repeat(40),
      readiness: { sub_verdicts: expect.any(Array) },
    });
    expect(first.readiness.sub_verdicts.map((entry) => entry.component)).toContain(
      'forbidden_actions',
    );
    expect(first.manifest_hash).toMatch(/^[a-f0-9]{64}$/u);

    const target = mkdtempSync(join(tmpdir(), 'devai-rtd-manifest-'));
    temporaryRoots.push(target);
    const path = await withAuthorityHostTestScope(() => persistRtdManifest(first, target));
    expect(path).toBe(join(getRtdManifestDir(target), 'RTM-0001.json'));
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(first);
  });
});
