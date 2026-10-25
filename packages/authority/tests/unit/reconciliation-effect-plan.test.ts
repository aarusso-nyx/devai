import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { canonicalJson } from '@devai-nyx/utils';
import { describe, expect, it } from 'vitest';
import {
  createReconciliationEffectPlan,
  reconciliationCustodyManifest,
} from '../../src/boundaries/reconciliation-effect-plan.js';
import type { ReconciliationPlan } from '../../src/boundaries/reconciliation-plan.js';

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const parent = 'a'.repeat(40);
const digest = 'b'.repeat(64);
function item<T>(values: readonly T[], index = 0): T {
  const value = values[index];
  if (value === undefined) throw new Error('fixture item missing');
  return value;
}
function source() {
  const files = [
    {
      commit: parent,
      path: 'record/proofs/chain.json',
      mode: '100644',
      blob_oid: 'c'.repeat(40),
      sha256: digest,
      bytes: 128,
      kind: 'chain' as const,
    },
    {
      commit: 'd'.repeat(40),
      path: 'record/proofs/chain.json',
      mode: '100644',
      blob_oid: 'c'.repeat(40),
      sha256: digest,
      bytes: 128,
      kind: 'chain' as const,
    },
    {
      commit: parent,
      path: '@commit',
      mode: 'commit',
      blob_oid: parent,
      sha256: 'e'.repeat(64),
      bytes: 92,
      kind: 'ancestry' as const,
    },
  ];
  const entries = [
    {
      path: 'README.md',
      mode: '100644' as const,
      oid: '1'.repeat(40),
      stage: 0,
      assume_valid: false,
    },
    {
      path: 'law/security/authorization.json',
      mode: '100644' as const,
      oid: '2'.repeat(40),
      stage: 2,
      assume_valid: false,
    },
    {
      path: 'record/proofs/chain.json',
      mode: '100644' as const,
      oid: '3'.repeat(40),
      stage: 3,
      assume_valid: false,
    },
  ];
  const manifest = {
    files,
    staged_files: [],
    index: {
      version: 2 as const,
      object_format: 'sha1' as const,
      raw_sha256: digest,
      semantic_sha256: digest,
      other_entries_sha256: digest,
      entries,
      has_tree_extension: false,
    },
    recovery_obligations: [
      {
        proof_path: 'record/proofs/work/generic/R-0025.jsonl',
        proof_sequence: 7,
        proof_sha256: digest,
        source_commit: parent,
        source_chain_sha256: digest,
        source_entry_manifest_hash: digest,
        mode: 'divergent' as const,
      },
    ],
  };
  return {
    selection: {
      parent,
      published_ref: 'refs/heads/main',
      published_tip: parent,
      origin_config_sha256: digest,
      effective_origin_sha256: digest,
    },
    source_manifest: manifest,
    source_manifest_sha256: sha(canonicalJson(manifest)),
  };
}
const schema = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      '../../../../law/schemas/evidence-reconciliation-plan.schema.json',
    ),
    'utf8',
  ),
) as { $defs: Record<string, unknown> };
const ajv = new Ajv2020({ strict: true });
const validate = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/effectPlan' });

