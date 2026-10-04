// Fake claude/codex CLI for ADR-MDL-0005 adapter tests. It never contacts a provider.
// FAKE_AGENT_SCENARIO selects the scripted stream; stdin (the prompt) is recorded in cwd.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const scenario = process.argv[2] ?? process.env.FAKE_AGENT_SCENARIO ?? 'claude-success';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
if (process.env.FAKE_AGENT_PROMPT_FILE)
  writeFileSync(process.env.FAKE_AGENT_PROMPT_FILE, Buffer.concat(chunks));
const emit = (value) =>
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

const claudeResult = (extra = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Added the test.',
  usage: {
    input_tokens: 1200,
    output_tokens: 300,
    cache_read_input_tokens: 5000,
    cache_creation_input_tokens: 800,
  },
  total_cost_usd: 0.42,
  ...extra,
});

switch (scenario) {
  case 'claude-success':
    emit({ type: 'system', subtype: 'init', session_id: 's-1' });
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working.' }] } });
    emit(claudeResult());
    break;
  case 'claude-writes':
    mkdirSync(dirname(process.env.FAKE_AGENT_WRITE_PATH ?? 'agent-output.txt'), {
      recursive: true,
    });
    writeFileSync(
      process.env.FAKE_AGENT_WRITE_PATH ?? 'agent-output.txt',
      'changed by the agent\n',
    );
    emit(claudeResult());
    break;
  case 'claude-missing-usage': {
    const { usage: _usage, total_cost_usd: _cost, ...bare } = claudeResult();
    emit({ ...bare, usage: { output_tokens: 10 } });
    break;
  }
  case 'claude-error':
    emit(claudeResult({ subtype: 'error_max_turns', is_error: true, result: null }));
    process.exitCode = 1;
    break;
  case 'claude-twice':
    emit(claudeResult());
    emit(claudeResult());
    break;
  case 'codex-success':
    emit({ type: 'thread.started', thread_id: 't-1' });
    emit({ type: 'turn.started' });
    emit({ type: 'item.completed', item: { id: 'i-1', type: 'agent_message', text: 'Done.' } });
    emit({
      type: 'turn.completed',
      usage: { input_tokens: 900, cached_input_tokens: 4000, output_tokens: 200 },
    });
    break;
  case 'codex-failed':
    emit({ type: 'turn.started' });
    emit({ type: 'turn.failed', error: { message: 'rate limited' } });
    process.exitCode = 1;
    break;
  case 'malformed':
    emit('not json at all');
    emit('{"type":"result"');
    break;
  case 'hang':
    setInterval(() => {}, 1000);
    break;
  default:
    process.exitCode = 2;
}
