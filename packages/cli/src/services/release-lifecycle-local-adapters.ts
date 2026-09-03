import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  spawnSync,
  writeFileSync,
} from '@devai-nyx/authority';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import { runCheckTasks, type CheckRunnerReport } from './check-runner/index.js';
import type {
  ReleaseLifecycleRequest,
  ReleaseProvider,
  ReleaseProviderResult,
  ReleaseStateMaterial,
} from './release-lifecycle-execution.js';

type Json = Readonly<Record<string, unknown>>;

export interface BuiltInReleaseLifecycleLocalContext {
  readonly repo_root: string;
  readonly resolve_receipt: (
    locator: NonNullable<ReleaseLifecycleRequest['receipt_locators']>[number],
  ) => unknown;
  readonly resolve_plan_input: (input: Json) => unknown;
  readonly read_contained_bytes: (path: string) => Buffer;
  readonly run_checks?: typeof runCheckTasks;
}

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function object(value: unknown, code = 'release-local-adapter-input-invalid'): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Json;
}

function planReceipts(
  request: ReleaseLifecycleRequest,
  resolveReceipt: BuiltInReleaseLifecycleLocalContext['resolve_receipt'],
): readonly Json[] {
  const values = (request.receipt_locators ?? [])
    .filter((locator) => locator.kind === 'release-plan-receipt')
    .map((locator) => object(resolveReceipt(locator)));
  if (values.length !== request.candidate_locator.release_units.length) {
    throw new Error('release-receipt-identity-mismatch');
  }
  return values;
}

function receiptInput(receipt: Json, kind: string): Json {
  const values = receipt['inputs'];
  if (!Array.isArray(values)) throw new Error('rpl-input-unresolved');
  const matches = values.map((value) => object(value)).filter((value) => value['kind'] === kind);
  if (matches.length !== 1) throw new Error('rpl-input-unresolved');
  return matches[0] as Json;
}

function artifact(
  path: string,
  bytes: Buffer,
): {
  readonly path: string;
  readonly sha256: string;
  readonly size_bytes: number;
} {
  return { path, sha256: sha256(bytes), size_bytes: bytes.byteLength };
}

function manifestEvidence(
  context: BuiltInReleaseLifecycleLocalContext,
  request: ReleaseLifecycleRequest,
) {
  return request.candidate_locator.release_units.map((unit) => ({
    release_unit: unit.release_unit,
    version: unit.version,
    packages: unit.package_roster.map((pkg) => {
      const bytes = context.read_contained_bytes(pkg.manifest_path);
      const manifest = object(JSON.parse(bytes.toString('utf8')) as unknown);
      if (
        sha256(bytes) !== pkg.manifest_digest_sha256 ||
        manifest['name'] !== pkg.package_id ||
        manifest['version'] !== unit.version
      ) {
        throw new Error('release-package-manifest-identity-mismatch');
      }
      return {
        package_id: pkg.package_id,
        manifest: artifact(pkg.manifest_path, bytes),
        tarball: null,
        sbom: null,
        evidence_manifest: null,
        provider_result: null,
        trust: null,
      };
    }),
  }));
}

function materialInputs(receipts: readonly Json[]): ReleaseStateMaterial['inputs'] {
  const values = new Map<string, ReleaseStateMaterial['inputs'][number]>();
  const stateKind = (kind: string): string =>
    kind === 'release-verification-profile'
      ? 'release-profile'
      : kind === 'action-registry-policy'
        ? 'action-registry'
        : kind;
  for (const receipt of receipts) {
    const inputs = receipt['inputs'];
    if (!Array.isArray(inputs)) throw new Error('rpl-input-unresolved');
    for (const raw of inputs) {
      const input = object(raw);
      if (
        typeof input['kind'] !== 'string' ||
        typeof input['path'] !== 'string' ||
        typeof input['sha256'] !== 'string'
      ) {
        throw new Error('rpl-input-unresolved');
      }
      const value = {
        kind: stateKind(input['kind']),
        path: input['path'],
        sha256: input['sha256'],
      };
      values.set(`${value.kind}\0${value.path}`, value);
    }
  }
  return [...values.values()].sort((left, right) =>
    `${left.kind}\0${left.path}`.localeCompare(`${right.kind}\0${right.path}`, 'en'),
  );
}

