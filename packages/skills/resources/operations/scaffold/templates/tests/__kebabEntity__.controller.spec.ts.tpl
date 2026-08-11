/* Generated for __NAMESPACE__/__MODULE__ — spec: __SPEC_VERSION__ sha: __SPEC_SHA__ */
import { Test } from '@nestjs/testing';
import { __classEntity__Controller } from './controllers/__kebabEntity__.controller';
import { __classEntity__Service } from './services/__kebabEntity__.service';

describe('__classEntity__Controller', () => {
  it('compiles', async () => {
    const module = await Test.createTestingModule({
      controllers: [__classEntity__Controller],
      providers: [{ provide: __classEntity__Service, useValue: {} }],
    }).compile();
    const ctrl = module.get(__classEntity__Controller);
    expect(ctrl).toBeTruthy();
  });
});

