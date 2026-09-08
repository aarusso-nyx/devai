import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function readinessFixture() {
  const root = mkdtempSync(join(tmpdir(), 'devai-rtd-readiness-'));
  temporaryRoots.push(root);
  for (const path of ['law/invariants', 'law/policy', '.devai/config'])
    mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, '.devai/config/domains.json'), JSON.stringify({ core: ['AUTH'] }));
  writeFileSync(join(root, 'authority.md'), '# Human roles\n');
  const schema = JSON.parse(
    readFileSync(join(ROOT, 'law/schemas/invariant.schema.json'), 'utf8'),
  ) as { examples: Array<Record<string, unknown>> };
  const invariant = {
    ...schema.examples[0],
    authority_docs: { docs: [{ doc: 'authority.md', anchor: 'human-roles' }] },
  };
  writeFileSync(join(root, 'law/invariants/INV-AUTH-001.json'), JSON.stringify(invariant));
  return root;
}
function fixtureManifest(root: string) {
  return withAuthorityHostTestScope(() =>
    buildRtdManifest({
      repoRoot: root,
      id: 'RTM-0001',
      now: '2026-09-07T00:00:00.000Z',
      integrationHead: 'b'.repeat(40),
    }),
  );
}
function completeTrace(root: string) {
  writeFileSync(
    join(root, 'law/trace.json'),
    JSON.stringify({
      schemaVersion: '1.0.0',
      version: '1.0.0',
      invariants: [{ id: 'INV-AUTH-001', tests: [] }],
      test_corpus: [],
    }),
  );
}
describe('RTD aggregate refusal propagation', () => {
  it('does not report readiness when defined invariants have no required trace', async () => {
    const root = readinessFixture();
    const manifest = await fixtureManifest(root);
    expect(manifest.components.invariants?.ok).toBe(true);
    expect(manifest.readiness.ok).toBe(false);
    expect(manifest.components.trace).toMatchObject({
      ok: false,
      count: 0,
      errors: [expect.stringContaining('trace file missing but 1 invariants are defined')],
    });
    expect(manifest.readiness.sub_verdicts).toContainEqual({
      component: 'trace',
      ok: false,
      error_count: 1,
    });
  });
  it.each(['{', 'null'])(
    'does not omit a present unreadable forbidden-actions registry %s',
    async (bytes) => {
      const root = readinessFixture();
      completeTrace(root);
      writeFileSync(join(root, 'law/policy/forbidden-actions.json'), bytes);
      const manifest = await fixtureManifest(root);
      expect(manifest.components.invariants?.ok).toBe(true);
      expect(manifest.components.trace?.ok).toBe(true);
      expect(manifest.readiness.ok).toBe(false);
      expect(manifest.components.forbidden_actions).toMatchObject({
        ok: false,
        count: 0,
        errors: [expect.stringContaining('unreadable:')],
      });
      expect(manifest.readiness.sub_verdicts).toContainEqual({
        component: 'forbidden_actions',
        ok: false,
        error_count: 1,
      });
    },
  );
  it('retains optional absence for a skeleton with no invariant or trace records', async () => {
    const root = readinessFixture();
    rmSync(join(root, 'law/invariants/INV-AUTH-001.json'));
    const manifest = await fixtureManifest(root);
    expect(manifest.readiness.ok).toBe(true);
    expect(manifest.components.trace).toBeUndefined();
    expect(manifest.components.forbidden_actions).toBeUndefined();
    expect(manifest.components.adrs).toBeUndefined();
  });
});

it('retains both independently discoverable failures in the same readiness record', async () => {
  const root = readinessFixture();
  writeFileSync(join(root, 'law/policy/forbidden-actions.json'), '{');
  const manifest = await fixtureManifest(root);
  expect(manifest.readiness).toEqual({
    ok: false,
    sub_verdicts: [
      { component: 'invariants', ok: true },
      { component: 'trace', ok: false, error_count: 1 },
      { component: 'forbidden_actions', ok: false, error_count: 1 },
    ],
  });
  expect(manifest.components.trace?.errors).toHaveLength(1);
  expect(manifest.components.forbidden_actions?.errors).toHaveLength(1);
});

describe('RTD ADR input availability', () => {
  it('preserves the established sorted content fingerprint for readable ADRs', async () => {
    const root = readinessFixture();
    completeTrace(root);
    const adrDir = join(root, 'law/adr');
    mkdirSync(adrDir);
    const second = { name: 'ADR-002-second.md', content: '# Second\n' };
    const first = { name: 'ADR-001-first.md', content: '# First\n' };
    for (const record of [second, first]) writeFileSync(join(adrDir, record.name), record.content);
    writeFileSync(join(adrDir, 'README.md'), 'Not an ADR');
    const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
    const manifest = await fixtureManifest(root);
    expect(manifest.components.adrs).toEqual({
      count: 2,
      hash: sha(
        JSON.stringify([first, second].map(({ name, content }) => ({ name, sha: sha(content) }))),
      ),
      ok: true,
    });
    expect(manifest.readiness.ok).toBe(true);
    expect(manifest.readiness.sub_verdicts).toContainEqual({ component: 'adrs', ok: true });
  });

  it('retains an unreadable ADR directory as a failed component', async () => {
    const root = readinessFixture();
    completeTrace(root);
    const adrDir = join(root, 'law/adr');
    writeFileSync(adrDir, 'owner-managed invalid directory placeholder');
    const manifest = await fixtureManifest(root);
    expect(manifest.readiness.ok).toBe(false);
    expect(manifest.components.adrs).toMatchObject({
      ok: false,
      errors: [`unreadable: ${adrDir}`],
    });
    expect(manifest.readiness.sub_verdicts).toContainEqual({
      component: 'adrs',
      ok: false,
      error_count: 1,
    });
    expect(readFileSync(adrDir, 'utf8')).toBe('owner-managed invalid directory placeholder');
  });

  it('aggregates unreadable ADR members and later policy failures without discarding readable ADRs', async () => {
    const root = readinessFixture();
    completeTrace(root);
    const adrDir = join(root, 'law/adr');
    mkdirSync(adrDir);
    const unreadable = join(adrDir, 'ADR-001-unreadable.md');
    mkdirSync(unreadable);
    const readable = join(adrDir, 'ADR-002-readable.md');
    writeFileSync(readable, '# Accepted decision\n');
    writeFileSync(join(root, 'law/policy/forbidden-actions.json'), '{');
    const first = await fixtureManifest(root);
    expect(first.readiness.ok).toBe(false);
    expect(first.components.adrs).toMatchObject({
      count: 2,
      ok: false,
      errors: [`unreadable: ${unreadable}`],
    });
    expect(first.readiness.sub_verdicts).toEqual([
      { component: 'invariants', ok: true },
      { component: 'trace', ok: true },
      { component: 'adrs', ok: false, error_count: 1 },
      { component: 'forbidden_actions', ok: false, error_count: 1 },
    ]);
    writeFileSync(readable, '# Revised accepted decision\n');
    const second = await fixtureManifest(root);
    expect(second.components.adrs?.hash).not.toBe(first.components.adrs?.hash);
    expect(second.components.adrs?.errors).toEqual(first.components.adrs?.errors);
  });
});
