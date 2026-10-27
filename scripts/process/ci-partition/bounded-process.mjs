import { spawn } from 'node:child_process';
export async function boundedProcess(
  executable,
  args,
  { input, deadline, maxOutput = 134217728, cwd } = {},
) {
  const left = deadline - Date.now();
  if (
    !Number.isSafeInteger(deadline) ||
    left <= 0 ||
    left > 2147483647 ||
    !Number.isSafeInteger(maxOutput) ||
    maxOutput < 1 ||
    maxOutput > 134217728
  )
    throw Error('REFUSED');
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let parts = [],
      size = 0,
      bad = false,
      spawnError = false,
      err = '';
    child.stderr.on('data', (c) => {
      if (err.length < 8192) err += c.toString().slice(0, 8192 - err.length);
    });
    const kill = () => {
      bad = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The process or PATH entry may already be unavailable.
      }
    };
    const timer = setTimeout(kill, left);
    child.on('error', () => {
      spawnError = true;
    });
    child.stdin.on('error', () => {
      bad = true;
    });
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxOutput) kill();
      else parts.push(chunk);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (bad || spawnError || signal || code !== 0 || Date.now() >= deadline) {
        reject(Error('REFUSED'));
      } else resolve(Buffer.concat(parts));
    });
    child.stdin.end(input);
  });
}
