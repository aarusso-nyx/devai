import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { validators } from '@devai-nyx/schemas';
import {
  canonicalJson,
  computeEvidenceEpochLineHash,
  computeEvidenceManifestHash,
} from '@devai-nyx/utils';
import { requireScope } from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/host-operation.js';
import { scopes } from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/host-scope.js';
import { parseProofIndex, type ProofIndexSnapshot } from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/proof-index-codec.js';
import {
  captureReconciliationHostContext,
  disposeReconciliationHostContext,
  readReconciliationHostIdentity,
  readReconciliationHostPaths,
  type ReconciliationHostIdentity,
} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/reconciliation-host-context.js';
import {
  readReconciliationHostBinding,
  readReconciliationPlanSelectors,
} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/reconciliation-host-operation.js';
import { checkReconciliationClockWindow } from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/runtime/reconciliation-clock.js';

const CHAIN = 'record/proofs/chain.json';
const CATALOGUE = 'law/security/authorization.json';
const MAX_BLOB = 32 * 1024 * 1024;
const MAX_TOTAL = 512 * 1024 * 1024;
const MAX_ENTRIES = 100000;
const MAX_COMMITS = 20000;
const ENV = Object.freeze({
  PATH: '/usr/bin:/bin',
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ALLOW_PROTOCOL: 'https:ssh:file',
});
const GIT = [
  '--no-optional-locks',
  '--no-replace-objects',
  '--no-lazy-fetch',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'credential.helper=',
  '-c',
  'core.sshCommand=/usr/bin/ssh -oBatchMode=yes -oStrictHostKeyChecking=yes -oUpdateHostKeys=no -oControlMaster=no -oControlPath=none',
];

type Code =
  | 'RECONCILIATION_PLAN_INVALID'
  | 'RECONCILIATION_PLAN_STALE'
  | 'RECONCILIATION_PLAN_LIMIT'
  | 'RECONCILIATION_PLAN_SOURCE_INVALID'
  | 'RECONCILIATION_PLAN_PUBLICATION_INVALID';
export class ReconciliationPlanError extends Error {
  constructor(readonly code: Code) {
    super(code);
    this.name = 'ReconciliationPlanError';
  }
}
function fail(code: Code = 'RECONCILIATION_PLAN_INVALID'): never {
  throw new ReconciliationPlanError(code);
}
function sha(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function utf8(bytes: Uint8Array): string {
  const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (!Buffer.from(value).equals(Buffer.from(bytes))) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
  return value;
}
function compare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
function pathSafe(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4096 &&
    !value.includes('\\') &&
    ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
    value
      .split('/')
      .every((part) => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
  );
}
function git(root: string, args: readonly string[], input?: string, maximum = MAX_TOTAL): Buffer {
  const result = spawnSync('/usr/bin/git', [...GIT, ...args], {
    cwd: root,
    env: ENV,
    input,
    encoding: 'buffer',
    timeout: 30000,
    maxBuffer: maximum,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
  if (result.status !== 0 || result.signal || result.error || !Buffer.isBuffer(result.stdout))
    fail();
  return result.stdout;
}
function data(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('RECONCILIATION_PLAN_SOURCE_INVALID');
  return value as Record<string, unknown>;
}

/** Parse historical formatting without accepting duplicate keys or non-JSON scalars. */
function json(bytes: Uint8Array): unknown {
  const text = utf8(bytes);
  let cursor = 0,
    nodes = 0;
  const whitespace = (): void => {
    while (' \t\n\r'.includes(text[cursor] ?? '!')) cursor++;
  };
  const string = (): string => {
    const start = cursor++;
    while (cursor < text.length) {
      const c = text[cursor++];
      if (c === '\\') {
        cursor++;
        continue;
      }
      if (c === '"') {
        const value: unknown = JSON.parse(text.slice(start, cursor));
        if (typeof value !== 'string' || Buffer.from(value).toString('utf8') !== value)
          fail('RECONCILIATION_PLAN_SOURCE_INVALID');
        return value;
      }
    }
    return fail('RECONCILIATION_PLAN_SOURCE_INVALID');
  };
  const scan = (depth: number): void => {
    if (depth > 64 || ++nodes > 1000000) fail('RECONCILIATION_PLAN_LIMIT');
    whitespace();
    const c = text[cursor];
    if (c === '"') {
      string();
      return;
    }
    if (c === '{' || c === '[') {
      const object = c === '{',
        end = object ? '}' : ']';
      cursor++;
      whitespace();
      if (text[cursor] === end) {
        cursor++;
        return;
      }
      const keys = new Set<string>();
      while (cursor < text.length) {
        if (object) {
          whitespace();
          if (text[cursor] !== '"') fail('RECONCILIATION_PLAN_SOURCE_INVALID');
          const key = string();
          if (keys.has(key)) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
          keys.add(key);
          whitespace();
          if (text[cursor++] !== ':') fail('RECONCILIATION_PLAN_SOURCE_INVALID');
        }
        scan(depth + 1);
        whitespace();
        const separator = text[cursor++];
        if (separator === end) return;
        if (separator !== ',') fail('RECONCILIATION_PLAN_SOURCE_INVALID');
      }
      fail('RECONCILIATION_PLAN_SOURCE_INVALID');
    }
    const scalar =
      /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(
        text.slice(cursor),
      )?.[0];
    if (!scalar) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
    const value: unknown = JSON.parse(scalar);
    if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0)))
      fail('RECONCILIATION_PLAN_SOURCE_INVALID');
    cursor += scalar.length;
  };
  scan(0);
  whitespace();
  if (cursor !== text.length) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
  return JSON.parse(text) as unknown;
}

