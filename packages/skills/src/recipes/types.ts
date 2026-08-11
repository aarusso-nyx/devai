export const RECIPE_NAMES = [
  'devai-assess',
  'devai-plan',
  'devai-fix',
  'devai-docs',
  'devai-scaffold',
  'devai-verify',
  'devai-round',
] as const;

export type RecipeName = (typeof RECIPE_NAMES)[number];
export type RecipeStatus = 'stable' | 'preview';
export type RecipeEffect = 'read' | 'local-write' | 'runtime-write';

export type RecipeWritePolicy =
  | { readonly mode: 'none' }
  | {
      readonly mode: 'explicit-files' | 'bounded-patterns';
      readonly scopes: readonly string[];
    };

export interface RecipeVariant {
  readonly description: string;
  readonly effect: RecipeEffect;
  readonly write_policy: RecipeWritePolicy;
  readonly operations: readonly string[];
}

export interface RecipeManifest {
  readonly schemaVersion: '1';
  readonly name: RecipeName;
  readonly status: RecipeStatus;
  readonly description: string;
  readonly variants: Readonly<Record<string, RecipeVariant>>;
}

export interface LoadedRecipe {
  readonly manifest: RecipeManifest;
  readonly skill_markdown: string;
  readonly resource_dir: string;
}