function checkPassed(report: CheckRunnerReport, stage: 'preflight' | 'certify'): boolean {
  if (report.exitCode !== 0 || report.execution === undefined) return false;
  if (report.execution.some((entry) => entry.outcome !== 'PASS')) return false;
  return stage === 'preflight'
    ? report.preflightReceipt !== undefined
    : report.receipt !== undefined;
}

function runStage(
  context: BuiltInReleaseLifecycleLocalContext,
  receipt: Json,
  stage: 'preflight' | 'certify',
): readonly CheckRunnerReport[] {
  const intentInput = receiptInput(receipt, 'release-intent');
  const profileInput = receiptInput(receipt, 'release-verification-profile');
  const intent = intentInput['inline_document'] ?? context.resolve_plan_input(intentInput);
  const intentDocument = object(intent);
  const base = object(intentDocument['base']);
  if (typeof base['commit'] !== 'string') throw new Error('rpl-input-unresolved');
  const profile = context.resolve_plan_input(profileInput);
  const run = context.run_checks ?? runCheckTasks;
  const preflight = run({
    repoRoot: context.repo_root,
    target: 'release',
    operation: 'run',
    releaseIntent: intent,
    releaseProfile: profile,
    baseCommit: base['commit'],
    releaseStage: 'preflight',
  });
  if (!checkPassed(preflight, 'preflight') || stage === 'preflight') return [preflight];
  return [
    preflight,
    run({
      repoRoot: context.repo_root,
      target: 'release',
      operation: 'run',
      releaseIntent: intent,
      releaseProfile: profile,
      baseCommit: base['commit'],
      releaseStage: 'certify',
      preflightReceipt: preflight.preflightReceipt?.value,
    }),
  ];
}

function checkProvider(
  context: BuiltInReleaseLifecycleLocalContext,
  action: 'release preflight' | 'release certify',
): ReleaseProvider {
  return (request): ReleaseProviderResult => {
    try {
      const receipts = planReceipts(request, context.resolve_receipt);
      const stage = action === 'release preflight' ? 'preflight' : 'certify';
      const reports = receipts.flatMap((receipt) => runStage(context, receipt, stage));
      if (
        reports.some(
          (report) => !checkPassed(report, report.preflightReceipt ? 'preflight' : 'certify'),
        )
      ) {
        return { outcome: 'failure', code: `release-${stage}-failed` };
      }
      const receiptDigests = [
        ...receipts.map((receipt) => String(receipt['receipt_digest_sha256'])),
        ...reports.flatMap((report) =>
          [report.preflightReceipt?.digest, report.receipt?.digest].filter(
            (value): value is string => value !== undefined,
          ),
        ),
      ].sort();
      return {
        outcome: 'success',
        material: {
          release_units: manifestEvidence(context, request),
          inputs: materialInputs(receipts),
          evidence: {
            manifest_digest_sha256: canonicalSha256(reports),
            receipt_digests: [...new Set(receiptDigests)],
            independently_checkable: true,
          },
          artifacts: [],
        },
      };
    } catch (error) {
      return {
        outcome: 'failure',
        code: error instanceof Error ? error.message : 'release-local-adapter-failed',
      };
    }
  };
}

function ensureContainedDirectory(repoRoot: string, requested: string): string {
  const root = resolve(repoRoot);
  const destination = resolve(root, requested);
  const escaped = relative(root, destination);
  if (escaped === '..' || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
    throw new Error('release-destination-path-unsafe');
  }
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('release-destination-path-unsafe');
  }
  let cursor = root;
  for (const part of escaped.split(sep)) {
    if (part.length === 0) continue;
    cursor = join(cursor, part);
    if (!existsSync(cursor)) mkdirSync(cursor, { mode: 0o700 });
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('release-destination-path-unsafe');
    }
  }
  return destination;
}

function packedFilename(stdout: string): string {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) throw new Error('release-pack-output-invalid');
  const first = object(parsed[0]);
  if (typeof first['filename'] !== 'string' || first['filename'].length === 0) {
    throw new Error('release-pack-output-invalid');
  }
  return first['filename'];
}