interface ChainRecord {
  id: string;
  timestamp: string;
  actor: string;
  actor_role: string;
  action: string;
  status: string;
  context: { git: { head_sha: string | null } };
  artifacts: { sha256: string | null }[];
  previous_run_hash: string | null;
  manifest_hash: string;
  sequence?: number;
  previous_hash?: string;
  proof_path?: string;
  proof_sequence?: number;
  proof_sha256?: string;
  recovered_from?: unknown;
}
interface Chain {
  head: string | null;
  records: ChainRecord[];
}
function chain(bytes: Uint8Array): Chain {
  const parsed = data(json(bytes));
  if (
    Object.keys(parsed).some((key) => key !== 'head' && key !== 'records') ||
    !Object.hasOwn(parsed, 'head') ||
    !Array.isArray(parsed.records) ||
    parsed.records.length > MAX_ENTRIES
  )
    fail('RECONCILIATION_PLAN_SOURCE_INVALID');
  let previous: string | null = null;
  for (const [index, value] of parsed.records.entries()) {
    if (!validators.evidence(value)) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
    const record = value as ChainRecord;
    if (
      (record.sequence !== undefined && record.sequence !== index + 1) ||
      (record.previous_hash !== undefined && record.previous_hash !== (previous ?? 'GENESIS')) ||
      record.previous_run_hash !== previous ||
      computeEvidenceManifestHash({
        id: record.id,
        timestamp: record.timestamp,
        actor: record.actor,
        actor_role: record.actor_role,
        action: record.action,
        status: record.status,
        git_head_sha: record.context.git.head_sha,
        artifact_sha256s: record.artifacts.map((a) => a.sha256),
        previous_run_hash: previous,
      }) !== record.manifest_hash
    )
      fail('RECONCILIATION_PLAN_SOURCE_INVALID');
    previous = record.manifest_hash;
  }
  if (parsed.head !== previous) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
  return parsed as unknown as Chain;
}
interface EpochRow {
  proof_sequence: number;
  proof_sha256: string;
  action: string | null;
  line_type: string;
}
function epoch(bytes: Buffer, path: string): EpochRow[] {
  const match = /^record\/proofs\/work\/([^/]+)\/([^/]+)\.jsonl$/u.exec(path);
  if (!match || bytes.length === 0 || bytes.at(-1) !== 10)
    fail('RECONCILIATION_PLAN_SOURCE_INVALID');
  let start = 0,
    previous: string | null = null,
    closed = false;
  const rows: EpochRow[] = [],
    types: string[] = [];
  for (let end = 0; end < bytes.length; end++) {
    if (bytes[end] !== 10) continue;
    const raw = bytes.subarray(start, end);
    start = end + 1;
    const value = json(raw);
    if (!validators.proofEpoch(value)) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
    const line = data(value),
      { line_hash: hash, ...unsigned } = line;
    const sequence = rows.length + 1;
    if (
      closed ||
      line.kind !== match[1] ||
      line.round_id !== match[2] ||
      line.sequence !== sequence ||
      line.previous_line_hash !== previous ||
      hash !== computeEvidenceEpochLineHash(unsigned)
    )
      fail('RECONCILIATION_PLAN_SOURCE_INVALID');
    if (
      line.line_type === 'errata' &&
      (typeof line.corrects_sequence !== 'number' ||
        line.corrects_sequence >= sequence ||
        types[line.corrects_sequence - 1] !== 'record')
    )
      fail('RECONCILIATION_PLAN_SOURCE_INVALID');
    if (line.line_type === 'terminal') {
      if (
        line.record_count !== sequence - 1 ||
        line.terminal_hash !== (previous ?? sha('DEVAI-PROOF-EPOCH-EMPTY'))
      )
        fail('RECONCILIATION_PLAN_SOURCE_INVALID');
      closed = true;
    }
    const payload = data(line.payload);
    rows.push({
      proof_sequence: sequence,
      proof_sha256: sha(raw),
      action: typeof payload.action === 'string' ? payload.action : null,
      line_type: String(line.line_type),
    });
    types.push(String(line.line_type));
    previous = String(hash);
    if (rows.length > MAX_ENTRIES) fail('RECONCILIATION_PLAN_LIMIT');
  }
  return rows;
}

