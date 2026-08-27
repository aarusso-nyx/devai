// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-020
// Inspector acceptance for the two finding boundaries that are not inherently
// round-scoped. Attribution is opt-in per invocation: without --round nothing
// is recorded and behaviour is exactly what it was before tracking existed,
// because a round is never inferred. With --round the finding joins that
// round's chain, and an Auditor observation stays an observation.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CAC } from 'cac';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { readGovernanceEvents, type RoundTrackingActivation } from '@devai-nyx/loop';
import { triageClassify } from '../../src/commands/triage/classify.js';

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};

const roots: string[] = [];
const ROUND = 'R-0042';
const SESSION = 'AUTH-SESSION-0f1e2d3c4b5a69788796';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(repo: string, path: string, value: unknown): void {
  const absolute = join(repo, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(
    absolute,
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
}

function activation(): RoundTrackingActivation {
  return {
    schemaVersion: '1.0.0',
    round_id: ROUND,
    repository_id: 'adopter',
    state: 'active',
    adapter: {
      id: 'github-issues',
      adapter_version: '1.0.0',
      package_version: '1.3.0',
      config_digest_sha256: 'a'.repeat(64),
      workflow_digest_sha256: 'b'.repeat(64),
    },
    target: { repository: 'example/adopter', issue_number: null },
    authorization: {
      authority_session_id: SESSION,
      role: 'owner',
      publish_flag: true,
      authorized_at: '2026-08-27T12:00:00.000Z',
    },
    disclosure_profile: 'public-safe-v1',
    pending_policy: 'freeze',
    disabled: null,
  };
}

/** A repository with one schema-valid failing sensor reading ready to classify. */
function repository(options: { readonly activated: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-finding-boundary-'));
  roots.push(root);
  put(root, 'reading.json', {
    schemaVersion: '1.0.0',
    id: 'SR-89f7974460e256a3',
    sensor: { name: 'unit_test', kind: 'unit_test' },
    timestamp: '2026-08-27T12:00:00.000Z',
    status: 'fail',
    deterministic: true,
    command: 'pnpm run test',
    command_hash: 'c'.repeat(64),
  });
  if (options.activated) {
    put(root, join('.devai/state/tracking', ROUND, 'activation.json'), activation());
  }
  return root;
}

async function classify(root: string, extra: readonly string[] = []) {
  const cli = cac('devai-finding-boundary');
  triageClassify.register(cli);
  const previous = {
    argv: process.argv,
    stdout: process.stdout.write,
    stderr: process.stderr.write,
  };
  let stderr = '';
  try {
    process.argv = [
      'node',
      'devai',
      'triage-classify',
      '--repo-root',
      root,
      '--input',
      'reading.json',
      ...extra,
    ];
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    cli.parse(process.argv, { run: false });
    await withAuthorityHostTestScope(() => cli.runMatchedCommand());
    return { stderr };
  } finally {
    process.argv = previous.argv;
    process.stdout.write = previous.stdout;
    process.stderr.write = previous.stderr;
  }
}

describe('triage classification attribution', () => {
  it('records nothing and behaves exactly as before when no round is given', async () => {
    const root = repository({ activated: true });
    const { stderr } = await classify(root);

    expect(stderr).toBe('');
    // The classification itself still happened.
    expect(existsSync(join(root, '.devai/state/triage'))).toBe(true);
    // A round is never inferred, so nothing was attributed to one.
    expect(readGovernanceEvents({ repoRoot: root, round: ROUND })).toHaveLength(0);
  });

  it('joins the round chain when a round is explicitly given', async () => {
    const root = repository({ activated: true });
    const { stderr } = await classify(root, ['--round', ROUND, '--task', 'TASK-7']);

    expect(stderr).toBe('');
    const events = readGovernanceEvents({ repoRoot: root, round: ROUND });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'finding_classified',
      task_id: 'TASK-7',
      authority_session_id: SESSION,
    });
    expect(events[0]?.public_safe_summary).toContain('classified as');
  });

  it('stays inert when the named round was never activated', async () => {
    const root = repository({ activated: false });
    const { stderr } = await classify(root, ['--round', ROUND]);

    expect(stderr).toBe('');
    expect(existsSync(join(root, '.devai/state/tracking'))).toBe(false);
  });

  it('classifies identically whether or not a round is attributed', async () => {
    const withoutRound = repository({ activated: true });
    await classify(withoutRound);
    const withRound = repository({ activated: true });
    await classify(withRound, ['--round', ROUND]);

    const read = (root: string): string => {
      const directory = join(root, '.devai/state/triage');
      const [name] = readdirSync(directory).sort();
      return readFileSync(join(directory, name ?? ''), 'utf8');
    };
    // Attribution is an observation of the verdict, never an input to it.
    expect(read(withRound)).toBe(read(withoutRound));
  });
});
