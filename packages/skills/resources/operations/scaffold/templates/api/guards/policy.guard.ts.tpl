/* Generated for __NAMESPACE__/__MODULE__ — spec: __SPEC_VERSION__ sha: __SPEC_SHA__ */
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ACTION_KEY, RESOURCE_KEY } from '../decorators/policy.decorator';

/*
 * Template-shaped RBAC/ABAC policy guard. Reads the request's
 * `user` (populated by the host app's authentication
 * middleware) and the route's `@Resource()` + `@Action()`
 * decorators, and decides whether to allow the call.
 *
 * Template behaviour (intentionally permissive):
 *   - No authenticated user → deny.
 *   - No `@Resource()` + `@Action()` on the route → allow.
 *   - Both decorators present → allow if the user has at least
 *     one role. Adopters replace this with their domain-specific
 *     rule engine (per-resource role tables, ABAC attribute
 *     checks, etc.).
 *
 * Adopters who want a config-driven policy engine bind their
 * own implementation when finishing the generated module.
 */
@Injectable()
export class __MODULE__PolicyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const user = (req as { user?: { roles?: string[] } }).user;
    if (user === undefined) return false;
    const handler = context.getHandler();
    const klass = context.getClass();
    const action = this.reflector.get<string | undefined>(ACTION_KEY, handler);
    const resource =
      this.reflector.get<string | undefined>(RESOURCE_KEY, handler) ??
      this.reflector.get<string | undefined>(RESOURCE_KEY, klass);
    // No policy declarations on the route → allow (the controller
    // is opting out of policy enforcement by not annotating).
    if (action === undefined || resource === undefined) return true;
    const roles = (user.roles ?? []).map((r) => String(r).toLowerCase());
    // Template default: any authenticated user with at least one
    // role passes. Adopter hand-finish: replace with the real
    // (resource × action × role) decision logic.
    return roles.length > 0;
  }
}
