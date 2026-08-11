import { executeMaterializeOperation } from './materialize.js';
import { executeScaffoldOperation } from './scaffold/index.js';
import type { OperationCommandRunner, OperationHost, OperationHostRequest } from './types.js';

function inputString(request: OperationHostRequest, key: string): string | undefined {
  const value = request.inputs?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function commandArgv(request: OperationHostRequest): readonly string[] {
  const argv = request.definition.argv;
  if (argv === undefined) throw new Error(`OPERATION_COMMAND_MISSING:${request.operation}`);
  if (request.operation === 'sense.inventory') {
    return [...argv, '--slice', inputString(request, 'slice') ?? 'all'];
  }
  if (request.operation === 'round.assess') {
    const round = inputString(request, 'round');
    if (round === undefined) throw new Error('OPERATION_INPUT_REQUIRED:round');
    return [...argv, '--round', round];
  }
  if (request.operation === 'evidence.verify') {
    const scope = inputString(request, 'scope') ?? 'local';
    if (!['local', 'chain'].includes(scope)) throw new Error('OPERATION_INPUT_INVALID:scope');
    return [...argv, '--scope', scope];
  }
  return argv;
}

export function createOperationHost(commandRunner: OperationCommandRunner): OperationHost {
  return Object.freeze({
    execute(request: OperationHostRequest) {
      if (request.definition.execution === 'host-scaffolder') {
        return executeScaffoldOperation(request);
      }
      if (request.definition.execution === 'host-materializer') {
        return executeMaterializeOperation(request);
      }
      return commandRunner.run({
        argv: commandArgv(request),
        cwd: request.repo_root,
        effect: request.definition.effect,
        write_paths: request.write_paths ?? [],
      });
    },
  });
}
