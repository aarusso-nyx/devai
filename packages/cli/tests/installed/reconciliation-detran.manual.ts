/** Explicit installed public DETRAN rehearsal; external custody is not a portable unit fixture.
 * No private runtime imports or authority mocks.
 * Fixture construction is a separate driver so native workflow duration does not
 * require changing any established Vitest timeout. Run prepare once, then set
 * DEVAI_DETRAN_FIXTURE_JSON, DEVAI_INSTALLED_PACKAGE and DEVAI_DETRAN_EVIDENCE.
 * The orchestrator supplies the admitted package and actual public upgrade/bind.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

const driver = await import(
  pathToFileURL(resolve(import.meta.dirname, 'reconciliation-detran-driver.mjs')).href
);

it('retains exact historical custody and derives the two original physical orphan rows', () => {
  const admitted = driver.custody();
  const source = '/Volumes/Development/.codex/artifacts/detran/pr211-main-reconciliation-20261023';
  const main = readFileSync(resolve(source, 'main/record/proofs/chain.json'));
  const s2 = readFileSync(resolve(source, 's2/record/proofs/chain.json'));
  const epoch = readFileSync(resolve(source, 's2/record/proofs/work/generic/R-0025.jsonl'));
  expect(JSON.parse(main.toString()).records).toHaveLength(335);
  expect(JSON.parse(s2.toString()).records).toHaveLength(169);
  expect(
    driver.orphanOracle(main, epoch).map((row: { proof_sequence: number }) => row.proof_sequence),
  ).toEqual([7, 8]);
  expect(admitted.input.historicalIndex.entries).toBe(15804);
  expect(admitted.input.resolvedZipMembers).toHaveLength(58);
});

it('installed public plan admits the genuine bound historical fixture without changing its index', () => {
  const fixturePath = process.env['DEVAI_DETRAN_FIXTURE_JSON'];
  const packageRoot = process.env['DEVAI_INSTALLED_PACKAGE'];
  const evidencePath = process.env['DEVAI_DETRAN_EVIDENCE'];
  expect(fixturePath, 'Prepare actual disposable fixture and public binding first').toBeTruthy();
  expect(packageRoot, 'Admitted installed candidate is required').toBeTruthy();
  expect(evidencePath, 'External evidence output is required').toBeTruthy();
  if (!fixturePath || !packageRoot || !evidencePath)
    throw new Error('Installed rehearsal inputs absent');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  expect(fixture.mode).toBe('historical');
  expect(fixture.selected_records).toBe(335);
  const result = driver.publicPlan(fixture, packageRoot, evidencePath);
  expect(result.exit, result.stderr.toString()).toBe(0);
  const envelope = JSON.parse(result.stdout.toString());
  expect(envelope).toMatchObject({
    schemaVersion: '1.0.0',
    action_id: 'evidence reconcile plan',
    ok: true,
  });
  const plan = envelope.result.value;
  expect(plan).toMatchObject({
    schemaVersion: '1.0.0',
    kind: 'evidence-reconciliation-plan',
    grants_authority: false,
  });
  expect(
    plan.source_manifest.recovery_obligations.map(
      (row: { proof_sequence: number }) => row.proof_sequence,
    ),
  ).toEqual([7, 8]);
});
