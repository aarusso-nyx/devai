// Invariants: INV-DEVAI-001, INV-DEVAI-002, INV-DEVAI-020
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ROSTER as PACKAGED_SCHEMA_ROSTER,
  validators as packagedValidators,
} from '../../packages/schemas/dist/index.js';
import { subprocessCoverageEnvironment } from '../helpers/subprocess-coverage.js';

const ROOT = resolve(import.meta.dirname, '../..');
const BIN = join(ROOT, 'packages/cli/tests/fixtures/authorized-cli-test-driver.mjs');
const REAL_BIN = join(ROOT, 'packages/cli/dist/runtime/index/bin.js');
const repositories: string[] = [];
const COMPATIBILITY_VALIDATORS = {
  adr: 'adr.schema.json',
  agentRun: 'agent-run.schema.json',
  apiMap: 'api-map.schema.json',
  coverageMatrix: 'coverage-matrix.schema.json',
  dataModelInventory: 'data-model-inventory.schema.json',
  depGraph: 'dep-graph.schema.json',
  glossaryEntry: 'glossary-entry.schema.json',
  invCandidate: 'inv-candidate.schema.json',
  journey: 'journey.schema.json',
  mutationIntent: 'mutation-intent.schema.json',
  rbacInventory: 'rbac-inventory.schema.json',
  routesInventory: 'routes-inventory.schema.json',
  rtdManifest: 'rtd-manifest.schema.json',
  testWeakeningConfig: 'test-weakening-config.schema.json',
  useCases: 'use-cases.schema.json',
} as const;

afterEach(() => {
  for (const repository of repositories.splice(0)) {
    rmSync(repository, { recursive: true, force: true });
  }
});

describe('installed inventory_api sensor', () => {
  it('packages every advertised compatibility validator used by runtime consumers', () => {
    const unavailable = Object.entries(COMPATIBILITY_VALIDATORS).flatMap(
      ([key, schema]) =>
        (PACKAGED_SCHEMA_ROSTER as readonly string[]).includes(schema) &&
        typeof (packagedValidators as unknown as Record<string, unknown>)[key] === 'function'
          ? []
          : [`${key}:${schema}`],
    );

    expect(unavailable).toEqual([]);
  });

  it('returns a valid SensorReading through the assembled public sense facade', () => {
    const repository = mkdtempSync(join(tmpdir(), 'devai-inventory-api-adopter-'));
    repositories.push(repository);
    const source = join(repository, 'src');
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, 'tickets.controller.ts'),
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

    for (const selector of ['--constitution', '--operational-law', '--subprocess-effects']) {
      const binding = spawnSync(
        process.execPath,
        [
          REAL_BIN,
          'init',
          'bind',
          selector,
          '--target',
          repository,
          '--as-role',
          'architect',
          '--write',
          '--format',
          'json',
        ],
        { cwd: repository, encoding: 'utf8', env: subprocessCoverageEnvironment() },
      );
      expect(binding.status, binding.stderr).toBe(0);
    }

    const result = spawnSync(
      process.execPath,
      [
        BIN,
        'sense',
        'run',
        'inventory_api',
        '--repo-root',
        repository,
        '--format',
        'json',
      ],
      {
        cwd: repository,
        encoding: 'utf8',
        env: subprocessCoverageEnvironment(),
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const envelope = JSON.parse(result.stdout) as {
      action_id: string;
      result: {
        value: {
          execution_status: string;
          readiness_status: string;
          results: Array<{ stdout: string; stderr: string; status: number | null }>;
        };
      };
    };
    expect(envelope.action_id).toBe('sense run');
    expect(envelope.result.value).toMatchObject({
      execution_status: 'pass',
      readiness_status: 'pass',
      results: [{ stderr: '', status: 0 }],
    });
    const reading = JSON.parse(envelope.result.value.results[0]?.stdout ?? '') as {
      sensor: { kind: string };
      status: string;
    };
    expect(reading.sensor.kind).toBe('inventory_api');
    expect(reading.status).toBe('pass');
  }, 30_000);
});
