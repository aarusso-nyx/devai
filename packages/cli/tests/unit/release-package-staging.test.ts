import { execFileSync, spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../..');
const output = mkdtempSync(join(tmpdir(), 'devai-release-stage-test-'));
const SELECTED_RELEASE_VERSION = '2.4.0';
const TRUSTED_VERIFIER_PACKAGE_VERSION = '1.9.0';
const TRUSTED_VERIFIER_POLICY = JSON.parse(
  readFileSync(join(root, 'law/policy/trusted-local-rc-verifier-package.json'), 'utf8'),
) as {
  verifier: { provenance_sha256: string; source_commit: string };
};
const TRUSTED_VERIFIER_SOURCE_COMMIT = TRUSTED_VERIFIER_POLICY.verifier.source_commit;
const TRUSTED_VERIFIER_PROVENANCE_SHA256 = TRUSTED_VERIFIER_POLICY.verifier.provenance_sha256;

function manifestEnvironment(input: {
  readonly workspace: string;
  readonly output: string;
  readonly provenance?: string;
  readonly version?: string;
}) {
  const digest = 'a'.repeat(64);
  return {
    ...process.env,
    PACKAGE_NAME: '@aarusso-nyx/devai',
    RELEASE_TAG: `v${SELECTED_RELEASE_VERSION}`,
    PACKAGE_TARBALL: join(input.workspace, 'package.tgz'),
    SITE_ARCHIVE: join(input.workspace, 'site.tar.gz'),
    SBOM_FILE: join(input.workspace, 'sbom.json'),
    OUTPUT_FILE: input.output,
    COMMIT_SHA: 'b'.repeat(40),
    TREE_SHA: 'c'.repeat(40),
    LEDGER_VERIFIER_PACKAGE_VERSION: input.version ?? TRUSTED_VERIFIER_PACKAGE_VERSION,
    LEDGER_VERIFIER_PROVENANCE_SHA256: input.provenance ?? TRUSTED_VERIFIER_PROVENANCE_SHA256,
    LEDGER_POLICY_DIGEST: digest,
    LEDGER_ENVELOPE_SHA256: digest,
    LEDGER_RESULTS_SHA256: digest,
    LEDGER_ARTIFACTS_SHA256: digest,
    LEDGER_TASK_POLICY_SHA256: digest,
    LEDGER_TRUST_STORE_SHA256: digest,
    LEDGER_TOOLCHAIN_SHA256: digest,
    LEDGER_ENVIRONMENT_SHA256: digest,
    LEDGER_RELEASE_SIGNERS_SHA256: digest,
  };
}

afterAll(() => rmSync(output, { recursive: true, force: true }));

/**
 * One enforced deadline per bounded case or hook (#324). Every child of that case or hook gets
 * only the time remaining, so the children together never outrun the Vitest bound around them.
 * Each child leads its own process group. When the deadline passes, or a captured stream exceeds
 * its cap, the whole group gets SIGKILL; the helper then waits a bounded grace for `close` and,
 * if a descendant still holds the pipes, destroys them and fails instead of pending forever.
 * Only the deadline counts as a timeout: any other exit or signal is the child's own result.
 *
 * Known limits, documented rather than handled: a descendant that calls setsid or setpgid
 * leaves the group and escapes the group kill, and `close` proves only that every holder of
 * the child's pipes has closed them, not that every grandchild has exited.
 */
interface Deadline {
  readonly totalMs: number;
  remaining(): number;
}

function deadline(totalMs: number): Deadline {
  const end = performance.now() + totalMs;
  return { totalMs, remaining: () => Math.max(0, Math.floor(end - performance.now())) };
}

interface ChildResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Captured bytes per stream before the group is killed. A runaway guard, not a size limit
 * on legitimate output: `check --affected --task-plan --format json` printed more than 1 MiB
 * for a large diff, so the cap matches the 64 MiB `maxBuffer` the synchronous calls used.
 */
const OUTPUT_CAP_BYTES = 64 * 1024 * 1024;
/** How long `close` may take after the group kill before the pipes are destroyed. */
const CLOSE_GRACE_MS = 2_000;

function runBounded(
  command: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; env?: NodeJS.ProcessEnv }>,
  limit: Deadline,
): Promise<ChildResult> {
  const label = [command, ...args].join(' ');
  const remaining = limit.remaining();
  if (remaining === 0) {
    return Promise.reject(
      new Error(
        `${label} was not started: the ${String(limit.totalMs)} ms deadline of its case was already spent`,
      ),
    );
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const captured = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const bytes = { stdout: 0, stderr: 0 };
    let killReason: string | undefined;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(graceTimer);
      outcome();
    };
    const killGroup = (reason: string): void => {
      if (killReason !== undefined) return;
      killReason = reason;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The group is already gone.
      }
      graceTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        settle(() =>
          rejectPromise(
            new Error(
              `${label}: ${reason}; its process group was killed, but its pipes stayed open ${String(CLOSE_GRACE_MS)} ms later (a descendant outside the group still holds them)`,
            ),
          ),
        );
      }, CLOSE_GRACE_MS);
    };
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream].on('data', (chunk: Buffer) => {
        bytes[stream] += chunk.length;
        if (bytes[stream] > OUTPUT_CAP_BYTES) {
          killGroup(`its ${stream} exceeded the ${String(OUTPUT_CAP_BYTES)}-byte capture cap`);
          return;
        }
        captured[stream].push(chunk);
      });
    }
    const deadlineTimer = setTimeout(
      () => killGroup(`it exceeded the enforced ${String(limit.totalMs)} ms deadline of its case`),
      remaining,
    );
    child.on('error', (error) => settle(() => rejectPromise(error)));
    // `close` fires once every holder of the child's pipes has closed them.
    child.on('close', (status, signal) => {
      settle(() => {
        if (killReason !== undefined) {
          rejectPromise(new Error(`${label}: ${killReason}; its process group was killed`));
          return;
        }
        resolvePromise({
          status,
          signal,
          stdout: Buffer.concat(captured.stdout).toString('utf8'),
          stderr: Buffer.concat(captured.stderr).toString('utf8'),
        });
      });
    });
  });
}

