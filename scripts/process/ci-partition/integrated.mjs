import { request } from 'node:https';
import {
  mkdtempSync,
  chmodSync,
  rmSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  lstatSync,
  statSync,
  accessSync,
  constants,
} from 'node:fs';
import { join, delimiter, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cappedCopy, eventIdentity, runBounded } from './guards.mjs';
import { verifiedTar } from './verified-buffer.mjs';
import { boundedProcess } from './bounded-process.mjs';
// Public key bytes from the Git project, retained locally for independent provenance review.
// A matching digest or valid signature is not a current key trust or revocation decision.
const KEY_FILE = fileURLToPath(new URL('./git-signing-key.asc', import.meta.url));
const PIN = {
  version: '2.47.3',
  url: 'https://www.kernel.org/pub/software/scm/git/git-2.47.3.tar.xz',
  sha256: '9c2eb1250781b3e5bfef098572d07fdf132d67e6c065e4307332ade9819a1501',
};
const fail = () => {
  throw Error('REFUSED');
};
// Resolve exactly the first executable selected by PATH without executing an untrusted `which`.
function pathGit(path) {
  if (typeof path !== 'string' || !path || path.includes('\n') || path.includes('\r')) fail();
  for (const dir of path.split(delimiter)) {
    if (!dir) fail();
    const candidate = resolve(dir, 'git');
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // The process or PATH entry may already be unavailable.
    }
  }
  fail();
}

