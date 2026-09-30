#!/usr/bin/env node
// Packed-adopter publication proof (ADR-REL-0033, ADR-SCR-0011 IA-004).
//
// Packs the candidate CLI package through the npm-pack-output guard (or takes an
// existing tarball with --tarball <path>), extracts it into a disposable adopter
// fixture, and runs the proof defined in docs/adopters/pack-resolution.md from the
// packed bytes. Every divergence exits 1 with its named code. The script reads only
// the source law files it compares against, the packed artifact, and the fixture it
// creates under the system temporary directory; it performs no push, tag, publish, or
// network write, and it never edits a threshold, a reading, or an override.
//
// Usage: node scripts/rehearse-packed-adopter.mjs [--tarball <path>] [--format json] [--keep]

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { npmPackOutput } from './npm-pack-output.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PACKAGE = join(ROOT, 'packages/cli');
const STORE = '.devai/state/sensor-readings';
const LEGACY_STORE = 'record/proofs/freshness/readings';
const RECORDED_KIND = 'inventory_api';
const CELL = { substrate: 'F4', property: 'T1' };
const FOUR_KINDS = [
  'decision_record_integrity',
  'decision_citation_resolution',
  'archive_immutability',
  'round_record_integrity',
];
// Each packed path an adopter installs, paired with the source bytes it must equal.
const PACKED_LAW = [
  ['dist/law/policy/sensor-registry.json', 'law/policy/sensor-registry.json'],
  ['dist/runtime/index/sensor-registry.json', 'law/policy/sensor-registry.json'],
  ['dist/law/policy/sense-presets.json', 'law/policy/sense-presets.json'],
  ['dist/runtime/index/sense-presets.json', 'law/policy/sense-presets.json'],
  [
    'dist/runtime/index/schemas/sensor-reading.schema.json',
    'law/schemas/sensor-reading.schema.json',
  ],
];
const PACKED_SCHEMA = 'dist/runtime/index/schemas/sensor-reading.schema.json';

const argv = process.argv.slice(2);
function option(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}
const json = option('--format') === 'json' || argv.includes('--json');
const keep = argv.includes('--keep');
const suppliedTarball = option('--tarball');

// Child processes never inherit a Git hook's repository binding or any network proxy.
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith('GIT_') && !/^(https?|all|no)_proxy$/iu.test(key),
  ),
);
childEnv.NO_COLOR = '1';

const checks = [];
function record(id, failureCode, ok, detail) {
  checks.push({ id, ok, ...(ok ? {} : { code: failureCode }), ...(detail ? { detail } : {}) });
  return ok;
}

class ProofFailure extends Error {}
function fail(code, detail) {
  checks.push({ id: 'pack', ok: false, code, ...(detail ? { detail } : {}) });
  throw new ProofFailure(code);
}

const workspace = mkdtempSync(join(tmpdir(), 'devai-packed-adopter-rehearsal-'));
const fixture = join(workspace, 'adopter');
let packageRoot = '';
let tarballPath = '';
let head = '';

function cli(args) {
  const result = spawnSync(
    process.execPath,
    [join(packageRoot, 'dist/runtime/index/bin.js'), ...args],
    { cwd: fixture, encoding: 'utf8', env: childEnv, maxBuffer: 256 * 1024 * 1024 },
  );
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function envelope(result) {
  // The CLI writes its envelope to stdout, or to stderr when the action is refused or gated.
  try {
    return JSON.parse(result.stdout.trim() === '' ? result.stderr : result.stdout);
  } catch {
    return undefined;
  }
}

function git(args) {
  return execFileSync('git', args, { cwd: fixture, encoding: 'utf8', env: childEnv }).trim();
}

function packedJson(relative) {
  return JSON.parse(readFileSync(join(packageRoot, relative), 'utf8'));
}

function packedValidator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv.compile(packedJson(PACKED_SCHEMA));
}

function resetStore() {
  rmSync(join(fixture, STORE), { recursive: true, force: true });
  mkdirSync(join(fixture, STORE), { recursive: true });
}

function placeInStore(kind, name, body) {
  mkdirSync(join(fixture, STORE, kind), { recursive: true });
  writeFileSync(join(fixture, STORE, kind, name), body);
}

function senseRunReading(kind) {
  const parsed = envelope(cli(['sense', 'run', kind, '--repo-root', '.', '--format', 'json']));
  const value = parsed?.result?.value ?? parsed?.error?.context?.payload;
  const stdout = value?.results?.[0]?.stdout ?? '';
  return stdout === '' ? undefined : JSON.parse(stdout);
}

