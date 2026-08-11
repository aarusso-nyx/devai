import type { CAC } from 'cac';
import { validators } from '@devai-nyx/schemas';
import { EXIT_USAGE } from '@devai-nyx/utils';
import { cliError, renderCliError } from '../cli-error.js';
import { defineCommand, getActionsList, type ActionAuthority } from '../define-command.js';

const KNOWN_AUTHORITIES: readonly ActionAuthority[] = [
  'mesh_controller',
  'specifier',
  'constructor',
  'sensor',
  'policy_firewall',
  'release_controller',
  'agent_runtime',
  'host_tooling',
];

export const actionsList = defineCommand({
  name: 'catalog actions',
  description: 'List registered DEVAI actions as JSON.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    cli
      .command('catalog-actions', 'List registered DEVAI actions as JSON')
      .option(
        '--authority <name>',
        `Filter by action authority. One of: ${KNOWN_AUTHORITIES.join(', ')}`,
      )
      .option('--human', 'Human-readable command table')
      .action((options: { authority?: string; human?: boolean }) => {
        const auth = options.authority;
        if (auth !== undefined && !KNOWN_AUTHORITIES.includes(auth as ActionAuthority)) {
          process.stderr.write(
            `devai catalog actions: unknown --authority '${auth}'; expected one of ${KNOWN_AUTHORITIES.join(', ')}\n`,
          );
          process.exit(EXIT_USAGE);
        }
        const actions = getActionsList({
          ...(auth !== undefined ? { authority: auth as ActionAuthority } : {}),
        });
        if (!validators.actionsListOutput(actions)) {
          const error = cliError({
            code: 'ACTIONS_LIST_OUTPUT_INVALID',
            class: 'contract-violation',
            exit: 7,
            message: 'Action catalog output failed its governed schema.',
            remediation: 'Run the CLI contract test suite and repair the action manifest.',
            refs: { doc: 'law/schemas/actions-list-output.schema.json' },
            context: { issues: validators.actionsListOutput.errors ?? [] },
          });
          process.stderr.write(renderCliError(error, options.human !== true));
          process.exit(7);
        }
        if (options.human === true) {
          const rows = actions.map(
            (action) =>
              `${action.name.padEnd(46)} ${action.status.padEnd(12)} ${action.effects.padEnd(13)} ${action.description}`,
          );
          process.stdout.write(
            `COMMAND${' '.repeat(39)} LIFECYCLE    EFFECTS       DESCRIPTION\n${rows.join('\n')}\n`,
          );
        } else {
          process.stdout.write(JSON.stringify(actions) + '\n');
        }
      });
  },
});
