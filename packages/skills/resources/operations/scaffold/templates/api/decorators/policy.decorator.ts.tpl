import { SetMetadata } from '@nestjs/common';

export const RESOURCE_KEY = '__policy_resource__';
export const ACTION_KEY = '__policy_action__';

export const Resource = (resource: string) => SetMetadata(RESOURCE_KEY, resource);
export const Action = (action: string) => SetMetadata(ACTION_KEY, action);