function recordReading(reading) {
  const input = join('scratch', `${String(reading.id)}.json`);
  mkdirSync(join(fixture, 'scratch'), { recursive: true });
  writeFileSync(join(fixture, input), `${JSON.stringify(reading)}\n`);
  const result = cli([
    'sense',
    'record',
    '--input',
    input,
    '--repo-root',
    '.',
    '--as-role',
    'inspector',
    '--write',
    '--format',
    'json',
  ]);
  return result.status === 0 ? String(envelope(result)?.result?.value?.path ?? '') : '';
}

function scorecard(at = head) {
  return cli(['audit', 'scorecard', '--repo-root', '.', '--at', at, '--format', 'json']);
}

function cellOf(result) {
  if (result.status !== 0) return undefined;
  const cells = envelope(result)?.result?.value?.cells ?? [];
  return cells.find((cell) => cell.substrate === CELL.substrate && cell.property === CELL.property);
}

function pack() {
  if (suppliedTarball !== undefined) {
    tarballPath = resolve(suppliedTarball);
    if (!existsSync(tarballPath)) fail('RELEASE_PACK_OUTPUT_INVALID', 'tarball missing');
  } else {
    const destination = join(workspace, 'pack');
    mkdirSync(destination);
    const manifest = JSON.parse(readFileSync(join(CLI_PACKAGE, 'package.json'), 'utf8'));
    let entry;
    try {
      const output = execFileSync(
        'npm',
        ['pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', destination],
        { cwd: CLI_PACKAGE, encoding: 'utf8', env: childEnv },
      );
      entry = npmPackOutput(JSON.parse(output), {
        name: manifest.name,
        version: manifest.version,
      });
    } catch (error) {
      fail('RELEASE_PACK_OUTPUT_INVALID', error instanceof Error ? error.message : String(error));
    }
    tarballPath = join(destination, basename(entry.filename));
  }
  const extract = join(workspace, 'extract');
  mkdirSync(extract);
  try {
    execFileSync('tar', ['-xzf', tarballPath, '-C', extract], { env: childEnv });
  } catch {
    fail('RELEASE_PACK_OUTPUT_INVALID', 'tarball does not extract');
  }
  packageRoot = join(extract, 'package');
  if (!existsSync(join(packageRoot, 'dist/runtime/index/bin.js'))) {
    fail('RELEASE_PACK_OUTPUT_INVALID', 'packed bin missing: run pnpm run build first');
  }
}

function checkArtifact() {
  for (const [packed, source] of PACKED_LAW) {
    const packedPath = join(packageRoot, packed);
    record(
      `artifact:${packed}`,
      `RELEASE_PACKED_ADOPTER_ARTIFACT_DIVERGED:${packed}`,
      existsSync(packedPath) && readFileSync(packedPath).equals(readFileSync(join(ROOT, source))),
    );
  }
  const registry = packedJson('dist/law/policy/sensor-registry.json').entries;
  const sweep = packedJson('dist/law/policy/sense-presets.json').presets.find(
    (preset) => preset.name === 'sweep',
  );
  const effects = new Map(registry.map((entry) => [entry.kind, entry.effect]));
  const effectful = (sweep?.members ?? []).filter((kind) => effects.get(kind) !== 'read');
  record(
    'sweep:effect',
    `RELEASE_PACKED_ADOPTER_SWEEP_EFFECT:${effectful[0] ?? 'sweep'}`,
    sweep !== undefined && sweep.members.length > 0 && effectful.length === 0,
    effectful.length > 0 ? effectful.join(',') : undefined,
  );
  const enumKinds = new Set(packedJson(PACKED_SCHEMA).properties.sensor.properties.kind.enum);
  const unadmitted = (sweep?.members ?? []).filter((kind) => !enumKinds.has(kind));
  record(
    'sweep:admitted',
    `RELEASE_PACKED_ADOPTER_READING_INVALID:${unadmitted[0] ?? 'sweep'}`,
    unadmitted.length === 0,
    unadmitted.length > 0 ? unadmitted.join(',') : undefined,
  );
}

