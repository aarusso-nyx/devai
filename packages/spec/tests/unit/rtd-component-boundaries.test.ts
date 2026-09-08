import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@devai-nyx/utils';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { buildRtdManifest, persistRtdManifest } from '../../src/rtd-manifest/index.js';

// Invariants: INV-DEVAI-001
const ROOT = resolve(import.meta.dirname, '../../../..');
const roots: string[] = [];
const now = '2026-09-08T12:00:00.000Z';
const head = 'a'.repeat(40);
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function example(name: string): Record<string, unknown> {
  const value = (
    JSON.parse(readFileSync(join(ROOT, 'law/schemas', `${name}.schema.json`), 'utf8')) as {
      examples: Record<string, unknown>[];
    }
  ).examples[0];
  if (value === undefined) throw new Error(`Missing schema example: ${name}`);
  return structuredClone(value);
}
function put(root: string, path: string, value: unknown) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, typeof value === 'string' ? value : JSON.stringify(value));
  return full;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devai-rtd-components-'));
  roots.push(root);
  put(root, '.devai/config/domains.json', { core: ['AUTH'] });
  put(root, 'authority.md', '# Human roles\n');
  const invariant = {
    ...example('invariant'),
    authority_docs: { docs: [{ doc: 'authority.md', anchor: 'human-roles' }] },
  };
  const journey = { ...example('journey'), related_invariants: ['INV-AUTH-001'] };
  const glossary = example('glossary-entry');
  delete glossary.see_also;
  delete glossary.related_invariants;
  const trace = {
    schemaVersion: '1.0.0',
    version: '1.0.0',
    invariants: [{ id: 'INV-AUTH-001', tests: [] }],
    test_corpus: [],
  };
  const policy = JSON.parse(
    readFileSync(join(ROOT, 'law/policy/forbidden-actions.json'), 'utf8'),
  ) as { schemaVersion: string; actions: Record<string, unknown>[] };
  const action = policy.actions[0];
  if (action === undefined) throw new Error('Missing canonical forbidden action');
  const forbidden = { schemaVersion: policy.schemaVersion, actions: [action] };
  const records = {
    invariants: invariant,
    journeys: journey,
    glossary,
    trace,
    forbidden_actions: forbidden,
  };
  const paths = {
    invariants: 'law/invariants/INV-AUTH-001.json',
    journeys: 'product/journeys/JNY-001.json',
    glossary: 'law/glossary/GE-001.json',
    trace: 'law/trace.json',
    forbidden_actions: 'law/policy/forbidden-actions.json',
  };
  for (const key of Object.keys(paths) as (keyof typeof paths)[])
    put(root, paths[key], records[key]);
  return { root, paths, records };
}
function build(root: string) {
  return withAuthorityHostTestScope(() =>
    buildRtdManifest({ repoRoot: root, id: 'RTM-0001', now, integrationHead: head }),
  );
}

