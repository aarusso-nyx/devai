import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ATTESTED_RC_WORKFLOW_FILE,
  NEXT_VERIFIER_SOURCE_COMMIT,
  VERIFIER_PACKAGE,
  VERIFIER_SOURCE_COMMIT,
  attestedRcVerificationWorkflow,
  buildCiScaffoldPlan,
} from '../../src/services/ci-scaffold/index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(root: string, path: string, value: unknown): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
}

function project(root: string): void {
  put(root, '.devai/config/project.json', {
    ci_economy: {
      attested_rc: {
        profile: 'rc',
        transport: 'protected-tag-v1',
        tag_prefix: 'devai-local-evidence/',
        binding: 'exact-tree',
        required_check: 'verified-local-rc',
        failure_mode: 'fail-closed',
        local_only_nodes: ['test:mutation'],
      },
    },
  });
}

describe('attested RC workflow scaffold', () => {
  it('selects the protected package verifier and never executes candidate product commands', () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-attested-workflow-'));
    roots.push(root);
    project(root);
    const plan = buildCiScaffoldPlan({ targetRoot: root });
    expect(plan.path).toBe(join(root, '.github/workflows', ATTESTED_RC_WORKFLOW_FILE));
    expect(plan.content).toBe(attestedRcVerificationWorkflow());
    expect(() => parse(plan.content)).not.toThrow();
    expect(plan.content).toContain('vars.DEVAI_LEDGER_VERIFIER_PROVENANCE_SHA256');
    expect(plan.content).toContain(
      'test "$actual_provenance_sha256" = "$VERIFIER_PROVENANCE_SHA256"',
    );
    expect(plan.content).toContain(`manifest.name !== '${VERIFIER_PACKAGE}'`);
    expect(plan.content).toContain(
      `!['${VERIFIER_SOURCE_COMMIT}', '${NEXT_VERIFIER_SOURCE_COMMIT}'].includes(provenance.sourceCommit)`,
    );
    expect(plan.content).toContain('DEVAI_VERIFIER_PACKAGE_BIN_INVALID:');
    expect(plan.content).toContain('DEVAI_VERIFIER_PACKAGE_POPULATION_INVALID');
    expect(plan.content).toContain('node "$DEVAI_EVIDENCE_BUNDLE_VERIFY"');
    expect(plan.content).toContain('node "$DEVAI_EVIDENCE_POLICY"');
    expect(
      plan.content.indexOf('test "$actual_provenance_sha256" = "$VERIFIER_PROVENANCE_SHA256"'),
    ).toBeLessThan(
      plan.content.indexOf('cp -R "$source_root/schemas" "$source_root/src" "$verifier_root/"'),
    );
    expect(plan.content).toContain('name: verified-local-rc');
    expect(plan.content).toContain('--binding "${{ steps.identity.outputs.binding }}"');
    expect(plan.content).toContain('control/law/policy/devai-local-rc-trust-store.json');
    expect(plan.content).not.toMatch(/pnpm (?:run|exec|test)|\bstryker\b/u);
    expect(plan.content).not.toContain('NODE_AUTH_TOKEN');
    expect(plan.content).not.toContain('devai-nyx/devai-verifier');
    expect(plan.content).not.toContain('DEVAI_LEDGER_PACKAGE_TGZ_B64');
    expect(plan.content).not.toContain('DEVAI_LEDGER_PACKAGE_SHA256');
    expect(plan.content).not.toMatch(/repository:\s+devai-nyx\/devai-verifier/u);
  });

  it('fails closed instead of generating from malformed attested-RC policy', () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-attested-workflow-'));
    roots.push(root);
    project(root);
    const configPath = join(root, '.devai/config/project.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      ci_economy: { attested_rc: { failure_mode: string } };
    };
    config.ci_economy.attested_rc.failure_mode = 'fallback';
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    expect(() => buildCiScaffoldPlan({ targetRoot: root })).toThrow(
      /CI_SCAFFOLD_ATTESTED_RC_INVALID/u,
    );
  });
});
