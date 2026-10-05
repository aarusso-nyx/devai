// ADR-MDL-0007 at the front door: round dispatch deactivate and round dispatch dispose are
// Owner-only and need --write and --experimental; deactivation leaves an audit record;
// round dispatch refuses a selection whose dependency closure the activation does not
// admit, and names every task whose uncertain work needs a disposition.
import { runWithAuthorityHostEffects, type AuthorityHostEffectScope } from '@devai-nyx/authority';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync as nodeWriteSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cac } from 'cac';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createIssuer,
  runtimeApi,
} from '../../../authority/tests/unit/authority-runtime-testkit.js';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import {
  EXPERIMENTAL_ACTIVATION_RECORD,
  EXPERIMENTAL_WITHDRAWALS_DIR,
  loadTask,
  readExperimentalActivation,
  saveTask,
  writeExperimentalActivation,
  type ExperimentalActivation,
  type TaskRecord,
} from '@devai-nyx/loop';
import { composeAgentPrompt } from '@devai-nyx/skills';
import { declaredRoleConsentRefusal } from '../../src/authority/authority-declarations.js';
import { canonicalRegistry } from '../../src/define-command.js';
import { roundDispatch } from '../../src/commands/round/dispatch-agents.js';
import { roundDispatchDeactivate } from '../../src/commands/round/dispatch-deactivate.js';
import { roundDispatchDispose } from '../../src/commands/round/dispatch-dispose.js';
import type { CommandDefinition } from '../../src/define-command.js';

const ROUND = 'R-0012';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const entries = canonicalRegistry();
const entry = (name: string) => {
  const found = entries.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`missing ${name}`);
  return found;
};
const code = (result: { readonly stdout: string; readonly stderr: string } | undefined) => {
  if (result === undefined) return undefined;
  const parsed = JSON.parse(result.stderr || result.stdout || '{}') as {
    readonly code?: string;
    readonly error?: { readonly code?: string };
  };
  return parsed.error?.code ?? parsed.code;
};

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-dispatch-recovery-'));
  roots.push(root);
  mkdirSync(join(root, 'work/rounds', ROUND), { recursive: true });
  writeFileSync(join(root, 'work/rounds', ROUND, 'AUTHORIZATION.md'), 'status: active\nGRANTED\n');
  writeFileSync(join(root, 'AGENTS.md'), '# Fixture adopter\n');
  return root;
}

function activation(): ExperimentalActivation {
  const now = Date.now();
  return {
    schemaVersion: '1.0.0',
    id: 'experimental-activation',
    authority: 'Owner',
    issued_at: new Date(now - 60_000).toISOString(),
    expires_at: new Date(now + 7 * 24 * 3_600_000).toISOString(),
    runtimes: [{ runtime: 'claude-cli', models: ['sonnet'], efforts: ['high'] }],
    disciplines: ['engineer', 'inspector'],
    budgets: {
      attempts_per_task: 4,
      attempts_per_invocation: 8,
      attempt_wall_clock_minutes: 30,
      tokens_per_invocation: 1_000_000,
    },
  };
}

function task(root: string, id: string, overrides: Record<string, unknown> = {}): TaskRecord {
  const draft = {
    schemaVersion: '2.0.0',
    id,
    round_id: ROUND,
    status: 'ready',
    discipline: 'engineer',
    title: `Implement ${id}`,
    target_modules: [`MOD-${id}`],
    target_substrates: ['F2'],
    created_at: '2026-10-04T00:00:00.000Z',
    db_isolation: 'database',
    iteration_count: 0,
    executor: {
      kind: 'agent',
      runtime: 'claude-cli',
      model: 'sonnet',
      effort: 'high',
      selection: { mode: 'exact', registry_id: 'claude-cli' },
      prompt_composition_id: 'PC-0000000000000000',
      max_iterations: 4,
      capabilities: ['repository-context'],
      // ADR-MDL-0005 D-8: the recipe is the prompt's payload layer, so it is required.
      recipe_name: 'devai-fix',
    },
    ...overrides,
  } as TaskRecord;
  if (draft.executor.kind !== 'agent') return draft;
  const id16 = composeAgentPrompt({ repoRoot: root, task: draft }).composition.id;
  return { ...draft, executor: { ...draft.executor, prompt_composition_id: id16 } } as TaskRecord;
}

