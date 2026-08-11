/* Generated for __NAMESPACE__/__MODULE__ — spec: __SPEC_VERSION__ sha: __SPEC_SHA__ */
import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { __classEntity__Service } from '../services/__kebabEntity__.service';
import { Create__classEntity__Dto } from '../dto/create-__kebabEntity__.dto';
import { Update__classEntity__Dto } from '../dto/update-__kebabEntity__.dto';
import { __MODULE__PolicyGuard } from '../guards/policy.guard';
import { Resource, Action } from '../decorators/policy.decorator';

@Controller('/api/__NAMESPACE__/__kebabModule__/__kebabEntity__')
@Resource('__kebabEntity__')
@UseGuards(__MODULE__PolicyGuard)
export class __classEntity__Controller {
  constructor(private readonly service: __classEntity__Service) {}

  @Get()
  @Action('read')
  list() {
    return this.service.findAll();
  }

  @Get(':id')
  @Action('read')
  get(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Action('create')
  create(@Body() dto: Create__classEntity__Dto) {
    // ownerId extraction from auth token should be added by scaffolder
    return this.service.create(dto);
  }

  @Put(':id')
  @Action('update')
  update(@Param('id') id: string, @Body() dto: Update__classEntity__Dto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @Action('delete')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
