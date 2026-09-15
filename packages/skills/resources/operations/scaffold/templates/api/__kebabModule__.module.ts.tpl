/* Generated for __NAMESPACE__/__MODULE__ — spec: __SPEC_VERSION__ sha: __SPEC_SHA__ */
import { Module } from '@nestjs/common';
__API_ENTITY_IMPORTS__
import { __MODULE__PolicyGuard } from './guards/policy.guard';

/*
 * Template-shaped @Module: the scaffolded controller + service +
 * policy guard wire up correctly, but the data layer is left as a
 * port (see __kebabEntity__.service.ts). Adopters bind their own
 * data layer (e.g. TypeORM, @stynx/data, Drizzle, raw pg) by
 * providing the service's repository dependency in this @Module's
 * `providers`.
 *
 * The scaffolder is deterministic and template-shaped, not
 * production-ready; adopters select and bind the data layer.
 */
@Module({
  imports: [],
  controllers: [__API_CONTROLLERS__],
  providers: [__API_SERVICES__, __MODULE__PolicyGuard],
  exports: [__API_SERVICES__],
})
export class __MODULE__Module {}
