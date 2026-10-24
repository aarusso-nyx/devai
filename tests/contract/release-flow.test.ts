import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';

const flowUrl = pathToFileURL(resolve('scripts/process/release-flow.mjs')).href;
const runnerUrl = pathToFileURL(resolve('scripts/process/validation-runner.mjs')).href;
const docsUrl = pathToFileURL(resolve('scripts/process/docs-build.mjs')).href;
const {
  checkpoint,
  oneNpmResult,
  normalizeNpmDistTags,
  saveJournal,
  recoverJournal,
  assertPromotedAssets,
  assertControlPaths,
} = await import(flowUrl);
const { acquireValidation, recoverValidation, runValidation } = await import(runnerUrl);
const { buildDocs } = await import(docsUrl);
const roots: string[] = [];
const children: ChildProcess[] = [];
const ownedPidMarkers = new Map<number, string>();
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devai-release-flow-'));
  roots.push(root);
  return root;
}
function sharedOwnerFile(root: string) {
  const [id] = readdirSync(join(root, 'leases/shared'));
  if (id === undefined) throw new Error('shared fixture lease was not registered');
  return join(root, 'leases/shared', id, 'owner.json');
}
function fixtureProcessRunning(pid: number) {
  try {
    const state = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], {
      encoding: 'utf8',
    }).trim();
    return state.length > 0 && !state.includes('Z');
  } catch {
    return false;
  }
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 8_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('fixture did not progress');
    await delay(20);
  }
}
function worker(root: string, name: string, exclusive: boolean) {
  const script = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(join(root, name))},'started');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(root, `${name}-stop`))})){clearInterval(t)}},20);`;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {runValidation} from ${JSON.stringify(runnerUrl)};process.exitCode=await runValidation(${JSON.stringify([process.execPath, '-e', script])},${JSON.stringify({ root: join(root, 'leases'), exclusive, waitMs: 7_000 })});`,
    ],
    { stdio: 'pipe' },
  );
  children.push(child);
  return child;
}
afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  for (const [pid, marker] of ownedPidMarkers) {
    try {
      const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
      });
      if (command.includes(marker)) process.kill(pid, 'SIGKILL');
    } catch {
      // The fixture may already have exited; never signal a reused PID.
    }
  }
  ownedPidMarkers.clear();
  await delay(100);
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe('host validation admission', () => {
  it('does not inherit an abandoned owner whose PID is now an actual ancestor', async () => {
    const root = fixture();
    const path = join(root, 'exclusive');
    mkdirSync(path);
    writeFileSync(
      join(path, 'owner.json'),
      JSON.stringify({
        id: '12345678-1234-1234-1234-123456789abc',
        pid: process.pid,
        processStartedAt: 'different process birth',
      }),
    );
    await expect(acquireValidation({ root, waitMs: 150 })).rejects.toThrow('VALIDATION_LEASE_BUSY');
    expect(existsSync(path)).toBe(true);
  });

  it('recovers a reused owner PID but refuses recovery of the actual current owner', async () => {
    const root = fixture();
    const path = join(root, 'exclusive');
    const id = '12345678-1234-1234-1234-123456789abc';
    mkdirSync(path);
    writeFileSync(
      join(path, 'owner.json'),
      JSON.stringify({ id, pid: process.pid, processStartedAt: 'different process birth' }),
    );
    recoverValidation(root, id);
    expect(existsSync(path)).toBe(false);
    const lease = await acquireValidation({ root, exclusive: true });
    const owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
    expect(owner.processStartedAt).toEqual(expect.any(String));
    expect(() => recoverValidation(root, owner.id)).toThrow('VALIDATION_RECOVERY_LIVE_WORK');
    lease.release();
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });

  it('recovers a hard-killed shared wrapper after its child finishes in a still-live caller group', async () => {
    const root = fixture();
    const ready = join(root, 'abandoned-shared-ready');
    const stop = join(root, 'abandoned-shared-stop');
    const code = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'');setInterval(()=>{if(fs.existsSync(${JSON.stringify(stop)}))process.exit(0)},20);`;
    const actor = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {runValidation} from ${JSON.stringify(runnerUrl)};process.exitCode=await runValidation(${JSON.stringify([process.execPath, '-e', code])},{root:${JSON.stringify(join(root, 'leases'))}});`,
      ],
      { stdio: 'pipe' },
    );
    children.push(actor);
    await until(() => existsSync(ready));
    const leasePath = sharedOwnerFile(root);
    await until(() => JSON.parse(readFileSync(leasePath, 'utf8')).descendants?.length > 0);
    const owner = JSON.parse(readFileSync(leasePath, 'utf8'));
    ownedPidMarkers.set(owner.childPid, ready);
    const callerGroup = Number(
      execFileSync('ps', ['-p', String(process.pid), '-o', 'pgid='], { encoding: 'utf8' }).trim(),
    );
    actor.kill('SIGKILL');
    await until(() => actor.signalCode === 'SIGKILL');
    expect(() => recoverValidation(join(root, 'leases'), owner.id)).toThrow(
      'VALIDATION_RECOVERY_LIVE_WORK',
    );
    writeFileSync(stop, '');
    await until(() => !fixtureProcessRunning(owner.childPid));
    expect(() => process.kill(-callerGroup, 0)).not.toThrow();
    recoverValidation(join(root, 'leases'), owner.id);
    expect(existsSync(leasePath)).toBe(false);
    const next = await acquireValidation({
      root: join(root, 'leases'),
      exclusive: true,
      waitMs: 1000,
    });
    next.release();
  });

  it('preserves owned-group and live-child recovery guards while ignoring a reused shared child PID', () => {
    const root = fixture();
    const path = join(root, 'exclusive');
    const id = '12345678-1234-1234-1234-123456789abc';
    const group = Number(
      execFileSync('ps', ['-p', String(process.pid), '-o', 'pgid='], { encoding: 'utf8' }).trim(),
    );
    const startedAt = execFileSync('ps', ['-p', String(process.pid), '-o', 'lstart='], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    }).trim();
    mkdirSync(path);
    const write = (value: object) =>
      writeFileSync(
        join(path, 'owner.json'),
        JSON.stringify({ id, pid: 99_999_999, descendants: [], ...value }),
      );
    write({ ownsGroup: true, childGroup: group, childPid: 99_999_999 });
    expect(() => recoverValidation(root, id)).toThrow('VALIDATION_RECOVERY_LIVE_WORK');
    write({
      ownsGroup: false,
      childGroup: 99_999_999,
      childPid: process.pid,
      childStartedAt: startedAt,
    });
    expect(() => recoverValidation(root, id)).toThrow('VALIDATION_RECOVERY_LIVE_WORK');
    write({
      ownsGroup: false,
      childGroup: group,
      childPid: process.pid,
      childStartedAt: 'different process birth',
    });
    recoverValidation(root, id);
    expect(existsSync(path)).toBe(false);
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });

  it('escalates cancellation when the immediate child ignores SIGTERM', async () => {
    const root = fixture();
    const ready = join(root, 'resistant-parent-ready');
    const stopping = join(root, 'resistant-parent-stopping');
    const code = `const fs=require('node:fs');process.on('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(stopping)},''));fs.writeFileSync(${JSON.stringify(ready)},'');setInterval(()=>{},100);`;
    const actor = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {runValidation} from ${JSON.stringify(runnerUrl)};process.exitCode=await runValidation(${JSON.stringify([process.execPath, '-e', code])},{root:${JSON.stringify(join(root, 'leases'))}});`,
      ],
      { stdio: 'pipe' },
    );
    children.push(actor);
    await until(() => existsSync(ready));
    const leasePath = sharedOwnerFile(root);
    await until(() => Number.isSafeInteger(JSON.parse(readFileSync(leasePath, 'utf8')).childPid));
    ownedPidMarkers.set(JSON.parse(readFileSync(leasePath, 'utf8')).childPid, ready);
    const writer = worker(root, 'after-resistant-parent', true);
    let queuedLog = '';
    writer.stderr?.on('data', (chunk) => (queuedLog += String(chunk)));
    await until(() => queuedLog.includes('validation queued'));
    actor.kill('SIGTERM');
    await until(() => existsSync(stopping));
    expect(actor.exitCode).toBeNull();
    expect(existsSync(leasePath)).toBe(true);
    expect(existsSync(join(root, 'after-resistant-parent'))).toBe(false);
    await until(() => actor.exitCode !== null && existsSync(join(root, 'after-resistant-parent')));
    expect(actor.exitCode).toBe(143);
    writeFileSync(join(root, 'after-resistant-parent-stop'), '');
    await until(() => writer.exitCode !== null);
    expect(writer.exitCode).toBe(0);
  });

  it('keeps shared admission while a recorded worker outlives its normally exited parent', async () => {
    const root = fixture();
    const ready = join(root, 'normal-ready');
    const pidFile = join(root, 'normal-pid');
    const parentStop = join(root, 'parent-stop');
    const workerStop = join(root, 'worker-stop');
    const descendantCode = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'');setInterval(()=>{if(fs.existsSync(${JSON.stringify(workerStop)}))process.exit(0)},20);`;
    const parentCode = `const fs=require('node:fs');const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{stdio:'ignore',detached:true});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{if(fs.existsSync(${JSON.stringify(parentStop)}))process.exit(0)},20);`;
    const actor = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {runValidation} from ${JSON.stringify(runnerUrl)};process.exitCode=await runValidation(${JSON.stringify([process.execPath, '-e', parentCode])},{root:${JSON.stringify(join(root, 'leases'))}});`,
      ],
      { stdio: 'pipe' },
    );
    children.push(actor);
    await until(() => existsSync(ready) && existsSync(pidFile));
    const descendantPid = Number(readFileSync(pidFile, 'utf8'));
    ownedPidMarkers.set(descendantPid, ready);
    const leasePath = sharedOwnerFile(root);
    await until(() =>
      JSON.parse(readFileSync(leasePath, 'utf8')).descendants?.some(
        ({ pid }: { pid: number }) => pid === descendantPid,
      ),
    );
    const writer = worker(root, 'after-normal-worker', true);
    let queuedLog = '';
    writer.stderr?.on('data', (chunk) => (queuedLog += String(chunk)));
    await until(() => queuedLog.includes('validation queued'));
    writeFileSync(parentStop, '');
    await delay(200);
    expect(actor.exitCode).toBeNull();
    expect(existsSync(leasePath)).toBe(true);
    expect(existsSync(join(root, 'after-normal-worker'))).toBe(false);
    writeFileSync(workerStop, '');
    await until(() => actor.exitCode !== null && existsSync(join(root, 'after-normal-worker')));
    expect(actor.exitCode).toBe(0);
    writeFileSync(join(root, 'after-normal-worker-stop'), '');
    await until(() => writer.exitCode !== null);
    expect(writer.exitCode).toBe(0);
  });

  it('refuses recovery of a live recorded descendant and distinguishes reused PIDs', () => {
    const root = fixture();
    const owner = join(root, 'exclusive');
    const id = '12345678-1234-1234-1234-123456789abc';
    const startedAt = execFileSync('ps', ['-p', String(process.pid), '-o', 'lstart='], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    }).trim();
    mkdirSync(owner);
    writeFileSync(
      join(owner, 'owner.json'),
      JSON.stringify({ id, pid: 99_999_999, descendants: [{ pid: process.pid, startedAt }] }),
    );
    expect(() => recoverValidation(root, id)).toThrow('VALIDATION_RECOVERY_LIVE_WORK');
    writeFileSync(
      join(owner, 'owner.json'),
      JSON.stringify({
        id,
        pid: 99_999_999,
        descendants: [{ pid: process.pid, startedAt: 'different process birth' }],
      }),
    );
    recoverValidation(root, id);
    expect(existsSync(owner)).toBe(false);
  });

  it.each([
    { label: 'shared', exclusive: false, resistsTerm: false },
    { label: 'exclusive', exclusive: true, resistsTerm: false },
    { label: 'shared with a TERM-resistant worker', exclusive: false, resistsTerm: true },
  ])(
    'retains $label admission until detached descendants stop on cancellation',
    async ({ exclusive, resistsTerm }) => {
      const root = fixture();
      const ready = join(root, 'descendant-ready');
      const stopping = join(root, 'descendant-stopping');
      const pidFile = join(root, 'descendant-pid');
      const descendantCode = `const fs=require('node:fs');let stopping=false;process.on('SIGTERM',()=>{if(stopping)return;stopping=true;fs.writeFileSync(${JSON.stringify(stopping)},'');if(!${JSON.stringify(resistsTerm)})setTimeout(()=>process.exit(0),350)});fs.writeFileSync(${JSON.stringify(ready)},'');setInterval(()=>{},100);`;
      const parentCode = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{stdio:'ignore',detached:true});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},100);`;
      const actor = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {runValidation} from ${JSON.stringify(runnerUrl)};process.exitCode=await runValidation(${JSON.stringify([process.execPath, '-e', parentCode])},${JSON.stringify({ root: join(root, 'leases'), exclusive, waitMs: 7000 })});`,
        ],
        { stdio: 'pipe' },
      );
      children.push(actor);
      await until(() => existsSync(ready) && existsSync(pidFile));
      const descendantPid = Number(readFileSync(pidFile, 'utf8'));
      ownedPidMarkers.set(descendantPid, ready);
      const leasePath = exclusive
        ? join(root, 'leases/exclusive/owner.json')
        : sharedOwnerFile(root);
      const writer = worker(root, 'after-descendant', true);
      let queuedLog = '';
      writer.stderr?.on('data', (chunk) => (queuedLog += String(chunk)));
      await until(() => queuedLog.includes('validation queued'));
      actor.kill('SIGTERM');
      await until(() => existsSync(stopping) || actor.exitCode !== null);
      expect(existsSync(stopping)).toBe(true);
      expect(actor.exitCode).toBeNull();
      expect(JSON.parse(readFileSync(leasePath, 'utf8')).pid).toBe(actor.pid);
      expect(existsSync(join(root, 'after-descendant'))).toBe(false);
      await until(() => actor.exitCode !== null && existsSync(join(root, 'after-descendant')));
      expect(actor.exitCode).toBe(143);
      writeFileSync(join(root, 'after-descendant-stop'), '');
      await until(() => writer.exitCode !== null);
      expect(writer.exitCode).toBe(0);
    },
  );

  it('exposes only complete metadata during initial publication and child registration', () => {
    const root = fixture();
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import fs from 'node:fs';import {dirname,join} from 'node:path';import {syncBuiltinESMExports} from 'node:module';
const {acquireValidation}=await import(${JSON.stringify(runnerUrl)});
const original=fs.writeFileSync;const observations=[];
fs.writeFileSync=function(path,data,options={}){
  if(typeof path!=='string'||!path.startsWith(${JSON.stringify(`${root}/`)}))return original.call(this,path,data,options);
  const opts=typeof options==='string'?{encoding:options}:options;
  const fd=fs.openSync(path,opts.flag??'w',opts.mode);
  try{
    const canonical=join(dirname(path),'owner.json');
    observations.push(fs.existsSync(canonical)?JSON.parse(fs.readFileSync(canonical,'utf8')):null);
    return original.call(this,fd,data,{encoding:opts.encoding??'utf8'});
  }finally{fs.closeSync(fd);}
};syncBuiltinESMExports();
try{const lease=await acquireValidation({root:${JSON.stringify(root)},waitMs:1000});
lease.recordChild(99999999,false);
const shared=join(${JSON.stringify(root)},'shared');const updated=JSON.parse(fs.readFileSync(join(shared,fs.readdirSync(shared)[0],'owner.json'),'utf8'));
lease.release();console.log(JSON.stringify({observations,updated}));
}finally{fs.writeFileSync=original;syncBuiltinESMExports();}`,
        ],
        { encoding: 'utf8' },
      ),
    );
    expect(result.observations).toHaveLength(2);
    expect(result.observations[0]).toBeNull();
    expect(result.observations[1]).toMatchObject({
      id: result.updated.id,
      pid: result.updated.pid,
    });
    expect(result.observations[1]).not.toHaveProperty('childPid');
    expect(result.updated.childPid).toBe(99_999_999);
  });

  it.each(['departed', 'inaccessible', 'malformed'])(
    'handles a %s lease during the reentrance scan',
    (condition) => {
      const root = fixture();
      const prior = join(root, 'shared/prior');
      const ownerFile = join(prior, 'owner.json');
      mkdirSync(prior, { recursive: true });
      writeFileSync(
        ownerFile,
        condition === 'malformed'
          ? 'invalid json'
          : JSON.stringify({ id: 'prior', pid: process.pid }),
      );
      const result = JSON.parse(
        execFileSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const {acquireValidation}=await import(${JSON.stringify(runnerUrl)});
const original=fs.readFileSync;let intercepted=0;
fs.readFileSync=function(path,...args){
  if(path===${JSON.stringify(ownerFile)}){
    intercepted++;
    if(${JSON.stringify(condition)}==='departed')fs.rmSync(${JSON.stringify(prior)},{recursive:true});
    if(${JSON.stringify(condition)}==='inaccessible')throw Object.assign(new Error('access denied'),{code:'EACCES'});
  }
  return original.call(this,path,...args);
};syncBuiltinESMExports();
try{const lease=await acquireValidation({root:${JSON.stringify(root)},waitMs:1000});
const inherited=lease.inherited;lease.release();console.log(JSON.stringify({intercepted,inherited,remaining:fs.readdirSync(${JSON.stringify(join(root, 'shared'))}).length}));
}catch(error){console.log(JSON.stringify({intercepted,code:error.code,syntax:error instanceof SyntaxError}));
}finally{fs.readFileSync=original;syncBuiltinESMExports();}`,
          ],
          { encoding: 'utf8' },
        ),
      );
      expect(result.intercepted).toBe(1);
      if (condition === 'departed')
        expect(result).toEqual({ intercepted: 1, inherited: false, remaining: 0 });
      else if (condition === 'inaccessible') expect(result.code).toBe('EACCES');
      else expect(result.syntax).toBe(true);
    },
  );

  it('keeps shared tasks inside the caller process group for authority cleanup', async () => {
    const root = fixture();
    const output = join(root, 'group');
    const parentGroup = execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], {
      encoding: 'utf8',
    }).trim();
    const code = `require('node:fs').writeFileSync(${JSON.stringify(output)},require('node:child_process').execFileSync('ps',['-o','pgid=','-p',String(process.pid)],{encoding:'utf8'}).trim());`;
    expect(await runValidation([process.execPath, '-e', code], { root })).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe(parentGroup);
  });

  it('drains shared runs, reserves the host against new work, then releases it', async () => {
    const root = fixture();
    worker(root, 'first', false);
    worker(root, 'second', false);
    await until(() => existsSync(join(root, 'first')) && existsSync(join(root, 'second')));
    const writer = worker(root, 'rc', true);
    await until(() => existsSync(join(root, 'leases/exclusive/owner.json')));
    worker(root, 'later', false);
    await delay(150);
    expect(existsSync(join(root, 'rc'))).toBe(false);
    expect(existsSync(join(root, 'later'))).toBe(false);
    writeFileSync(join(root, 'first-stop'), '');
    writeFileSync(join(root, 'second-stop'), '');
    await until(() => existsSync(join(root, 'rc')));
    expect(existsSync(join(root, 'later'))).toBe(false);
    writeFileSync(join(root, 'rc-stop'), '');
    await until(() => existsSync(join(root, 'later')));
    await until(() => writer.exitCode !== null);
    expect(writer.exitCode).toBe(0);
    writeFileSync(join(root, 'later-stop'), '');
  });
  it('drains real tests without counting a queued wrapper as active Vitest', async () => {
    const root = fixture();
    const env = { ...process.env, HOME: root };
    const runner = resolve('scripts/process/validation-runner.mjs');
    const vitest = join(root, 'vitest/vitest.mjs');
    const directMarker = join(root, 'direct');
    const queuedMarker = join(root, 'queued');
    const queuedPidFile = join(root, 'queued-pid');
    const census = join(root, 'census');
    const entered = join(root, 'exclusive-entered');
    const stop = join(root, 'exclusive-stop');
    mkdirSync(join(root, 'vitest'));
    writeFileSync(
      vitest,
      "import {writeFileSync} from 'node:fs';writeFileSync(process.argv[2],'started');if(process.argv[3]==='hold')setInterval(()=>{},100);",
    );
    // A real Vitest command must still count when the wrapper is a later argument.
    const direct = spawn(process.execPath, [vitest, directMarker, 'hold', runner], { env });
    children.push(direct);
    if (!direct.pid) throw new Error('direct fixture did not start');
    const directPid = direct.pid;
    await until(() => existsSync(directMarker));
    const claimant = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import * as fs from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';import {acquireValidation,competingTestPids} from ${JSON.stringify(runnerUrl)};
const lease=await acquireValidation({exclusive:true,waitMs:7000,activeTests:()=>{
const queuedPid=fs.existsSync(${JSON.stringify(queuedPidFile)})?Number(fs.readFileSync(${JSON.stringify(queuedPidFile)},'utf8')):0;
const active=competingTestPids().filter(pid=>pid===${directPid}||pid===queuedPid);
fs.writeFileSync(${JSON.stringify(census)},JSON.stringify({queuedPid,active}));return active;}});
fs.writeFileSync(${JSON.stringify(entered)},'');while(!fs.existsSync(${JSON.stringify(stop)}))await delay(20);lease.release();`,
      ],
      { env, stdio: 'pipe' },
    );
    children.push(claimant);
    let observed = { queuedPid: 0, active: [] as number[] };
    const sampled = () => {
      try {
        observed = JSON.parse(readFileSync(census, 'utf8')) as typeof observed;
        return true;
      } catch {
        return false;
      }
    };
    await until(() => sampled() && observed.active.includes(directPid));
    const queued = spawn(process.execPath, [runner, '--', process.execPath, vitest, queuedMarker], {
      env,
      stdio: 'pipe',
    });
    children.push(queued);
    if (!queued.pid) throw new Error('queued fixture did not start');
    let queuedLog = '';
    queued.stderr?.on('data', (chunk) => (queuedLog += String(chunk)));
    await until(() => queuedLog.includes('validation queued'));
    writeFileSync(queuedPidFile, String(queued.pid));
    await until(
      () => sampled() && observed.queuedPid === queued.pid && observed.active.includes(directPid),
    );
    expect(observed.active).not.toContain(queued.pid);
    expect(existsSync(entered)).toBe(false);
    expect(existsSync(queuedMarker)).toBe(false);
    direct.kill('SIGTERM');
    await until(() => existsSync(entered));
    expect(existsSync(queuedMarker)).toBe(false);
    writeFileSync(stop, '');
    await until(() => queued.exitCode !== null && claimant.exitCode !== null);
    expect(claimant.exitCode).toBe(0);
    expect(queued.exitCode).toBe(0);
    expect(existsSync(queuedMarker)).toBe(true);
  });
  it('cancels an active exclusive process group without abandoning its lease', async () => {
    const root = fixture();
    const actor = worker(root, 'active', true);
    await until(() => existsSync(join(root, 'active')));
    actor.kill('SIGTERM');
    actor.kill('SIGTERM');
    await until(() => actor.exitCode !== null);
    expect(actor.exitCode).toBe(143);
    expect(existsSync(join(root, 'leases/exclusive'))).toBe(false);
  });
  it('re-enters from descendants without adding environment variables', async () => {
    const root = fixture();
    const code = `import {runValidation} from ${JSON.stringify(runnerUrl)};process.exitCode=await runValidation([process.execPath,'-e','process.exit(17)'],{root:${JSON.stringify(root)}});`;
    expect(
      await runValidation([process.execPath, '--input-type=module', '-e', code], {
        root,
        exclusive: true,
      }),
    ).toBe(17);
    expect(existsSync(join(root, 'exclusive'))).toBe(false);
  });
  it('removes a queued exclusive claim on cancellation, leaving running tests alone', async () => {
    const root = fixture();
    const reader = worker(root, 'reader', false);
    await until(() => existsSync(join(root, 'reader')));
    const writer = worker(root, 'rc', true);
    await until(() => existsSync(join(root, 'leases/exclusive/owner.json')));
    writer.kill('SIGTERM');
    await until(() => writer.exitCode !== null);
    expect(existsSync(join(root, 'leases/exclusive'))).toBe(false);
    expect(existsSync(join(root, 'rc'))).toBe(false);
    expect(reader.exitCode).toBeNull();
    writeFileSync(join(root, 'reader-stop'), '');
  });
  it('refuses lock upgrades and releases admission after a spawn failure', async () => {
    const root = fixture();
    const lease = await acquireValidation({ root });
    await expect(acquireValidation({ root, exclusive: true })).rejects.toThrow(
      'VALIDATION_LEASE_UPGRADE_REFUSED',
    );
    lease.release();
    await expect(
      runValidation(['/devai-does-not-exist'], { root, exclusive: true }),
    ).rejects.toThrow();
    expect(existsSync(join(root, 'exclusive'))).toBe(false);
  });
  it('never recovers a live owner, but explicitly recovers an abandoned lease', () => {
    const root = fixture();
    const owner = join(root, 'exclusive');
    mkdirSync(owner);
    const id = '12345678-1234-1234-1234-123456789abc';
    writeFileSync(join(owner, 'owner.json'), JSON.stringify({ id, pid: process.pid }));
    expect(() => recoverValidation(root, id)).toThrow('VALIDATION_RECOVERY_LIVE_WORK');
    writeFileSync(join(owner, 'owner.json'), JSON.stringify({ id, pid: 99_999_999 }));
    recoverValidation(root, id);
    expect(existsSync(owner)).toBe(false);
  });
});

