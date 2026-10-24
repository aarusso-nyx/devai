#!/usr/bin/env node
// Cooperative host admission, not an evidence cache or an authorization boundary.
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
function processSnapshot() {
  const processes = new Map();
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    maxBuffer: 8 * 1024 * 1024,
  });
  for (const line of output.split('\n')) {
    const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u.exec(line);
    if (row)
      processes.set(Number(row[1]), {
        pid: Number(row[1]),
        parentPid: Number(row[2]),
        groupPid: Number(row[3]),
        state: row[4],
        startedAt: row[5].trim(),
      });
  }
  if (!processes.has(process.pid)) throw new Error('VALIDATION_PROCESS_CENSUS_INVALID');
  return processes;
}
const sameRunningProcess = (identity, processes) => {
  const current = processes.get(identity.pid);
  return (
    current !== undefined &&
    current.startedAt === identity.startedAt?.trim() &&
    !current.state.includes('Z')
  );
};
const descendantsRunning = (owner) => {
  if (!owner.descendants?.length) return false;
  const processes = processSnapshot();
  return owner.descendants.some((identity) => sameRunningProcess(identity, processes));
};
const childRunning = (owner) => {
  if (!owner.childPid) return false;
  const identity = owner.childStartedAt
    ? { pid: owner.childPid, startedAt: owner.childStartedAt }
    : owner.descendants?.find(({ pid }) => pid === owner.childPid);
  return identity ? sameRunningProcess(identity, processSnapshot()) : alive(owner.childPid);
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
      const test = /(?:\/vitest\/vitest\.mjs|\bvitest run\b|\(vitest(?: \d+)?\))/u.exec(row[3]);
      const wrapper = /(?:^|[/\s])validation-runner\.mjs(?=\s|$)/u.exec(row[3]);
      if (
        lineage.has(pid) ||
        !test ||
        // A queued participant carries its future command in argv. Its actual
        // Vitest child, when started, has the test marker before any wrapper argument.
        (wrapper && wrapper.index < test.index)
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
function writeOwner(path, owner) {
  const temporary = join(path, `owner.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, join(path, 'owner.json'));
  } finally {
    rmSync(temporary, { force: true });
  }
}

function claim(path, owner) {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  writeOwner(path, owner);
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
    let leaseOwner;
    try {
      leaseOwner = read(path);
    } catch (error) {
      // Another runner may release its lease while this scan is in progress.
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (lineage.has(leaseOwner.pid)) {
      if (exclusive && path !== writer) throw new Error('VALIDATION_LEASE_UPGRADE_REFUSED');
      return { inherited: true, release() {}, recordChild() {}, recordDescendants() {} };
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
      recordChild(pid, ownsGroup) {
        owner.childPid = pid;
        owner.ownsGroup = ownsGroup;
        owner.childGroup = ownsGroup ? pid : undefined;
        writeOwner(path, owner);
      },
      recordDescendants(identities) {
        owner.childStartedAt ??= identities.find(({ pid }) => pid === owner.childPid)?.startedAt;
        owner.descendants = identities;
        writeOwner(path, owner);
      },
      release() {
        if (
          (owner.ownsGroup && alive(-owner.childGroup)) ||
          childRunning(owner) ||
          descendantsRunning(owner)
        )
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
    if (
      alive(owner.pid) ||
      (owner.ownsGroup && owner.childGroup && alive(-owner.childGroup)) ||
      childRunning(owner) ||
      descendantsRunning(owner)
    )
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
  let requestedSignal;
  let signalAt;
  let monitor;
  let killTimer;
  let escalated = false;
  let censusError;
  let quiescent = false;
  let childStartedAt;
  let recorded = '';
  const descendants = new Map();
  // Only the outer exclusive host controller creates a process group. Shared
  // task wrappers MUST remain inside the authority runner's existing group,
  // preserving its timeout termination and protected-namespace writer census.
  const ownsGroup = options.exclusive === true && !lease.inherited;
  const capture = () => {
    const processes = processSnapshot();
    const root = processes.get(child.pid);
    if (childStartedAt === undefined && root && child.exitCode === null)
      childStartedAt = root.startedAt;
    const owned = new Set(
      [...descendants.values()]
        .filter((identity) => sameRunningProcess(identity, processes))
        .map((identity) => identity.pid),
    );
    if (root && root.startedAt === childStartedAt && !root.state.includes('Z'))
      owned.add(child.pid);
    let changed = true;
    while (changed) {
      changed = false;
      for (const process of processes.values())
        if (!owned.has(process.pid) && owned.has(process.parentPid)) {
          owned.add(process.pid);
          changed = true;
        }
    }
    descendants.clear();
    for (const pid of owned) {
      const identity = processes.get(pid);
      if (identity && !identity.state.includes('Z')) descendants.set(pid, identity);
    }
    const identities = [...descendants.values()]
      .map(({ pid, startedAt }) => ({ pid, startedAt }))
      .sort((a, b) => a.pid - b.pid);
    const serialized = JSON.stringify(identities);
    if (serialized !== recorded) {
      lease.recordDescendants(identities);
      recorded = serialized;
    }
    return processes;
  };
  const deliver = (pid, signal) => {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') process.stderr.write('VALIDATION_SIGNAL_NOT_DELIVERED\n');
    }
  };
  const signalOwned = (signal, processes) => {
    if (ownsGroup && child?.pid) deliver(-child.pid, signal);
    for (const identity of [...descendants.values()].reverse())
      if (
        sameRunningProcess(identity, processes) &&
        !(ownsGroup && identity.groupPid === child.pid)
      )
        deliver(identity.pid, signal);
    if (!ownsGroup && child?.pid && !descendants.has(child.pid) && child.exitCode === null)
      deliver(child.pid, signal);
  };
  const escalate = () => {
    if (escalated || !child?.pid) return;
    escalated = true;
    try {
      signalOwned('SIGKILL', capture());
    } catch (error) {
      censusError = error;
      deliver(ownsGroup ? -child.pid : child.pid, 'SIGKILL');
    }
  };
  const forward = (signal) => {
    requestedSignal = signal;
    signalAt ??= Date.now();
    if (child?.pid) {
      try {
        signalOwned(signal, capture());
      } catch (error) {
        censusError = error;
        deliver(ownsGroup ? -child.pid : child.pid, signal);
      }
      killTimer ??= setTimeout(escalate, 1_000);
      killTimer.unref();
    }
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const handlers = signals.map((signal) => () => forward(signal));
  const releaseQuiescent = () => {
    if (child?.pid && !quiescent)
      throw new Error(
        censusError ? 'VALIDATION_PROCESS_CENSUS_FAILED' : 'VALIDATION_CHILDREN_STILL_RUNNING',
      );
    lease.release();
  };
  signals.forEach((signal, index) => process.on(signal, handlers[index]));
  try {
    child = spawn(argv[0], argv.slice(1), {
      stdio: 'inherit',
      detached: ownsGroup,
    });
    if (child.pid && !lease.inherited) lease.recordChild(child.pid, ownsGroup);
    if (child.pid) {
      capture();
      monitor = setInterval(() => {
        try {
          capture();
        } catch (error) {
          censusError = error;
        }
      }, 500);
      monitor.unref();
    }
    const outcome = await new Promise((resolveResult, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) =>
        resolveResult(
          requestedSignal
            ? requestedSignal === 'SIGINT'
              ? 130
              : 143
            : (code ?? (signal === 'SIGINT' ? 130 : 143)),
        ),
      );
    });
    // The immediate child can exit before its descendants, including a task
    // that authority put in a separate group. Keep admission while they drain.
    const confirmBy = Date.now() + 3_000;
    for (;;) {
      capture();
      if (censusError) throw censusError;
      if (descendants.size === 0 && !(ownsGroup && alive(-child.pid))) break;
      if (requestedSignal && !escalated && Date.now() >= signalAt + 1_000) {
        escalate();
      }
      if (Date.now() >= confirmBy) throw new Error('VALIDATION_CHILDREN_STILL_RUNNING');
      await delay(50);
    }
    quiescent = true;
    return outcome;
  } finally {
    clearInterval(monitor);
    clearTimeout(killTimer);
    signals.forEach((signal, index) => process.off(signal, handlers[index]));
    releaseQuiescent();
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
