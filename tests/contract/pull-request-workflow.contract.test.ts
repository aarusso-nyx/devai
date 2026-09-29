// ADR-CHK-0003, Inspector Adversarial Acceptance IA-001 and IA-002 (workflow
// side): the pull-request workflow restores the check-runner bootstrap from a
// cache keyed by the digest of the TypeScript inputs it compiles, compiles
// only on a cache miss, runs the affected plan in one step (never from the
// release gate script), and carries no path filter a candidate could edit to
// suppress checks.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = resolve(import.meta.dirname, '../..');
const WORKFLOW = join(ROOT, '.github/workflows/pull-request-checks.yml');
const BOOTSTRAP_OUTPUT = '.devai/state/pr-bootstrap';
const PINNED_CACHE_ACTION = /^actions\/cache(?:\/restore)?@[0-9a-f]{40}$/u;
const BOOTSTRAP_COMPILE = /\brelease:bootstrap\b|scripts\/process\/bootstrap-check-runner\.mjs/u;
const BOOTSTRAP_CLI = /pr-bootstrap\/cli\/bin\.js/u;
const AFFECTED_CHECK = /(?:pr-bootstrap\/cli\/bin\.js|\bdevai)\s+check\b[^\n;&|]*\s--affected\b/gu;
const GATE_SCRIPT = join(ROOT, 'scripts/run-pr-release-gate.mjs');

type Step = Readonly<{
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Readonly<Record<string, unknown>>;
  env?: Readonly<Record<string, unknown>>;
}>;
type Workflow = Readonly<{
  on?: Readonly<Record<string, unknown>>;
  jobs?: Readonly<Record<string, Readonly<{ steps?: readonly Step[] }>>>;
}>;

const workflow = parse(readFileSync(WORKFLOW, 'utf8')) as Workflow;
const steps: readonly Step[] = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);

function cacheSteps(): readonly Step[] {
  return steps.filter(
    (step) =>
      typeof step.uses === 'string' &&
      /^actions\/cache\b/u.test(step.uses) &&
      String(step.with?.path ?? '').includes(BOOTSTRAP_OUTPUT),
  );
}

function stepText(step: Step): string {
  return [step.if ?? '', step.run ?? '', JSON.stringify(step.env ?? {})].join('\n');
}

describe('pull-request workflow shape (ADR-CHK-0003)', () => {
  it('carries no path filter on the pull_request trigger (IA-002)', () => {
    const trigger = (workflow.on?.pull_request ?? {}) as Readonly<Record<string, unknown>>;
    expect(Object.keys(trigger)).not.toContain('paths');
    expect(Object.keys(trigger)).not.toContain('paths-ignore');
  });

  it('restores the bootstrap output from a pinned cache step (IA-001)', () => {
    const caches = cacheSteps();
    expect(caches, `a cache step whose path holds ${BOOTSTRAP_OUTPUT}`).toHaveLength(1);
    expect(caches[0]?.uses ?? '').toMatch(PINNED_CACHE_ACTION);
    expect(caches[0]?.id, 'the cache step has an id its hit output is read by').toMatch(/\S/u);
  });

  it('keys the bootstrap cache by the digest of the TypeScript inputs', () => {
    const key = String(cacheSteps()[0]?.with?.key ?? '');
    expect(key, 'the cache key digests files').toMatch(/hashFiles\(/u);
    const hashed = [...key.matchAll(/hashFiles\(([^)]*)\)/gu)].map((match) => match[1] ?? '');
    expect(
      hashed.some((argument) => /\.ts\b|\.tsx?['"*]|tsconfig/u.test(argument)),
      `hashFiles covers TypeScript sources or tsconfig inputs: ${key}`,
    ).toBe(true);
  });

  it('restores the cache before the bootstrap is compiled or invoked', () => {
    const cacheIndex = steps.findIndex((step) => cacheSteps().includes(step));
    const firstUse = steps.findIndex((step) => {
      const run = step.run ?? '';
      return BOOTSTRAP_COMPILE.test(run) || BOOTSTRAP_CLI.test(run);
    });
    expect(cacheIndex, 'the cache step exists').toBeGreaterThanOrEqual(0);
    expect(firstUse, 'a step compiles or invokes the bootstrap').toBeGreaterThanOrEqual(0);
    expect(cacheIndex).toBeLessThan(firstUse);
  });

  it('compiles the bootstrap only on a cache miss', () => {
    const cacheId = cacheSteps()[0]?.id;
    expect(cacheId, 'the cache step has an id').toBeDefined();
    const compiling = steps.filter((step) => BOOTSTRAP_COMPILE.test(step.run ?? ''));
    expect(compiling, 'a step compiles the bootstrap').not.toEqual([]);
    const hitOutput = new RegExp(
      `steps\\.${String(cacheId).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\.outputs\\.cache-hit`,
      'u',
    );
    for (const step of compiling) {
      expect(stepText(step), `step "${step.name ?? ''}" is conditioned on the cache hit`).toMatch(
        hitOutput,
      );
    }
  });

  it('runs the affected plan in exactly one workflow step', () => {
    const affected = steps.filter((step) => [...(step.run ?? '').matchAll(AFFECTED_CHECK)].length);
    expect(
      affected.map((step) => step.name ?? step.id ?? ''),
      'workflow steps that run check --affected',
    ).toHaveLength(1);
    expect([...(affected[0]?.run ?? '').matchAll(AFFECTED_CHECK)]).toHaveLength(1);
  });

  it('leaves the affected plan out of the pull-request release gate script', () => {
    // The gate stays in the workflow for the commit range, the bump floor, and
    // the release-profile preflight; only its code, not its comments, is read.
    const code = readFileSync(GATE_SCRIPT, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/^\s*\/\/.*$/gmu, '');
    expect(code, 'the gate script invokes no --affected plan').not.toMatch(/--affected\b/u);
  });

  it('still runs the preflight probes', () => {
    const preflight = steps.filter((step) =>
      /(?:pr-bootstrap\/cli\/bin\.js|\bdevai)\s+check\b[^\n;&|]*\s--preflight\b/u.test(
        step.run ?? '',
      ),
    );
    expect(preflight).toHaveLength(1);
  });
});
