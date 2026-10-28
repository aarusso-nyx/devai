// Independent adversarial tests of the experimental Git installer; fixtures are not publisher evidence.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const { provision, verifyPath } = await import(
  pathToFileURL(join(root, 'scripts/process/ci-partition/integrated.mjs')).href
);
const { boundedProcess } = await import(
  pathToFileURL(join(root, 'scripts/process/ci-partition/bounded-process.mjs')).href
);
const { verifiedTar } = await import(
  pathToFileURL(join(root, 'scripts/process/ci-partition/verified-buffer.mjs')).href
);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const homes: string[] = [];
const temp = () => {
  const p = realpathSync(mkdtempSync(join('/tmp', 'gpi-')));
  homes.push(p);
  return p;
};
afterEach(() => {
  for (const p of homes.splice(0)) rmSync(p, { recursive: true, force: true });
});
const candidate = 'a'.repeat(40),
  base = 'b'.repeat(40),
  tree = 'c'.repeat(40);
const source = Buffer.from('controlled compressed source fixture');
const pin = { version: '2.47.3', url: 'https://example.invalid/source', sha256: hash(source) };
function installer() {
  const dir = temp();
  const manifest = join(dir, 'manifest.json'),
    event = join(dir, 'event.json'),
    path = join(dir, 'github-path'),
    envfile = join(dir, 'github-env');
  writeFileSync(manifest, JSON.stringify({ runtimes: { git: pin.version } }));
  writeFileSync(
    event,
    JSON.stringify({ pull_request: { head: { sha: candidate }, base: { sha: base } } }),
  );
  writeFileSync(path, '');
  writeFileSync(envfile, '');
  const env = {
    RUNNER_TEMP: dir,
    GITHUB_PATH: path,
    GITHUB_ENV: envfile,
    GITHUB_EVENT_PATH: event,
    GITHUB_EVENT_NAME: 'pull_request',
    DEVAI_GIT_KEY_FILE: join(dir, 'public-key'),
  };
  const fetch = async (_url: string, target: string) =>
    writeFileSync(target, target.endsWith('.xz') ? source : 'signature');
  const run = async (exe: string, args: string[], options: { cwd?: string }) => {
    if (exe === 'mkdir') {
      if (!args[0]) throw Error('fixture mkdir target missing');
      mkdirSync(args[0]);
    }
    if (exe === 'make' && args[0] === 'install') {
      if (!options.cwd) throw Error('fixture build directory missing');
      const bin = join(options.cwd, '..', 'install', 'bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'git'), '#!/bin/sh\n', { mode: 0o700 });
    }
  };
  const read = async (_exe: string, args: string[]) =>
    args[0] === '--version'
      ? 'git version 2.47.3'
      : args[0] === 'status'
        ? ''
        : args[1] === 'HEAD^{tree}'
          ? tree
          : args[0] === 'merge-base'
            ? base
            : candidate;
  const verify = async () => Buffer.from('verified tar');
  const extract = async () => Buffer.alloc(0);
  return { dir, manifest, env, fetch, run, read, verify, extract, pin };
}

describe('installer and handoff adversarial cases', () => {
  it('requests stripped installation without hard-linked Git aliases', async () => {
    const f = installer();
    const installations: string[][] = [];
    const run = async (exe: string, args: string[], options: { cwd?: string }) => {
      if (exe === 'make' && args[0] === 'install') installations.push(args);
      await f.run(exe, args, options);
    };
    await provision({ ...f, run });
    expect(installations).toHaveLength(1);
    expect(installations[0]).toContain('NO_INSTALL_HARDLINKS=YesPlease');
    expect(installations[0]).toContain('INSTALL_STRIP=-s');
  });

  it('refuses a hard-linked, oversized or symlinked executable before handoff', async () => {
    for (const kind of ['hard-link', 'oversized', 'symlink']) {
      const f = installer();
      const run = async (exe: string, args: string[], options: { cwd?: string }) => {
        await f.run(exe, args, options);
        if (exe !== 'make' || args[0] !== 'install' || !options.cwd) return;
        const git = join(options.cwd, '..', 'install', 'bin', 'git');
        if (kind === 'hard-link') linkSync(git, join(f.dir, 'alias'));
        if (kind === 'oversized') writeFileSync(git, Buffer.alloc(8 * 1024 * 1024 + 1));
        if (kind === 'symlink') {
          const alternate = join(f.dir, 'alternate');
          renameSync(git, alternate);
          symlinkSync(alternate, git);
        }
      };
      await expect(provision({ ...f, run })).rejects.toThrow();
      expect(readFileSync(f.env.GITHUB_PATH, 'utf8')).toBe('');
      expect(readFileSync(f.env.GITHUB_ENV, 'utf8')).toBe('');
    }
  });

  it('refuses hard links and oversized executables on subsequent verification', async () => {
    for (const kind of ['hard-link', 'oversized']) {
      const f = installer();
      const result = await provision(f);
      const environment = {
        ...f.env,
        DEVAI_BINDING_PATH: result.bindingPath,
        PATH: join(result.work, 'install', 'bin'),
      };
      await expect(
        verifyPath({ manifest: f.manifest, env: environment, read: f.read }),
      ).resolves.toMatchObject({ candidate });
      if (kind === 'hard-link') linkSync(result.git, join(f.dir, 'alias'));
      if (kind === 'oversized') writeFileSync(result.git, Buffer.alloc(8 * 1024 * 1024 + 1));
      await expect(
        verifyPath({ manifest: f.manifest, env: environment, read: f.read }),
      ).rejects.toThrow();
    }
  });

  it('hands off one installed identity and rejects a PATH shadow', async () => {
    const f = installer();
    const result = await provision(f);
    expect(readFileSync(f.env.GITHUB_ENV, 'utf8')).toBe(
      `DEVAI_BINDING_PATH=${result.bindingPath}\n`,
    );
    expect(readFileSync(f.env.GITHUB_PATH, 'utf8')).toBe(
      `${join(result.work, 'install', 'bin')}\n`,
    );
    const environment = {
      ...f.env,
      DEVAI_BINDING_PATH: result.bindingPath,
      PATH: join(result.work, 'install', 'bin'),
    };
    expect(
      (await verifyPath({ manifest: f.manifest, env: environment, read: f.read })).candidate,
    ).toBe(candidate);
    const shadow = join(f.dir, 'shadow');
    mkdirSync(shadow);
    writeFileSync(join(shadow, 'git'), '#!/bin/sh\n', { mode: 0o700 });
    await expect(
      verifyPath({
        manifest: f.manifest,
        env: { ...environment, PATH: `${shadow}:${environment.PATH}` },
        read: f.read,
      }),
    ).rejects.toThrow();
  });
  it('rejects an in-place substituted executable that reports the same version and delegates Git operations', async () => {
    const f = installer();
    const originalRun = f.run;
    const run = async (exe: string, args: string[], options: { cwd?: string }) => {
      await originalRun(exe, args, options);
      if (exe === 'make' && args[0] === 'install') {
        if (!options.cwd) throw Error('fixture build directory missing');
        const git = join(options.cwd, '..', 'install', 'bin', 'git');
        writeFileSync(
          git,
          `#!/bin/sh\ncase "$1:$2" in\n  --version:) printf '%s\\n' 'git version 2.47.3';;\n  rev-parse:HEAD) printf '%s\\n' '${candidate}';;\n  rev-parse:HEAD^{tree}) printf '%s\\n' '${tree}';;\n  merge-base:*) printf '%s\\n' '${base}';;\n  status:*) exit 0;;\n  *) exit 1;;\nesac\n`,
          { mode: 0o700 },
        );
      }
    };
    const result = await provision({ ...f, run });
    const environment = {
      ...f.env,
      DEVAI_BINDING_PATH: result.bindingPath,
      PATH: join(result.work, 'install', 'bin'),
    };
    await expect(verifyPath({ manifest: f.manifest, env: environment })).resolves.toMatchObject({
      candidate,
    });
    const delegate = join(f.dir, 'delegate');
    copyFileSync(result.git, delegate);
    writeFileSync(
      result.git,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '%s\\n' 'git version 2.47.3'; else exec "${delegate}" "$@"; fi\n`,
      { mode: 0o700 },
    );
    await expect(verifyPath({ manifest: f.manifest, env: environment })).rejects.toThrow();
  });
  it('refuses executable content, inode, symlink and binding substitutions', async () => {
    for (const kind of ['in-place', 'same-bytes-new-inode', 'symlink', 'binding-digest']) {
      const f = installer();
      const result = await provision(f);
      const environment = {
        ...f.env,
        DEVAI_BINDING_PATH: result.bindingPath,
        PATH: join(result.work, 'install', 'bin'),
      };
      await expect(
        verifyPath({ manifest: f.manifest, env: environment, read: f.read }),
      ).resolves.toMatchObject({ candidate });
      if (kind === 'in-place') writeFileSync(result.git, '#!/bin/sh\n# changed\n', { mode: 0o700 });
      if (kind === 'same-bytes-new-inode') {
        const alternate = join(f.dir, 'alternate');
        copyFileSync(result.git, alternate);
        renameSync(alternate, result.git);
      }
      if (kind === 'symlink') {
        const alternate = join(f.dir, 'alternate');
        copyFileSync(result.git, alternate);
        unlinkSync(result.git);
        symlinkSync(alternate, result.git);
      }
      if (kind === 'binding-digest') {
        const binding = JSON.parse(readFileSync(result.bindingPath, 'utf8'));
        binding.gitIdentity.sha256 = '0'.repeat(64);
        writeFileSync(result.bindingPath, JSON.stringify(binding));
      }
      await expect(
        verifyPath({ manifest: f.manifest, env: environment, read: f.read }),
      ).rejects.toThrow();
    }
  });
  it('refuses an executable changed during version and identity probes', async () => {
    const f = installer();
    const result = await provision(f);
    const environment = {
      ...f.env,
      DEVAI_BINDING_PATH: result.bindingPath,
      PATH: join(result.work, 'install', 'bin'),
    };
    const read = async (exe: string, args: string[]) => {
      const output = await f.read(exe, args);
      if (args[0] === '--version')
        writeFileSync(result.git, '#!/bin/sh\n# changed during probe\n', { mode: 0o700 });
      return output;
    };
    await expect(verifyPath({ manifest: f.manifest, env: environment, read })).rejects.toThrow();
  });
  it('refuses manifest drift and PATH substitution after initial verification', async () => {
    const f = installer();
    const result = await provision(f);
    const environment = {
      ...f.env,
      DEVAI_BINDING_PATH: result.bindingPath,
      PATH: join(result.work, 'install', 'bin'),
    };
    await expect(
      verifyPath({ manifest: f.manifest, env: environment, read: f.read }),
    ).resolves.toMatchObject({ candidate });
    writeFileSync(f.manifest, JSON.stringify({ runtimes: { git: '9.9.9' } }));
    await expect(
      verifyPath({ manifest: f.manifest, env: environment, read: f.read }),
    ).rejects.toThrow();
    writeFileSync(f.manifest, JSON.stringify({ runtimes: { git: '2.47.3' } }));
    const shadow = join(f.dir, 'substitution');
    mkdirSync(shadow);
    writeFileSync(join(shadow, 'git'), '#!/bin/sh\n', { mode: 0o700 });
    await expect(
      verifyPath({
        manifest: f.manifest,
        env: { ...environment, PATH: `${shadow}:${environment.PATH}` },
        read: f.read,
      }),
    ).rejects.toThrow();
  });
  it('refuses altered source and interrupted installation without publishing a path', async () => {
    for (const kind of ['source', 'signature', 'extract', 'build']) {
      const f = installer();
      const args = {
        ...f,
        fetch:
          kind === 'source'
            ? async (_url: string, target: string) => writeFileSync(target, 'altered')
            : f.fetch,
        verify:
          kind === 'signature'
            ? async () => {
                throw Error('untrusted signature');
              }
            : f.verify,
        extract:
          kind === 'extract'
            ? async () => {
                throw Error('interrupted');
              }
            : f.extract,
        run:
          kind === 'build'
            ? async () => {
                throw Error('interrupted');
              }
            : f.run,
      };
      await expect(provision(args)).rejects.toThrow();
      expect(readFileSync(f.env.GITHUB_PATH, 'utf8')).toBe('');
      expect(readFileSync(f.env.GITHUB_ENV, 'utf8')).toBe('');
      expect(readdirSync(f.dir).filter((name) => name.startsWith('devai-pr-git-'))).toEqual([]);
    }
  });
  it.each([
    ['source-download', 'source-download'],
    ['source-digest', 'source-digest'],
    ['signature-download', 'signature-download'],
    ['signature-verification', 'signature-verification'],
    ['extraction', 'extraction'],
    ['build', 'build'],
    ['installation', 'installation'],
    ['identity', 'identity'],
  ])(
    'identifies %s failure with the fixed %s stage and refuses handoff',
    async (failure, expected) => {
      const f = installer();
      const stages: string[] = [];
      const marker = '::error::untrusted-diagnostic';
      const args = {
        ...f,
        onStage: (stage: string) => stages.push(stage),
        fetch: async (url: string, target: string) => {
          if (failure === 'source-download' && target.endsWith('.xz')) throw Error(marker);
          if (failure === 'signature-download' && !target.endsWith('.xz')) throw Error(marker);
          if (failure === 'source-digest' && target.endsWith('.xz'))
            return writeFileSync(target, 'altered');
          return f.fetch(url, target);
        },
        verify:
          failure === 'signature-verification'
            ? async () => {
                throw Error(marker);
              }
            : f.verify,
        extract:
          failure === 'extraction'
            ? async () => {
                throw Error(marker);
              }
            : f.extract,
        run: async (exe: string, argv: string[], options: { cwd?: string }) => {
          if (failure === 'build' && exe === 'make' && argv[0] === 'configure') throw Error(marker);
          if (failure === 'installation' && exe === 'make' && argv[0] === 'install')
            throw Error(marker);
          return f.run(exe, argv, options);
        },
        read: failure === 'identity' ? async () => marker : f.read,
      };
      await expect(provision(args)).rejects.toThrow();
      expect(stages.at(-1)).toBe(expected);
      expect(stages).not.toContain(marker);
      expect(readFileSync(f.env.GITHUB_PATH, 'utf8')).toBe('');
      expect(readFileSync(f.env.GITHUB_ENV, 'utf8')).toBe('');
      expect(readdirSync(f.dir).filter((name) => name.startsWith('devai-pr-git-'))).toEqual([]);
    },
  );
  it('retains the installation after either handoff append is attempted and fails', async () => {
    for (const failure of ['env', 'path']) {
      const f = installer();
      const unwritable = join(f.dir, 'unwritable');
      mkdirSync(unwritable);
      if (failure === 'env') f.env.GITHUB_ENV = unwritable;
      else f.env.GITHUB_PATH = unwritable;
      const stages: string[] = [];
      await expect(
        provision({ ...f, onStage: (stage: string) => stages.push(stage) }),
      ).rejects.toThrow();
      expect(stages.at(-1)).toBe('handoff');
      const work = readdirSync(f.dir).filter((name) => name.startsWith('devai-pr-git-'));
      expect(work).toHaveLength(1);
      if (!work[0]) throw Error('fixture installation missing');
      const binding = join(f.dir, work[0], 'binding.json');
      expect(existsSync(binding)).toBe(true);
      expect(existsSync(join(f.dir, work[0], 'install', 'bin', 'git'))).toBe(true);
      if (failure === 'env') expect(readFileSync(f.env.GITHUB_PATH, 'utf8')).toBe('');
      else expect(readFileSync(f.env.GITHUB_ENV, 'utf8')).toBe(`DEVAI_BINDING_PATH=${binding}\n`);
    }
  });
  it('fails and retains the installation after a partial append to either handoff file', async () => {
    for (const failure of ['env', 'path']) {
      const f = installer();
      const selected = failure === 'env' ? f.env.GITHUB_ENV : f.env.GITHUB_PATH;
      const original = fs.writeFileSync;
      try {
        fs.writeFileSync = ((
          path: fs.PathOrFileDescriptor,
          data: string | NodeJS.ArrayBufferView,
          options?: fs.WriteFileOptions,
        ) => {
          if (path === selected) {
            original(path, String(data).slice(0, 5), options);
            throw Error('simulated partial append');
          }
          return original(path, data, options);
        }) as typeof fs.writeFileSync;
        syncBuiltinESMExports();
        await expect(provision(f)).rejects.toThrow();
      } finally {
        fs.writeFileSync = original;
        syncBuiltinESMExports();
      }
      expect(readFileSync(selected, 'utf8')).toHaveLength(5);
      const work = readdirSync(f.dir).filter((name) => name.startsWith('devai-pr-git-'));
      expect(work).toHaveLength(1);
      if (!work[0]) throw Error('fixture installation missing');
      expect(existsSync(join(f.dir, work[0], 'binding.json'))).toBe(true);
      if (failure === 'env') expect(readFileSync(f.env.GITHUB_PATH, 'utf8')).toBe('');
      else
        expect(readFileSync(f.env.GITHUB_ENV, 'utf8')).toBe(
          `DEVAI_BINDING_PATH=${join(f.dir, work[0], 'binding.json')}\n`,
        );
    }
  });
  it('rejects a runner path containing workflow command injection before either handoff', async () => {
    const f = installer();
    f.env.RUNNER_TEMP = `${f.dir}\n::error::injected`;
    await expect(provision(f)).rejects.toThrow();
    expect(readFileSync(f.env.GITHUB_ENV, 'utf8')).toBe('');
    expect(readFileSync(f.env.GITHUB_PATH, 'utf8')).toBe('');
    expect(readdirSync(f.dir).filter((name) => name.startsWith('devai-pr-git-'))).toEqual([]);
  });
  it('terminates a process at the shared deadline', async () => {
    await expect(
      boundedProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        deadline: Date.now() + 200,
      }),
    ).rejects.toThrow();
  });
  it('reports a fixed manifest stage without exposing a malicious path', () => {
    const f = installer();
    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts/process/ci-partition/integrated.mjs'), 'provision'],
      { cwd: f.dir, encoding: 'utf8', env: { ...process.env, ...f.env } },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('Git operation refused (manifest)\n');
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain(f.dir);
    expect(readFileSync(f.env.GITHUB_PATH, 'utf8')).toBe('');
    expect(readFileSync(f.env.GITHUB_ENV, 'utf8')).toBe('');
  });
  it('does not leak raw failures from its actual command line', () => {
    const f = installer(),
      marker = '::error::private-input';
    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts/process/ci-partition/integrated.mjs'), 'provision'],
      {
        encoding: 'utf8',
        env: { ...process.env, ...f.env, GITHUB_EVENT_PATH: join(f.dir, marker) },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain(marker);
    expect(result.stderr).toBe('Git operation refused (event)\n');
    expect(result.stdout).toBe('');
  });
});

describe('real detached-signature verification', () => {
  it('accepts a generated valid signing key and rejects changed bytes, signature, key and identity', async () => {
    const dir = temp(),
      home = join(dir, 'signer'),
      privateParent = join(dir, 'private');
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(privateParent, { mode: 0o700 });
    const gpg = (...args: string[]) => {
      const result = spawnSync('gpg', ['--homedir', home, '--batch', ...args], {
        encoding: 'utf8',
      });
      if (result.status !== 0) throw Error(`fixture gpg failed: ${result.stderr}`);
      return result.stdout;
    };
    gpg(
      '--passphrase',
      '',
      '--quick-generate-key',
      'Inspector Fixture <fixture@example.invalid>',
      'ed25519',
      'sign',
      '0',
    );
    const fingerprintLine = gpg('--with-colons', '--list-keys')
      .split('\n')
      .find((line) => line.startsWith('fpr:'));
    if (!fingerprintLine) throw Error('fixture fingerprint missing');
    const fingerprint = fingerprintLine.split(':')[9];
    if (!fingerprint) throw Error('fixture fingerprint missing');
    const plain = join(dir, 'source.tar'),
      archive = join(dir, 'source.tar.xz'),
      signature = join(dir, 'source.sign'),
      keyFile = join(dir, 'key');
    writeFileSync(plain, 'fixture tar bytes');
    const compressed = spawnSync('xz', ['-c', plain]);
    expect(compressed.status).toBe(0);
    writeFileSync(archive, compressed.stdout);
    gpg('--yes', '--output', signature, '--detach-sign', plain);
    const exported = spawnSync('gpg', ['--homedir', home, '--batch', '--export', fingerprint]);
    expect(exported.status).toBe(0);
    writeFileSync(keyFile, exported.stdout);
    const binding = {
      archive,
      signature,
      keyFile,
      privateParent,
      sourceDigest: hash(readFileSync(archive)),
      keyDigest: hash(readFileSync(keyFile)),
      primary: fingerprint,
      signing: fingerprint,
      deadline: Date.now() + 30000,
    };
    const verified = await verifiedTar(binding).catch(() => {
      throw Error('valid fixture verification refused');
    });
    expect(verified.toString()).toBe('fixture tar bytes');
    const original = readFileSync(archive);
    writeFileSync(archive, Buffer.from('changed source'));
    await expect(verifiedTar(binding)).rejects.toThrow();
    writeFileSync(archive, original);
    await expect(verifiedTar({ ...binding, sourceDigest: '0'.repeat(64) })).rejects.toThrow();
    await expect(verifiedTar({ ...binding, keyDigest: '0'.repeat(64) })).rejects.toThrow();
    await expect(verifiedTar({ ...binding, signing: '0'.repeat(40) })).rejects.toThrow();
    writeFileSync(signature, 'altered signature');
    await expect(verifiedTar(binding)).rejects.toThrow();
    writeFileSync(keyFile, 'substituted key');
    await expect(verifiedTar(binding)).rejects.toThrow();
  }, 60000);
});
