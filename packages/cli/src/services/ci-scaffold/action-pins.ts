import { existsSync, readFileSync } from '@devai-nyx/authority';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One GitHub Action pin: the release tag it names and the full commit it is pinned to. */
export interface ActionPin {
  readonly ref: string;
  readonly digest: string;
}

/** The action pins every DEVAI-generated workflow uses (#383). */
export interface ActionPins {
  readonly checkout: ActionPin;
  readonly setupNode: ActionPin;
  readonly uploadArtifact: ActionPin;
}

const PINNED_ACTIONS = {
  checkout: 'actions/checkout',
  setupNode: 'actions/setup-node',
  uploadArtifact: 'actions/upload-artifact',
} as const;

/**
 * Reads the action pins from the packaged adopter toolchain defaults
 * (law/policy/adopter-defaults/toolchain.json), so the attested-RC verification workflow and
 * the main-observation workflow pin one set of versions an adopter can align with (#383).
 * Undefined when the packaged defaults are absent (a runtime bundle that generates no workflow
 * ships none); a present file with a missing action, or a pin that is not an exact tag and a
 * full commit, refuses to load.
 */
function readActionPins(): ActionPins | undefined {
  const moduleRoot = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleRoot, '../../law/policy/adopter-defaults/toolchain.json'),
    resolve(moduleRoot, '../../../../../law/policy/adopter-defaults/toolchain.json'),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path === undefined) return undefined;
  // A truncated or non-JSON file, or a top level that is not an object, is refused with the
  // declared code rather than a raw SyntaxError or TypeError (#391).
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('CI_SCAFFOLD_ACTION_PINS_INVALID');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('CI_SCAFFOLD_ACTION_PINS_INVALID');
  }
  const manifest = parsed as {
    readonly actions?: Readonly<
      Record<string, { readonly ref?: unknown; readonly digest?: unknown }>
    >;
  };
  const pin = (action: string): ActionPin => {
    const entry = manifest.actions?.[action];
    const ref = entry?.ref;
    const digest = entry?.digest;
    if (
      typeof ref !== 'string' ||
      !/^v\d+\.\d+\.\d+$/u.test(ref) ||
      typeof digest !== 'string' ||
      !/^[0-9a-f]{40}$/u.test(digest)
    )
      throw new Error(`CI_SCAFFOLD_ACTION_PINS_INVALID: ${action}`);
    return Object.freeze({ ref, digest });
  };
  return Object.freeze({
    checkout: pin(PINNED_ACTIONS.checkout),
    setupNode: pin(PINNED_ACTIONS.setupNode),
    uploadArtifact: pin(PINNED_ACTIONS.uploadArtifact),
  });
}

let cached: ActionPins | undefined;

/**
 * The action pins, read once on first use rather than at import, so a module that imports a
 * workflow generator without generating a workflow needs no toolchain defaults. Generating a
 * workflow fails closed: absent defaults throw CI_SCAFFOLD_ACTION_PINS_MISSING.
 */
export function getActionPins(): ActionPins {
  cached ??= readActionPins();
  if (cached === undefined) throw new Error('CI_SCAFFOLD_ACTION_PINS_MISSING');
  return cached;
}

/**
 * One pin's digest for an informational export, or the empty string when the packaged defaults
 * are absent. Never used to generate a workflow; the generators call getActionPins().
 */
export function actionPinDigestIfPresent(action: keyof ActionPins): string {
  try {
    return getActionPins()[action].digest;
  } catch (error) {
    if (error instanceof Error && error.message === 'CI_SCAFFOLD_ACTION_PINS_MISSING') return '';
    throw error;
  }
}
