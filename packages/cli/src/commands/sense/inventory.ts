import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CAC } from 'cac';
import {
  computeReverseAdherence,
  discoverSchemas,
  discoverTests,
  extractComponents,
  extractDependencies,
  extractModules,
  extractRoutes,
  glossaryCoverage,
  normalizeCoverage,
  regenerateInventory,
  resolveStackAdapterPack,
  validateContracts,
  withInventoryReadSnapshot,
} from '#runtime-core';
import { INVENTORY_SLICES, inventorySlice } from '@devai-nyx/sensors/inventory-slices';
import { EXIT_FAIL, EXIT_PASS, EXIT_REVIEW, EXIT_USAGE } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';

interface InventoryOptions {
  readonly slice?: string;
  readonly repoRoot?: string;
  readonly adopterRoot?: string;
  readonly databaseUrl?: string;
  readonly databaseSchema?: string;
  readonly coverage?: string;
  readonly trace?: string;
  readonly human?: boolean;
}

type InventoryMemberResult = {
  readonly member: string;
  readonly status: 'pass' | 'review';
  readonly value: unknown;
};

async function baseInventory(
  repoRoot: string,
): Promise<Awaited<ReturnType<typeof regenerateInventory>>> {
  return regenerateInventory({
    repoRoot,
    timestamp: new Date().toISOString(),
    integrationHead: '0'.repeat(40),
  });
}

async function inventoryMember(
  member: string,
  options: InventoryOptions,
  repoRoot: string,
): Promise<InventoryMemberResult> {
  switch (member) {
    case 'stack-adapter-pack-resolution': {
      const value = resolveStackAdapterPack({
        repoRoot,
        adopterRoot: options.adopterRoot ?? repoRoot,
      });
      return {
        member,
        status: value.matched === null || value.ambiguous ? 'review' : 'pass',
        value,
      };
    }
    case 'inventory-adherence': {
      const tracePath = resolve(repoRoot, options.trace ?? 'law/trace.json');
      if (!existsSync(tracePath)) throw new Error(`SENSE_INVENTORY_TRACE_MISSING:${tracePath}`);
      const inventory = await baseInventory(repoRoot);
      const trace = JSON.parse(readFileSync(tracePath, 'utf8')) as Parameters<
        typeof computeReverseAdherence
      >[0]['trace'];
      const value = computeReverseAdherence({ inventory, trace });
      return { member, status: value.counts.orphan === 0 ? 'pass' : 'review', value };
    }
    case 'component-inventory': {
      const value = extractComponents({ repoRoot });
      return { member, status: 'pass', value: { count: value.length, components: value } };
    }
    case 'contract-inventory': {
      const value = validateContracts({ repoRoot });
      return { member, status: value.ok ? 'pass' : 'review', value };
    }
    case 'inventory-coverage': {
      const coveragePath = resolve(repoRoot, options.coverage ?? 'coverage/coverage-final.json');
      const value = normalizeCoverage({ coveragePath });
      return { member, status: value.summary === null ? 'review' : 'pass', value };
    }
    case 'dependency-graph': {
      const value = extractDependencies({ repoRoot });
      return { member, status: 'pass', value };
    }
    case 'glossary-inventory': {
      const value = glossaryCoverage({ repoRoot });
      return { member, status: 'pass', value };
    }
    case 'module-inventory': {
      const value = extractModules({ repoRoot });
      return { member, status: 'pass', value: { count: value.length, modules: value } };
    }
    case 'route-inventory': {
      const value = extractRoutes({ repoRoot });
      return { member, status: 'pass', value: { count: value.length, routes: value } };
    }
    case 'schema-inventory': {
      const value = await discoverSchemas({
        repoRoot,
        noDb: options.databaseUrl === undefined,
        ...(options.databaseUrl === undefined ? {} : { databaseUrl: options.databaseUrl }),
        ...(options.databaseSchema === undefined ? {} : { databaseSchema: options.databaseSchema }),
      });
      return { member, status: 'pass', value: { count: value.length, schemas: value } };
    }
    case 'test-inventory': {
      const value = discoverTests({ repoRoot });
      return { member, status: 'pass', value: { count: value.length, tests: value } };
    }
    default:
      throw new Error(`SENSE_INVENTORY_MEMBER_UNIMPLEMENTED:${member}`);
  }
}

export async function executeInventorySlice(
  name: string,
  options: InventoryOptions = {},
): Promise<{
  readonly slice: string;
  readonly members: readonly string[];
  readonly status: 'pass' | 'review';
  readonly results: readonly InventoryMemberResult[];
  readonly implicit_persistence: false;
}> {
  return withInventoryReadSnapshot(async () => {
    const descriptor = inventorySlice(name);
    if (descriptor === undefined) throw new Error(`SENSE_INVENTORY_SLICE_UNKNOWN:${name}`);
    const repoRoot = resolve(options.repoRoot ?? '.');
    const results: InventoryMemberResult[] = [];
    for (const member of descriptor.members) {
      results.push(await inventoryMember(member, options, repoRoot));
    }
    return Object.freeze({
      slice: descriptor.name,
      members: descriptor.members,
      status: results.some((result) => result.status === 'review') ? 'review' : 'pass',
      results: Object.freeze(results),
      implicit_persistence: false,
    });
  });
}

export const senseInventoryCmd = defineCommand({
  name: 'sense inventory',
  description: 'Render one canonical repository inventory slice without persistence.',
  authority: 'sensor',
  register(cli: CAC): void {
    cli
      .command(
        'sense-inventory',
        'Render one canonical repository inventory slice without persistence',
      )
      .option(
        '--slice <name>',
        `Required slice: ${INVENTORY_SLICES.map((slice) => slice.name).join(' | ')}`,
      )
      .option('--repo-root <path>', 'Repository root (default: .)')
      .option('--adopter-root <path>', 'Adopter root for stack pack resolution')
      .option('--database-url <url>', 'Optional read-only database introspection URL')
      .option('--database-schema <name>', 'Optional database schema filter')
      .option('--coverage <path>', 'Coverage JSON path')
      .option('--trace <path>', 'Trace registry path')
      .option('--human', 'Human-readable summary')
      .action(async (options: InventoryOptions) => {
        if (options.slice === undefined) {
          process.stderr.write('devai sense inventory: --slice is required\n');
          process.exitCode = EXIT_USAGE;
          return;
        }
        try {
          const output = await executeInventorySlice(options.slice, options);
          process.stdout.write(
            options.human === true
              ? `devai sense inventory (${output.slice}): ${output.status.toUpperCase()} ${String(output.results.length)} member(s)\n`
              : `${JSON.stringify(output)}\n`,
          );
          process.exitCode = output.status === 'pass' ? EXIT_PASS : EXIT_REVIEW;
        } catch (error) {
          process.stderr.write(
            `devai sense inventory: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          process.exitCode = EXIT_FAIL;
        }
      });
  },
});
