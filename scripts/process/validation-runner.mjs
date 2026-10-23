#!/usr/bin/env node
// Cooperative host admission, not an evidence cache or an authorization boundary.
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const validationRoot = () => join(homedir(), '.cache/devai/validation-v1', hostname());
const read = (path) => JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
};
function ancestors() {
  const result = new Set([process.pid]);
  let pid = process.ppid;
  while (pid > 1 && !result.has(pid)) {
    result.add(pid);
    pid = Number(
      execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim(),
    );
  }
  return result;
}

// Older worktrees and direct Vitest invocations do not participate in admission.
// Drain those too before starting an exclusive run; never kill another task.
export function competingTestPids() {
  const lineage = ancestors();
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((row) => /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(row))
    .filter(Boolean);
  const parents = new Map(rows.map((row) => [Number(row[1]), Number(row[2])]));
  return rows
    .filter((row) => {
      const pid = Number(row[1]);
      if (
        lineage.has(pid) ||
        !/(?:\/vitest\/vitest\.mjs|\bvitest run\b|\(vitest(?: \d+)?\))/u.test(row[3])
      )
        return false;
      const seen = new Set();
      let parent = pid;
      while (parent > 1 && !seen.has(parent)) {
        if (parent === process.pid) return false;
        seen.add(parent);
        parent = parents.get(parent) ?? 0;
      }
      return true;
    })
    .map((row) => Number(row[1]));
}
function claim(path, owner) {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  writeFileSync(join(path, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  return true;
}

export async function acquireValidation({
  exclusive = false,
  root = validationRoot(),
  waitMs = 3_600_000,
  signal,
  activeTests = root === validationRoot() ? competingTestPids : () => [],
} = {}) {
  const readers = join(root, 'shared');
  const writer = join(root, 'exclusive');
  mkdirSync(readers, { recursive: true, mode: 0o700 });
  const lineage = ancestors();
  // Reentrance uses actual process ancestry, so it also works through the
  // check runner's deliberately scrubbed environment. No credential is forwarded.
  for (const path of [writer, ...readdirSync(readers).map((name) => join(readers, name))]) {
    if (!existsSync(join(path, 'owner.json'))) continue;
    if (lineage.has(read(path).pid)) {
      if (exclusive && path !== writer) throw new Error('VALIDATION_LEASE_UPGRADE_REFUSED');
      return { inherited: true, release() {}, recordChild() {} };
    }
  }
  const owner = { id: randomUUID(), pid: process.pid, startedAt: new Date().toISOString() };
  const path = exclusive ? writer : join(readers, owner.id);
  const deadline = Date.now() + waitMs;
  let held = false,
    announced = false;
  try {
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (exclusive) {
        if (!held) held = claim(writer, owner);
        if (held && readdirSync(readers).length === 0 && activeTests().length === 0) break;
      } else if (!existsSync(writer)) {
        held = claim(path, owner);
        // Close the race with an exclusive claimant. Never start work if a
        // writer appeared between our initial observation and registration.
        if (held && !existsSync(writer)) break;
        if (held) {
          rmSync(path, { recursive: true });
          held = false;
        }
      }
      if (!announced) {
        process.stderr.write(`validation queued (${root})\n`);
        announced = true;
      }
      await delay(100, undefined, { signal });
    }
    if (!held || (exclusive && (readdirSync(readers).length !== 0 || activeTests().length !== 0)))
      throw new Error('VALIDATION_LEASE_BUSY');
    return {
      inherited: false,
      recordChild(pid) {
        owner.childGroup = pid;
        writeFileSync(join(path, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
      },
      release() {
        if (owner.childGroup && alive(-owner.childGroup))
          throw new Error('VALIDATION_CHILDREN_STILL_RUNNING');
        if (read(path).id !== owner.id) throw new Error('VALIDATION_LEASE_OWNER_CHANGED');
        rmSync(path, { recursive: true });
      },
    };
  } catch (error) {
    if (held) rmSync(path, { recursive: true });
    throw error;
  }
}

/** Recovery never steals a live lease or abandons its surviving process group. */
export function recoverValidation(root, id) {
  if (!/^[a-f0-9-]{36}$/u.test(id)) throw new Error('VALIDATION_RECOVERY_ID_INVALID');
  for (const path of [join(root, 'exclusive'), join(root, 'shared', id)]) {
    if (!existsSync(join(path, 'owner.json'))) continue;
    const owner = read(path);
    if (owner.id !== id) continue;
    if (alive(owner.pid) || (owner.childGroup && alive(-owner.childGroup)))
      throw new Error('VALIDATION_RECOVERY_LIVE_WORK');
    rmSync(path, { recursive: true });
    return;
  }
  throw new Error('VALIDATION_RECOVERY_NOT_FOUND');
}

export async function runValidation(argv, options = {}) {
  if (argv.length === 0) throw new Error('VALIDATION_COMMAND_REQUIRED');
  const abort = new AbortController();
  const cancel = () => abort.abort(new Error('VALIDATION_WAIT_CANCELLED'));
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, cancel);
  let lease;
  try {
    lease = await acquireValidation({ ...options, signal: abort.signal });
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, cancel);
  }
  let child;
  const forward = (signal) => {
    if (child?.pid) process.kill(lease.inherited ? child.pid : -child.pid, signal);
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const handlers = signals.map((signal) => () => forward(signal));
  try {
    child = spawn(argv[0], argv.slice(1), {
      stdio: 'inherit',
      detached: !lease.inherited,
    });
    if (child.pid && !lease.inherited) lease.recordChild(child.pid);
    signals.forEach((signal, index) => process.on(signal, handlers[index]));
    return await new Promise((resolveResult, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) =>
        resolveResult(code ?? (signal === 'SIGINT' ? 130 : 143)),
      );
    });
  } finally {
    signals.forEach((signal, index) => process.off(signal, handlers[index]));
    lease.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === 'recover') recoverValidation(validationRoot(), args[1]);
    else {
      const separator = args.indexOf('--');
      if (separator < 0 || args.slice(0, separator).some((arg) => arg !== '--exclusive'))
        throw new Error('VALIDATION_RUNNER_USAGE');
      process.exitCode = await runValidation(args.slice(separator + 1), {
        exclusive: args.includes('--exclusive'),
      });
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
