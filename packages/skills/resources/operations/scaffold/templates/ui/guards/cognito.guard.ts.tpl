/* Generated for __NAMESPACE__/__MODULE__ — spec: __SPEC_VERSION__ sha: __SPEC_SHA__ */
import { Inject, Injectable, Optional } from '@angular/core';
import { CanActivate } from '@angular/router';

/** Adopter-owned session and resource-policy adapter. Never infer authentication
 * from a stored token's presence. Bind the application's verified Cognito session
 * and policy implementation to this token in an ancestor injector. */
export abstract class __MODULE__UiAuthorization {
  abstract authenticated(): boolean | Promise<boolean>;
  abstract permits(resource: string, action: string): boolean | Promise<boolean>;
}

@Injectable()
export class CognitoGuard implements CanActivate {
  constructor(@Optional() @Inject(__MODULE__UiAuthorization) private readonly authorization: __MODULE__UiAuthorization | null) {}

  async canActivate(): Promise<boolean> {
    try {
      return (await this.authorization?.authenticated()) === true;
    } catch {
      return false;
    }
  }
}
