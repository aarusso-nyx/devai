import { realpathSync } from 'node:fs';
import type { CAC } from 'cac';
import { requireReconciliationPhaseOutput } from '../../reconciliation-phase-output.js';
import {
  readReconciliationInventoryInput,
  materializeReconciliationInventory,
} from '@devai-nyx/authority/reconciliation-native';
import { defineCommand } from '../../define-command.js';
import { buildReconciliationInventoryBodies } from '../evidence/reconciliation-inventory-bodies.js';
import { emitReconciliationRefusal } from '../evidence/reconciliation-phases.js';
export const senseBootstrapInventory = defineCommand({
  name: 'sense bootstrap-inventory',
  description: 'Publish seven diagnostic bodies from the exact approved staged source.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    cli
      .command(
        'sense-bootstrap-inventory',
        'Generate diagnostic inventory from the approved staged snapshot',
      )
      .option('--repo-root <path>', 'Canonical repository root (required)')
      .option('--plan <path>', 'Saved canonical plan path (required)')
      .option('--plan-sha256 <sha256>', 'Exact saved plan digest (required)')
      .option('--approval <sha256>', 'Exact Owner approval id (required)')
      .option('--as-role <role>', 'Architect initiation (required)')
      .option('--write', 'Explicit write consent (required)')
      .action((input: { repoRoot?: string }) => {
        try {
          const output = requireReconciliationPhaseOutput();
          if (!input.repoRoot) throw new Error('RECONCILIATION_PHASE_HELD');
          const root = realpathSync(input.repoRoot),
            source = readReconciliationInventoryInput(root),
            built = buildReconciliationInventoryBodies(
              root,
              source.plan,
              source.blobs,
              new Date(source.clock.wall_ms).toISOString(),
            ),
            result = materializeReconciliationInventory(
              root,
              source,
              built.outputs.map(({ path, text }) => ({ path, text })),
            );
          output.finishReconciliationPhase(result);
          process.exitCode = 0;
        } catch (error) {
          emitReconciliationRefusal(error);
        }
      });
  },
});
