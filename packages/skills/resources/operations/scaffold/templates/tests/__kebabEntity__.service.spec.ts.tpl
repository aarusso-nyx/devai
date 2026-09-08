/* Generated for __NAMESPACE__/__MODULE__ — spec: __SPEC_VERSION__ sha: __SPEC_SHA__ */
import { Test } from '@nestjs/testing';
import { __classEntity__Service } from '../src/__moduleSlug__/services/__kebabEntity__.service';

describe('__classEntity__Service', () => {
  it('creates', async () => {
    const module = await Test.createTestingModule({
      providers: [__classEntity__Service],
    }).compile();
    const svc = module.get(__classEntity__Service);
    expect(svc).toBeTruthy();
  });
});
