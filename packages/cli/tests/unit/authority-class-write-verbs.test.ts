// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017
// Inspector acceptance for ADR-AUT-0004 IA-004 and IA-005: the class verb sets of the adopter
// path authority are derived from the registered action registry by the rule the record
// states, frozen here at their current values, and produced in the package by one function
// beside `subjectGroups`; the registry, its generated views, the immutable core rules, and the
// package extension `devai-adopter-authority` stay byte-identical to the R-0502 head.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import * as policySupport from '../../src/authority/policy-support.js';
import { buildTrustedAuthoritySources } from '../../src/authority/policy.js';
import { canonicalRegistry, type RegistryEntry } from '../../src/define-command.js';

const ROOT = resolve(import.meta.dirname, '../../../..');

type ClassName = 'root' | 'test' | 'architecture';
type ClassVerbs = Record<ClassName, readonly string[]>;

/** The class role of each class of ADR-AUT-0003, whose verbs ADR-AUT-0004 fixes. */
const CLASS_ROLE: Readonly<Record<ClassName, string>> = {
  root: 'engineer',
  test: 'inspector',
  architecture: 'architect',
};

/** IA-004: the sets frozen at their registered values; a change here is a reviewed diff. */
const FROZEN: ClassVerbs = {
  root: ['task start'],
  test: ['check'],
  architecture: ['init apply architect', 'release export', 'round plan', 'round seal'],
};

/** The Engineer verbs of ADR-AUT-0003 that ADR-AUT-0004 removes from every class rule. */
const REMOVED = ['round run', 'task finish'];

const entries: readonly RegistryEntry[] = canonicalRegistry();

/**
 * The derivation of ADR-AUT-0004, read by the Inspector from the record: every entry whose
 * effect is not `read`, whose authority contract carries `fs:workspace`, and whose subject is
 * the human subject admitting the role or the harness subject initiated by exactly that role.
 */
function derive(registry: readonly RegistryEntry[], role: string): string[] {
  return registry
    .filter((entry) => {
      if (entry.effects === 'read') return false;
      const contract = entry.authority_contract;
      if (!(contract.capabilities as readonly string[]).includes('fs:workspace')) return false;
      const subject = contract.subject as {
        kind: string;
        allowed_roles?: readonly string[];
        actor?: string;
        initiator?: { allowed_roles?: readonly string[] };
      };
      if (subject.kind === 'human') return subject.allowed_roles?.includes(role) === true;
      if (subject.kind === 'derived-machine' && subject.actor === 'harness') {
        const initiators = subject.initiator?.allowed_roles ?? [];
        return initiators.length === 1 && initiators[0] === role;
      }
      return false;
    })
    .map((entry) => entry.name)
    .sort();
}

function deriveAll(registry: readonly RegistryEntry[]): ClassVerbs {
  return {
    root: derive(registry, CLASS_ROLE.root),
    test: derive(registry, CLASS_ROLE.test),
    architecture: derive(registry, CLASS_ROLE.architecture),
  };
}

/**
 * The registry-derived function TASK-0536 exports from policy-support.ts beside
 * `subjectGroups`. Read through the module namespace so this file compiles before the export
 * exists; until then every case that calls it fails with CLASS_WRITE_VERBS_UNEXPORTED.
 */
function packageClassWriteVerbs(registry: readonly RegistryEntry[]): ClassVerbs {
  const exported = (policySupport as Record<string, unknown>)['classWriteVerbs'];
  if (typeof exported !== 'function') {
    throw new Error(
      'CLASS_WRITE_VERBS_UNEXPORTED: policy-support.ts must export classWriteVerbs(entries)',
    );
  }
  return (exported as (value: readonly RegistryEntry[]) => ClassVerbs)(registry);
}

function registered(name: string): RegistryEntry {
  const entry = entries.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`missing action ${name}`);
  return entry;
}

/** A registry entry with a replaced effect, capability list, or subject. */
function variant(
  base: RegistryEntry,
  name: string,
  change: {
    effects?: RegistryEntry['effects'];
    capabilities?: readonly string[];
    subject?: Record<string, unknown>;
  },
): RegistryEntry {
  return {
    ...base,
    name,
    handler: `${base.handler}-${name.replaceAll(' ', '-')}`,
    effects: change.effects ?? base.effects,
    authority_contract: {
      ...base.authority_contract,
      action_id: name,
      capabilities: change.capabilities ?? base.authority_contract.capabilities,
      subject: change.subject ?? base.authority_contract.subject,
    },
  } as RegistryEntry;
}