describe('preflight protected control paths', () => {
  it('rejects a user-controlled parent symlink before certification', () => {
    const root = fixture();
    const target = join(root, 'keys'),
      alias = join(root, 'key-alias');
    mkdirSync(target);
    symlinkSync(target, alias);
    expect(() => assertControlPaths({ publicKey: join(alias, 'public.pem') })).toThrow(
      'RELEASE_FLOW_CONTROL_SYMLINK:publicKey',
    );
  });
  it('accepts ordinary directories including the supported macOS temporary root', () => {
    const root = fixture();
    expect(() =>
      assertControlPaths({ publicKey: join(root, 'public.pem'), outputDir: join(root, 'export') }),
    ).not.toThrow();
  });
});

describe('publication run asset binding', () => {
  const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
  function assets(version: string) {
    const directory = fixture();
    const artifacts = Object.fromEntries(
      ['package', 'sbom', 'site'].map((kind) => {
        const file = `${kind}.tgz`,
          bytes = `${kind}:${version}`;
        writeFileSync(join(directory, file), bytes);
        return [kind, { file, sha256: sha(bytes) }];
      }),
    );
    const manifest = JSON.stringify({
      schemaVersion: '1.0.0',
      release: {
        repository: 'aarusso-nyx/devai',
        package: '@aarusso-nyx/devai',
        version,
        tag: `v${version}`,
      },
      artifacts,
    });
    writeFileSync(join(directory, 'release-manifest.json'), manifest);
    const files: Record<string, string> = { 'release-manifest.json': sha(manifest) };
    for (const artifact of Object.values(artifacts)) files[artifact.file] = artifact.sha256;
    const sums =
      Object.entries(files)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, digest]) => `${digest}  ${name}`)
        .join('\n') + '\n';
    writeFileSync(join(directory, 'SHA256SUMS'), sums);
    files.SHA256SUMS = sha(sums);
    return { directory, files };
  }
  it('accepts the exact manifest-bound promoted bytes', () => {
    const release = assets('2.7.1');
    expect(() => assertPromotedAssets(release.files, release.directory)).not.toThrow();
  });
  it('rejects a complete valid promoted asset set belonging to another release', () => {
    const release = assets('2.7.1'),
      other = assets('2.7.2');
    expect(() => assertPromotedAssets(release.files, other.directory)).toThrow(
      'RELEASE_FLOW_PUBLICATION_PROMOTION_MISMATCH',
    );
  });
});

