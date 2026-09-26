// RED (TASK-0182 / ADR-CFG-0001, IA-003): packages/cli/src/services/interactive-config.ts
// does not exist yet, so this file fails at the dynamic import below. It
// encodes docs/adopters/interactive-configuration.md#prompts-come-from-the-schemas:
// "An `enum` ... becomes a numbered selection. An answer outside the
// enumeration is rejected at the prompt with the schema's message; it never
// reaches apply time."
//
// Assumption the Engineer must honor (see the task report for the complete
// list): the profile prompt is the first schema-driven prompt in bind mode
// (mode itself is selected via the `mode` input, not prompted); an
// out-of-enumeration answer causes `io.ask` to be called again for the same
// logical prompt (the scripted answer queue is consumed in prompt order, so
// re-prompting shows up as one extra `ask` call), and `io.print` receives a
// rejection message naming every value in `law/schemas/project-config.schema.json`'s
// `profile` enum (`tier1`, `tier2`, `tier3`) before that next `ask` call.
// Declining write consent at the end must leave `executed: false` and perform
// no filesystem write, per the replay guarantee's "no write" clause -- this
// keeps the fixture from depending on a full bind materialization.

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getValidator } from '@devai-nyx/schemas';

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

function scriptedIo(answers: readonly string[], transcript: string[]): ScriptedIo {
  const queue = [...answers];
  return {
    ask(prompt: string) {
      transcript.push(`ask:${prompt}`);
      const next = queue.shift();
      if (next === undefined) throw new Error('SCRIPTED_IO_EXHAUSTED');
      return Promise.resolve(next);
    },
    print(text: string) {
      transcript.push(`print:${text}`);
    },
  };
}

const roots: string[] = [];

function fixture(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('init plan --interactive validates prompt answers against their schema', () => {
  it('confirms the fixture premise: tier4 is invalid and tier1 is valid for profile', () => {
    const validateProject = getValidator('project-config.schema.json');
    expect(
      validateProject({
        schemaVersion: '1.0.0',
        project_type: 'runtime-host',
        name: 'schema-prompt-fixture',
        profile: 'tier4',
      }),
    ).toBe(false);
    expect(
      validateProject({
        schemaVersion: '1.0.0',
        project_type: 'runtime-host',
        name: 'schema-prompt-fixture',
        profile: 'tier1',
      }),
    ).toBe(true);
  });

  it('rejects tier4 at the profile prompt with the schema enumeration before any plan is built, then accepts tier1', async () => {
    const target = fixture('devai-init-interactive-schema-prompts-');
    const module = await loadInteractiveConfig();
    const transcript: string[] = [];
    const answers = [
      'tier4', // rejected: outside the profile enum
      'tier1', // accepted on re-prompt
      'runtime-host',
      'application',
      'docusaurus',
      'none',
      'no',
      'architect',
      'no', // decline write consent: ends the session with a plan and no write
    ];
    const io = scriptedIo(answers, transcript);

    const session = await module.runInteractiveInitPlan({
      repoRoot: target,
      target,
      tier: 'tier1',
      mode: 'bind',
      io,
    });

    expect(session.executed).toBe(false);

    const askIndexes = transcript
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.startsWith('ask:'))
      .map(({ index }) => index);
    expect(askIndexes.length).toBeGreaterThanOrEqual(2);
    const [firstAskIndex, secondAskIndex] = askIndexes;
    if (firstAskIndex === undefined || secondAskIndex === undefined) {
      throw new Error('expected at least two ask() calls for the profile prompt and its retry');
    }

    const rejectionTranscriptIndex = transcript.findIndex(
      (line, index) =>
        index > firstAskIndex &&
        line.startsWith('print:') &&
        line.includes('tier1') &&
        line.includes('tier2') &&
        line.includes('tier3'),
    );
    // "before any plan is built": the rejection is emitted strictly between the
    // first ask() call (the invalid `tier4` answer) and the second ask() call
    // that resolves the corrected `tier1` answer.
    expect(rejectionTranscriptIndex).toBeGreaterThan(firstAskIndex);
    expect(rejectionTranscriptIndex).toBeLessThan(secondAskIndex);

    expect(readdirSync(target)).toEqual([]);
  });
});