const harness = (roles: readonly string[]) => ({
  kind: 'derived-machine',
  actor: 'harness',
  transition: 'harness-write',
  initiator: { allowed_roles: [...roles], preserve_in_context: true },
});

describe('IA-004: the class verb sets derive from the registry and are frozen', () => {
  it('the derivation over the registered registry yields exactly the frozen sets', () => {
    expect(deriveAll(entries)).toEqual(FROZEN);
  });

  it('policy-support exports one registry-derived function that yields exactly the frozen sets', () => {
    expect(packageClassWriteVerbs(entries)).toEqual(FROZEN);
  });

  it('the package function agrees with the derivation, not a list, when the registry changes', () => {
    const check = registered('check');
    const taskStart = registered('task start');
    const roundSeal = registered('round seal');
    const changed = [
      ...entries,
      // Admitted: a harness write initiated by exactly the Inspector that reaches the workspace.
      variant(check, 'synthetic inspector write', {}),
      // Admitted: a human Architect write that reaches the workspace.
      variant(roundSeal, 'synthetic architect write', {}),
      // Refused: a read effect never enters a class set.
      variant(check, 'synthetic inspector read', { effects: 'read' }),
      // Refused: a write without fs:workspace cannot reach an adopter root.
      variant(taskStart, 'synthetic engineer state write', {
        capabilities: ['fs:f5-state', 'fs:proofs'],
      }),
      // Refused: a harness initiator set that is not exactly the class role.
      variant(taskStart, 'synthetic shared harness write', {
        subject: harness(['engineer', 'inspector']),
      }),
      // Refused: a machine actor other than the harness.
      variant(taskStart, 'synthetic binding write', {
        subject: {
          kind: 'derived-machine',
          actor: 'binding',
          transition: 'bind',
          initiator: { allowed_roles: ['engineer'], preserve_in_context: true },
        },
      }),
    ];
    const expected: ClassVerbs = {
      root: ['task start'],
      test: ['check', 'synthetic inspector write'],
      architecture: [...FROZEN.architecture, 'synthetic architect write'].sort(),
    };
    expect(deriveAll(changed)).toEqual(expected);
    expect(packageClassWriteVerbs(changed)).toEqual(expected);
  });

  it('round run and task finish enter no class set, because neither carries fs:workspace', () => {
    for (const name of REMOVED) {
      expect(registered(name).authority_contract.capabilities).not.toContain('fs:workspace');
      for (const verbs of Object.values(FROZEN)) expect(verbs).not.toContain(name);
    }
  });

  it('each role verb appears on one class only', () => {
    const all = Object.values(FROZEN).flat();
    expect(new Set(all).size).toBe(all.length);
  });
});

// IA-005: no registry subject is widened. The three verbs that decide the matrix admit
// exactly the roles they admitted at the R-0502 head.
describe('IA-005: the registered subjects of the matrix verbs are unchanged', () => {
  it.each([
    ['check', harness(['inspector'])],
    ['task start', harness(['engineer'])],
    ['round seal', { kind: 'human', allowed_roles: ['architect'] }],
  ] as const)('%s keeps its registered subject', (name, subject) => {
    const entry = registered(name);
    expect(entry.effects).not.toBe('read');
    expect(entry.authority_contract.capabilities).toContain('fs:workspace');
    expect(entry.authority_contract.subject).toEqual(subject);
  });
});