function packOnce(packageRoot: string, output: string): string {
  const result = spawnSync(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', output],
    { cwd: packageRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    throw new Error('release-pack-failed');
  }
  const path = join(output, basename(packedFilename(result.stdout)));
  if (!existsSync(path)) throw new Error('release-pack-output-missing');
  return path;
}

function safeArtifactName(packageId: string): string {
  return packageId
    .replace(/^@/u, '')
    .replaceAll('/', '-')
    .replaceAll(/[^A-Za-z0-9._-]/gu, '-');
}

function prepareProvider(context: BuiltInReleaseLifecycleLocalContext): ReleaseProvider {
  return (request): ReleaseProviderResult => {
    let temporary = '';
    try {
      const receipts = planReceipts(request, context.resolve_receipt);
      const destination = request.destination;
      if (destination?.kind !== 'local-staging') {
        throw new Error('release-destination-path-unsafe');
      }
      const outputRoot = ensureContainedDirectory(context.repo_root, destination.exact_identifier);
      temporary = mkdtempSync(join(tmpdir(), 'devai-release-prepare-'));
      const releaseUnits = manifestEvidence(context, request);
      const artifacts: ReleaseStateMaterial['artifacts'][number][] = [];
      const preparedUnits = releaseUnits.map((unit) => ({
        ...unit,
        packages: unit.packages.map((pkg) => {
          const roster = request.candidate_locator.release_units
            .find((value) => value.release_unit === unit.release_unit)
            ?.package_roster.find((value) => value.package_id === pkg.package_id);
          if (roster === undefined) throw new Error('release-release-unit-bijection-invalid');
          const packageRoot = dirname(resolve(context.repo_root, roster.manifest_path));
          const firstRoot = join(temporary, `${safeArtifactName(pkg.package_id)}-first`);
          const secondRoot = join(temporary, `${safeArtifactName(pkg.package_id)}-second`);
          mkdirSync(firstRoot, { mode: 0o700 });
          mkdirSync(secondRoot, { mode: 0o700 });
          const first = packOnce(packageRoot, firstRoot);
          const second = packOnce(packageRoot, secondRoot);
          const firstBytes = readFileSync(first);
          const secondBytes = readFileSync(second);
          if (sha256(firstBytes) !== sha256(secondBytes)) {
            throw new Error('release-pack-nondeterministic');
          }
          const name = `${safeArtifactName(pkg.package_id)}-${unit.version}`;
          const tarballPath = join(outputRoot, `${name}.tgz`);
          writeFileSync(tarballPath, firstBytes, { flag: 'wx', mode: 0o600 });
          const tarball = artifact(
            relative(context.repo_root, tarballPath).replaceAll('\\', '/'),
            firstBytes,
          );
          const sbomDocument = {
            bomFormat: 'CycloneDX',
            specVersion: '1.6',
            version: 1,
            metadata: {
              component: {
                type: 'library',
                name: pkg.package_id,
                version: unit.version,
                hashes: [{ alg: 'SHA-256', content: tarball.sha256 }],
              },
            },
          };
          const sbomBytes = Buffer.from(`${canonicalJson(sbomDocument)}\n`);
          const sbomPath = join(outputRoot, `${name}.cdx.json`);
          writeFileSync(sbomPath, sbomBytes, { flag: 'wx', mode: 0o600 });
          const sbom = artifact(
            relative(context.repo_root, sbomPath).replaceAll('\\', '/'),
            sbomBytes,
          );
          artifacts.push(
            { kind: 'manifest', ...pkg.manifest },
            { kind: 'package-tarball', ...tarball },
            { kind: 'sbom', ...sbom },
          );
          return { ...pkg, tarball, sbom };
        }),
      }));
      return {
        outcome: 'success',
        material: {
          release_units: preparedUnits,
          inputs: materialInputs(receipts),
          evidence: {
            manifest_digest_sha256: canonicalSha256(artifacts),
            receipt_digests: receipts
              .map((receipt) => String(receipt['receipt_digest_sha256']))
              .sort(),
            independently_checkable: true,
          },
          artifacts: artifacts.sort((left, right) =>
            `${left.kind}\0${left.path}`.localeCompare(`${right.kind}\0${right.path}`, 'en'),
          ),
        },
      };
    } catch (error) {
      return {
        outcome: 'failure',
        code: error instanceof Error ? error.message : 'release-prepare-failed',
      };
    } finally {
      if (temporary.length > 0) rmSync(temporary, { recursive: true, force: true });
    }
  };
}

/** Production local adapters. Protected providers are intentionally absent. */
export function builtInReleaseLifecycleLocalProvider(
  context: BuiltInReleaseLifecycleLocalContext,
  action: ReleaseLifecycleRequest['action_id'],
): ReleaseProvider | undefined {
  if (action === 'release preflight' || action === 'release certify') {
    return checkProvider(context, action);
  }
  if (action === 'release prepare') return prepareProvider(context);
  return undefined;
}
