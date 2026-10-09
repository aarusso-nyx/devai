// #391: the packaged toolchain defaults that pin the generated workflows' actions refuse to
// load with the declared code. A truncated or non-JSON file, or a top level that is not an
// object, raises CI_SCAFFOLD_ACTION_PINS_INVALID rather than a raw SyntaxError or TypeError;
// an absent file still raises CI_SCAFFOLD_ACTION_PINS_MISSING; the shipped file loads.
import { readFileSync as realReadFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');
const SHIPPED = realReadFileSync(join(ROOT, 'law/policy/adopter-defaults/toolchain.json'), 'utf8');
const TOOLCHAIN = 'law/policy/adopter-defaults/toolchain.json';

const files = vi.hoisted(() => ({ toolchain: undefined as string | undefined }));

vi.mock('@devai-nyx/authority', async (importOriginal) => {
  const original = await importOriginal<typeof import('@devai-nyx/authority')>();
  const isToolchain = (path: unknown): boolean =>
    String(path).replaceAll('\\', '/').endsWith(TOOLCHAIN);
  return {
    ...original,
    existsSync: (path: Parameters<typeof original.existsSync>[0]) =>
      isToolchain(path) ? files.toolchain !== undefined : original.existsSync(path),
    readFileSync: ((path: unknown, ...rest: unknown[]) => {
      if (!isToolchain(path)) {
        return (original.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
      }
      if (files.toolchain === undefined) throw new Error(`ENOENT: ${String(path)}`);
      return files.toolchain;
    }) as typeof original.readFileSync,
  };
});

async function load() {
  vi.resetModules();
  return import('../../src/services/ci-scaffold/action-pins.js');
}

function thrown(callback: () => unknown): unknown {
  try {
    callback();
  } catch (error) {
    return error;
  }
  return undefined;
}

beforeEach(() => {
  files.toolchain = SHIPPED;
});

afterEach(() => {
  vi.resetModules();
});

describe('ci-scaffold action pins from the packaged toolchain defaults (#391)', () => {
  it('loads the shipped defaults', async () => {
    const { getActionPins } = await load();
    const pins = getActionPins();
    expect(pins.checkout.digest).toMatch(/^[0-9a-f]{40}$/u);
    expect(pins.setupNode.digest).toMatch(/^[0-9a-f]{40}$/u);
    expect(pins.uploadArtifact.digest).toMatch(/^[0-9a-f]{40}$/u);
  });

  it.each([
    ['a truncated file', SHIPPED.slice(0, Math.floor(SHIPPED.length / 2))],
    ['non-JSON text', 'actions: checkout\n'],
    ['an empty file', ''],
    ['a top-level array', '[]'],
    ['a top-level string', '"actions"'],
    ['a top-level number', '42'],
    ['a top-level null', 'null'],
  ])('raises CI_SCAFFOLD_ACTION_PINS_INVALID for %s', async (_label, text) => {
    files.toolchain = text;
    const { getActionPins, actionPinDigestIfPresent } = await load();
    const error = thrown(() => getActionPins());
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SyntaxError);
    expect(error).not.toBeInstanceOf(TypeError);
    expect((error as Error).message).toMatch(/^CI_SCAFFOLD_ACTION_PINS_INVALID\b/u);
    // The informational export only tolerates absence, never a broken file.
    expect(() => actionPinDigestIfPresent('checkout')).toThrow(/CI_SCAFFOLD_ACTION_PINS_INVALID/u);
  });

  it('still raises CI_SCAFFOLD_ACTION_PINS_MISSING when the packaged file is absent', async () => {
    files.toolchain = undefined;
    const { getActionPins, actionPinDigestIfPresent } = await load();
    expect(() => getActionPins()).toThrow('CI_SCAFFOLD_ACTION_PINS_MISSING');
    expect(actionPinDigestIfPresent('checkout')).toBe('');
  });

  it('keeps refusing an object whose action pin is malformed', async () => {
    files.toolchain = JSON.stringify({ actions: { 'actions/checkout': { ref: 'main' } } });
    const { getActionPins } = await load();
    expect(() => getActionPins()).toThrow(/^CI_SCAFFOLD_ACTION_PINS_INVALID/u);
  });
});
