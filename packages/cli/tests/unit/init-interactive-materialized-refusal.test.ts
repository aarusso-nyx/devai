// RED (TASK-0182 / ADR-CFG-0001, IA-002): packages/cli/src/services/interactive-config.ts
// does not exist yet, so this file fails at the dynamic import below. It
// encodes docs/adopters/interactive-configuration.md#materialized-files-edit-mode-refuses:
// edit mode never re-materializes a file that `scripts/check-policy-materialization.mjs`
// pins byte-identical to `law/policy`, and "the refusal is a structured error,
// not a prompt to override."
//
// Assumption the Engineer must honor (see the task report for the complete
// list): selecting a materialized file's key in edit mode rejects the
// `runInteractiveInitPlan(...)` promise with an `Error` whose `.message` is
// the JSON-encoded structured error envelope (`law/schemas/error.schema.json`),
// matching the `cliError`/`renderCliError` convention already used by
// `packages/cli/src/commands/init/index.ts` (see `INIT_TARGET_PRECONDITION_UNSATISFIED`
// there for a precedent). The envelope's `message` offers `init bind` as the
// remediation path, and `context` names the refused file.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validators } from '@devai-nyx/schemas';

interface ScriptedIo {
  readonly ask: (prompt: string) => Promise<string>;
  readonly print: (text: string) => void;
}

interface RunInteractiveInitPlanInput {
  readonly repoRoot: string;
  readonly target: string;
  readonly tier: string;
  readonly mode: 'bind' | 'edit';
  readonly io: ScriptedIo;
}

interface RunInteractiveInitPlanResult {
  readonly argv: readonly (readonly string[])[];
  readonly plan: unknown;
  readonly executed: boolean;
}

interface InteractiveConfigModule {
  readonly runInteractiveInitPlan: (
    input: RunInteractiveInitPlanInput,
  ) => Promise<RunInteractiveInitPlanResult>;
}

async function loadInteractiveConfig(): Promise<InteractiveConfigModule> {
  const specifier = new URL('../../src/services/interactive-config.js', import.meta.url).href;
  return (await import(/* @vite-ignore */ specifier)) as InteractiveConfigModule;
}

function scriptedIo(answers: readonly string[]): ScriptedIo {
  const queue = [...answers];
  return {
    ask() {
      const next = queue.shift();
      if (next === undefined) throw new Error('SCRIPTED_IO_EXHAUSTED');
      return Promise.resolve(next);
    },
    print() {
      // Refusal transcripts are not asserted here; see
      // init-interactive-replay.test.ts for the printed-argv assertion.
    },
  };
}

const roots: string[] = [];

function put(root: string, path: string, value: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, value);
}

function fixture(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('init plan --interactive edit mode refuses materialized files', () => {
  it('refuses thresholds.json with a re-bind offer and leaves it unchanged', async () => {
    const target = fixture('devai-init-interactive-materialized-refusal-');
    const thresholdsPath = join(target, '.devai/config/thresholds.json');
    put(
      target,
      '.devai/config/thresholds.json',
      `${JSON.stringify({ schemaVersion: '1.0.0', fixture: 'adopter-managed-bytes' }, null, 2)}\n`,
    );
    put(
      target,
      '.devai/config/project.json',
      `${JSON.stringify(
        {
          schemaVersion: '1.0.0',
          project_type: 'platform-package',
          name: 'materialized-refusal-fixture',
          profile: 'tier1',
        },
        null,
        2,
      )}\n`,
    );
    const before = readFileSync(thresholdsPath, 'utf8');

    const module = await loadInteractiveConfig();
    const io = scriptedIo(['thresholds.json']);

    await expect(
      module.runInteractiveInitPlan({
        repoRoot: target,
        target,
        tier: 'tier1',
        mode: 'edit',
        io,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof Error)) return false;
      const envelope = JSON.parse(error.message) as Record<string, unknown>;
      if (!validators.error(envelope)) return false;
      if (typeof envelope['message'] !== 'string') return false;
      if (!envelope['message'].includes('init bind')) return false;
      if (!envelope['message'].includes('thresholds.json')) return false;
      const context = envelope['context'];
      if (typeof context !== 'object' || context === null) return false;
      return JSON.stringify(context).includes('thresholds.json');
    });

    expect(readFileSync(thresholdsPath, 'utf8')).toBe(before);
  });
});