interface Blob {
  type: 'blob' | 'commit';
  bytes: Buffer;
}
interface File {
  commit: string;
  path: string;
  mode: string;
  blob_oid: string;
  sha256: string;
  bytes: number;
  kind: 'chain' | 'epoch' | 'ancestry';
}
interface StagedFile {
  path: string;
  stage: number;
  mode: string;
  blob_oid: string;
  sha256: string;
  bytes: number;
}
interface Recovery {
  proof_path: string;
  proof_sequence: number;
  proof_sha256: string;
  source_commit: string | null;
  source_chain_sha256: string | null;
  source_entry_manifest_hash: string | null;
  mode: 'divergent' | 'newest';
}
export interface ReconciliationPlan {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'evidence-reconciliation-plan';
  readonly identity: ReconciliationHostIdentity;
  readonly binding_sha256: string;
  readonly selection: Readonly<{
    parent: string;
    published_ref: string;
    published_tip: string;
    origin_config_sha256: string;
    effective_origin_sha256: string;
  }>;
  readonly bases: readonly string[];
  readonly source_manifest: Readonly<{
    files: readonly File[];
    index: ProofIndexSnapshot;
    staged_files: readonly StagedFile[];
    recovery_obligations: readonly Recovery[];
  }>;
  readonly source_manifest_sha256: string;
  readonly grants_authority: false;
}

