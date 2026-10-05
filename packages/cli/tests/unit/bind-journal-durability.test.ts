// Issue #264 review: the bind journal orders its writes durably. The journal and its
// directory are flushed before the first target write, every written target (the receipt
// among them) and its directory are flushed before the journal is removed, and the journal's
// directory is flushed after the removal. Each flush is observed against the disk state at
// the moment it happens.
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
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';

interface Flush {
  readonly path: string;
  readonly journal: boolean;
  readonly project: string | null;
  readonly receipt: string | null;
}

const observed = vi.hoisted(() => ({ root: '', flushes: [] as Flush[] }));

vi.mock('../../src/commands/init/durable-fs.js', async () => {
  const fs = await import('node:fs');
  const read = (path: string) => (fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : null);
  return {
    fsyncPath: (path: string) => {
      observed.flushes.push({
        path,
        journal: fs.existsSync(
          `${observed.root}/.devai/config/adopter-policy-binding.journal.json`,
        ),
        project: read(`${observed.root}/.devai/config/project.json`),
        receipt: read(`${observed.root}/.devai/config/upgrade-receipt.json`),
      });
    },
  };
});

const { commitBindJournal, openBindJournal, releaseBindJournal, writeAdopterPolicyPairAtomically } =
  await import('../../src/commands/init/bind-adapters.js');

const PROJECT = '.devai/config/project.json';
const RECEIPT = '.devai/config/upgrade-receipt.json';
const JOURNAL = '.devai/config/adopter-policy-binding.journal.json';
const roots: string[] = [];

afterEach(() => {
  releaseBindJournal();
  observed.flushes.splice(0);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-bind-durability-')));
  roots.push(root);
  mkdirSync(join(root, '.devai/config'), { recursive: true });
  writeFileSync(join(root, PROJECT), '{"devai_version":"1.6.0"}\n');
  observed.root = root;
  return root;
}

describe('#264 review: the bind journal flushes in a durable order', () => {
  it('flushes the journal before any target moves and the targets before the journal goes', async () => {
    const root = repository();
    await withAuthorityHostTestScope(() =>
      writeAdopterPolicyPairAtomically(root, new Map([[PROJECT, '{"devai_version":"2.0.0"}\n']])),
    );
    const flushes = observed.flushes;
    const journal = flushes.findIndex((flush) => flush.path === join(root, JOURNAL));
    expect(journal).toBeGreaterThanOrEqual(0);
    // The journal is durable while the target still holds its previous bytes.
    expect(flushes[journal]).toMatchObject({
      journal: true,
      project: '{"devai_version":"1.6.0"}\n',
    });
    expect(flushes[journal + 1]).toMatchObject({
      path: join(root, '.devai/config'),
      journal: true,
    });
    // The renamed target and its directory are durable before the journal is removed.
    const target = flushes.findIndex((flush) => flush.path === join(root, PROJECT));
    expect(target).toBeGreaterThan(journal);
    expect(flushes[target]).toMatchObject({
      journal: true,
      project: '{"devai_version":"2.0.0"}\n',
    });
    // The removal is flushed last, through the journal's directory.
    expect(flushes.at(-1)).toMatchObject({ path: join(root, '.devai/config'), journal: false });
    expect(existsSync(join(root, JOURNAL))).toBe(false);
  });

  it('commits an upgrade only after every target and the receipt are durable', async () => {
    const root = repository();
    await withAuthorityHostTestScope(() => {
      openBindJournal(root);
      const opened = observed.flushes.findIndex((flush) => flush.path === join(root, JOURNAL));
      expect(opened).toBe(0);
      expect(observed.flushes[1]).toMatchObject({ path: dirname(join(root, JOURNAL)) });
      writeFileSync(join(root, PROJECT), '{"devai_version":"2.0.0"}\n');
      writeAdopterPolicyPairAtomically(root, new Map([[RECEIPT, '{"to":"2.0.0"}\n']]));
      observed.flushes.splice(0);
      commitBindJournal(root);
    });
    const flushes = observed.flushes;
    const project = flushes.findIndex((flush) => flush.path === join(root, PROJECT));
    const receipt = flushes.findIndex((flush) => flush.path === join(root, RECEIPT));
    expect(project).toBeGreaterThanOrEqual(0);
    expect(receipt).toBeGreaterThanOrEqual(0);
    // Every target, the receipt among them, is flushed while the journal still exists.
    for (const index of [project, receipt]) {
      expect(flushes[index]).toMatchObject({ journal: true, receipt: '{"to":"2.0.0"}\n' });
    }
    expect(flushes.at(-1)).toMatchObject({ path: join(root, '.devai/config'), journal: false });
    expect(readFileSync(join(root, RECEIPT), 'utf8')).toBe('{"to":"2.0.0"}\n');
    expect(existsSync(join(root, JOURNAL))).toBe(false);
  });
});
