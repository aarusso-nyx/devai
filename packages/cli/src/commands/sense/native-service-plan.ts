import { getValidator } from '@devai-nyx/schemas';
import type { PlannedTask, TaskDescriptorNode } from '../../services/check-runner/types.js';
import type { NativeDockerBinding, NativeDockerImage } from '../../native-service-docker-broker.js';

export interface NativeServiceRequest {
  readonly schemaVersion: '1.0.0';
  readonly profile:
    | 'postgres-http-v1'
    | 'postgres-http-s3-v1'
    | 'postgres-redis-http-s3-kms-v1'
    | 'playwright-chromium-web-v1';
  readonly backendId: 'owned-linux-native-v1-linux-amd64' | 'owned-linux-native-v1-linux-arm64';
  readonly provisioner: { readonly kind: 'owned-docker-v1'; readonly toolchainKey: string };
  readonly postgres: { readonly image: string };
  readonly redis?: { readonly image: string; readonly processControl?: 'pause-resume-v1' };
  readonly localstack?: { readonly image: string; readonly services: readonly string[] };
}

export interface NativeServiceSelection {
  readonly request: NativeServiceRequest;
  readonly docker: { readonly path: string; readonly sha256: string };
  readonly engine: { readonly path: string; readonly dev: number; readonly ino: number };
  readonly supervisor: { readonly path: string; readonly sha256: string };
  readonly brokerSha256: string;
  readonly artifacts: {
    readonly docker: NativeDockerBinding;
    readonly postgres: NativeDockerImage;
  };
  readonly capabilities: readonly string[];
  readonly digest: string;
}

/** Resolve only implemented package-owned backends; a valid declaration grants no authority. */
export function resolveNativeServiceSelection(
  _root: string,
  _task: PlannedTask | undefined,
  _declaration: TaskDescriptorNode,
  request: unknown,
): NativeServiceSelection | undefined {
  if (request === undefined) return undefined;
  if (!getValidator('native-service-profile.schema.json')(request))
    throw new Error('SENSE_NATIVE_SERVICE_PROFILE_INVALID');
  // ADR-SCR-0020 requires an approved Linux runtime, namespace plan and independent replay.
  // The earlier host-native inspector cannot authorize any of the declared profiles.
  throw new Error('SENSE_NATIVE_SERVICE_BACKEND_UNIMPLEMENTED');
}