function indexBytes(path: string): Buffer {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_BLOB)) fail();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.birthtimeNs !== before.birthtimeNs ||
      opened.size !== before.size
    )
      fail('RECONCILIATION_PLAN_STALE');
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) fail('RECONCILIATION_PLAN_STALE');
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0) fail('RECONCILIATION_PLAN_STALE');
    const after = fstatSync(fd, { bigint: true });
    if (
      after.ctimeNs !== opened.ctimeNs ||
      after.mtimeNs !== opened.mtimeNs ||
      after.size !== opened.size ||
      BigInt(bytes.length) !== opened.size
    )
      fail('RECONCILIATION_PLAN_STALE');
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/** Fixed native observations only. This output is data and cannot authorize an effect. */
export function readReconciliationPlan(repositoryRoot: string): ReconciliationPlan {
  let context: ReturnType<typeof captureReconciliationHostContext> | undefined;
  try {
    const scope = requireScope('process');
    if (
      scope.effect !== 'read' ||
      scope.action_id !== 'evidence reconcile plan' ||
      typeof repositoryRoot !== 'string' ||
      realpathSync(repositoryRoot) !== repositoryRoot
    )
      fail();
    const selectors = readReconciliationPlanSelectors(),
      binding = readReconciliationHostBinding();
    context = captureReconciliationHostContext(repositoryRoot, binding.identity.repository_id);
    const identity = readReconciliationHostIdentity(context),
      paths = readReconciliationHostPaths(context);
    if (
      canonicalJson(identity) !== canonicalJson(binding.identity) ||
      identity.merge_heads.length === 0
    )
      fail();
    const format = identity.object_format,
      oidPattern = format === 'sha1' ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u;
    const parents = [identity.head, ...identity.merge_heads];
    for (const forbidden of [
      join(paths.git_dir, 'shallow'),
      join(paths.common_dir, 'shallow'),
      join(paths.common_dir, 'info', 'grafts'),
      join(paths.common_dir, 'objects', 'info', 'alternates'),
      join(paths.common_dir, 'objects', 'info', 'http-alternates'),
    ]) {
      try {
        lstatSync(forbidden);
        fail('RECONCILIATION_PLAN_SOURCE_INVALID');
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      }
    }
    const actualConfig = (): Buffer =>
      git(repositoryRoot, ['config', '--includes', '--null', '--list'], undefined, 4 * 1024 * 1024);
    const initialConfig = actualConfig();
    if (
      /(?:^|\0)(?:extensions\.partialclone|remote\.[^\n\0]+\.(?:promisor|partialclonefilter))\n/iu.test(
        utf8(initialConfig),
      )
    )
      fail('RECONCILIATION_PLAN_SOURCE_INVALID');
    if (
      new Set(parents).size !== parents.length ||
      !parents.includes(selectors.selected_parent) ||
      !oidPattern.test(selectors.selected_parent)
    )
      fail();
    const objects = new Map<string, Blob>();
    let charged = 0;
    const load = (ids: readonly string[]): void => {
      const needed = [...new Set(ids)].filter((id) => !objects.has(id));
      if (needed.length === 0) return;
      if (needed.length > MAX_ENTRIES || needed.some((id) => !oidPattern.test(id)))
        fail('RECONCILIATION_PLAN_LIMIT');
      const input = `${needed.join('\n')}\n`;
      const checks = utf8(
        git(repositoryRoot, ['cat-file', '--batch-check'], input, 16 * 1024 * 1024),
      ).split('\n');
      if (checks.pop() !== '' || checks.length !== needed.length) fail();
      const sizes = checks.map((line, index) => {
        const parts = line.split(' '),
          size = Number(parts[2]);
        if (
          parts.length !== 3 ||
          parts[0] !== needed[index] ||
          !['blob', 'commit'].includes(parts[1] ?? '') ||
          !/^(?:0|[1-9][0-9]*)$/u.test(parts[2] ?? '') ||
          !Number.isSafeInteger(size) ||
          size > MAX_BLOB
        )
          fail('RECONCILIATION_PLAN_LIMIT');
        charged += size;
        if (charged > MAX_TOTAL) fail('RECONCILIATION_PLAN_LIMIT');
        return size;
      });
      const output = git(
        repositoryRoot,
        ['cat-file', '--batch'],
        input,
        sizes.reduce((sum, size) => sum + size + 128, 0),
      );
      let offset = 0;
      for (const [index, id] of needed.entries()) {
        const end = output.indexOf(10, offset);
        if (end < 0) fail();
        const header = utf8(output.subarray(offset, end)).split(' '),
          size = sizes[index];
        if (size === undefined || header.join(' ') !== checks[index]) fail();
        const type = header[1];
        if (type !== 'blob' && type !== 'commit') fail();
        offset = end + 1;
        const bytes = output.subarray(offset, offset + size);
        offset += size;
        if (
          bytes.length !== size ||
          output[offset++] !== 10 ||
          createHash(format).update(`${type} ${size}\0`).update(bytes).digest('hex') !== id
        )
          fail('RECONCILIATION_PLAN_SOURCE_INVALID');
        objects.set(id, { type, bytes });
      }
      if (offset !== output.length) fail();
    };
    const blob = (id: string): Buffer => {
      load([id]);
      const object = objects.get(id);
      if (object?.type !== 'blob') return fail();
      return object.bytes;
    };
    const sourceFiles: File[] = [],
      chains = new Map<string, Chain>(),
      epochVersions = new Map<string, { commit: string; rows: EpochRow[] }[]>();
    const histories: { commit: string; path: string; chain: Chain }[] = [];
    const add = (
      commit: string,
      path: string,
      mode: string,
      id: string,
      kind: 'chain' | 'epoch',
    ): void => {
      if (sourceFiles.some((file) => file.commit === commit && file.path === path)) return;
      const bytes = blob(id);
      sourceFiles.push({
        commit,
        path,
        mode,
        blob_oid: id,
        sha256: sha(bytes),
        bytes: bytes.length,
        kind,
      });
      if (kind === 'chain') {
        const parsed = chain(bytes);
        histories.push({ commit, path, chain: parsed });
        if (path === CHAIN) chains.set(commit, parsed);
      } else {
        const versions = epochVersions.get(path) ?? [];
        versions.push({ commit, rows: epoch(bytes, path) });
        epochVersions.set(path, versions);
      }
    };
    const bases = new Set<string>();
    for (const merge of identity.merge_heads) {
      const found = utf8(git(repositoryRoot, ['merge-base', '--all', identity.head, merge]))
        .trimEnd()
        .split('\n');
      if (found.length === 0 || found.some((oid) => !oidPattern.test(oid))) fail();
      for (const oid of found) bases.add(oid);
    }
    const ancestry = utf8(
      git(repositoryRoot, ['rev-list', '--parents', ...parents], undefined, 16 * 1024 * 1024),
    )
      .trimEnd()
      .split('\n');
    if (
      ancestry.length > MAX_COMMITS ||
      ancestry.some((line) => line.split(' ').some((id) => !oidPattern.test(id)))
    )
      fail('RECONCILIATION_PLAN_LIMIT');
    const commits = ancestry.map((line) => line.split(' ')[0] as string);
    load(commits);
    for (const [ordinal, commit] of commits.entries()) {
      const object = objects.get(commit);
      if (object?.type !== 'commit') fail();
      const headerEnd = object.bytes.indexOf('\n\n');
      if (headerEnd < 0) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
      const headers = object.bytes.subarray(0, headerEnd).toString('utf8').split('\n');
      const actualParents = headers
        .filter((line) => line.startsWith('parent '))
        .map((line) => line.slice(7));
      const listedParents = (ancestry[ordinal] ?? '').split(' ').slice(1);
      if (
        !/^tree [a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(headers[0] ?? '') ||
        canonicalJson(actualParents) !== canonicalJson(listedParents) ||
        actualParents.some((parent) => !objects.has(parent))
      )
        fail('RECONCILIATION_PLAN_SOURCE_INVALID');
      sourceFiles.push({
        commit,
        path: '',
        mode: 'commit',
        blob_oid: commit,
        sha256: sha(object.bytes),
        bytes: object.bytes.length,
        kind: 'ancestry',
      });
    }
    const capturedSources = new Set<string>();
    const readSourceCommit = (commit: string): void => {
      if (capturedSources.has(commit)) return;
      capturedSources.add(commit);
      const listing = utf8(
        git(repositoryRoot, ['ls-tree', '-r', '-z', '--full-tree', commit, '--', 'record/proofs/']),
      );
      const entries = listing
        .split('\0')
        .filter(Boolean)
        .map((line) => {
          const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/u.exec(line);
          if (!match || !pathSafe(match[3] ?? '')) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
          return { path: match[3] as string, mode: match[1] as string, id: match[2] as string };
        })
        .filter((entry) => entry.path === CHAIN || entry.path.endsWith('.jsonl'));
      if (!entries.some((entry) => entry.path === CHAIN))
        fail('RECONCILIATION_PLAN_SOURCE_INVALID');
      load(entries.map((entry) => entry.id));
      for (const entry of entries)
        add(commit, entry.path, entry.mode, entry.id, entry.path === CHAIN ? 'chain' : 'epoch');
      for (let i = 0; i < histories.length; i++) {
        const history = histories[i];
        if (!history || history.commit !== commit) continue;
        if (histories.length > MAX_ENTRIES) fail('RECONCILIATION_PLAN_LIMIT');
        for (const record of history.chain.records) {
          if (record.recovered_from === undefined) continue;
          const provenance = data(record.recovered_from),
            sourcePath = provenance.source_chain_path;
          if (
            typeof sourcePath !== 'string' ||
            !pathSafe(sourcePath) ||
            sourcePath === history.path
          )
            fail('RECONCILIATION_PLAN_SOURCE_INVALID');
          const line = utf8(git(repositoryRoot, ['ls-tree', commit, '--', sourcePath]));
          const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)\n$/u.exec(line);
          if (!match || match[3] !== sourcePath) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
          const sourceBytes = blob(match[2] as string);
          if (sha(sourceBytes) !== provenance.source_chain_sha256)
            fail('RECONCILIATION_PLAN_SOURCE_INVALID');
          add(commit, sourcePath, match[1] as string, match[2] as string, 'chain');
          const source = histories.find(
            (item) => item.commit === commit && item.path === sourcePath,
          )?.chain;
          const sequence = provenance.source_entry_sequence,
            fork = provenance.fork_sequence;
          if (
            !source ||
            typeof sequence !== 'number' ||
            typeof fork !== 'number' ||
            fork < 1 ||
            !Number.isSafeInteger(fork) ||
            !Number.isSafeInteger(sequence) ||
            sequence <= fork ||
            fork >= source.records.length ||
            fork >= history.chain.records.length
          )
            fail('RECONCILIATION_PLAN_SOURCE_INVALID');
          const original = source.records[sequence - 1];
          if (
            !original ||
            original.id !== provenance.source_entry_id ||
            original.sequence !== sequence ||
            original.manifest_hash !== provenance.source_entry_manifest_hash ||
            original.recovered_from !== undefined ||
            original.action !== record.action ||
            original.proof_path !== record.proof_path ||
            original.proof_sequence !== record.proof_sequence ||
            original.proof_sha256 !== record.proof_sha256 ||
            canonicalJson(source.records.slice(0, fork)) !==
              canonicalJson(history.chain.records.slice(0, fork))
          )
            fail('RECONCILIATION_PLAN_SOURCE_INVALID');
        }
      }
      for (const history of histories.filter((item) => item.commit === commit)) {
        const seen = new Set<string>();
        for (const record of history.chain.records) {
          if (record.proof_path === undefined) continue;
          const rows = epochVersions
            .get(record.proof_path)
            ?.find((version) => version.commit === commit)?.rows;
          const sequence = record.proof_sequence;
          const key = `${record.proof_path}\0${sequence}`;
          if (
            typeof sequence !== 'number' ||
            !Number.isSafeInteger(sequence) ||
            sequence < 1 ||
            rows?.[sequence - 1]?.proof_sha256 !== record.proof_sha256 ||
            seen.has(key)
          )
            fail('RECONCILIATION_PLAN_SOURCE_INVALID');
          seen.add(key);
        }
      }
    };
    for (const commit of [...new Set([...parents, ...bases])]) readSourceCommit(commit);
    const beforeIndexBytes = indexBytes(join(paths.git_dir, 'index')),
      index = parseProofIndex(beforeIndexBytes, format);
    if (
      index.entries.length > MAX_ENTRIES ||
      index.entries.some(
        (entry) =>
          // Symlink blobs are witnessed as metadata, never followed or admitted
          // as producer text. The staged producer must reject direct link reads.
          !['100644', '100755', '120000'].includes(entry.mode) ||
          (entry.stage !== 0 && entry.path !== CHAIN && entry.path !== CATALOGUE),
      )
    )
      fail('RECONCILIATION_PLAN_SOURCE_INVALID');
    load(index.entries.map((entry) => entry.oid));
    const stagedFiles = index.entries.map((entry) => {
      const bytes = blob(entry.oid);
      return {
        path: entry.path,
        stage: entry.stage,
        mode: entry.mode,
        blob_oid: entry.oid,
        sha256: sha(bytes),
        bytes: bytes.length,
      };
    });
    const changed = utf8(
      git(repositoryRoot, ['diff-files', '--name-only', '-z', '--no-ext-diff', '--no-textconv']),
    )
      .split('\0')
      .filter(Boolean);
    if (changed.some((path) => path !== CHAIN && path !== CATALOGUE))
      fail('RECONCILIATION_PLAN_SOURCE_INVALID');
    const untracked = git(repositoryRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
    if (untracked.length !== 0) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
    const selected = chains.get(selectors.selected_parent);
    if (!selected) fail();
    const recoveries: Recovery[] = [];
    const history = (): string[] =>
      utf8(
        git(
          repositoryRoot,
          ['log', '--format=%H', ...parents, '--', CHAIN],
          undefined,
          2 * 1024 * 1024,
        ),
      )
        .trimEnd()
        .split('\n');
    let chainHistory: string[] | undefined;
    for (const [path, versions] of epochVersions) {
      const longest = versions.reduce((a, b) => (a.rows.length >= b.rows.length ? a : b));
      for (const version of versions)
        for (const [i, row] of version.rows.entries())
          if (row.proof_sha256 !== longest.rows[i]?.proof_sha256)
            fail('RECONCILIATION_PLAN_SOURCE_INVALID');
      for (const row of longest.rows) {
        const existing = selected.records.filter(
          (record) => record.proof_path === path && record.proof_sequence === row.proof_sequence,
        );
        if (
          existing.length > 1 ||
          (existing.length === 1 && existing[0]?.proof_sha256 !== row.proof_sha256)
        )
          fail('RECONCILIATION_PLAN_SOURCE_INVALID');
        if (existing.length === 1) continue;
        if (row.proof_sequence === longest.rows.length) {
          recoveries.push({
            proof_path: path,
            proof_sequence: row.proof_sequence,
            proof_sha256: row.proof_sha256,
            source_commit: null,
            source_chain_sha256: null,
            source_entry_manifest_hash: null,
            mode: 'newest',
          });
          continue;
        }
        chainHistory ??= history();
        if (chainHistory.length > MAX_COMMITS) fail('RECONCILIATION_PLAN_LIMIT');
        let original: { commit: string; record: ChainRecord } | undefined;
        for (const commit of chainHistory) {
          if (!oidPattern.test(commit)) fail();
          if (!chains.has(commit)) {
            const line = utf8(git(repositoryRoot, ['ls-tree', commit, '--', CHAIN]));
            const match =
              /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\trecord\/proofs\/chain\.json\n$/u.exec(
                line,
              );
            if (!match) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
            chains.set(commit, chain(blob(match[2] as string)));
          }
          const matches =
            chains
              .get(commit)
              ?.records.filter(
                (record) =>
                  record.proof_path === path &&
                  record.proof_sequence === row.proof_sequence &&
                  record.proof_sha256 === row.proof_sha256 &&
                  record.recovered_from === undefined,
              ) ?? [];
          if (matches.length > 1) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
          if (matches[0]) {
            original = { commit, record: matches[0] };
            break;
          }
        }
        if (!original) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
        readSourceCommit(original.commit);
        const file = sourceFiles.find(
          (file) => file.commit === original.commit && file.path === CHAIN,
        );
        if (!file) fail();
        recoveries.push({
          proof_path: path,
          proof_sequence: row.proof_sequence,
          proof_sha256: row.proof_sha256,
          source_commit: original.commit,
          source_chain_sha256: file.sha256,
          source_entry_manifest_hash: original.record.manifest_hash,
          mode: 'divergent',
        });
      }
    }
    const publication = (): { tip: string; config: string; effective: string } => {
      const config = sha(actualConfig());
      if (config !== sha(initialConfig)) fail('RECONCILIATION_PLAN_STALE');
      const effectiveBytes = git(
          repositoryRoot,
          ['ls-remote', '--get-url', 'origin'],
          undefined,
          65536,
        ),
        effective = utf8(effectiveBytes).trimEnd();
      if (
        !(
          effective.startsWith('https://') ||
          effective.startsWith('ssh://') ||
          effective.startsWith('file://') ||
          /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:[^\s]+$/u.test(effective)
        ) ||
        /[\r\n]/u.test(effective)
      )
        fail('RECONCILIATION_PLAN_PUBLICATION_INVALID');
      const lines = utf8(
        git(
          repositoryRoot,
          [
            'ls-remote',
            '--refs',
            '--upload-pack=git-upload-pack',
            'origin',
            selectors.published_ref,
          ],
          undefined,
          65536,
        ),
      ).split('\n');
      if (lines.pop() !== '' || lines.length !== 1) fail('RECONCILIATION_PLAN_PUBLICATION_INVALID');
      const [tip, ref] = (lines[0] ?? '').split('\t');
      if (!tip || !oidPattern.test(tip) || ref !== selectors.published_ref)
        fail('RECONCILIATION_PLAN_PUBLICATION_INVALID');
      load([tip]);
      if (objects.get(tip)?.type !== 'commit') fail('RECONCILIATION_PLAN_PUBLICATION_INVALID');
      if (tip !== selectors.selected_parent)
        git(
          repositoryRoot,
          ['merge-base', '--is-ancestor', selectors.selected_parent, tip],
          undefined,
          65536,
        );
      return { tip, config, effective: sha(effectiveBytes) };
    };
    const advertised = publication();
    const manifest = {
      files: sourceFiles.sort((a, b) => compare(a.commit, b.commit) || compare(a.path, b.path)),
      index,
      staged_files: stagedFiles,
      recovery_obligations: recoveries.sort(
        (a, b) => compare(a.proof_path, b.proof_path) || a.proof_sequence - b.proof_sequence,
      ),
    };
    const finalPublication = publication();
    const finalChanged = utf8(
      git(repositoryRoot, ['diff-files', '--name-only', '-z', '--no-ext-diff', '--no-textconv']),
    )
      .split('\0')
      .filter(Boolean);
    if (
      canonicalJson(changed) !== canonicalJson(finalChanged) ||
      git(repositoryRoot, ['ls-files', '--others', '--exclude-standard', '-z']).length !== 0
    )
      fail('RECONCILIATION_PLAN_STALE');
    const final = readReconciliationHostBinding();
    if (
      scope !== scopes.getStore() ||
      canonicalJson(identity) !== canonicalJson(readReconciliationHostIdentity(context)) ||
      canonicalJson(identity) !== canonicalJson(final.identity) ||
      binding.binding_sha256 !== final.binding_sha256 ||
      sha(indexBytes(join(paths.git_dir, 'index'))) !== index.raw_sha256 ||
      canonicalJson(advertised) !== canonicalJson(finalPublication)
    )
      fail('RECONCILIATION_PLAN_STALE');
    checkReconciliationClockWindow(binding.clock, final.clock, 'review');
    const result: ReconciliationPlan = {
      schemaVersion: '1.0.0',
      kind: 'evidence-reconciliation-plan',
      identity,
      binding_sha256: binding.binding_sha256,
      selection: {
        parent: selectors.selected_parent,
        published_ref: selectors.published_ref,
        published_tip: advertised.tip,
        origin_config_sha256: advertised.config,
        effective_origin_sha256: advertised.effective,
      },
      bases: [...bases].sort(compare),
      source_manifest: manifest,
      source_manifest_sha256: sha(canonicalJson(manifest)),
      grants_authority: false,
    };
    const freeze = (value: unknown): void => {
      if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
      }
    };
    freeze(result);
    return result;
  } catch (error) {
    if (error instanceof ReconciliationPlanError) throw error;
    console.error('DIAGNOSTIC_NONPRODUCT_ERROR', error instanceof Error ? error.name : typeof error, error instanceof Error ? error.stack?.split('\n').filter(line => line.trimStart().startsWith('at ')).slice(0, 5).join('\n') : '');
    return fail();
  } finally {
    if (context) disposeReconciliationHostContext(context);
  }
}
