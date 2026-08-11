// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalArgv = [...process.argv];
const originalExitCode = process.exitCode;
const originalWrite = process.stdout.write;

afterEach(() => {
  process.argv = [...originalArgv];
  process.exitCode = originalExitCode;
  process.stdout.write = originalWrite;
});

const DEFAULT_DOMAINS = [
  'init',
  'doctor',
  'check',
  'sense',
  'round',
  'evidence',
  'release',
] as const;

async function rootHelp(flag = '--help'): Promise<string> {
  vi.resetModules();
  let stdout = '';
  process.argv = ['node', 'devai', flag];
  process.exitCode = undefined;
  process.stdout.write = ((chunk: unknown) => {
    stdout += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  }) as typeof process.stdout.write;

  await import('../../src/bin.js');
  expect(process.exitCode).toBe(0);
  return stdout;
}

function helpDomains(help: string): readonly string[] {
  const lines = help.split('\n');
  const start = lines.indexOf('Domains:');
  const end = lines.indexOf('Options:', start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return lines.slice(start + 1, end).flatMap((line) => {
    const match = line.match(/^\s{2}([a-z][a-z0-9-]*)\s{2,}/u);
    return match?.[1] === undefined ? [] : [match[1]];
  });
}

describe('public CLI bootstrap', () => {
  it('renders exactly seven porcelain domains in default root help', async () => {
    const help = await rootHelp();
    expect(help).toContain('Usage: devai <command> [options]');
    expect(helpDomains(help)).toEqual(DEFAULT_DOMAINS);
    expect(helpDomains(help)).not.toContain('task');
    expect(helpDomains(help)).not.toContain('catalog');
  }, 15_000);

  it('--all exposes only task and catalog as expanded plumbing', async () => {
    const help = await rootHelp('--all');
    expect(helpDomains(help)).toEqual([...DEFAULT_DOMAINS, 'task', 'catalog']);
  }, 15_000);
});
