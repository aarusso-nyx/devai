import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// Invariants: INV-DEVAI-020

type Capability = 'fs:unknown-write' | 'db:unclassified' | `proc:${string}` | `net:${string}`;

interface ActionAnalysis {
  readonly capabilities: readonly Capability[];
  readonly unresolved_edges: readonly unknown[];
}

interface EffectReport {
  readonly actions: Readonly<Record<string, ActionAnalysis>>;
  readonly findings: readonly Readonly<{ code: string; action_id?: string }>[];
}

interface EffectsCheckApi {
  parseActionEffectsSource(source: string): Readonly<Record<string, string>>;
  validateDeclaredCapabilityConsistency(input: {
    readonly catalog: readonly string[];
    readonly contracts: readonly Readonly<{
      action_id: string;
      effect: string;
      capabilities?: readonly string[];
    }>[];
  }): void;
  analyzeEffectProgram(input: {
    readonly tsconfigPath: string;
    readonly catalog: readonly string[];
    readonly contracts: readonly Readonly<{
      action_id: string;
      effect: string;
      capabilities: readonly string[];
    }>[];
    readonly subprocessRegistry: Readonly<{ templates: readonly unknown[] }>;
  }): Promise<EffectReport>;
}

async function effectsApi(): Promise<EffectsCheckApi> {
  const url = pathToFileURL(resolve(import.meta.dirname, '../../src/index.ts')).href;
  return (await import(/* @vite-ignore */ url)) as EffectsCheckApi;
}

const fixtureRoot = resolve(import.meta.dirname, 'fixtures/adversarial');
const tsconfigPath = resolve(fixtureRoot, 'tsconfig.json');
const adversarialActions = [
  'fixture callback',
  'fixture factory',
  'fixture union',
  'fixture higher-order',
  'fixture method',
] as const;
const programActions = [...adversarialActions, 'fixture spawn'] as const;

function readContracts(actions: readonly string[]) {
  return actions.map((action_id) => ({
    action_id,
    effect: 'read',
    capabilities: [] as const,
  }));
}

describe('effect-inference contracts', () => {
  it('fails when statically extracted entries differ from the runtime catalog', async () => {
    const api = await effectsApi();
    await expect(
      api.analyzeEffectProgram({
        tsconfigPath,
        catalog: [...programActions, 'fixture catalog-only'],
        contracts: readContracts(programActions),
        subprocessRegistry: { templates: [] },
      }),
    ).rejects.toThrow(/EFFECT_EXTRACTOR_CATALOG_MISMATCH/u);
  });

  it('attributes a guarded seam export by its symbol declaration before @types/node signature', async () => {
    const api = await effectsApi();
    const report = await api.analyzeEffectProgram({
      tsconfigPath,
      catalog: programActions,
      contracts: readContracts(programActions),
      subprocessRegistry: { templates: [] },
    });
    expect(report.actions['fixture callback']?.capabilities).toContain('fs:unknown-write');
  });

  it('parses identifier keys and string-literal keys from ACTION_EFFECTS', async () => {
    const api = await effectsApi();
    expect(
      api.parseActionEffectsSource(
        "const ACTION_EFFECTS = { doctor: 'read', 'docs publish': 'remote-write' } as const;",
      ),
    ).toEqual({ doctor: 'read', 'docs publish': 'remote-write' });
  });

  it('reports an unregistered subprocess template without silently classifying it', async () => {
    const api = await effectsApi();
    const report = await api.analyzeEffectProgram({
      tsconfigPath,
      catalog: programActions,
      contracts: readContracts(programActions),
      subprocessRegistry: { templates: [] },
    });
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: 'SPAWN_EFFECT_UNDECLARED', action_id: 'fixture spawn' }),
    );
  });

  it('fails consistency when a catalogued action omits capabilities', async () => {
    const api = await effectsApi();
    expect(() =>
      api.validateDeclaredCapabilityConsistency({
        catalog: ['fixture missing'],
        contracts: [{ action_id: 'fixture missing', effect: 'read' }],
      }),
    ).toThrow(/EFFECT_CAPABILITIES_MISSING/u);
  });

  it.each(adversarialActions)(
    'conservatively reaches or dispositions %s dynamic dispatch',
    async (action) => {
      const api = await effectsApi();
      const report = await api.analyzeEffectProgram({
        tsconfigPath,
        catalog: programActions,
        contracts: readContracts(programActions),
        subprocessRegistry: { templates: [] },
      });
      expect(report.actions[action]?.capabilities).toContain('fs:unknown-write');
      expect(report.actions[action]?.unresolved_edges).toEqual([]);
    },
  );
});
