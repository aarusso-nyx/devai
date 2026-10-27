import { spawn } from 'node:child_process';
import { createWriteStream, lstatSync, readFileSync, openSync } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
const refuse = () => {
  throw Error('REFUSED');
};
export function eventIdentity(eventPath, eventName) {
  const st = lstatSync(eventPath);
  if (!st.isFile() || st.size > 1048576) refuse();
  const e = JSON.parse(readFileSync(eventPath, 'utf8'));
  const candidate =
    eventName === 'pull_request'
      ? e.pull_request?.head?.sha
      : eventName === 'merge_group'
        ? e.merge_group?.head_sha
        : undefined;
  const base =
    eventName === 'pull_request'
      ? e.pull_request?.base?.sha
      : eventName === 'merge_group'
        ? e.merge_group?.base_sha
        : undefined;
  if (!/^[a-f0-9]{40}$/.test(candidate ?? '') || !/^[a-f0-9]{40}$/.test(base ?? '')) refuse();
  return { candidate, base };
}
export async function cappedCopy(input, path, cap) {
  if (!Number.isSafeInteger(cap) || cap < 1) refuse();
  let count = 0;
  const limiter = new Transform({
    transform(chunk, enc, cb) {
      count += chunk.length;
      if (count > cap) cb(Error('REFUSED'));
      else cb(null, chunk);
    },
  });
  const fd = openSync(path, 'wx', 0o600);
  await pipeline(input, limiter, createWriteStream(path, { fd, autoClose: true }));
}
// One shared deadline for all commands. A timeout kills the detached process group and waits for the leader's close.
export async function runBounded(exe, args, { deadline, cwd } = {}) {
  const remaining = deadline - Date.now();
  if (
    !Number.isSafeInteger(deadline) ||
    !Number.isFinite(remaining) ||
    remaining <= 0 ||
    remaining > 2147483647
  )
    refuse();
  return await new Promise((resolve, reject) => {
    let expired = false,
      spawnError;
    const child = spawn(exe, args, { cwd, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (c) => {
      if (err.length < 8192) err += c.toString().slice(0, 8192 - err.length);
    });
    child.on('error', (e) => {
      spawnError = e;
    });
    const timer = setTimeout(() => {
      expired = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The child may have already exited.
      }
    }, remaining);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (expired || spawnError || code !== 0 || signal) {
        reject(Error('REFUSED'));
      } else resolve();
    });
  });
}
