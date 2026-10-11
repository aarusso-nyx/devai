import { readFileSync } from 'node:fs';
import { replayNativeLinuxTask } from './commands/sense/native-linux-replay.js';
// Private package asset: only the parent invokes this after complete workload quiescence.
if (process.argv.length !== 3 || process.argv[2] !== '--replay')
  throw new Error('NATIVE_LINUX_REPLAY_INVOCATION_INVALID');
process.stdout.write(JSON.stringify(replayNativeLinuxTask(readFileSync(0, 'utf8'))));
