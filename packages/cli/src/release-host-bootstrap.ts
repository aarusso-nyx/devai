import { isBuiltin, registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  captureReleaseHostCandidate,
  captureReleaseHostPackage,
  type ReleaseHostCandidateControls,
  type ReleaseHostPackageControls,
} from './services/release-policy-host-snapshot.js';
import type { ReleaseCandidateSnapshot } from './services/release-candidate-snapshot.js';
import type { ReleasePackageSnapshot } from './services/release-package-snapshot.js';

export type { ReleaseHostCandidateControls, ReleaseHostPackageControls };
export {
  verifyReleaseHostArchive,
  type ReleaseHostArchiveControls,
  type ReleaseHostArchiveProjection,
} from './services/release-package-snapshot.js';

export interface BootstrappedReleaseHost {
  /** The one shared CLI runtime, loaded from this installation's approved bytes. */
  readonly runtime: typeof import('./release-host.js');
  /** Branded by that exact running implementation, not the bootstrap's verifier copy. */
  readonly installed_package: ReleasePackageSnapshot;
  readonly collectCandidate: (controls: ReleaseHostCandidateControls) => ReleaseCandidateSnapshot;
}

const INVALID = 'rpl-package-identity-mismatch';
const ENTRY = 'dist/runtime/index/release-host.js';
const attempted = new Set<string>();

/**
 * Trusted host startup, before importing release-host or the bin. The bootstrap and
 * Node process are external trust controls: hashing this bootstrap after evaluation
 * would not authenticate it. No request, candidate file or environment selects code.
 *
 * The canonical runtime URL preserves resource resolution and the CLI's WeakSets.
 * A pre-cached runtime is refused unless this invocation's hook supplied its bytes.
 * Await the returned promise before use. Concurrent or repeated attempts for the
 * same canonical runtime are refused, including retries after failed startup.
 * Required dependencies are bundled in that single module. Hooks remain installed
 * for the process lifetime: later imports cannot fall back to optional SDKs,
 * node_modules, or independently cached package members. Failed startup keeps a
 * permanent denial for that installation; there
 * is intentionally no dispose-and-continue mode. Other application modules and the
 * ordinary bin (when not bootstrapped) retain their normal loader behavior.
 *
 * This loader is code-identity enforcement, not a sandbox for approved host code.
 * Child task executables/dependencies remain separately approved execution controls.
 */
export async function bootstrapReleaseHost(
  controls: ReleaseHostPackageControls,
): Promise<BootstrappedReleaseHost> {
  let failed = false;
  try {
    const capture = captureReleaseHostPackage(controls);
    const rootUrl = pathToFileURL(`${capture.root}/`).href;
    const entryUrl = pathToFileURL(join(capture.root, ENTRY)).href;
    if (attempted.has(entryUrl)) throw new Error(INVALID);
    attempted.add(entryUrl);
    const source = capture.snapshot.read(ENTRY);
    let supplied = false;
    let refusedImport = false;
    let ready = false;
    const denyImport = (): never => {
      refusedImport = true;
      throw new Error(INVALID);
    };
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (isBuiltin(specifier))
          return {
            url: specifier.startsWith('node:') ? specifier : `node:${specifier}`,
            shortCircuit: true,
          };
        const protectedParent = context.parentURL === entryUrl;
        let url: string | undefined;
        if (specifier.startsWith('file:')) url = new URL(specifier).href;
        else if (specifier.startsWith('/')) url = pathToFileURL(specifier).href;
        else if (specifier.startsWith('.') && context.parentURL !== undefined)
          url = new URL(specifier, context.parentURL).href;
        if (url === entryUrl) {
          if (failed) return denyImport();
          if (!ready && context.parentURL !== import.meta.url) return denyImport();
          return { url, shortCircuit: true };
        }
        if (protectedParent || (url !== undefined && url.startsWith(rootUrl))) return denyImport();
        return nextResolve(specifier, context);
      },
      load(url, context, nextLoad) {
        if (url === entryUrl) {
          if (failed) return denyImport();
          supplied = true;
          return {
            format: 'module',
            source: Buffer.from(source),
            shortCircuit: true,
          };
        }
        if (url.startsWith(rootUrl)) return denyImport();
        return nextLoad(url, context);
      },
    });
    // Native import skips load for both prior import and prior require(ESM) cache
    // hits. Do NOT substitute require(ESM): it can call load yet return old exports.
    // Other importers are refused until the complete package equality checks pass.
    const runtime = (await import(entryUrl)) as typeof import('./release-host.js');
    // A dependency's optional-import catch cannot hide an initialization denial.
    if (!supplied || refusedImport) throw new Error(INVALID);
    const installed = runtime.verifyReleasePackageSnapshot(capture.readVerificationInput());
    runtime.bindReleaseHostPackageSnapshot(installed);
    const session: BootstrappedReleaseHost = Object.freeze({
      runtime,
      installed_package: installed,
      collectCandidate: (input: ReleaseHostCandidateControls) =>
        runtime.verifyReleaseCandidateSnapshot(captureReleaseHostCandidate(input)),
    });
    ready = true;
    return session;
  } catch {
    failed = true;
    // Do not expose paths, module source, rejected member names or native causes.
    throw new Error(INVALID);
  }
}
