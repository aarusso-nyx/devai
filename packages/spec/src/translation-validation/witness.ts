import { createHash } from 'node:crypto';
import type { MutationAuthorityRole } from './path-authority.js';
import type { TranslationStrategy } from './frames.js';

export interface TranslationWitnessClaim {
  readonly task_id: string;
  readonly stage:
    | 'journey-to-invariants'
    | 'invariants-to-tests'
    | 'invariants-tests-to-code'
    | 'documentation'
    | 'refactor';
  readonly base_sha: string;
  readonly candidate_sha: string;
  readonly test_overlay_sha?: string;
  readonly strategy: TranslationStrategy;
  readonly implements: readonly unknown[];
  readonly red_green?: readonly unknown[];
  readonly touched: readonly string[];
  readonly frame: {
    readonly spec_edits: 'none' | 'declared';
    readonly test_edits: 'none' | 'declared';
    readonly inventory_delta_confined_to: readonly string[];
    readonly effects_claimed: readonly string[];
  };
  readonly notes?: readonly string[];
}

export function createTranslationWitness(input: {
  readonly recipe_name: string;
  readonly recipe_variant: string;
  readonly authority_role: MutationAuthorityRole;
  readonly emitted_at: string;
  readonly claim: TranslationWitnessClaim;
}): Readonly<Record<string, unknown>> {
  const id = createHash('sha256')
    .update(
      JSON.stringify({
        recipe_name: input.recipe_name,
        recipe_variant: input.recipe_variant,
        emitted_at: input.emitted_at,
        task_id: input.claim.task_id,
        base_sha: input.claim.base_sha,
        candidate_sha: input.claim.candidate_sha,
      }),
    )
    .digest('hex')
    .slice(0, 16);
  return {
    schemaVersion: '1.0.0',
    id: `TW-${id}`,
    trust: 'untrusted-claim',
    task_id: input.claim.task_id,
    recipe_name: input.recipe_name,
    recipe_variant: input.recipe_variant,
    stage: input.claim.stage,
    base_sha: input.claim.base_sha,
    candidate_sha: input.claim.candidate_sha,
    ...(input.claim.test_overlay_sha !== undefined && {
      test_overlay_sha: input.claim.test_overlay_sha,
    }),
    emitted_at: input.emitted_at,
    strategy: input.claim.strategy,
    implements: input.claim.implements,
    ...(input.claim.red_green !== undefined && { red_green: input.claim.red_green }),
    touched: input.claim.touched,
    frame: {
      authority_role: input.authority_role,
      spec_edits: input.claim.frame.spec_edits,
      test_edits: input.claim.frame.test_edits,
      inventory_delta_confined_to: input.claim.frame.inventory_delta_confined_to,
      effects_claimed: input.claim.frame.effects_claimed,
    },
    ...(input.claim.notes !== undefined && { notes: input.claim.notes }),
  };
}