describe('fixed reconciliation effect recipe without host effects', () => {
  it('preserves every custody source mapping while deduplicating only identical object bytes', () => {
    const s = source();
    const recipe = createReconciliationEffectPlan(s);
    const bytes = reconciliationCustodyManifest(s);
    const manifest = JSON.parse(bytes) as { files: unknown[] };
    expect(manifest.files).toHaveLength(3);
    expect(recipe.custody.objects).toHaveLength(2);
    expect(recipe.custody.objects.reduce((n, item) => n + item.bytes, 0)).toBe(220);
    expect(recipe.custody.manifest.sha256).toBe(sha(bytes));
    expect(recipe.custody.manifest.bytes).toBe(Buffer.byteLength(bytes));
    expect(validate(recipe), JSON.stringify(validate.errors)).toBe(true);
  });

  it('binds exact staged source content independently from excluded proof/catalogue entries', () => {
    const s = source();
    const before = createReconciliationEffectPlan(s);
    item(s.source_manifest.index.entries, 1).oid = '4'.repeat(40);
    item(s.source_manifest.index.entries, 2).oid = '5'.repeat(40);
    s.source_manifest_sha256 = sha(canonicalJson(s.source_manifest));
    expect(createReconciliationEffectPlan(s).inventory.source_sha256).toBe(
      before.inventory.source_sha256,
    );
    item(s.source_manifest.index.entries).oid = '6'.repeat(40);
    s.source_manifest_sha256 = sha(canonicalJson(s.source_manifest));
    expect(createReconciliationEffectPlan(s).inventory.source_sha256).not.toBe(
      before.inventory.source_sha256,
    );
  });

  it('requires unchanged manifest identity and the complete selected original chain', () => {
    const s = source();
    s.source_manifest.files.pop();
    expect(() => createReconciliationEffectPlan(s)).toThrow('RECONCILIATION_PLAN_INVALID');
    s.source_manifest.files = s.source_manifest.files.filter((file) => file.commit !== parent);
    s.source_manifest_sha256 = sha(canonicalJson(s.source_manifest));
    expect(() => createReconciliationEffectPlan(s)).toThrow('RECONCILIATION_PLAN_SOURCE_INVALID');
  });

  it('refuses oversize objects and conflicting byte lengths for a deduplicated digest', () => {
    const s = source();
    item(s.source_manifest.files).bytes = 33554433;
    s.source_manifest_sha256 = sha(canonicalJson(s.source_manifest));
    expect(() => createReconciliationEffectPlan(s)).toThrow('RECONCILIATION_PLAN_LIMIT');
    item(s.source_manifest.files).bytes = 129;
    s.source_manifest_sha256 = sha(canonicalJson(s.source_manifest));
    expect(() => createReconciliationEffectPlan(s)).toThrow('RECONCILIATION_PLAN_LIMIT');
  });

  it.each([
    'wildcard-output',
    'eighth-output',
    'wrong-producer',
    'wrong-schema',
    'readiness',
    'different-lock',
    'extra-private-path',
    'extra-directory',
  ])('closes %s even when a caller rehashes its data', (change) => {
    const recipe = structuredClone(createReconciliationEffectPlan(source()));
    switch (change) {
      case 'wildcard-output':
        item(recipe.inventory.outputs).path += '/*';
        break;
      case 'eighth-output':
        recipe.inventory.outputs.push(item(recipe.inventory.outputs));
        break;
      case 'wrong-producer':
        Reflect.set(item(recipe.inventory.outputs), 'producer', 'externalCaller');
        break;
      case 'wrong-schema':
        Reflect.set(item(recipe.inventory.outputs), 'schema', 'sensor-reading.schema.json');
        break;
      case 'readiness':
        Reflect.set(recipe.inventory, 'grants_readiness', true);
        break;
      case 'different-lock':
        recipe.selection.append_lock_path = 'elsewhere.lock';
        break;
      case 'extra-private-path':
        Reflect.set(recipe.private_state, 'physical_path', '/tmp/foreign');
        break;
      case 'extra-directory':
        recipe.custody.directories.push('foreign');
        break;
    }
    expect(sha(canonicalJson(recipe))).toMatch(/^[a-f0-9]{64}$/u);
    expect(validate(recipe)).toBe(false);
  });

  it('exports a data recipe type without inventing a public authority claim', () => {
    const recipe: ReconciliationPlan['effect_plan'] = createReconciliationEffectPlan(source());
    expect(recipe.recovery.current_expected_head_each).toBe(true);
    expect(recipe.inventory.publishes_readings).toBe(false);
    expect(recipe.inventory.publishes_canonical_pointer).toBe(false);
  });
});