/** Resolves with stdout on exit 0; otherwise fails with the child's own exit and stderr. */
async function execBounded(
  file: string,
  args: readonly string[],
  cwd: string,
  limit: Deadline,
): Promise<string> {
  const result = await runBounded(file, args, { cwd }, limit);
  if (result.status === 0) return result.stdout;
  throw new Error(
    `Command failed: ${[file, ...args].join(' ')} (exit ${String(result.status)}, signal ${String(result.signal)})\n${result.stderr}`,
  );
}

/** Each bounded case, and inside it the one deadline all its children share. */
const STAGE_CASE_TIMEOUT_MS = 180_000;
const STAGE_CASE_DEADLINE_MS = 170_000;
const ARCHIVE_CASE_TIMEOUT_MS = 120_000;
const ARCHIVE_CASE_DEADLINE_MS = 110_000;

describe('normalized release package staging', () => {
  it(
    'requires two byte-identical packs and excludes private workspace packages',
    async () => {
      const limit = deadline(STAGE_CASE_DEADLINE_MS);
      const staged = JSON.parse(
        await execBounded(
          process.execPath,
          [join(root, 'scripts/stage-release-package.mjs'), '--output', output],
          root,
          limit,
        ),
      ) as {
        tarball: string;
        sha256: string;
        sbom: string;
        sbom_subject_sha256: string;
        reproductions: number;
        version: string;
      };
      expect(staged.reproductions).toBe(2);
      expect(staged.version).toBe(SELECTED_RELEASE_VERSION);
      expect(staged.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(staged.sbom_subject_sha256).toBe(staged.sha256);
      const sbom = JSON.parse(readFileSync(staged.sbom, 'utf8')) as {
        metadata: { component: { hashes: Array<{ alg: string; content: string }> } };
      };
      expect(staged.sbom).toMatch(
        new RegExp(`devai-${SELECTED_RELEASE_VERSION.replaceAll('.', '\\.')}\\.cdx\\.json$`, 'u'),
      );
      expect(sbom.metadata.component.hashes).toContainEqual({
        alg: 'SHA-256',
        content: staged.sha256,
      });
      expect(JSON.stringify(sbom)).not.toContain('@devai-nyx/');
      const manifest = JSON.parse(
        await execBounded('tar', ['-xOf', staged.tarball, 'package/package.json'], root, limit),
      ) as Record<string, unknown>;
      expect(manifest).toMatchObject({
        name: '@aarusso-nyx/devai',
        version: SELECTED_RELEASE_VERSION,
      });
      expect(manifest).not.toHaveProperty('devDependencies');
      expect(JSON.stringify(manifest)).not.toMatch(/workspace:|@devai-nyx\//u);
      const packagePopulation = await execBounded('tar', ['-tzf', staged.tarball], root, limit);
      expect(packagePopulation).toContain('package/dist/runtime/evidence-verification/src/cli.js');
      expect(packagePopulation).not.toContain('package/dist/runtime/evidence-verification/test/');
      // Two full `pnpm pack` reproductions: 13 to 18 s alone on a loaded workstation. The
      // bound is the hang guard for that cost under load and in the RC coverage lane (#246);
      // the staging run and both `tar` reads share one deadline inside it (#324).
    },
    STAGE_CASE_TIMEOUT_MS,
  );

  it('accepts a valid child output larger than 1 MiB in full', async () => {
    // Regression for the former 1 MiB cap: a large affected plan was killed as runaway output.
    const script =
      'process.stdout.write(JSON.stringify({ tasks: Array.from({ length: 40000 }, (_, i) => ({ nodeId: "n" + i, pad: "x".repeat(40) })) }))';
    const result = await runBounded(
      process.execPath,
      ['-e', script],
      { cwd: root },
      deadline(60_000),
    );
    expect(result.status).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBeGreaterThan(2 * 1024 * 1024);
    expect((JSON.parse(result.stdout) as { tasks: unknown[] }).tasks).toHaveLength(40000);
  });

  it('keeps the published landing page bound to the package version', () => {
    const packageVersion = (
      JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8')) as {
        version: string;
      }
    ).version;
    const landingPage = readFileSync(join(root, 'docs/site/src/pages/index.tsx'), 'utf8');
    expect(packageVersion).toBe(SELECTED_RELEASE_VERSION);
    expect(landingPage).toContain(`@aarusso-nyx/devai@${SELECTED_RELEASE_VERSION}`);
  });

  it('records a stable release and latest dist-tag for version 2.4.0', () => {
    const packageTarball = join(output, 'package.tgz');
    const siteArchive = join(output, 'site.tar.gz');
    const sbom = join(output, 'sbom.json');
    const manifest = join(output, 'release-manifest.json');
    writeFileSync(packageTarball, 'package');
    writeFileSync(siteArchive, 'site');
    writeFileSync(sbom, '{}');
    execFileSync(process.execPath, [join(root, 'scripts/create-release-manifest.mjs')], {
      cwd: root,
      env: manifestEnvironment({ workspace: output, output: manifest }),
    });
    const value = JSON.parse(readFileSync(manifest, 'utf8')) as {
      release: Record<string, unknown>;
      ledger: Record<string, unknown>;
    };
    expect(value.release).toMatchObject({
      tag: `v${SELECTED_RELEASE_VERSION}`,
      version: SELECTED_RELEASE_VERSION,
      release_type: 'stable',
      prerelease: false,
      dist_tag: 'latest',
    });
    expect(value.ledger).toMatchObject({
      verifier_package: '@aarusso-nyx/devai',
      verifier_package_version: TRUSTED_VERIFIER_PACKAGE_VERSION,
      verifier_provenance_sha256: TRUSTED_VERIFIER_PROVENANCE_SHA256,
      verifier_source_commit: TRUSTED_VERIFIER_SOURCE_COMMIT,
    });
  });

  it.each(['LEDGER_INSTALLED_CONTROL_SHA256', 'LEDGER_INSTALLED_OFFLINE_RECEIPT_SHA256'])(
    'ignores retired installed verification input: %s',
    (name) => {
      for (const value of ['', 'not-a-digest']) {
        const manifest = join(output, `missing-${name}-${value}.json`);
        execFileSync(process.execPath, [join(root, 'scripts/create-release-manifest.mjs')], {
          cwd: root,
          env: { ...manifestEnvironment({ workspace: output, output: manifest }), [name]: value },
          stdio: 'pipe',
        });
        const result = JSON.parse(readFileSync(manifest, 'utf8')) as {
          ledger: Record<string, unknown>;
        };
        expect(result.ledger).not.toHaveProperty('installed_control_sha256');
        expect(result.ledger).not.toHaveProperty('installed_offline_receipt_sha256');
        expect(result.ledger).toHaveProperty('release_signers_sha256', 'a'.repeat(64));
      }
    },
  );

  it.each([
    ['wrong provenance', { provenance: 'f'.repeat(64) }],
    ['the superseded 1.5.4 package version instead of the trusted verifier', { version: '1.5.4' }],
  ])('refuses %s verifier identity before writing a release manifest', (_name, identity) => {
    const manifest = join(output, `release-manifest-invalid-${_name.replaceAll(' ', '-')}.json`);
    expect(() =>
      execFileSync(process.execPath, [join(root, 'scripts/create-release-manifest.mjs')], {
        cwd: root,
        env: manifestEnvironment({ workspace: output, output: manifest, ...identity }),
        stdio: 'pipe',
      }),
    ).toThrow('RELEASE_MANIFEST_VERIFIER_IDENTITY_INVALID');
    expect(existsSync(manifest)).toBe(false);
  });

  it(
    'checks the real source archive without Git metadata and catches added stale documentation',
    async () => {
      const limit = deadline(ARCHIVE_CASE_DEADLINE_MS);
      const archive = join(output, 'source archive ç');
      cpSync(root, archive, {
        recursive: true,
        filter: (path) => {
          const name = relative(root, path);
          return !name
            .split('/')
            .some((part) => ['.git', 'node_modules', 'scratch', 'worktrees'].includes(part));
        },
      });
      symlinkSync(join(root, 'node_modules'), join(archive, 'node_modules'), 'dir');
      for (const name of readdirSync(join(root, 'packages'))) {
        const dependencies = join(root, 'packages', name, 'node_modules');
        if (existsSync(dependencies))
          symlinkSync(dependencies, join(archive, 'packages', name, 'node_modules'), 'dir');
      }
      expect(existsSync(join(archive, '.git'))).toBe(false);
      const check = () =>
        execBounded(
          process.execPath,
          [join(archive, 'scripts/check-publishable-closure.mjs')],
          archive,
          limit,
        );
      expect(JSON.parse(await check()).package).toBe(
        `@aarusso-nyx/devai@${SELECTED_RELEASE_VERSION}`,
      );
      writeFileSync(join(archive, 'docs/stale-package.md'), '@devai-nyx/cli');
      await expect(check()).rejects.toThrow(
        'PUBLISHABLE_OLD_PACKAGE_IDENTITY:docs/stale-package.md',
      );
      rmSync(join(archive, 'docs/stale-package.md'));
      mkdirSync(join(archive, 'docs/site/build'), { recursive: true });
      writeFileSync(join(archive, 'docs/site/build/stale.html'), '@devai-nyx/cli');
      await expect(check()).rejects.toThrow(
        'PUBLISHABLE_OLD_PACKAGE_IDENTITY:docs/site/build/stale.html',
      );
      // A copy of the whole source tree plus three closure runs: 7 to 9 s alone, above the RC
      // coverage lane's 15 s default once instrumented under load (#246). The copy reads the
      // live tree, so the file also runs in the `local-serial` lane, where no sibling test
      // writes into the tree while it is copied. The copy and the three closure runs share one
      // deadline inside the bound (#324); the copy itself is in-process.
    },
    ARCHIVE_CASE_TIMEOUT_MS,
  );

  it('keeps release closure bound to the selected public package version', () => {
    const closure = JSON.parse(
      execFileSync(process.execPath, [join(root, 'scripts/check-publishable-closure.mjs')], {
        cwd: root,
        encoding: 'utf8',
      }),
    ) as { package: string };
    expect(closure.package).toBe(`@aarusso-nyx/devai@${SELECTED_RELEASE_VERSION}`);
  });
});