// Digests pinned from commit 38a0a5df (R-0502 closed): `git show 38a0a5df:<path> | shasum -a
// 256`. The registry and its three generated views carry no change under ADR-AUT-0004.
// The registry and its CLI view were re-pinned when `round run` and `task finish` raised
// their planner max_batches from 128 to 2048 for the lock lease, fence and receipt writes
// (#285, #296); no effect, capability, subject or target kind changed.
const R0502_FILE_DIGESTS: ReadonlyArray<readonly [string, string]> = [
  [
    'law/policy/action-registry.json',
    '59deac2d823e80058a8223799c31653d7c8fc14dcc7a0ad49ca295545f01de27',
  ],
  [
    'packages/cli/src/generated/action-registry.ts',
    'e0b037c48a817d471453a99894e230a2c4e43a1c913b0d8d6b7b4dc6b85523de',
  ],
  [
    'packages/effects-check/src/generated/action-catalog.ts',
    '9b9ca8ac70a5da13b206b097094e5c53e738ae13c848322e75f49dab2897935c',
  ],
  [
    'packages/sensors/src/generated/action-kinds.ts',
    'f6b113b84d8356232a4fbf23013f73f8696b486e1f79d596004aaf1411bb18fe',
  ],
];

// Canonical SHA-256 of the immutable core source document and of the package extension
// `devai-adopter-authority`, materialized for the repository id below without an adopter
// block. Pinned from the rule sources of commit 38a0a5df (R-0502 closed): computed at
// cb0818d5, where `git diff 38a0a5df cb0818d5 -- packages/cli/src/authority
// packages/cli/src/generated packages/authority/src law/policy/action-registry.json` is empty.
// Re-pinned on 2026-10-04 when ADR-MDL-0006 added the Owner-only `round dispatch activate`
// action and ADR-MDL-0005 the experimental `round dispatch` action: the registry, its generated views and the derived core source change with it, and
// nothing else in the authority rule sources does. The package extension was re-pinned when
// round dispatch gained its git-ref and experimental-agent rules (ADR-MDL-0005 D-3, D-10).
// Re-pinned again when init upgrade (#264) joined the registry: the core gains it through the
// binding subject group, and the package extension names it beside init bind on the CI
// scaffold and host-adapter rules.
// Re-pinned when ADR-GOV-0025 added campaign status, campaign materialize and round ratify.
// ADR-MDL-0007 re-pinned both: round dispatch deactivate and round dispatch dispose join the
// registry, task escalate and round ratify gain git-ref targets to release attempt worktrees,
// and the package extension grants those three actions typed git-ref authority.
// The backlog add description declared its round tracking write (#306, #307): only the registry
// and its generated view changed.
const FIXED_REPOSITORY_ID = 'devai-ia-005';
const R0502_CORE_SOURCE_DIGEST = '18884489d6f36d21ff09f5578a2ae5fc5e49879b4cce715eb0ac0704235a6aa0';
const R0502_PACKAGE_EXTENSION_DIGEST =
  '83eee5dda73173720a9eab0ada9e1b3ddf79e2f5ce3d0fcf5dc546e296765fe2';

describe('IA-005: the registry, its views, the core rules, and devai-adopter-authority are byte-identical to R-0502', () => {
  it.each(R0502_FILE_DIGESTS)('%s is byte-identical to 38a0a5df', (path, digest) => {
    expect(
      createHash('sha256')
        .update(readFileSync(join(ROOT, path)))
        .digest('hex'),
    ).toBe(digest);
  });

  const scratch: string[] = [];
  afterAll(() => {
    for (const path of scratch) rmSync(path, { recursive: true, force: true });
  });

  it('a policy materialized without an adopter block carries the R-0502 core and package extension', () => {
    const repo = mkdtempSync(join(tmpdir(), 'devai-class-write-verbs-'));
    scratch.push(repo);
    mkdirSync(join(repo, '.devai/config'), { recursive: true });
    writeFileSync(
      join(repo, '.devai/config/project.json'),
      `${JSON.stringify({ name: FIXED_REPOSITORY_ID })}\n`,
    );
    const sources = buildTrustedAuthoritySources(
      entries,
      repo,
      '0.0.0-test',
      readFileSync(join(ROOT, 'law/constitution.md'), 'utf8'),
    );
    expect(sources.repository_id).toBe(FIXED_REPOSITORY_ID);
    expect(sources.provenance.source_policy.digest_sha256).toBe(R0502_CORE_SOURCE_DIGEST);
    expect(sources.provenance.additive_extensions).toEqual([
      {
        extension_id: 'devai-adopter-authority',
        extension_version: '1.0.0',
        digest_sha256: R0502_PACKAGE_EXTENSION_DIGEST,
      },
    ]);
  });
});
