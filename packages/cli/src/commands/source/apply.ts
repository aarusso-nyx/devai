import type { CAC } from 'cac';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { publishSourceFileSync } from '@devai-nyx/authority';
import { getValidator } from '@devai-nyx/schemas';
import { defineCommand } from '../../define-command.js';
import { cliError } from '../../cli-error.js';
import { parseSourceManifest } from './manifest.js';
import { emit } from '../round/workflow-support.js';

function sourceApply(role: 'architect' | 'engineer' | 'inspector') {
  return defineCommand({
    name: `source apply ${role}`,
    description: `Apply one exact source-file change under ${role} authority.`,
    authority: 'mesh_controller',
    register(cli: CAC): void {
      cli
        .command(`source-apply-${role}`, 'Apply one exact source file')
        .option('--manifest <path>', 'Source application manifest')
        .option('--human', 'Human-readable output')
        .action((options: { manifest?: string; human?: boolean }) => {
          let applied = false;
          try {
            if (typeof options.manifest !== 'string') throw new Error('SOURCE_MANIFEST_INVALID');
            const raw = new TextDecoder('utf-8', { fatal: true }).decode(
              readFileSync(resolve(options.manifest)),
            );
            const manifest = parseSourceManifest(raw);
            const output = { target: manifest.target, sha256: manifest.content_sha256 };
            if (!getValidator('source-apply-result.schema.json')(output))
              throw new Error('SOURCE_RESULT_SCHEMA_INVALID');
            const result = publishSourceFileSync(
              Object.freeze({
                root: realpathSync(process.cwd()),
                target: manifest.target,
                expected: manifest.expected,
                content: manifest.content_utf8,
                sha256: manifest.content_sha256,
              }),
            );
            applied = true;
            if (result.sha256 !== output.sha256)
              throw new Error('SOURCE_PUBLICATION_INDETERMINATE');
            emit(output, options.human === true, `source apply: ${manifest.target}`);
          } catch (error) {
            const raw = error instanceof Error ? error.message : '';
            const code = applied
              ? 'SOURCE_PUBLICATION_INDETERMINATE'
              : /^[A-Z][A-Z0-9_]+$/u.test(raw)
                ? raw
                : 'SOURCE_OPERATION_FAILED';
            const uncertain =
              code === 'SOURCE_PUBLICATION_INDETERMINATE' ||
              code === 'SOURCE_PUBLICATION_STAGING_REMAINS';
            const invalid = code === 'SOURCE_MANIFEST_INVALID';
            const detail = (error as { detail?: unknown } | undefined)?.detail;
            const envelope = cliError({
              code,
              class: uncertain ? 'infrastructure' : invalid ? 'invalid-input' : 'routing-authority',
              exit: uncertain ? 6 : invalid ? 4 : 2,
              message: code.toLowerCase().replaceAll('_', ' '),
              remediation: uncertain
                ? 'Inspect the target and any reported staging entry before deciding how to proceed.'
                : 'Correct the reported input or authority condition before retrying.',
              context: typeof detail === 'string' ? { detail } : {},
            });
            process.stderr.write(`${JSON.stringify(envelope)}\n`);
            process.exitCode = envelope.exit;
          }
        });
    },
  });
}

export const sourceApplyArchitect = sourceApply('architect');
export const sourceApplyEngineer = sourceApply('engineer');
export const sourceApplyInspector = sourceApply('inspector');