describe('resumable release checkpoints', () => {
  it('recovers only abandoned journal locks', () => {
    const path = join(fixture(), 'journal.json');
    writeFileSync(`${path}.lock`, `${process.pid}\n`);
    expect(() => recoverJournal(path)).toThrow('RELEASE_FLOW_LOCK_LIVE');
    writeFileSync(`${path}.lock`, '99999999\n');
    recoverJournal(path);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it('rechecks a completed output without executing the expensive operation again', () => {
    const root = fixture(),
      path = join(root, 'journal.json');
    const journal = { phases: {} };
    let executions = 0,
      verifications = 0;
    const execute = () => {
      executions++;
      return 'receipt';
    };
    const verify = (value: string) => {
      verifications++;
      expect(value).toBe('receipt');
    };
    checkpoint(path, journal, 'rc', execute, verify);
    checkpoint(path, JSON.parse(readFileSync(path, 'utf8')), 'rc', execute, verify);
    expect(executions).toBe(1);
    expect(verifications).toBe(2);
  });
  it('does not mark an interrupted or failing phase complete', () => {
    const path = join(fixture(), 'journal.json'),
      journal = { phases: {} };
    expect(() =>
      checkpoint(
        path,
        journal,
        'rc',
        () => {
          throw new Error('timeout');
        },
        () => {},
      ),
    ).toThrow('timeout');
    expect(JSON.parse(readFileSync(path, 'utf8')).phases.rc.status).toBe('running');
    checkpoint(
      path,
      journal,
      'rc',
      () => 'fresh receipt',
      (value: string) => expect(value).toBe('fresh receipt'),
    );
    expect(JSON.parse(readFileSync(path, 'utf8')).phases.rc.status).toBe('complete');
  });
  it('refuses a stale completed receipt instead of rerunning or relabelling it', () => {
    const path = join(fixture(), 'journal.json');
    const journal = { phases: { rc: { status: 'complete', value: 'changed receipt' } } };
    saveJournal(path, journal);
    expect(() =>
      checkpoint(
        path,
        journal,
        'rc',
        () => {
          throw new Error('must not run');
        },
        () => {
          throw new Error('receipt mismatch');
        },
      ),
    ).toThrow('receipt mismatch');
  });
  it.each([[{ name: 'package' }], { name: 'package' }, { package: { name: 'package' } }])(
    'accepts a single npm result in supported shapes',
    (shape) => {
      expect(oneNpmResult(shape)).toEqual({ name: 'package' });
    },
  );
  it.each([[], [{ name: 'a' }, { name: 'b' }], { a: {}, b: {} }, null])(
    'refuses ambiguous npm responses',
    (shape) => {
      expect(() => oneNpmResult(shape)).toThrow('RELEASE_FLOW_NPM_RESPONSE_AMBIGUOUS');
    },
  );
  it.each([
    { response: { latest: '2.7.0', next: '1.5.0-rc.1' } },
    { response: [{ latest: '2.7.0', next: '1.5.0-rc.1' }] },
  ])('accepts registry dist-tags as an object or a single result', ({ response }) => {
    expect(normalizeNpmDistTags(response)).toEqual({ latest: '2.7.0', next: '1.5.0-rc.1' });
  });
  it.each(
    [
      [],
      [{ latest: '2.7.0' }, { latest: '2.7.1' }],
      [[{ latest: '2.7.1' }]],
      { latest: { latest: '2.7.1' } },
      {},
      null,
      '2.7.1',
      { latest: 271 },
    ].map((response) => ({ response })),
  )('refuses ambiguous or malformed registry dist-tags', ({ response }) => {
    expect(() => normalizeNpmDistTags(response)).toThrow('RELEASE_FLOW_NPM_RESPONSE_AMBIGUOUS');
  });
});

describe('isolated documentation preparation', () => {
  function repository() {
    const root = fixture();
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'docs/site'), { recursive: true });
    writeFileSync(
      join(repo, 'docs/site/package.json'),
      JSON.stringify({
        private: true,
        scripts: {
          'security:check': "node -e \"require('node:fs').writeFileSync('audit-ran','yes')\"",
        },
      }),
    );
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init', '--quiet');
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    );
    return { root, repo };
  }
  it('runs the committed security command outside the candidate and removes preflight scratch', () => {
    const { root, repo } = repository();
    const result = buildDocs({ repo, parent: root, mode: 'preflight' });
    expect(existsSync(join(repo, 'docs/site/audit-ran'))).toBe(false);
    expect(existsSync(result.directory)).toBe(false);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })).toBe(
      '',
    );
  });
  it('stages exactly the committed source without running a build', () => {
    const { root, repo } = repository();
    const result = buildDocs({ repo, parent: root, mode: 'stage' });
    expect(readFileSync(join(result.source, 'docs/site/package.json'), 'utf8')).toBe(
      readFileSync(join(repo, 'docs/site/package.json'), 'utf8'),
    );
    expect(existsSync(join(result.source, 'docs/site/audit-ran'))).toBe(false);
    expect(existsSync(join(repo, 'docs/site/docs'))).toBe(false);
  });
  it('rejects committed symlinks before extracting the snapshot', () => {
    const { root, repo } = repository();
    symlinkSync(root, join(repo, 'docs/site/escape'));
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '--quiet',
        '-m',
        'fixture symlink',
      ],
      { cwd: repo },
    );
    expect(() => buildDocs({ repo, parent: root, mode: 'stage' })).toThrow(
      'DOCS_BUILD_SPECIAL_SOURCE',
    );
  });
  it('refuses a staging directory inside the candidate and dirty source input', () => {
    const { repo } = repository();
    expect(() => buildDocs({ repo, parent: repo, mode: 'preflight' })).toThrow(
      'DOCS_BUILD_INSIDE_CANDIDATE',
    );
    writeFileSync(join(repo, 'untracked'), 'unsafe');
    expect(() => buildDocs({ repo, mode: 'preflight' })).toThrow('RELEASE_CANDIDATE_DIRTY');
  });
});
