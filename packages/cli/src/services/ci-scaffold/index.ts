import { existsSync, lstatSync, mkdirSync, writeFileSync } from '@devai-nyx/authority';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { readAttestedRcConfig } from '../../commands/check/ci-local-only.js';

import { ledgerVerificationWorkflow, attestedRcVerificationWorkflow } from './workflows.js';
export {
  attestedRcVerificationWorkflow,
  ledgerVerificationWorkflow,
  CHECKOUT_COMMIT,
  SETUP_NODE_COMMIT,
  LEDGER_ENVIRONMENT,
} from './workflows.js';
export {
  VERIFIER_PACKAGE,
  VERIFIER_SOURCE_COMMIT,
  NEXT_VERIFIER_SOURCE_COMMIT,
} from './verifier-package.js';

export interface CiScaffoldOptions {
  readonly targetRoot: string;
  readonly outputPath?: string;
}

export interface CiScaffoldPlan {
  readonly path: string;
  readonly content: string;
  readonly exists: boolean;
}

export const LEDGER_WORKFLOW_FILE = 'devai-ledger-verify.yml';
export const ATTESTED_RC_WORKFLOW_FILE = 'devai-local-rc-verify.yml';

const DEFAULT_OUTPUT_RELATIVE = `.github/workflows/${LEDGER_WORKFLOW_FILE}`;

export function buildCiScaffoldPlan(opts: CiScaffoldOptions): CiScaffoldPlan {
  const root = resolve(opts.targetRoot);
  const attested = readAttestedRcConfig(root);
  if (attested.errors.length > 0)
    throw new Error(`CI_SCAFFOLD_ATTESTED_RC_INVALID:${attested.errors.join(';')}`);
  const defaultRelative =
    attested.config === undefined
      ? DEFAULT_OUTPUT_RELATIVE
      : `.github/workflows/${ATTESTED_RC_WORKFLOW_FILE}`;
  const path = resolve(opts.outputPath ?? join(root, defaultRelative));
  const fromRoot = relative(root, path);
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw new Error(`CI_SCAFFOLD_PATH_ESCAPE:${path}`);
  }
  let cursor = root;
  for (const segment of fromRoot.split(sep).slice(0, -1)) {
    cursor = join(cursor, segment);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`CI_SCAFFOLD_SYMLINK_REFUSED:${path}`);
    }
  }
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`CI_SCAFFOLD_SYMLINK_REFUSED:${path}`);
  }
  return {
    path,
    content:
      attested.config === undefined
        ? ledgerVerificationWorkflow()
        : attestedRcVerificationWorkflow(),
    exists: existsSync(path),
  };
}

export interface CiScaffoldResult {
  readonly written: boolean;
  readonly reason?: string;
}

export function executeCiScaffoldPlan(
  plan: CiScaffoldPlan,
  opts: { force?: boolean } = {},
): CiScaffoldResult {
  if (plan.exists && opts.force !== true) {
    return { written: false, reason: 'exists (use --force to overwrite)' };
  }
  mkdirSync(dirname(plan.path), { recursive: true });
  writeFileSync(plan.path, plan.content);
  return { written: true };
}
