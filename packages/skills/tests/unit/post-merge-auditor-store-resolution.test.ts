// ADR-SCR-0008 IA-005 (hook half): the post-merge auditor observes each merge from a
// detached observation worktree, but the readings it scores live in the bound
// checkout's `.devai/state/sensor-readings`, which is ignored by git and therefore
// absent from the detached worktree. The bundle must resolve readings from the bound
// checkout: a hook that resolves them from the detached worktree root measures an
// empty store and fails this test. The backlog.json the bundle writes conforms to
// law/schemas/observation-backlog.schema.json.
import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWithAuthorityHostEffects } from '@devai-nyx/authority';
import { getValidator } from '@devai-nyx/schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { validateObservationBacklog } from '../../src/operations/backlog.js';
import {
  createPostMergeHostScope,
  runPostMergeAuditor,
} from '../../src/post-merge-auditor/index.js';
import { POST_MERGE_DECLARATION } from '../../src/post-merge-auditor/host-receipt.js';
import { disableGitAutoMaintenance } from './git-fixture-maintenance.js';

type JsonRecord = Record<string, unknown>;

const NOW = '2026-07-24T12:00:00.000Z';
const VERSION = '1.0.0';
const STORE = '.devai/state/sensor-readings';
const PACKAGED_CONSTITUTION = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../dist/law/constitution.md',
);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function put(root: string, path: string, contents: string | Buffer): string {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return target;
}

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'DEVAI Test',
      GIT_AUTHOR_EMAIL: 'devai-test@example.invalid',
      GIT_COMMITTER_NAME: 'DEVAI Test',
      GIT_COMMITTER_EMAIL: 'devai-test@example.invalid',
    },
  }).trim();
}

function signed(value: JsonRecord, key: Buffer): JsonRecord {
  return {
    ...value,
    signature_hmac_sha256: createHmac('sha256', key).update(JSON.stringify(value)).digest('hex'),
  };
}

/** A failing lint reading (cell F2:T5) in the shape `sense record` persists. */
function failingLint(): JsonRecord {
  return {
    schemaVersion: '1.0.0',
    id: `SR-${sha256('store-resolution:lint:fail').slice(0, 16)}`,
    sensor: { name: 'lint', kind: 'lint', version: '1.0.0' },
    timestamp: NOW,
    status: 'fail',
    deterministic: true,
    command: 'devai sense run lint',
    command_hash: sha256('lint'),
    exit_code: 1,
  };
}

interface BoundCheckout {
  readonly root: string;
  readonly mergeSha: string;
  readonly receiptPath: string;
}

/**
 * A bound checkout with one `--no-ff` merge, an installed post-merge host adapter,
 * and an ignored readings store holding one recorded reading. Nothing under
 * `.devai/state/` is committed, exactly as on an adopter checkout.
 */
