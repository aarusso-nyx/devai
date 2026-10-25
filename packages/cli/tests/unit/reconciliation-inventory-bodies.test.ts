import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ReconciliationPlan } from '@devai-nyx/authority';
import { canonicalJson } from '@devai-nyx/utils';
import { createReconciliationEffectPlan } from '../../../authority/src/boundaries/reconciliation-effect-plan.js';
import {
  buildReconciliationInventoryBodies,
  createReconciliationInventoryReader,
} from '../../src/commands/evidence/reconciliation-inventory-bodies.js';
const root = '/bounded-staged-fixture',
  now = '2026-10-25T00:00:00.000Z';
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture(includeRegistry = true) {
  const files = new Map<string, Buffer>([
    [
      'src/staged.controller.ts',
      Buffer.from(
        "import { Controller, Get, UseGuards } from '@nestjs/common';\n@Controller('staged') export class StagedController { @Get('list') @UseGuards(StagedGuard) list() {} }\n",
      ),
    ],
    [
      'src/app.routes.ts',
      Buffer.from(
        "import { Routes } from '@angular/router'; export const routes: Routes = [{path: 'staged', component: StagedPage}];\n",
      ),
    ],
    [
      'database/schema.sql',
      Buffer.from(
        'CREATE TABLE staged_users (id uuid PRIMARY KEY, email text); CREATE TABLE staged_roles (id uuid PRIMARY KEY, name text);\n',
      ),
    ],
    [
      'product/use-cases/staged.json',
      Buffer.from(
        JSON.stringify({
          schemaVersion: '1.0.0',
          roles: ['operator'],
          cases: [
            {
              id: 'UC-staged',
              title: 'staged',
              mainFlow: [
                { action: 'list', refs: { endpointIds: ['GET /staged/list'], routeIds: [] } },
              ],
            },
          ],
        }),
      ),
    ],
    ['law/policy/action-registry.json', Buffer.from(JSON.stringify({ entries: [] }))],
    ['src/metadata-link', Buffer.from('../private')],
    ['src/binary.dat', Buffer.from([255, 254])],
  ]);
  if (!includeRegistry) files.delete('law/policy/action-registry.json');
  const blobs = new Map<string, Uint8Array>();
  const staged_files = [...files]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([path, bytes]) => {
      const oid = createHash('sha1')
        .update(`blob ${String(bytes.length)}\0`)
        .update(bytes)
        .digest('hex');
      blobs.set(oid, bytes);
      return {
        path,
        stage: 0,
        mode: path.endsWith('metadata-link') ? ('120000' as const) : ('100644' as const),
        blob_oid: oid,
        sha256: sha(bytes),
        bytes: bytes.length,
      };
    });
  const entries = staged_files.map((file) => ({
    path: file.path,
    stage: 0,
    mode: file.mode,
    oid: file.blob_oid,
    assume_valid: false,
  }));
  const parent = 'a'.repeat(40),
    digest = 'b'.repeat(64);
  const manifest = {
    files: [
      {
        commit: parent,
        path: 'record/proofs/chain.json',
        mode: '100644',
        blob_oid: parent,
        sha256: digest,
        bytes: 100,
        kind: 'chain' as const,
      },
    ],
    staged_files,
    index: {
      version: 2 as const,
      object_format: 'sha1' as const,
      raw_sha256: digest,
      semantic_sha256: digest,
      other_entries_sha256: digest,
      entries,
      has_tree_extension: false,
    },
    recovery_obligations: [],
  };
  const source = {
    source_manifest: manifest,
    source_manifest_sha256: sha(canonicalJson(manifest)),
    selection: {
      parent,
      published_ref: 'refs/heads/main',
      published_tip: parent,
      origin_config_sha256: digest,
      effective_origin_sha256: digest,
    },
  };
  const effect = createReconciliationEffectPlan(source);
  const plan: ReconciliationPlan = {
    schemaVersion: '1.0.0',
    kind: 'evidence-reconciliation-plan',
    identity: {
      schemaVersion: '1.0.0',
      kind: 'reconciliation-host-context',
      repository_id: 'fixture',
      worktree_id: 'wt-fixture',
      host_identity_sha256: digest,
      head: parent,
      object_format: 'sha1',
      merge_heads: ['c'.repeat(40)],
    },
    binding_sha256: digest,
    ...source,
    bases: [],
    effect_plan: effect,
    effect_plan_sha256: sha(canonicalJson(effect)),
    grants_authority: false,
  };
  return { plan, blobs, files };
}
describe('reconciliation immutable staged inventory', () => {
  it('retains a copied source image and rejects missing, binary, link and outside reads', () => {
    const f = fixture(),
      reader = createReconciliationInventoryReader(root, f.plan, f.blobs);
    expect(reader.readFile(`${root}/src/staged.controller.ts`)).toContain('StagedController');
    for (const bytes of f.blobs.values()) bytes.fill(0);
    expect(reader.readFile(`${root}/src/staged.controller.ts`)).toContain('StagedController');
    for (const path of [
      `${root}/src/metadata-link`,
      `${root}/src/binary.dat`,
      `${root}/src/missing.ts`,
      '/outside/source.ts',
    ])
      expect(() => reader.readFile(path)).toThrow();
    expect(() => reader.listDirectory('/outside')).toThrow();
  });
  it('refuses a changed blob or source projection before producers run', () => {
    const f = fixture(),
      first = f.blobs.keys().next().value;
    if (!first) throw new Error('fixture');
    f.blobs.set(first, Buffer.from('changed'));
    expect(() => createReconciliationInventoryReader(root, f.plan, f.blobs)).toThrow(
      'RECONCILIATION_INVENTORY_SOURCE_INVALID',
    );
    const second = fixture();
    second.plan.effect_plan.inventory.source_sha256 = '0'.repeat(64);
    expect(() => createReconciliationInventoryReader(root, second.plan, second.blobs)).toThrow();
  });
  it('produces diagnostic bodies for an adopter without an optional action registry', () => {
    const f = fixture(false);
    const result = buildReconciliationInventoryBodies(root, f.plan, f.blobs, now);
    expect(result.outputs).toHaveLength(7);
    expect(result.outputs[6]?.text).toContain('UC-staged');
    expect(result.grants_readiness).toBe(false);
  });
  it('runs all seven native producers with explicit model/API/routes dependencies and stable bytes', () => {
    const f = fixture(),
      result = buildReconciliationInventoryBodies(root, f.plan, f.blobs, now);
    expect(result.outputs.map((output) => output.path)).toEqual(
      f.plan.effect_plan.inventory.outputs.map((output) => output.path),
    );
    expect(result.outputs).toHaveLength(7);
    expect(result.outputs[0]?.text).toContain('/staged/list');
    expect(result.outputs[2]?.text).toContain('staged_users');
    expect(result.outputs[3]?.text).toContain('staged_users');
    expect(result.outputs[4]?.text).toContain('StagedGuard');
    const coverage = JSON.parse(result.outputs[6]?.text ?? 'null') as {
      stats: { endpointCount: number };
      links: { useCaseId: string; endpointId: string }[];
    };
    expect(coverage.stats.endpointCount).toBe(1);
    expect(coverage.links[0]?.useCaseId).toBe('UC-staged');
    expect(decodeURIComponent(coverage.links[0]?.endpointId ?? '')).toContain('/staged/list');
    expect(buildReconciliationInventoryBodies(root, f.plan, f.blobs, now)).toEqual(result);
    expect(result.grants_authority).toBe(false);
    expect(result.grants_readiness).toBe(false);
    expect(result.publishes_readings).toBe(false);
  });
});
