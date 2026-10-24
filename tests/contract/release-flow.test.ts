import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devai-release-flow-'));
  roots.push(root);
  return root;
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
  await delay(100);
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe('host validation admission', () => {
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
