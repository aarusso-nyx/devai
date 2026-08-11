import { minimatch } from 'minimatch';
import type { LoadedRecipe, RecipeManifest } from '../recipes/types.js';

const STATIC_AUTHORITY_PATHS = [
  'law/**',
  'product/**',
  '.devai/config/**',
  '.devai/pin/**',
  '.devai/local/rounds/**',
  'record/**',
] as const;

export interface PromptFirewallFinding {
  readonly code: 'RECIPE_READ_VARIANT_WRITES' | 'RECIPE_STATIC_AUTHORITY_WRITE';
  readonly severity: 'error' | 'critical';
  readonly recipe: string;
  readonly variant: string;
  readonly offending_scope: string;
  readonly message: string;
}

export interface PromptFirewallVerdict {
  readonly ok: boolean;
  readonly manifests_checked: number;
  readonly findings: readonly PromptFirewallFinding[];
}

type RecipeInput = RecipeManifest | LoadedRecipe;

function manifestOf(input: RecipeInput): RecipeManifest {
  return 'manifest' in input ? input.manifest : input;
}

function intersectsStaticAuthority(scope: string): boolean {
  const probes = [
    'law/policy/action-registry.json',
    'product/specification.md',
    '.devai/config/project.json',
    '.devai/local/rounds/R-1000/plan.json',
    '.devai/local/rounds/R-1000/audit/report.json',
    'record/proofs/evidence.json',
  ];
  return (
    probes.some((probe) => minimatch(probe, scope, { dot: true })) ||
    STATIC_AUTHORITY_PATHS.some((reserved) => scope === reserved)
  );
}

export function checkPromptOverlays(options: {
  readonly manifests: readonly RecipeInput[];
}): PromptFirewallVerdict {
  const findings: PromptFirewallFinding[] = [];
  for (const input of options.manifests) {
    const manifest = manifestOf(input);
    for (const [variantName, variant] of Object.entries(manifest.variants)) {
      const scopes = variant.write_policy.mode === 'none' ? [] : variant.write_policy.scopes;
      if (variant.effect === 'read' && scopes.length > 0) {
        for (const scope of scopes) {
          findings.push({
            code: 'RECIPE_READ_VARIANT_WRITES',
            severity: 'error',
            recipe: manifest.name,
            variant: variantName,
            offending_scope: scope,
            message: `read variant '${manifest.name}/${variantName}' declares '${scope}'`,
          });
        }
      }
      for (const scope of scopes.filter(intersectsStaticAuthority)) {
        findings.push({
          code: 'RECIPE_STATIC_AUTHORITY_WRITE',
          severity: 'critical',
          recipe: manifest.name,
          variant: variantName,
          offending_scope: scope,
          message: `recipe variant '${manifest.name}/${variantName}' crosses static authority at '${scope}'`,
        });
      }
    }
  }
  return Object.freeze({
    ok: findings.length === 0,
    manifests_checked: options.manifests.length,
    findings: Object.freeze(findings),
  });
}
