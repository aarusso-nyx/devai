import type { RecipeEffect, RecipeName, RecipeVariant } from '../recipes/types.js';

export const OPERATION_IDS = [
  'check.inspect',
  'sense.inventory',
  'init.plan',
  'round.assess',
  'evidence.verify',
  'check.lint',
  'check.build',
  'check.test',
  'scaffold.db',
  'scaffold.api',
  'scaffold.ui',
  'scaffold.tests',
  'scaffold.docs',
  'scaffold.ci',
  'scaffold.tests-from-docs',
  'check.typecheck',
  'check.coverage',
  'round.plan.preview',
  'round.run.preview',
  'round.close.preview',
] as const;

export type OperationId = (typeof OPERATION_IDS)[number];

export interface OperationDefinition {
  readonly id: OperationId;
  readonly description: string;
  readonly effect: RecipeEffect;
  readonly execution: 'host-command' | 'host-scaffolder' | 'host-materializer';
  readonly argv?: readonly string[];
}

export interface OperationInvocation {
  readonly recipe: RecipeName;
  readonly variant: string;
  readonly operation: OperationId;
  readonly repo_root: string;
  readonly write_paths?: readonly string[];
  readonly inputs?: Readonly<Record<string, unknown>>;
}

export interface OperationHostRequest extends OperationInvocation {
  readonly definition: OperationDefinition;
  readonly variant_contract: RecipeVariant;
}

export interface OperationResult {
  readonly operation: OperationId;
  readonly status: 'pass' | 'fail' | 'review' | 'skipped';
  readonly evidence?: unknown;
}

export interface OperationHost {
  execute(request: OperationHostRequest): OperationResult | Promise<OperationResult>;
}

export interface OperationCommandRunner {
  run(request: {
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly effect: RecipeEffect;
    readonly write_paths: readonly string[];
  }): OperationResult | Promise<OperationResult>;
}
