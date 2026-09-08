/* Generated for __NAMESPACE__/__MODULE__ — spec: __SPEC_VERSION__ sha: __SPEC_SHA__ */
import { Inject, Injectable, Optional } from '@angular/core';
import { ActivatedRouteSnapshot, CanActivate } from '@angular/router';
import { __MODULE__UiAuthorization } from './guards/cognito.guard';

@Injectable()
export class __MODULE__PolicyGuard implements CanActivate {
  constructor(@Optional() @Inject(__MODULE__UiAuthorization) private readonly authorization: __MODULE__UiAuthorization | null) {}

  async canActivate(route: ActivatedRouteSnapshot): Promise<boolean> {
    try {
      const { resource, action } = route.data;
      if (typeof resource !== 'string' || resource.length === 0 || typeof action !== 'string' || action.length === 0) return false;
      if ((await this.authorization?.authenticated()) !== true) return false;
      return (await this.authorization?.permits(resource, action)) === true;
    } catch {
      return false;
    }
  }
}
