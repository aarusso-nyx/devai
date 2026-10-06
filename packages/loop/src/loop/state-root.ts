/**
 * Durable initialization of the `.devai/state` root (#293, ADR-AUT-0005). Durable writers
 * fsync directories only at or below `.devai/state`, because actions holding state
 * authority may touch nothing above it. The root's own entry in `.devai` is made durable
 * once, by an authorized init step that holds workspace authority (`init apply harness`):
 * it fsyncs the repository directory when it created `.devai`, fsyncs `.devai`, and then
 * publishes a marker. Experimental dispatch requires a valid marker, so no acknowledged
 * dispatch record can live in a state root that a power loss could still remove.
 */
import {
  existsSync,
  flushDirectoryEntrySync,
  lstatSync,
  mkdirSync,
  readFileSync,
} from '@devai-nyx/authority';
import { join } from 'node:path';
import { fsyncDirectorySync, publishCreateOnlyDurableSync } from './durable-files.js';

/** Marker an authorized init step publishes once the state root is durable. */
export const STATE_ROOT_MARKER = '.devai/state/state-root.json';

/**
 * The marker's exact bytes. They carry no time or host, so an init replay reproduces the
 * same tree; the marker's presence alone attests that `.devai` was fsynced first.
 */
export const STATE_ROOT_MARKER_BODY = `${JSON.stringify({ schemaVersion: '1.0.0', id: 'state-root' }, null, 2)}\n`;

export function stateRootMarkerPath(repoRoot: string): string {
  return join(repoRoot, STATE_ROOT_MARKER);
}

/**
 * The marker's state: `absent`, `valid` (a regular file, not a symbolic link, holding exactly
 * the marker bytes), or `invalid` (anything else at the marker path).
 */
export function stateRootMarkerStatus(repoRoot: string): 'absent' | 'valid' | 'invalid' {
  const path = stateRootMarkerPath(repoRoot);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return 'absent';
  if (!stat.isFile()) return 'invalid';
  try {
    return readFileSync(path, 'utf8') === STATE_ROOT_MARKER_BODY ? 'valid' : 'invalid';
  } catch {
    return 'invalid';
  }
}

/** Whether an authorized init step durably initialized the state root. */
export function stateRootInitialized(repoRoot: string): boolean {
  return stateRootMarkerStatus(repoRoot) === 'valid';
}

/**
 * Create `.devai/state` if needed, make its entries durable (the repository directory when
 * `.devai` itself was created, then `.devai`), and publish the marker without replacing an
 * existing one. Idempotent: a second call keeps a valid marker and returns `created: false`;
 * an existing marker that is not valid refuses with `INIT_STATE_ROOT_MARKER_INVALID`. The
 * caller must hold workspace authority for `.devai` as well as state authority.
 */
export function initializeStateRootSync(repoRoot: string): {
  readonly created: boolean;
  readonly path: string;
} {
  const path = stateRootMarkerPath(repoRoot);
  if (stateRootMarkerStatus(repoRoot) === 'invalid') {
    throw new Error('INIT_STATE_ROOT_MARKER_INVALID');
  }
  const devai = join(repoRoot, '.devai');
  const state = join(devai, 'state');
  const createdDevai = !existsSync(devai);
  if (!existsSync(state)) mkdirSync(state, { recursive: true });
  if (createdDevai) flushDirectoryEntrySync(repoRoot);
  fsyncDirectorySync(devai);
  const created = publishCreateOnlyDurableSync(path, STATE_ROOT_MARKER_BODY);
  if (!created && stateRootMarkerStatus(repoRoot) !== 'valid') {
    throw new Error('INIT_STATE_ROOT_MARKER_INVALID');
  }
  return { created, path };
}
