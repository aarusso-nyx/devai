import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// Invariants: INV-DEVAI-020

describe('binding effect-check contracts', () => {
  async function enforce(report: {
    readonly findings: readonly Readonly<{
      code: string;
      action_id?: string;
      message: string;
    }>[];
  }): Promise<void> {
    const url = pathToFileURL(resolve(import.meta.dirname, '../../src/index.ts')).href;
    const api = (await import(/* @vite-ignore */ url)) as Readonly<{
      enforceEffectReport?: (input: typeof report) => void;
    }>;
    if (api.enforceEffectReport === undefined) throw new Error('EFFECT_BINDING_GATE_MISSING');
    api.enforceEffectReport(report);
  }

  it('fails closed when an inferred effect is under-declared', async () => {
    await expect(
      enforce({
        findings: [
          {
            code: 'EFFECT_UNDER_DECLARED',
            action_id: 'fixture under-declared',
            message: 'fs:workspace is inferred but absent from the declaration',
          },
        ],
      }),
    ).rejects.toThrow(/EFFECT_UNDER_DECLARED/u);
  });

  it('fails closed on an unregistered subprocess or undispositioned edge', async () => {
    for (const code of ['SPAWN_EFFECT_UNDECLARED', 'EFFECT_EDGE_UNRESOLVED']) {
      await expect(
        enforce({
          findings: [{ code, action_id: 'fixture bypass', message: code }],
        }),
      ).rejects.toThrow(new RegExp(code, 'u'));
    }
  });

  it('does not fail on over-declaration alone', async () => {
    await expect(
      enforce({
        findings: [
          {
            code: 'EFFECT_OVER_DECLARED',
            action_id: 'fixture conservative',
            message: 'declaration is conservative',
          },
        ],
      }),
    ).resolves.toBeUndefined();
  });
});
