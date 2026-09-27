export type EffectCapability =
  'fs:unknown-write' | 'db:unclassified' | `proc:${string}` | `net:${string}`;

export interface EffectContract {
  readonly action_id: string;
  readonly effect: string;
  readonly capabilities?: readonly string[];
}

export interface EffectDisposition {
  readonly edge: string;
  readonly reason: string;
}

export interface ActionEffectAnalysis {
  readonly declared_effect: string;
  readonly declared_capabilities: readonly string[];
  readonly capabilities: readonly EffectCapability[];
  readonly unresolved_edges: readonly string[];
  readonly dispositions: readonly EffectDisposition[];
}

export interface EffectFinding {
  readonly code: string;
  readonly action_id?: string;
  readonly message: string;
}

export interface EffectReport {
  readonly actions: Readonly<Record<string, ActionEffectAnalysis>>;
  readonly findings: readonly EffectFinding[];
  readonly subprocess_templates: readonly Readonly<{
    executable: string;
    argv_shape: readonly string[];
    actions: readonly string[];
  }>[];
  readonly advisory_patterns: Readonly<{
    violations: number;
    dispositions: readonly EffectDisposition[];
  }>;
  readonly metrics: Readonly<{
    program_files: number;
    catalog_actions: number;
    extracted_actions: number;
    unresolved_edges: number;
    dispositioned_edges: number;
    duration_ms: number;
  }>;
}

export interface SubprocessTemplate {
  readonly executable?: unknown;
  readonly argv_shape?: unknown;
  readonly capabilities?: unknown;
}

export interface AnalysisInput {
  readonly tsconfigPath: string;
  readonly catalog: readonly string[];
  readonly contracts: readonly EffectContract[];
  readonly subprocessRegistry: Readonly<{ templates: readonly SubprocessTemplate[] }>;
}

export function validateDeclaredCapabilityConsistency(input: {
  readonly catalog: readonly string[];
  readonly contracts: readonly EffectContract[];
}): void {
  const byAction = new Map(input.contracts.map((contract) => [contract.action_id, contract]));
  for (const action of input.catalog) {
    const contract = byAction.get(action);
    if (contract === undefined) throw new Error(`${action}: EFFECT_CONTRACT_MISSING`);
    if (contract.capabilities === undefined)
      throw new Error(`${action}: EFFECT_CAPABILITIES_MISSING`);
  }
  const extras = input.contracts.filter((contract) => !input.catalog.includes(contract.action_id));
  if (extras.length > 0) throw new Error('EFFECT_CONTRACT_CATALOG_MISMATCH');
}
