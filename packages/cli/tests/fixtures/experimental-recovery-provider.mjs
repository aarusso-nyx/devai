// Fake claude CLI for the ADR-MDL-0007 recovery, capacity and hardening tests. It never
// contacts a provider. argv[2] selects the scenario; the environment parameterizes it.
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const scenario = process.argv[2] ?? 'writes';
for await (const chunk of process.stdin) void chunk;
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const usage = {
  input_tokens: 100,
  output_tokens: 20,
  cache_read_input_tokens: 5,
  cache_creation_input_tokens: 1,
};
const success = (extra = {}) =>
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Done.',
    usage,
    total_cost_usd: 0.01,
    ...extra,
  });
const trace = (event) => {
  if (process.env.FAKE_TRACE_FILE)
    appendFileSync(process.env.FAKE_TRACE_FILE, `${event} ${String(process.pid)} ${Date.now()}\n`);
};
const write = () => {
  const path = process.env.FAKE_WRITE_PATH ?? 'packages/app/src/feature.ts';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `changed by ${String(process.pid)}\n`);
};

trace('start');
switch (scenario) {
  case 'writes':
    write();
    success();
    break;
  case 'slow-writes':
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_DELAY_MS ?? 400)));
    write();
    success();
    break;
  case 'fail':
    emit({ type: 'result', subtype: 'error_max_turns', is_error: true, result: null, usage });
    process.exitCode = 1;
    break;
  case 'symlink-out':
    mkdirSync('packages/app/src', { recursive: true });
    symlinkSync(process.env.FAKE_LINK_TARGET ?? '/etc/hosts', 'packages/app/src/link.ts');
    success();
    break;
  case 'no-cache':
    write();
    success({ usage: { input_tokens: 100, output_tokens: 20 } });
    break;
  case 'drop-locks':
    for (const name of readdirSync(process.env.FAKE_LOCKS_DIR ?? '.')) {
      rmSync(join(process.env.FAKE_LOCKS_DIR ?? '.', name), { recursive: true, force: true });
    }
    write();
    success();
    break;
  default:
    process.exitCode = 2;
}
trace('end');