describe('RTD component population and diagnostics', () => {
  it('binds every parsed record and slice verdict into the manifest', async () => {
    const f = fixture();
    put(f.root, 'product/journeys/README.json', { unrelated: true });
    put(f.root, 'law/glossary/README.json', { unrelated: true });
    const m = await build(f.root);
    expect(m.components).toEqual({
      invariants: {
        count: 1,
        ok: true,
        hash: canonicalSha256({ records: [f.records.invariants] }),
      },
      trace: { count: 1, ok: true, hash: canonicalSha256(f.records.trace) },
      journeys: { count: 1, ok: true, hash: canonicalSha256({ records: [f.records.journeys] }) },
      glossary: { count: 1, ok: true, hash: canonicalSha256({ records: [f.records.glossary] }) },
      forbidden_actions: { count: 1, ok: true, hash: canonicalSha256(f.records.forbidden_actions) },
    });
    expect(m.readiness).toEqual({
      ok: true,
      sub_verdicts: ['invariants', 'trace', 'journeys', 'glossary', 'forbidden_actions'].map(
        (component) => ({ component, ok: true }),
      ),
    });
    const { manifest_hash, ...bound } = m;
    expect(manifest_hash).toBe(canonicalSha256(bound));
  });

  it.each(['invariants', 'journeys', 'glossary', 'trace', 'forbidden_actions'] as const)(
    'retains actionable schema errors from %s without losing valid slices',
    async (key) => {
      const f = fixture();
      const file = put(f.root, f.paths[key], { ...f.records[key], unexpected: true });
      const m = await build(f.root);
      const component = m.components[key];
      expect(m.readiness.ok).toBe(false);
      expect(component?.ok).toBe(false);
      expect(component?.errors).toContain(
        key === 'forbidden_actions'
          ? 'must NOT have additional properties'
          : `${file}: must NOT have additional properties (additionalProperties)`,
      );
      expect(m.readiness.sub_verdicts).toContainEqual({
        component: key,
        ok: false,
        error_count: component?.errors?.length,
      });
      expect(m.components[key === 'glossary' ? 'journeys' : 'glossary']?.ok).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe(
        JSON.stringify({ ...f.records[key], unexpected: true }),
      );
    },
  );

  it.each(['invariants', 'journeys', 'glossary'] as const)(
    'retains unreadable %s input in its count and diagnostics',
    async (key) => {
      const f = fixture();
      const file = put(f.root, f.paths[key], '{');
      const m = await build(f.root);
      expect(m.readiness.ok).toBe(false);
      expect(m.components[key]).toMatchObject({
        count: 1,
        ok: false,
        hash: canonicalSha256({ records: [] }),
        errors: expect.arrayContaining([`unreadable: ${file}`]),
      });
      expect(m.components[key]?.errors?.some((e) => e.includes('JSON parse error:'))).toBe(true);
      expect(m.readiness.sub_verdicts).toContainEqual({
        component: key,
        ok: false,
        error_count: m.components[key]?.errors?.length,
      });
    },
  );

  it('reports a missing domain taxonomy and later malformed slices together', async () => {
    const f = fixture();
    rmSync(join(f.root, '.devai/config/domains.json'));
    put(f.root, f.paths.journeys, '{');
    put(f.root, f.paths.glossary, '{');
    const m = await build(f.root);
    expect(m.readiness.ok).toBe(false);
    for (const key of ['invariants', 'journeys', 'glossary'] as const) {
      expect(m.components[key]?.ok).toBe(false);
      expect(m.components[key]?.errors?.length).toBeGreaterThan(0);
      expect(m.readiness.sub_verdicts).toContainEqual({
        component: key,
        ok: false,
        error_count: m.components[key]?.errors?.length,
      });
    }
    expect(m.components.forbidden_actions?.ok).toBe(true);
  });

  it('allocates distinct durable RTM IDs and persists under the public proof directory', async () => {
    const f = fixture();
    const make = () =>
      withAuthorityHostTestScope(() =>
        buildRtdManifest({ repoRoot: f.root, now, integrationHead: head }),
      );
    const first = await make(),
      second = await make();
    expect([first.id, second.id]).toEqual(['RTM-0001', 'RTM-0002']);
    const counters = put(f.root, '.devai/state/counters.json', { RTM: 40, REL: 17 });
    expect((await make()).id).toBe('RTM-0041');
    expect(JSON.parse(readFileSync(counters, 'utf8'))).toEqual({ RTM: 41, REL: 17 });
    for (const m of [first, second]) {
      const path = await withAuthorityHostTestScope(() => persistRtdManifest(m, f.root));
      expect(path).toBe(join(f.root, 'record/proofs/compliance/rtd-manifests', `${m.id}.json`));
      expect(readFileSync(path, 'utf8')).toBe(JSON.stringify(m, null, 2) + '\n');
    }
  });
});