async function invoke(command: CommandDefinition, name: string, args: readonly string[]) {
  const program = cac('devai-dispatch-recovery');
  command.register(program);
  let stdout = '';
  let stderr = '';
  const original = { out: process.stdout.write, err: process.stderr.write, code: process.exitCode };
  process.stdout.write = ((chunk: unknown) => (
    (stdout += String(chunk)),
    true
  )) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => (
    (stderr += String(chunk)),
    true
  )) as typeof process.stderr.write;
  process.exitCode = undefined;
  try {
    program.parse(['node', 'devai', name, ...args], { run: false });
    await withAuthorityHostTestScope(() => program.runMatchedCommand());
    return { exit: process.exitCode ?? 0, stdout, stderr };
  } finally {
    process.stdout.write = original.out;
    process.stderr.write = original.err;
    process.exitCode = original.code;
  }
}

describe('Owner-only experimental consent for the recovery actions', () => {
  it.each(['round dispatch deactivate', 'round dispatch dispose'])(
    '%s admits only the Owner with both --write and --experimental',
    (name) => {
      const registered = entry(name);
      expect(registered.authority_contract.consent).toEqual({
        write: true,
        allow_publish: false,
        experimental: true,
      });
      const argv = (...flags: string[]) => [...name.split(' '), ...flags, '--format', 'json'];
      const refusal = (flags: string[], role: string) =>
        code(declaredRoleConsentRefusal(argv(...flags), registered, role, undefined, 'json', role));
      expect(refusal(['--write', '--experimental'], 'owner')).toBeUndefined();
      expect(refusal(['--write'], 'owner')).toBe('AUTHORITY_EXPERIMENTAL_CONSENT_REQUIRED');
      expect(refusal(['--experimental'], 'owner')).toBe('AUTHORITY_WRITE_CONSENT_REQUIRED');
      for (const role of ['architect', 'inspector', 'engineer', 'auditor']) {
        expect(refusal(['--write', '--experimental'], role)).toBe('AUTHORITY_HUMAN_ROLE_DENIED');
      }
    },
  );
});

describe('round dispatch deactivate', () => {
  it('withdraws the activation with an audit record and returns dispatch to refusal', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      writeExperimentalActivation(root, activation());
    });
    const recordBytes = readFileSync(join(root, EXPERIMENTAL_ACTIVATION_RECORD));
    const result = await invoke(roundDispatchDeactivate, 'round-dispatch-deactivate', [
      '--repo-root',
      root,
      '--note',
      'probe finished',
    ]);
    expect(result.exit).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      deactivated: true,
      role: 'owner',
      was_in_force: true,
      note: 'probe finished',
    });
    expect(existsSync(join(root, EXPERIMENTAL_ACTIVATION_RECORD))).toBe(false);
    const [withdrawal] = readdirSync(join(root, EXPERIMENTAL_WITHDRAWALS_DIR));
    const record = JSON.parse(
      readFileSync(join(root, EXPERIMENTAL_WITHDRAWALS_DIR, withdrawal ?? ''), 'utf8'),
    ) as Record<string, unknown>;
    expect(record['record_sha256']).toMatch(/^[a-f0-9]{64}$/u);
    expect(record['record_sha256']).toBe(
      (await import('node:crypto')).createHash('sha256').update(recordBytes).digest('hex'),
    );
    expect(readExperimentalActivation(root, new Date())).toEqual({
      ok: false,
      code: 'EXPERIMENTAL_ACTIVATION_MISSING',
    });
    const again = await invoke(roundDispatchDeactivate, 'round-dispatch-deactivate', [
      '--repo-root',
      root,
    ]);
    expect(again.exit).not.toBe(0);
    expect(JSON.parse(again.stderr)).toMatchObject({ code: 'EXPERIMENTAL_ACTIVATION_MISSING' });
  });

  it('writes a complete activation even when every write is short', async () => {
    const root = repository();
    const issuer = createIssuer(await runtimeApi(), { invocation_id: 'short-writes' });
    const scope: AuthorityHostEffectScope = {
      action_id: 'round dispatch activate',
      invocation_id: 'short-writes',
      effect: 'local-write',
      receipt_store: issuer,
      apply_effect: (request, apply) => {
        if (request.symbol !== 'writeSync') return apply();
        const [fd, buffer, offset, length] = request.arguments as [number, Buffer, number, number];
        return nodeWriteSync(fd, buffer, offset, Math.min(length, 7));
      },
    };
    try {
      await runWithAuthorityHostEffects(scope, async () => {
        writeExperimentalActivation(root, activation());
      });
    } finally {
      issuer.dispose();
    }
    expect(readExperimentalActivation(root, new Date())).toMatchObject({ ok: true });
  });
});

