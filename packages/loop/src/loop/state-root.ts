/**
 * Durable initialization of the `.devai/state` root (#293, ADR-AUT-0005). Durable writers
 * fsync directories only at or below `.devai/state`, because actions holding state
 * authority may touch nothing above it. The root's own entry in `.devai` is made durable
 * once, by an authorized init step that holds workspace authority (`init apply harness`):
 * it fsyncs `.devai` and then publishes a marker. Experimental dispatch requires the
 * marker, so no acknowledged dispatch record can live in a state root that a power loss
 * could still remove.
 */
import { existsSync, mkdirSync } from '@devai-nyx/authority';
import { join } from 'node:path';
import { fsyncDirectorySync, publishCreateOnlyDurableSync } from './durable-files.js';

/** Marker an authorized init step publishes once the state root is durable. */
export const STATE_ROOT_MARKER = '.devai/state/state-root.json';

export function stateRootMarkerPath(repoRoot: string): string {
  return join(repoRoot, STATE_ROOT_MARKER);
}

/** Whether an authorized init step durably initialized the state root. */
export function stateRootInitialized(repoRoot: string): boolean {
  return existsSync(stateRootMarkerPath(repoRoot));
}

/**
 * The marker's exact bytes. They carry no time or host, so an init replay reproduces the
 * same tree; the marker's presence alone attests that `.devai` was fsynced first.
 */
export const STATE_ROOT_MARKER_BODY = `${JSON.stringify({ schemaVersion: '1.0.0', id: 'state-root' }, null, 2)}\n`;

/**
 * Create `.devai/state` if needed, fsync `.devai` so the root's entry is durable, then
 * publish the marker without replacing an existing one. Idempotent: a second call keeps
 * the first marker and returns `created: false`. The caller must hold workspace authority
 * for `.devai` as well as state authority.
 */
export function initializeStateRootSync(repoRoot: string): {
  readonly created: boolean;
  readonly path: string;
} {
  const devai = join(repoRoot, '.devai');
  const state = join(devai, 'state');
  if (!existsSync(state)) mkdirSync(state, { recursive: true });
  fsyncDirectorySync(devai);
  const path = stateRootMarkerPath(repoRoot);
  const created = publishCreateOnlyDurableSync(path, STATE_ROOT_MARKER_BODY);
  return { created, path };
}
