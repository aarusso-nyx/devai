import { resolve } from 'node:path';
import type { CAC } from 'cac';
import { renderDecisionRecords, renderRoundRecords } from '#runtime-core';
import { writeGovernanceProjectionSync } from '@devai-nyx/authority';
import { EXIT_PASS, EXIT_USAGE } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';

interface RenderOptions {
  readonly repoRoot?: string;
  readonly out?: string;
}

function hasExplicitWriteConsent(): boolean {
  return process.argv.includes('--write');
}

function render(
  label: 'decisions' | 'rounds',
  options: RenderOptions,
  renderer: (input: { readonly repoRoot: string }) => string,
): void {
  const repoRoot = resolve(options.repoRoot ?? '.');
  const body = renderer({ repoRoot });
  if (options.out === undefined) {
    process.stdout.write(body);
    if (!body.endsWith('\n')) process.stdout.write('\n');
    process.exitCode = EXIT_PASS;
    return;
  }
  if (!hasExplicitWriteConsent()) {
    process.stderr.write(`devai docs ${label} render: --out requires --write\n`);
    process.exitCode = EXIT_USAGE;
    return;
  }
  const target = resolve(repoRoot, options.out);
  writeGovernanceProjectionSync(target, body);
  process.stdout.write(
    `${JSON.stringify({ ok: true, kind: label, out: options.out, bytes: Buffer.byteLength(body) })}\n`,
  );
  process.exitCode = EXIT_PASS;
}

export const docsDecisionsRender = defineCommand({
  name: 'docs decisions render',
  description:
    'Render the canonical per-record decision ledger to stdout; --out writes the same deterministic bytes with explicit consent.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    cli
      .command('docs-decisions-render', 'Render the canonical decision ledger')
      .option('--repo-root <path>', 'Repository root (default: cwd)')
      .option('--out <path>', 'Write the rendered projection relative to the repository root')
      .action((options: RenderOptions) => render('decisions', options, renderDecisionRecords));
  },
});

export const docsRoundsRender = defineCommand({
  name: 'docs rounds render',
  description:
    'Render sealed round records to stdout; --out writes the same deterministic bytes with explicit consent.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    cli
      .command('docs-rounds-render', 'Render the canonical round ledger')
      .option('--repo-root <path>', 'Repository root (default: cwd)')
      .option('--out <path>', 'Write the rendered projection relative to the repository root')
      .action((options: RenderOptions) => render('rounds', options, renderRoundRecords));
  },
});