describe('round dispatch dispose arguments', () => {
  it.each([
    [[], 'DISPOSITION_TASK_REQUIRED'],
    [['--task', 'TASK-0301'], 'DISPOSITION_INVALID'],
    [['--task', 'TASK-0301', '--as', 'replay'], 'DISPOSITION_INVALID'],
    [['--quarantine-journal', '--task', 'TASK-0301'], 'DISPOSITION_ARGUMENTS_CONFLICT'],
    [['--quarantine-journal'], 'TASK_DISPATCH_JOURNAL_MISSING'],
  ])('refuses %j with %s', async (args, expected) => {
    const root = repository();
    const result = await invoke(roundDispatchDispose, 'round-dispatch-dispose', [
      '--repo-root',
      root,
      '--round',
      ROUND,
      ...args,
    ]);
    expect(result.exit).not.toBe(0);
    expect(JSON.parse(result.stderr)).toMatchObject({ code: expected });
  });
});

describe('round dispatch preflight', () => {
  it('refuses a selection whose dependency closure holds a task the activation does not admit, before any lock', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      writeExperimentalActivation(root, activation());
      saveTask(
        root,
        task(root, 'TASK-0310', {
          executor: {
            kind: 'human',
            role: 'engineer',
            instructions_ref: 'docs/fixture.md',
            timeout_ms: 3_600_000,
            timeout_behavior: 'escalate',
            completion_evidence: ['merged pull request'],
          },
        }),
      );
      saveTask(root, task(root, 'TASK-0311', { upstream_task_id: 'TASK-0310' }));
    });
    const result = await invoke(roundDispatch, 'round-dispatch', [
      '--repo-root',
      root,
      '--round',
      ROUND,
      '--task',
      'TASK-0311',
    ]);
    expect(result.exit).not.toBe(0);
    expect(JSON.parse(result.stderr)).toMatchObject({ code: 'EXPERIMENTAL_TASK_NOT_AGENT' });
    expect(loadTask(root, 'TASK-0310').status).toBe('ready');
    expect(loadTask(root, 'TASK-0311').status).toBe('ready');
    expect(existsSync(join(root, '.devai/state/locks'))).toBe(false);
  });

  it('names every task whose uncertain work needs a disposition', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      writeExperimentalActivation(root, activation());
      saveTask(root, task(root, 'TASK-0312', { status: 'in_progress' }));
      saveTask(root, task(root, 'TASK-0313'));
    });
    const result = await invoke(roundDispatch, 'round-dispatch', [
      '--repo-root',
      root,
      '--round',
      ROUND,
    ]);
    expect(result.exit).not.toBe(0);
    expect(JSON.parse(result.stderr)).toEqual({
      code: 'TASK_DISPATCH_UNCERTAIN',
      operation: 'dispatch',
      exit: 2,
      uncertain: [{ task_id: 'TASK-0312', attempt: null, last_event: null }],
    });
    expect(loadTask(root, 'TASK-0313').status).toBe('ready');
  });
});