export async function download(
  url,
  path,
  deadline,
  cap = 16777216,
  remainingRedirects = 3,
  transport = request,
) {
  const left = deadline - Date.now();
  if (!Number.isSafeInteger(deadline) || left <= 0 || left > 2147483647) fail();
  let active;
  const timeout = setTimeout(() => active?.destroy(Error('REFUSED')), left);
  async function follow(next, n) {
    const u = new URL(next);
    if (u.protocol !== 'https:' || u.username || u.password || Date.now() >= deadline) fail();
    const response = await new Promise((resolve, reject) => {
      const req = transport(u, resolve);
      active = req;
      req.on('error', reject);
      req.end();
    });
    active = response;
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = response.headers.location;
      response.destroy();
      if (!location || n <= 0) fail();
      return follow(new URL(location, u).href, n - 1);
    }
    if (response.statusCode !== 200) {
      response.destroy();
      fail();
    }
    await cappedCopy(response, path, cap);
  }
  try {
    await follow(url, remainingRedirects);
  } finally {
    clearTimeout(timeout);
  }
}
async function output(exe, args, deadline) {
  const left = deadline - Date.now();
  if (!Number.isSafeInteger(deadline) || left <= 0 || left > 2147483647) fail();
  return new Promise((resolve, reject) => {
    let value = '',
      bad = false;
    const p = spawn(exe, args, { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let timer = setTimeout(() => {
      bad = true;
      try {
        process.kill(-p.pid, 'SIGKILL');
      } catch {
        // The process or PATH entry may already be unavailable.
      }
    }, left);
    p.stdout.on('data', (c) => {
      value += c;
      if (value.length > 4096) {
        bad = true;
        try {
          process.kill(-p.pid, 'SIGKILL');
        } catch {
          // The process or PATH entry may already be unavailable.
        }
      }
    });
    p.on('error', () => {
      bad = true;
    });
    p.on('close', (code, signal) => {
      clearTimeout(timer);
      if (bad || code !== 0 || signal) reject(Error('REFUSED'));
      else resolve(value.trim());
    });
  });
}
// Experimental; caller must authenticate the event environment and ensure exclusive runner access.
export async function provision({
  env = process.env,
  manifest = '.devai/config/toolchain.json',
  pin = PIN,
  fetch = download,
  run = runBounded,
  read = output,
  verify = verifiedTar,
  extract = boundedProcess,
  deadline = Date.now() + 600000,
}) {
  if (
    !env.RUNNER_TEMP ||
    /[\r\n]/.test(env.RUNNER_TEMP) ||
    !env.GITHUB_PATH ||
    !env.GITHUB_ENV ||
    !env.GITHUB_EVENT_PATH ||
    !['pull_request', 'merge_group'].includes(env.GITHUB_EVENT_NAME)
  )
    fail();
  const identity = eventIdentity(env.GITHUB_EVENT_PATH, env.GITHUB_EVENT_NAME);
  if (JSON.parse(readFileSync(manifest, 'utf8')).runtimes.git !== pin.version) fail();
  const work = mkdtempSync(join(env.RUNNER_TEMP, 'devai-pr-git-'));
  chmodSync(work, 0o700);
  const st = lstatSync(work);
  if (!st.isDirectory() || st.mode & 0o077 || (process.getuid && st.uid !== process.getuid()))
    fail();
  const archive = join(work, 'source.tar.xz'),
    src = join(work, 'source'),
    prefix = join(work, 'install');
  // Appending to two runner files cannot be transactional. Once a handoff write
  // is attempted, retain the installation even on failure so any complete line
  // already written cannot point at deleted files. The failed step remains failed.
  let handoffStarted = false;
  try {
    await fetch(pin.url, archive, deadline);
    const a = lstatSync(archive);
    if (!a.isFile() || a.size > 16777216) fail();
    if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== pin.sha256) fail();
    const sig = join(work, 'source.tar.sign');
    await fetch(
      'https://www.kernel.org/pub/software/scm/git/git-2.47.3.tar.sign',
      sig,
      deadline,
      65536,
    );
    const verified = await verify({
      archive,
      signature: sig,
      keyFile: KEY_FILE,
      privateParent: work,
      primary: '96E07AF25771955980DAD10020D04E5A713660A7',
      signing: 'E1F036B1FEE7221FC778ECEFB0B5E88696AFE6CB',
      sourceDigest: pin.sha256,
      keyDigest: '8ce1371362ceaf056652bbe988287bcf5f5cf9172e3266c4d335fd8ea46cdef0',
      deadline,
    });
    if (!Buffer.isBuffer(verified)) fail();
    await run('mkdir', [src], { deadline });
    await extract('tar', ['-xf', '-', '--strip-components=1', '-C', src], {
      input: verified,
      deadline,
      maxOutput: 65536,
    });
    await run('make', ['configure'], { cwd: src, deadline });
    await run('./configure', [`--prefix=${prefix}`, '--without-tcltk'], { cwd: src, deadline });
    await run('make', ['-j2', 'NO_GETTEXT=YesPlease'], { cwd: src, deadline });
    await run('make', ['install', 'NO_GETTEXT=YesPlease'], { cwd: src, deadline });
    const git = join(prefix, 'bin', 'git'),
      g = lstatSync(git);
    if (
      !g.isFile() ||
      !(g.mode & 0o111) ||
      g.mode & 0o022 ||
      (process.getuid && g.uid !== process.getuid()) ||
      realpathSync(git) !== git
    )
      fail();
    if ((await read(git, ['--version'], deadline)) !== `git version ${pin.version}`) fail();
    if ((await read(git, ['rev-parse', 'HEAD'], deadline)) !== identity.candidate) fail();
    const tree = await read(git, ['rev-parse', 'HEAD^{tree}'], deadline);
    if (!/^[a-f0-9]{40}$/.test(tree)) fail();
    if ((await read(git, ['status', '--porcelain', '--untracked-files=all'], deadline)) !== '')
      fail();
    if (
      (await read(git, ['merge-base', identity.base, identity.candidate], deadline)) !==
      identity.base
    )
      fail();
    await run(git, ['diff', '--quiet'], { deadline });
    await run(git, ['diff', '--name-only', identity.base, identity.candidate], { deadline });
    if (
      !Number.isSafeInteger(deadline) ||
      deadline - Date.now() <= 0 ||
      deadline - Date.now() > 2147483647
    )
      fail();
    const bindingPath = join(work, 'binding.json');
    writeFileSync(bindingPath, JSON.stringify({ git, tree, ...identity }) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    if (deadline - Date.now() <= 0) fail();
    handoffStarted = true;
    writeFileSync(env.GITHUB_ENV, `DEVAI_BINDING_PATH=${bindingPath}\n`, { flag: 'a' });
    writeFileSync(env.GITHUB_PATH, join(prefix, 'bin') + '\n', { flag: 'a' });
    return { work, git, tree, bindingPath, ...identity };
  } catch (e) {
    if (!handoffStarted) rmSync(work, { recursive: true, force: true });
    throw e;
  }
}

export async function verifyPath({
  expectedGit,
  manifest,
  env = process.env,
  deadline = Date.now() + 30000,
  read = output,
}) {
  if (
    !env.DEVAI_BINDING_PATH ||
    !env.RUNNER_TEMP ||
    !env.GITHUB_EVENT_PATH ||
    !['pull_request', 'merge_group'].includes(env.GITHUB_EVENT_NAME)
  )
    fail();
  const { candidate, base } = eventIdentity(env.GITHUB_EVENT_PATH, env.GITHUB_EVENT_NAME);
  const root = realpathSync(env.RUNNER_TEMP);
  const bindingReal = realpathSync(env.DEVAI_BINDING_PATH);
  if (
    bindingReal !== env.DEVAI_BINDING_PATH ||
    !bindingReal.startsWith(root + '/devai-pr-git-') ||
    !bindingReal.endsWith('/binding.json') ||
    bindingReal === env.GITHUB_EVENT_PATH ||
    bindingReal === env.GITHUB_PATH
  )
    fail();
  const bindingStat = lstatSync(env.DEVAI_BINDING_PATH);
  if (
    !bindingStat.isFile() ||
    bindingStat.mode & 0o077 ||
    (process.getuid && bindingStat.uid !== process.getuid()) ||
    bindingStat.size > 4096
  )
    fail();
  const binding = JSON.parse(readFileSync(env.DEVAI_BINDING_PATH, 'utf8'));
  expectedGit = expectedGit ?? binding.git;
  if (binding.git !== expectedGit || binding.candidate !== candidate || binding.base !== base)
    fail();
  if (JSON.parse(readFileSync(manifest, 'utf8')).runtimes.git !== PIN.version) fail();
  const st = lstatSync(expectedGit);
  if (
    !st.isFile() ||
    !(st.mode & 0o111) ||
    st.mode & 0o022 ||
    (process.getuid && st.uid !== process.getuid()) ||
    realpathSync(expectedGit) !== expectedGit
  )
    fail();
  const gitVersion = await read(expectedGit, ['--version'], deadline);
  if (
    pathGit(env.PATH) !== expectedGit ||
    gitVersion !== `git version ${PIN.version}` ||
    (await read(expectedGit, ['rev-parse', 'HEAD'], deadline)) !== candidate
  )
    fail();
  const tree = await read(expectedGit, ['rev-parse', 'HEAD^{tree}'], deadline);
  if (
    !/^[a-f0-9]{40}$/.test(tree) ||
    (await read(expectedGit, ['merge-base', base, candidate], deadline)) !== base ||
    (await read(expectedGit, ['status', '--porcelain', '--untracked-files=all'], deadline)) !== ''
  )
    fail();
  if (binding.tree !== tree) fail();
  return { candidate, base, tree, gitVersion };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try {
    if (process.argv[2] === 'provision') {
      const result = await provision();
      process.stdout.write('Git provision passed\n');
      process.stdout.write(result.bindingPath + '\n');
    } else if (process.argv[2] === 'verify') {
      await verifyPath({
        expectedGit: process.env.DEVAI_EXPECTED_GIT,
        manifest: '.devai/config/toolchain.json',
      });
      process.stdout.write('Git verification passed\n');
    } else fail();
  } catch {
    process.stderr.write('Git operation refused\n');
    process.exitCode = 1;
  }
}
