// RED (TASK-0182 / ADR-CFG-0001, IA-001): packages/cli/src/services/interactive-config.ts
// does not exist yet, so this file fails at the dynamic import below. It encodes
// the replay guarantee from docs/adopters/interactive-configuration.md: a
// completed bind session performs every write through the existing `init bind`
// / `init apply` actions, and printing the exact non-interactive argv it ran
// means replaying that argv in a second target reproduces the same tree.
//
// Assumptions the Engineer must honor (see the task report for the complete
// list): `packages/cli/src/services/interactive-config.ts` exports
// `runInteractiveInitPlan(input)` returning `{ argv, plan, executed }`, where
// `argv` is a readonly array of readonly string arrays -- each entry the exact
// CLI token list passed after `devai` for one `init-bind` / `init-apply-<seg>`
// invocation (e.g. `['init-bind', '--target', target, '--write']`), in
// execution order. `io.ask(prompt)` resolves the next scripted answer in
// prompt order; `io.print(text)` receives the human-readable status stream
// (plan diff, then the printed argv). Declining write consent must not be
// exercised here (see init-interactive-schema-prompts.test.ts); this file
// always answers "yes".

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { CAC } from '../../node_modules/cac/dist/index.d.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  initApplyArchitect,
  initApplyHarness,
  initApplyOwner,
  initBind,
} from '../../src/commands/init/index.js';

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};

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

function fixture(prefix: string, git = true): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  if (git) {
    if (spawnSync('git', ['init', '--quiet'], { cwd: root }).status !== 0) {
      throw new Error('test git init failed');
    }
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const COMMAND_BY_NAME: Readonly<Record<string, { register(cli: CAC): void }>> = {
  'init-bind': initBind,
  'init-apply-owner': initApplyOwner,
  'init-apply-architect': initApplyArchitect,
  'init-apply-harness': initApplyHarness,
};

async function invoke(
  definition: { register(cli: CAC): void },
  argv: readonly string[],
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const cli = cac('devai-init-interactive-replay');
  definition.register(cli);
  const originalArgv = process.argv;
  const originalExit = process.exit;
  const originalExitCode = process.exitCode;
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let stdout = '';
  let stderr = '';
  try {
    process.argv = ['node', 'devai', ...argv];
    process.exitCode = undefined;
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    process.exit = ((code?: string | number | null) => {
      process.exitCode = typeof code === 'number' ? code : 0;
      throw new Error(`TEST_PROCESS_EXIT:${String(process.exitCode)}`);
    }) as typeof process.exit;
    cli.parse(process.argv, { run: false });
    try {
      await withAuthorityHostTestScope(() => cli.runMatchedCommand());
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('TEST_PROCESS_EXIT:')) throw error;
    }
    await new Promise<void>((done) => setImmediate(done));
    return { exit: process.exitCode ?? 0, stdout, stderr };
  } finally {
    process.argv = originalArgv;
    process.exit = originalExit;
    process.exitCode = originalExitCode;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

async function replayArgv(argv: readonly (readonly string[])[]): Promise<void> {
  for (const tokens of argv) {
    const [name] = tokens;
    const definition = name === undefined ? undefined : COMMAND_BY_NAME[name];
    if (definition === undefined) {
      throw new Error(`REPLAY_ARGV_UNKNOWN_COMMAND: ${JSON.stringify(tokens)}`);
    }
    const result = await invoke(definition, tokens);
    expect(result.exit, `${tokens.join(' ')} failed: ${result.stderr}`).toBe(0);
  }
}

/** Every regular file below `root`, excluding `.git`, keyed by its sha256. */
function treeDigest(root: string): Record<string, string> {
  const digest: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!statSync(absolute).isFile()) continue;
      const relativePath = relative(root, absolute).split(sep).join('/');
      digest[relativePath] = createHash('sha256').update(readFileSync(absolute)).digest('hex');
    }
  };
  walk(root);
  return digest;
}

describe('init plan --interactive replay (bind mode)', () => {
  it('traces every write to a printed init bind/apply invocation that reproduces the same tree', async () => {
    const target = fixture('devai-init-interactive-replay-');
    const module = await loadInteractiveConfig();
    const transcript: string[] = [];
    const answers = [
      // Answered only if the contract's "chosen at the first prompt" mode
      // selection is itself a schema-driven prompt rather than the `mode`
      // input; ignored (left in the queue) otherwise.
      'bind',
      'tier1', // profile
      'runtime-host', // project_type
      'application', // repo.kind
      'docusaurus', // docs.builder
      'none', // includes: no optional components
      'no', // governance_tracking opt-in: off by default
      'architect', // role declaration
      'yes', // write consent
    ];
    const io = scriptedIo(answers, transcript);

    const session = await withAuthorityHostTestScope(() =>
      module.runInteractiveInitPlan({
        repoRoot: target,
        target,
        tier: 'tier1',
        mode: 'bind',
        io,
      }),
    );

    expect(session.executed).toBe(true);
    expect(Array.isArray(session.argv)).toBe(true);
    expect(session.argv.length).toBeGreaterThan(0);
    for (const tokens of session.argv) {
      expect(tokens[0]).toMatch(/^init-(bind|apply-(owner|architect|harness))$/u);
    }

    // Replay guarantee item 4: the flow prints the exact argv it executed.
    const printed = transcript
      .filter((line) => line.startsWith('print:'))
      .map((line) => line.slice('print:'.length))
      .join('\n');
    for (const tokens of session.argv) {
      expect(printed).toContain(tokens.join(' '));
    }

    const replayTarget = fixture('devai-init-interactive-replay-target-');
    await replayArgv(
      session.argv.map((tokens) =>
        tokens.map((token) => (token === target ? replayTarget : token)),
      ),
    );

    expect(treeDigest(replayTarget)).toEqual(treeDigest(target));
  });
});