function createFixture() {
  mkdirSync(fixture);
  git(['init', '-q']);
  git(['config', 'user.name', 'DEVAI packed adopter']);
  git(['config', 'user.email', 'packed-adopter@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(fixture, '.gitignore'), '.devai/state/\nscratch/\n');
  for (const selector of [
    ['--constitution', '--tier', 'tier1'],
    ['--operational-law'],
    ['--subprocess-effects'],
    [],
  ]) {
    const bound = cli([
      'init',
      'bind',
      ...selector,
      '--target',
      '.',
      '--as-role',
      'architect',
      '--write',
      '--format',
      'json',
    ]);
    if (bound.status !== 0) fail('RELEASE_PACK_OUTPUT_INVALID', `init bind: ${bound.stderr}`);
  }
  mkdirSync(join(fixture, 'src'));
  writeFileSync(
    join(fixture, 'src/tickets.controller.ts'),
    [
      "import { Controller, Get } from '@nestjs/common';",
      '',
      "@Controller('tickets')",
      'export class TicketsController {',
      '  @Get()',
      '  list() { return []; }',
      '}',
      '',
    ].join('\n'),
  );
  git(['add', '-A']);
  git(['commit', '-qm', 'packed adopter fixture']);
  head = git(['rev-parse', 'HEAD']);
}

function checkSweepReadings() {
  const parsed = envelope(
    cli([
      'sense',
      'run',
      '--preset',
      'sweep',
      '--round',
      'R-0001',
      '--repo-root',
      '.',
      '--format',
      'json',
    ]),
  );
  const value = parsed?.result?.value ?? parsed?.error?.context?.payload;
  const validate = packedValidator();
  const emitted = new Set();
  const invalid = [];
  for (const run of value?.results ?? []) {
    if (run.stdout === '') continue;
    let reading;
    try {
      reading = JSON.parse(run.stdout);
    } catch {
      invalid.push(String(run.command));
      continue;
    }
    const kind = String(reading?.sensor?.kind ?? run.command);
    if (!validate(reading)) invalid.push(kind);
    else emitted.add(kind);
  }
  const missing = FOUR_KINDS.filter((kind) => !emitted.has(kind));
  const failed = [...invalid, ...missing];
  record(
    'sweep:readings',
    `RELEASE_PACKED_ADOPTER_READING_INVALID:${failed[0] ?? 'sweep'}`,
    value !== undefined && failed.length === 0,
    failed.length > 0 ? failed.join(',') : `${String(emitted.size)} readings valid`,
  );
}

function checkRoute() {
  resetStore();
  const reading = senseRunReading(RECORDED_KIND);
  const persisted = reading === undefined ? '' : recordReading(reading);
  const relative = reading === undefined ? '' : join(STORE, RECORDED_KIND, `${reading.id}.json`);
  const first = scorecard();
  const second = scorecard();
  record(
    'route:identical',
    'RELEASE_PACKED_ADOPTER_ROUTE_DIVERGED',
    first.status === 0 && second.status === 0 && first.stdout === second.stdout,
  );
  const cell = cellOf(first);
  record(
    'route:consumed',
    'RELEASE_PACKED_ADOPTER_READING_NOT_CONSUMED',
    reading?.status === 'pass' &&
      packedValidator()(reading) &&
      persisted.endsWith(relative) &&
      existsSync(join(fixture, relative)) &&
      cell?.verdict === 'PASS' &&
      JSON.stringify(cell.sensor_readings ?? []) === JSON.stringify([reading.id]),
  );
  return reading;
}

function checkSelection(template) {
  resetStore();
  // Reading ids are content-derived, so the earlier observation is taken with the
  // controller moved aside: it reads review, the later one pass.
  const controller = join(fixture, 'src/tickets.controller.ts');
  const aside = join(workspace, 'tickets.controller.ts');
  renameSync(controller, aside);
  let earlier;
  try {
    earlier = senseRunReading(RECORDED_KIND);
  } finally {
    renameSync(aside, controller);
  }
  const later = senseRunReading(RECORDED_KIND);
  let ok =
    earlier !== undefined &&
    later !== undefined &&
    earlier.id !== later.id &&
    String(later.timestamp) > String(earlier.timestamp);
  if (ok) {
    recordReading(later);
    recordReading(earlier);
    const first = scorecard();
    const second = scorecard();
    ok =
      first.stdout === second.stdout &&
      JSON.stringify(cellOf(first)?.sensor_readings ?? []) === JSON.stringify([later.id]) &&
      JSON.stringify(cellOf(second)?.sensor_readings ?? []) === JSON.stringify([later.id]);
  }
  // A failure older than the stale window reads stale, never PASS.
  resetStore();
  if (template !== undefined) {
    const stale = {
      ...template,
      id: 'SR-00000000000000a1',
      status: 'fail',
      timestamp: '2000-01-01T00:00:00.000Z',
    };
    delete stale.findings;
    placeInStore(RECORDED_KIND, `${stale.id}.json`, `${JSON.stringify(stale)}\n`);
    const cell = cellOf(scorecard());
    ok =
      ok &&
      packedValidator()(stale) &&
      cell !== undefined &&
      cell.verdict !== 'PASS' &&
      String(cell.notes ?? '').includes('REVIEW-stale');
  } else {
    ok = false;
  }
  record('route:selection', 'RELEASE_PACKED_ADOPTER_SELECTION_DIVERGED', ok);
}

function checkEmptyStore() {
  resetStore();
  const cell = cellOf(scorecard());
  record(
    'store:empty',
    'RELEASE_PACKED_ADOPTER_EMPTY_STORE_NOT_UNKNOWN',
    cell?.verdict === 'UNKNOWN' && (cell.sensor_readings ?? []).length === 0,
  );
}

function checkHead() {
  resetStore();
  const otherSha = head.startsWith('b') ? 'c'.repeat(40) : 'b'.repeat(40);
  const short = scorecard(head.slice(0, 12));
  const other = scorecard(otherSha);
  record(
    'route:exact-head',
    'RELEASE_PACKED_ADOPTER_HEAD_NOT_ENFORCED',
    short.status !== 0 &&
      short.stdout === '' &&
      other.status !== 0 &&
      other.stdout === '' &&
      `${other.stdout}${other.stderr}`.includes('AUDIT_SCORECARD_EXACT_HEAD_REQUIRED'),
  );
}

function checkRejections(template) {
  const cases = [
    [
      'store:unparseable',
      'SR-00000000000000c3.json',
      '{not json\n',
      'SCORECARD_READING_UNPARSEABLE',
    ],
  ];
  if (template !== undefined) {
    const invalid = { ...template, id: 'SR-00000000000000b2' };
    delete invalid.command_hash;
    cases.push([
      'store:schema-invalid',
      'SR-00000000000000b2.json',
      `${JSON.stringify(invalid)}\n`,
      'SCORECARD_READING_INVALID',
    ]);
  }
  for (const [id, name, body, code] of cases) {
    resetStore();
    placeInStore(RECORDED_KIND, name, body);
    const result = scorecard();
    const output = `${result.stdout}${result.stderr}`;
    const pattern = new RegExp(`${code}:\\S*${name.replaceAll('.', '\\.')}`, 'u');
    record(
      id,
      'RELEASE_PACKED_ADOPTER_INVALID_READING_ACCEPTED',
      pattern.test(output) && cellOf(result)?.verdict !== 'PASS',
    );
  }
  if (template === undefined) {
    record('store:schema-invalid', 'RELEASE_PACKED_ADOPTER_INVALID_READING_ACCEPTED', false);
  }
}

function checkLegacyStore() {
  const legacy = join(fixture, LEGACY_STORE);
  let present = existsSync(legacy);
  try {
    present = present || lstatSync(legacy).isSymbolicLink();
  } catch {
    // absent
  }
  record(
    'store:legacy-absent',
    'RELEASE_PACKED_ADOPTER_LEGACY_STORE_PRESENT',
    !present && !existsSync(join(fixture, 'record')),
  );
}

let exitCode = 0;
try {
  pack();
  checkArtifact();
  createFixture();
  checkSweepReadings();
  const template = checkRoute();
  checkSelection(template);
  checkEmptyStore();
  checkHead();
  checkRejections(template);
  checkLegacyStore();
} catch (error) {
  if (!(error instanceof ProofFailure)) {
    checks.push({
      id: 'rehearsal',
      ok: false,
      code: 'RELEASE_PACK_OUTPUT_INVALID',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
} finally {
  if (!keep) rmSync(workspace, { recursive: true, force: true });
}

const failures = checks.filter((check) => !check.ok);
if (failures.length > 0) exitCode = 1;
const report = {
  ok: failures.length === 0,
  ...(failures.length === 0 ? {} : { code: failures[0].code }),
  codes: failures.map((check) => check.code),
  tarball: suppliedTarball === undefined ? basename(tarballPath) : tarballPath,
  fixture_head: head,
  ...(keep ? { workspace } : {}),
  checks,
};
if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  for (const check of checks) {
    process.stdout.write(
      `${check.ok ? 'PASS' : 'FAIL'} ${check.id}${check.ok ? '' : ` ${check.code}`}\n`,
    );
  }
  process.stdout.write(
    `packed-adopter rehearsal: ${report.ok ? 'PASS' : `FAIL ${String(report.code)}`}\n`,
  );
}
process.exitCode = exitCode;
