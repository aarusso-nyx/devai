/* Generated for __NAMESPACE__/__MODULE__ — spec: __SPEC_VERSION__ sha: __SPEC_SHA__ */
import { Module } from '@nestjs/common';
import { __classEntity__Service } from './services/__kebabEntity__.service';
import { __classEntity__Controller } from './controllers/__kebabEntity__.controller';
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
  controllers: [__classEntity__Controller],
  providers: [__classEntity__Service, __MODULE__PolicyGuard],
  exports: [__classEntity__Service],
})
export class __MODULE__Module {}
