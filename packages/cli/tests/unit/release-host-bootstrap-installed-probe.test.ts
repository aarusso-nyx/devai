import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const probe = readFileSync(
  fileURLToPath(new URL('../fixtures/release-host-bootstrap-installed-probe.mjs', import.meta.url)),
  'utf8',
);

describe('installed release-host bootstrap probe', () => {
  it('keeps the real-package bootstrap population and isolated irreversible modes', () => {
    for (const marker of [
      "'pnpm-negative'",
      "'positive-candidate'",
      "'captured-immutability'",
      "'cache-import'",
      "'cache-require'",
      "'cache-altered-import'",
      "'cache-altered-require'",
      "'asset-inequality'",
      "'provisioning-refusals'",
      "'failed-startup'",
      'bootstrapReleaseHost',
      'provisionReleaseHostPackage',
      'archiveManifest',
      'collectCandidate',
      'remote.origin.promisor',
      'gitControl',
      'createRequire',
      '__devaiBootstrapCachedSentinel',
      'execFileSync(',
      'process.execPath',
    ]) {
      expect(probe, `installed bootstrap probe missing ${marker}`).toContain(marker);
    }
    expect(probe).toContain("message: 'rpl-package-identity-mismatch'");
    expect(probe).toContain("provisioned.host.runtime.invokeDevaiCli(['--version'])");
  });
});
