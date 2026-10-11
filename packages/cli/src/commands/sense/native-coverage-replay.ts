import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, relative, resolve } from 'node:path';
import { createNativeCoverageAdapterKernel } from '../../native-coverage-kernel.js';
import type {
  NativeCoverageAdapterOptions,
  NativeCoverageKernelHost,
} from '../../native-coverage-kernel.js';
import { canonicalize } from '../../services/check-runner/canonical.js';
import {
  gitText,
  trackedPaths,
  isHarnessMutatedPath,
  RELEASE_INPUT_PROJECTION,
} from '../../services/check-runner/policy-git.js';
import { nativeCoverageGitIdentity } from './native-coverage-host.js';

type Row = Record<string, unknown>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function invalid(): never {
  throw new Error('NATIVE_COVERAGE_ADAPTER_REPLAY_INVALID');
}
const keys = (row: Row, fields: readonly string[]) => {
  if (
    JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(['nonce', 'scope', ...fields].sort())
  )
    invalid();
};

/** Independent current derivation, never an authored provider's claimed proof or a dist exemption. */
export function replayNativeCoverageAdapters(
  root: string,
  task: { readonly cwd: string },
  rows: readonly Row[],
): { has: (path: string, row: Row) => boolean } {
  const relevant = rows.filter((row) => String(row['kind']).startsWith('adapter-'));
  const verified = new Map<string, { sha256: string; scope: string; index: number }[]>();
  const indices = new Map(rows.map((row, index) => [row, index]));
  const parents = new Map<string, string>();
  for (const row of rows)
    if (
      (row['kind'] === 'child' || row['kind'] === 'loader-registration') &&
      typeof row['childScope'] === 'string' &&
      typeof row['scope'] === 'string'
    )
      parents.set(row['childScope'], row['scope']);
  const admitted = {
    has(path: string, row: Row): boolean {
      const index = indices.get(row);
      let scope = row['scope'];
      if (index === undefined || typeof scope !== 'string') return false;
      const ancestry = new Set<string>();
      while (typeof scope === 'string' && !ancestry.has(scope)) {
        ancestry.add(scope);
        scope = parents.get(scope);
      }
      return (verified.get(path) ?? []).some(
        (receipt) => receipt.index < index && ancestry.has(receipt.scope),
      );
    },
  };
  if (relevant.length === 0) return admitted;
  const repository = realpathSync(root);
  const packageDir = realpathSync(resolve(repository, task.cwd));
  const git = nativeCoverageGitIdentity();
  const candidate = gitText(repository, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  const io: NativeCoverageKernelHost['io'] = {
    createHash,
    accessSync,
    constants,
    lstatSync,
    readFileSync,
    readdirSync,
    readlinkSync,
    realpathSync,
    createRequire,
    // Reuse the host's closed policy-Git boundary. No caller receives this callback.
    execFileSync: ((executable: string, args: readonly string[]) => {
      if (executable !== git.path || args[0] !== '-c' || args[1] !== 'core.fsmonitor=false')
        return invalid();
      const command = args.slice(2);
      if (JSON.stringify(command) === JSON.stringify(['rev-parse', '--verify', 'HEAD']))
        return `${gitText(repository, ['rev-parse', '--verify', 'HEAD^{commit}']).trim()}\n`;
      return invalid();
    }) as NativeCoverageKernelHost['io']['execFileSync'],
  };
  type Kernel = ReturnType<typeof createNativeCoverageAdapterKernel>;
  const adapters = new Map<
    string,
    {
      kernel: Kernel;
      phase: 'active' | 'evidence' | 'ended';
      derivations: Map<string, string>;
      evidenceSha256?: string;
    }
  >();
  for (const row of relevant) {
    if (
      typeof row['scope'] !== 'string' ||
      typeof row['adapterId'] !== 'number' ||
      !Number.isSafeInteger(row['adapterId']) ||
      row['adapterId'] < 1 ||
      row['adapterId'] > 1024
    )
      invalid();
    const key = `${String(row['scope'])}:${row['adapterId']}`;
    if (row['kind'] === 'adapter-begin') {
      keys(row, ['kind', 'adapterId', 'request', 'requestSha256']);
      if (adapters.has(key) || hash(JSON.stringify(row['request'])) !== row['requestSha256'])
        invalid();
      const kernel = createNativeCoverageAdapterKernel(
        row['request'] as NativeCoverageAdapterOptions,
        {
          io,
          path: '',
          mode: 'governed',
          bound: {
            repository,
            candidate,
            packageDir,
            git,
            tracked: trackedPaths(repository).filter((path) => !isHarnessMutatedPath(path)),
            excludedPrefixes: RELEASE_INPUT_PROJECTION.excludedPrefixes,
          },
        },
      );
      if (canonicalize(kernel.request) !== canonicalize(row['request'])) invalid();
      adapters.set(key, { kernel, phase: 'active', derivations: new Map() });
      continue;
    }
    const state = adapters.get(key);
    if (state === undefined || state.phase === 'ended') invalid();
    if (row['kind'] === 'adapter-derived') {
      keys(row, [
        'kind',
        'adapterId',
        'mode',
        'source',
        'outputs',
        'diagnostics',
        'derivationSha256',
      ]);
      if (
        state.phase !== 'active' ||
        (row['mode'] !== 'production' && row['mode'] !== 'coverage') ||
        typeof row['source'] !== 'string'
      )
        invalid();
      const result = state.kernel.api.compile({ mode: row['mode'], source: row['source'] });
      const summary = {
        outputs: result.outputs.map(({ path, sha256 }) => ({ path, sha256 })),
        diagnostics: result.diagnostics,
      };
      const derivationSha256 = hash(JSON.stringify(summary));
      if (
        canonicalize(summary.outputs) !== canonicalize(row['outputs']) ||
        canonicalize(summary.diagnostics) !== canonicalize(row['diagnostics']) ||
        derivationSha256 !== row['derivationSha256']
      )
        invalid();
      if (row['mode'] === 'production')
        for (const output of result.outputs) state.derivations.set(output.path, derivationSha256);
    } else if (row['kind'] === 'adapter-verified-output') {
      keys(row, ['kind', 'adapterId', 'path', 'sha256', 'derivationSha256']);
      if (
        state.phase !== 'active' ||
        typeof row['path'] !== 'string' ||
        state.derivations.get(row['path']) !== row['derivationSha256']
      )
        invalid();
      const text = state.kernel.api.readVerifiedOutput(row['path']);
      if (hash(text) !== row['sha256']) invalid();
      const path = resolve(packageDir, row['path']);
      const portable = relative(repository, path);
      if (isAbsolute(portable) || portable === '..' || portable.startsWith('../')) invalid();
      const prior = verified.get(path) ?? [];
      if (prior.some((receipt) => receipt.sha256 !== row['sha256'])) invalid();
      prior.push({
        sha256: hash(text),
        scope: row['scope'] as string,
        index: indices.get(row) as number,
      });
      verified.set(path, prior);
    } else if (row['kind'] === 'adapter-evidence') {
      keys(row, ['kind', 'adapterId', 'evidence', 'evidenceSha256']);
      if (state.phase !== 'active') invalid();
      const evidence = state.kernel.api.evidence();
      const evidenceSha256 = hash(JSON.stringify(evidence));
      if (
        canonicalize(evidence) !== canonicalize(row['evidence']) ||
        evidenceSha256 !== row['evidenceSha256']
      )
        invalid();
      state.evidenceSha256 = evidenceSha256;
      state.phase = 'evidence';
    } else if (row['kind'] === 'adapter-end') {
      keys(row, ['kind', 'adapterId', 'evidenceSha256']);
      if (state.phase !== 'evidence' || state.evidenceSha256 !== row['evidenceSha256']) invalid();
      state.kernel.api.verify();
      state.phase = 'ended';
    } else invalid();
  }
  for (const state of adapters.values()) {
    if (state.phase !== 'ended') invalid();
    state.kernel.api.verify();
  }
  return admitted;
}
