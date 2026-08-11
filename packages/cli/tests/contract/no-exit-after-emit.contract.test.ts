import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Contract test pinning the stdout-truncation convention (D-109
 * follow-up). process.exit() immediately after a large stdout write
 * races the async pipe drain and truncates output at the 64KB pipe
 * buffer for spawned consumers. Success paths in command actions must
 * therefore set process.exitCode and let the event loop drain.
 *
 * Files in EXEMPT keep explicit process.exit() because their commands
 * may hold open handles (DB pools, LLM/network sockets) that would
 * otherwise keep the process alive after the action returns. Their
 * payloads must stay small or flush before exiting; widening an
 * exemption requires editing this list deliberately.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const COMMANDS_ROOT = join(HERE, '..', '..', 'src', 'commands');

const EXEMPT: readonly string[] = [
  'llm/index.ts', // LLM/network client sockets
  'loop/index.ts', // Postgres pools, advisory locks
  'loop-run/index.ts', // DB + LLM orchestrator
  'phase6/index.ts', // tie-break ladder may hold LLM sockets
  // The whole sense/ family routes through finishSenseCommand and may
  // be LLM/network-backed (judge, runtime probes); revisit if a
  // deterministic sensor's reading ever exceeds the pipe buffer.
  'sense/',
];

function walk(dir: string, acc: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith('.ts')) acc.push(p);
  }
}

describe('success-path exit convention (no exit-after-emit truncation)', () => {
  it('no non-exempt command file calls process.exit(EXIT_PASS)', () => {
    const files: string[] = [];
    walk(COMMANDS_ROOT, files);
    expect(files.length).toBeGreaterThan(40);
    const offenders: string[] = [];
    for (const f of files) {
      const rel = relative(COMMANDS_ROOT, f);
      if (EXEMPT.some((e) => rel === e || rel.startsWith(e))) continue;
      const body = readFileSync(f, 'utf8');
      if (body.includes('process.exit(EXIT_PASS)')) offenders.push(rel);
    }
    expect(
      offenders,
      `success paths must use process.exitCode (truncation class, D-109); offenders: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
// Invariants: INV-DEVAI-001
