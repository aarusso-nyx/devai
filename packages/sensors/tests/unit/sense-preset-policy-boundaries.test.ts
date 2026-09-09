import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const POLICY_PATH = 'sense-presets.json';

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock('node:fs');
});

afterEach(() => {
  vi.doUnmock('node:fs');
});

describe('sense preset policy boundaries', () => {
  it('resolves every canonical preset and leaves an unknown name absent', async () => {
    const { SENSE_PRESET_POLICY, sensePreset } = await import('../../src/sense-presets.js');

    expect(SENSE_PRESET_POLICY).toMatchObject({
      schemaVersion: '1.0.0',
      id: 'sense-presets',
      registry: 'law/policy/sensor-registry.json',
      ordering: 'canonical-sensor-registry-order',
      implicit_persistence: 'forbidden',
    });
    expect(sensePreset('baseline')?.name).toBe('baseline');
    expect(sensePreset('structural')?.name).toBe('structural');
    expect(sensePreset('governed')?.name).toBe('governed');
    expect(sensePreset('sweep')?.name).toBe('sweep');
    expect(sensePreset('not-a-canonical-preset')).toBeUndefined();
  });

  it('rejects archive binding when no code-bound policy asset is available', async () => {
    const { assertBundledSensePresets } = await import('../../src/sense-presets.js');

    expect(() => assertBundledSensePresets(new TextEncoder().encode('{}'))).toThrow(
      'rpl-package-identity-mismatch',
    );
  });

  it('reports the exact development-policy-unavailable error', async () => {
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        existsSync: vi.fn((path: Parameters<typeof actual.existsSync>[0]) =>
          String(path).endsWith('/' + POLICY_PATH) ? false : actual.existsSync(path),
        ),
      };
    });

    await expect(import('../../src/sense-presets.js')).rejects.toThrow(
      'canonical sense preset policy is unavailable: package build is missing its staged law artifact',
    );
  });

  it('rejects a development policy that fails the sense-presets schema', async () => {
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        existsSync: vi.fn((path: Parameters<typeof actual.existsSync>[0]) =>
          String(path).endsWith('/' + POLICY_PATH) ? true : actual.existsSync(path),
        ),
        readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) =>
          String(args[0]).endsWith('/' + POLICY_PATH) ? '{}' : actual.readFileSync(...args),
        ),
      };
    });

    await expect(import('../../src/sense-presets.js')).rejects.toThrow(
      /^canonical sense preset policy is schema-invalid: /u,
    );
  });
});
