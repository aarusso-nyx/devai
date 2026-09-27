import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { validators } from '@devai-nyx/schemas';
import type { StateChange } from './frames.js';
import { requireId } from './isolation.js';
import { RECIPE_NAME_PATTERN, RECIPE_VARIANT_PATTERN, recipeRunDirectory } from './mutations.js';
export {
  createTranslationWitness,
  recordMutationCandidate,
  recordMutationEvidenceCommit,
} from './mutations.js';
export type {
  MutationCandidateRecord,
  MutationEvidenceRecord,
  MutationIntent,
  TranslationWitnessClaim,
} from './mutations.js';

export {
  dropValidationDatabase,
  provisionValidationDatabase,
  recoverValidationLeases,
  runLinuxIsolated,
} from './isolation.js';

export { evaluateTranslationFrames, validateInvariantStrategies } from './frames.js';
export type {
  FrameEvaluation,
  InvariantLike,
  StateChange,
  TranslationStrategy,
  ValidationFrame,
} from './frames.js';

export { classifyTranslationPath } from './path-authority.js';
export type {
  MutationAuthorityRole,
  TranslationAuthorityRole,
  TranslationFilesystemEffect,
  TranslationPathClassification,
} from './path-authority.js';

export function buildExpectedDiffManifest(input: {
  readonly validation_id: string;
  readonly witness_id: string;
  readonly lease_id: string;
  readonly recipe_name: string;
  readonly recipe_variant: string;
  readonly recipe_record_path: string;
}): readonly StateChange[] {
  const validationId = requireId(input.validation_id, /^VR-[a-f0-9]{16}$/u, 'validation id');
  const witnessId = requireId(input.witness_id, /^TW-[a-f0-9]{16}$/u, 'witness id');
  const leaseId = requireId(input.lease_id, /^TVL-[a-f0-9]{16}$/u, 'lease id');
  const recipeName = requireId(input.recipe_name, RECIPE_NAME_PATTERN, 'recipe name');
  const recipeVariant = requireId(input.recipe_variant, RECIPE_VARIANT_PATTERN, 'recipe variant');
  const prefix = `${recipeRunDirectory(recipeName, recipeVariant)}/`;
  if (!input.recipe_record_path.startsWith(prefix)) {
    throw new Error('RECIPE_RECORD_PATH_INVALID');
  }
  const filename = input.recipe_record_path.slice(prefix.length);
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/u.test(filename) ||
    filename.includes('..') ||
    filename.includes('/') ||
    filename.includes('\\')
  ) {
    throw new Error('RECIPE_RECORD_PATH_INVALID');
  }
  return [
    {
      path: `.devai/state/translation-validation/leases/${leaseId}.json`,
      operation: 'create',
    },
    {
      path: `.devai/state/translation-validation/leases/${leaseId}.json`,
      operation: 'retire',
    },
    {
      path: `record/proofs/compliance/translation-validation/witnesses/${witnessId}.json`,
      operation: 'create',
    },
    {
      path: `record/proofs/compliance/translation-validation/results/${validationId}.json`,
      operation: 'create',
    },
    { path: `${prefix}${filename}`, operation: 'append' },
    { path: 'record/proofs/chain.json', operation: 'append' },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function embeddedTranslationWitness(
  value: unknown,
  recipeName: string,
  recipeVariant: string,
): unknown {
  if (
    !isRecord(value) ||
    value['recipe_name'] !== recipeName ||
    value['recipe_variant'] !== recipeVariant
  ) {
    return undefined;
  }
  if (value['status'] !== 'pass' && value['status'] !== 'review') return undefined;
  const evidence = value['evidence'];
  return isRecord(evidence) ? evidence['translation_witness'] : undefined;
}

export function resolveRecipeRecordPath(input: {
  readonly repo_root: string;
  readonly recipe_name: string;
  readonly recipe_variant: string;
  readonly witness_id: string;
}): string {
  const recipeName = requireId(input.recipe_name, RECIPE_NAME_PATTERN, 'recipe name');
  const recipeVariant = requireId(input.recipe_variant, RECIPE_VARIANT_PATTERN, 'recipe variant');
  const witnessId = requireId(input.witness_id, /^TW-[a-f0-9]{16}$/u, 'witness id');
  const relativeDirectory = recipeRunDirectory(recipeName, recipeVariant);
  const directory = resolve(input.repo_root, relativeDirectory);
  let names: string[];
  try {
    names = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    throw new Error('RECIPE_RECORD_NOT_FOUND');
  }
  const matches: string[] = [];
  for (const name of names) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/u.test(name) ||
      name.includes('..') ||
      name.includes('/') ||
      name.includes('\\')
    ) {
      continue;
    }
    try {
      const record = JSON.parse(readFileSync(resolve(directory, name), 'utf8')) as unknown;
      const witness = embeddedTranslationWitness(record, recipeName, recipeVariant);
      if (
        isRecord(witness) &&
        witness['id'] === witnessId &&
        witness['recipe_name'] === recipeName &&
        witness['recipe_variant'] === recipeVariant &&
        validators.translationWitness(witness)
      ) {
        matches.push(`${relativeDirectory}/${name}`);
      }
    } catch {
      // Invalid or unreadable records are not eligible matches.
    }
  }
  if (matches.length === 0) throw new Error('RECIPE_RECORD_NOT_FOUND');
  if (matches.length !== 1) throw new Error('RECIPE_RECORD_NOT_UNIQUE');
  return matches[0] as string;
}