function boundCheckout(reading: JsonRecord): BoundCheckout {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-post-merge-store-')));
  roots.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  disableGitAutoMaintenance(root);
  put(root, '.gitignore', '.devai/state/\n.devai/worktrees/\n');
  const constitutionPath = put(root, 'law/constitution.md', '# Constitution\n');
  const policyPath = put(root, '.devai/config/authority-policy.json', '{}\n');
  put(root, 'README.md', 'baseline\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'baseline']);
  const baselineSha = git(root, ['rev-parse', 'HEAD']);
  git(root, ['checkout', '-qb', 'feature-1']);
  put(root, 'feature-1.txt', 'feature 1\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'feature 1']);
  git(root, ['checkout', '-q', 'main']);
  git(root, ['merge', '--no-ff', 'feature-1', '-qm', 'merge 1']);
  const mergeSha = git(root, ['rev-parse', 'HEAD']);

  // The recorded reading lives only in the bound checkout's ignored store.
  const { id, sensor } = reading as { readonly id: string; readonly sensor: { kind: string } };
  put(root, `${STORE}/${sensor.kind}/${id}.json`, `${JSON.stringify(reading, null, 2)}\n`);
  expect(git(root, ['status', '--porcelain', '--', STORE])).toBe('');

  const hookPath = put(root, '.git/hooks/post-merge', '#!/bin/sh\nexit 0\n');
  const key = Buffer.from('post-merge-observation-key-32b!');
  put(root, '.git/devai/post-merge.key', key);
  const attestationPath = join(root, '.git/devai/post-merge-host-adapter.json');
  const receiptPath = join(root, '.git/devai/post-merge-receipt.json');
  const constitutionDigest = existsSync(constitutionPath)
    ? sha256(readFileSync(constitutionPath))
    : existsSync(PACKAGED_CONSTITUTION)
      ? sha256(readFileSync(PACKAGED_CONSTITUTION))
      : 'absent';
  const attestation = signed(
    {
      schemaVersion: '1.0.0',
      adapter_id: 'post-merge-store-resolution-fixture',
      adapter_kind: 'installed-checkout',
      repository: root,
      repository_id: 'fixture',
      hook_path: hookPath,
      hook_digest_sha256: sha256(readFileSync(hookPath)),
      key_digest_sha256: sha256(key),
      policy_digest_sha256: sha256(readFileSync(policyPath)),
      constitution_digest_sha256: constitutionDigest,
      package_binding: { name: '@aarusso-nyx/devai', version: VERSION },
      installed_at_head: baselineSha,
      installed_at: NOW,
      cadence: { installed_checkout: 'persistent', remote_host: 'unknown' },
    },
    key,
  );
  put(root, '.git/devai/post-merge-host-adapter.json', `${JSON.stringify(attestation)}\n`);
  put(
    root,
    '.devai/config/post-merge-host-adapter.json',
    `${JSON.stringify(POST_MERGE_DECLARATION, null, 2)}\n`,
  );
  const receipt = signed(
    {
      schemaVersion: '1.0.0',
      repository: root,
      repository_id: 'fixture',
      adapter_id: 'post-merge-store-resolution-fixture',
      merge_sha: mergeSha,
      issued_at: NOW,
      hook_digest_sha256: attestation['hook_digest_sha256'],
      attestation_digest_sha256: sha256(readFileSync(attestationPath)),
      nonce: 'c'.repeat(32),
    },
    key,
  );
  put(root, '.git/devai/post-merge-receipt.json', `${JSON.stringify(receipt)}\n`);
  return { root, mergeSha, receiptPath };
}

async function runAuditor(fx: BoundCheckout) {
  const host = createPostMergeHostScope(fx.root, fx.mergeSha);
  try {
    return await runWithAuthorityHostEffects(host.scope, () =>
      runPostMergeAuditor({
        repoRoot: fx.root,
        hostReceiptPath: fx.receiptPath,
        now: NOW,
        devaiVersion: VERSION,
      }),
    );
  } finally {
    host.dispose();
  }
}

function bundleArtifact(fx: BoundCheckout, name: string): JsonRecord {
  return JSON.parse(
    readFileSync(
      join(fx.root, '.git/devai/post-merge-observations', fx.mergeSha, `${name}.json`),
      'utf8',
    ),
  ) as JsonRecord;
}

describe('ADR-SCR-0008 IA-005 the post-merge hook resolves the bound checkout store', () => {
  it('scores the readings recorded in the bound checkout, not the empty detached worktree store', async () => {
    const reading = failingLint();
    const fx = boundCheckout(reading);
    const result = await runAuditor(fx);
    expect(result.processed).toEqual([fx.mergeSha]);

    // The detached observation worktree carries no store of its own.
    const worktree = join(fx.root, '.devai/worktrees/auditor-post-merge');
    expect(existsSync(worktree)).toBe(true);
    expect(existsSync(join(worktree, STORE))).toBe(false);

    const scorecard = bundleArtifact(fx, 'scorecard') as {
      readonly cells: readonly {
        readonly substrate: string;
        readonly property: string;
        readonly verdict: string;
        readonly sensor_readings?: readonly string[];
      }[];
    };
    const lint = scorecard.cells.find((cell) => cell.substrate === 'F2' && cell.property === 'T5');
    expect(lint?.verdict).toBe('FAIL');
    expect(lint?.sensor_readings).toContain(reading['id']);
  });

  it('writes a backlog.json that conforms to the observation backlog contract', async () => {
    const reading = failingLint();
    const fx = boundCheckout(reading);
    await runAuditor(fx);

    const backlog = bundleArtifact(fx, 'backlog');
    const validate = getValidator('observation-backlog.schema.json');
    expect(validate(backlog), JSON.stringify(validate.errors)).toBe(true);
    expect(validateObservationBacklog(backlog)).toEqual({ ok: true, errors: [] });
    expect(backlog).toMatchObject({
      schemaVersion: '1.0.0',
      merge_sha: fx.mergeSha,
      generated_at: NOW,
    });
    expect(backlog['observations']).toContainEqual({
      cell: 'F2:T5',
      verdict: 'FAIL',
      reading_ids: [reading['id']],
    });
  });
});
