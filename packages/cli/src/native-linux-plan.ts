import { readFileSync } from 'node:fs';
import { deriveNativeLinuxTask } from './commands/sense/native-linux-plan.js';
// Private package asset: the owned supervisor invokes this before the adopter exists.
if (process.argv.length !== 3 || process.argv[2] !== '--derive')
  throw new Error('NATIVE_LINUX_PLAN_INVOCATION_INVALID');
process.stdout.write(JSON.stringify(deriveNativeLinuxTask(readFileSync(0, 'utf8'))));
